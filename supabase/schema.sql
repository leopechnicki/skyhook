-- ===========================================================================
-- SKYHOOK - global leaderboard schema (Supabase / Postgres)
-- ===========================================================================
--
-- Run this ONCE, whole, in the Supabase dashboard: SQL Editor -> New query ->
-- paste -> Run. It is idempotent: running it twice is safe and changes nothing
-- the second time, so it doubles as the "is my project set up right?" check.
--
-- The threat model this file answers
-- ---------------------------------
-- The game is a static page on GitHub Pages. There is no server of ours in the
-- path, so the browser talks straight to PostgREST with the PUBLIC anon key.
-- Anyone can read that key out of js/config.js - it is meant to be public. That
-- means EVERY rule that matters has to live in this file, enforced by Postgres,
-- because the client is 100% attacker-controlled. Specifically:
--
--   * Row Level Security is ON for every table. Without it the anon key is a
--     master key to the whole schema.
--   * A player may INSERT only rows carrying their own auth.uid(). They may
--     never UPDATE or DELETE a score - not even their own. Scores are an
--     append-only ledger; "edit my score" is the same operation as "cheat".
--   * The public leaderboard is a VIEW that selects username + score + run
--     stats and nothing else. Emails live in auth.users, which PostgREST does
--     not expose at all, and no view here reaches into it.
--   * Plausibility and rate limiting run in a BEFORE INSERT trigger rather than
--     in an RPC. An RPC-only rate limit is bypassable by calling the table
--     directly; a trigger is not, because it sits under every write path.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles - the only identity the leaderboard needs
-- ---------------------------------------------------------------------------
-- One row per account, holding the display name and NOTHING else. Leo's brief
-- was explicit: username, email, password, no extra profile fields. The email
-- and password stay in auth.users where GoTrue manages them; this table
-- deliberately does not copy the email, so a leak here cannot leak an address.

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now(),

  -- 3-16 chars, letters/digits/underscore. Enforced here as well as in the UI
  -- because the UI is a suggestion and this is the rule.
  constraint profiles_username_shape check (username ~ '^[A-Za-z0-9_]{3,16}$')
);

-- Case-insensitive uniqueness: "Leo" and "leo" must not be two people on a
-- board where the whole point is telling players apart at a glance.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- 2. scores - append-only run ledger
-- ---------------------------------------------------------------------------

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  score       integer not null,
  hooks       integer not null,
  altitude    integer not null default 0,
  duration_ms integer not null,
  created_at  timestamptz not null default now(),

  -- Absolute sanity bounds. These are not balance tuning; they are the
  -- boundaries of what the game can physically emit. A run outside them did
  -- not come from the game.
  constraint scores_score_range    check (score       >= 0 and score       <= 5000000),
  constraint scores_hooks_range    check (hooks       >= 0 and hooks       <= 200000),
  constraint scores_altitude_range check (altitude    >= 0 and altitude    <= 50000000),
  constraint scores_duration_range check (duration_ms >= 500 and duration_ms <= 86400000),

  -- Scoring in js/game.js: a hook pays round((tight ? 15 : 8) * combo *
  -- (1 + (mass - 1) * 0.22)), with combo capped at 9 and the deepest star mass
  -- around 4.2 -> ~230 points is the best single hook the game can pay. Shards
  -- add 25 * max(1, floor(combo * 0.5)) -> at most 100, and a shard is spawned
  -- per body, so it cannot outrun the hook count either. 450 per hook plus a
  -- 500 floor is roughly double the theoretical ceiling: generous enough that
  -- no honest run is ever rejected, tight enough that a submitted 999999999
  -- with 3 hooks is.
  constraint scores_score_plausible check (score <= 500 + hooks * 450),

  -- The release debounce (ACT_DEBOUNCE) is 0.12 s of SIM time, so nine hooks
  -- per second is already past what the input path can produce. Plus a 12-hook
  -- allowance for the opening burst.
  constraint scores_rate_plausible check (hooks <= 12 + (duration_ms / 1000.0) * 9)
);

-- The leaderboard reads "best score per user, ranked". This index serves both
-- halves of that.
create index if not exists scores_user_best_idx
  on public.scores (user_id, score desc, created_at asc);
create index if not exists scores_score_idx
  on public.scores (score desc, created_at asc);

-- ---------------------------------------------------------------------------
-- 3. Rate limit - in a trigger, so no write path can skip it
-- ---------------------------------------------------------------------------
-- A run takes a minimum of a few seconds to play, so a real player cannot
-- produce more than a handful of scores a minute. Anything past 10 in 60
-- seconds is a script, and the answer is a hard error rather than a silent
-- drop, so the client can show the player something truthful.

create or replace function public.scores_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent integer;
begin
  select count(*) into recent
    from public.scores
   where user_id = new.user_id
     and created_at > now() - interval '60 seconds';

  if recent >= 10 then
    raise exception 'rate limit: too many scores submitted, try again in a minute'
      using errcode = '54000';
  end if;

  -- The client does not get to choose whose score this is, no matter what it
  -- puts in the body. Belt for the RLS policy's braces.
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;

  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists scores_rate_limit_trg on public.scores;
create trigger scores_rate_limit_trg
  before insert on public.scores
  for each row execute function public.scores_rate_limit();

-- ---------------------------------------------------------------------------
-- 4. New account -> profile row
-- ---------------------------------------------------------------------------
-- Email signup sends { data: { username } } so the name the player typed lands
-- in raw_user_meta_data. Google OAuth sends no username at all, so one is
-- derived from the Google display name or the local part of the address and
-- then de-duplicated. Deriving from the email is the ONLY place an address is
-- touched, it is never stored, and the player can see the result on the board.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raw      text;
  base     text;
  candidate text;
  n        integer := 0;
begin
  raw := coalesce(
    new.raw_user_meta_data ->> 'username',
    new.raw_user_meta_data ->> 'user_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(coalesce(new.email, ''), '@', 1),
    ''
  );

  base := regexp_replace(lower(raw), '[^a-z0-9_]', '', 'g');
  base := left(base, 16);
  if char_length(base) < 3 then
    base := 'pilot' || to_char(floor(random() * 1000)::int, 'FM000');
  end if;

  candidate := base;
  while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
    n := n + 1;
    if n > 500 then
      candidate := left(base, 8) || floor(random() * 100000000)::text;
      exit;
    end if;
    candidate := left(base, 16 - char_length(n::text)) || n::text;
  end loop;

  insert into public.profiles (id, username)
  values (new.id, candidate)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

-- profiles: the world may read display names (that is what a leaderboard is).
-- A signed-in user may create their own row - which normally the trigger above
-- already did - and may never touch anyone else's. No UPDATE policy and no
-- DELETE policy exist, so those operations are denied to everyone.
drop policy if exists profiles_public_read on public.profiles;
create policy profiles_public_read
  on public.profiles for select
  to anon, authenticated
  using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

-- scores: public read (the board), own-row insert, and that is the entire
-- surface. The absence of UPDATE/DELETE policies is the feature - under RLS,
-- no policy means no permission, including for the row's own author.
drop policy if exists scores_public_read on public.scores;
create policy scores_public_read
  on public.scores for select
  to anon, authenticated
  using (true);

drop policy if exists scores_insert_own on public.scores;
create policy scores_insert_own
  on public.scores for insert
  to authenticated
  with check (user_id = auth.uid());

-- Table grants, stated explicitly rather than inherited from whatever the
-- project's default privileges happen to be. RLS decides WHICH rows; these
-- decide which verbs exist at all.
grant select on public.profiles to anon, authenticated;
grant insert on public.profiles to authenticated;
grant select on public.scores   to anon, authenticated;
grant insert on public.scores   to authenticated;

-- Make the "no UPDATE/DELETE" rule explicit at the grant layer too, so a
-- future permissive policy added by accident still cannot write.
revoke update, delete on public.scores   from anon, authenticated;
revoke update, delete on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The public board
-- ---------------------------------------------------------------------------
-- One row per player (their best run), ranked. security_invoker = on means the
-- view runs with the CALLER's permissions and therefore obeys the RLS policies
-- above instead of quietly bypassing them - the pattern Supabase's own linter
-- asks for. Columns are chosen by hand: username, the run, the date. No email,
-- no user id, no auth metadata.

create or replace view public.leaderboard
with (security_invoker = on)
as
select
  row_number() over (order by b.score desc, b.created_at asc) as rank,
  p.username,
  b.score,
  b.hooks,
  b.altitude,
  b.created_at
from (
  select distinct on (s.user_id)
         s.user_id, s.score, s.hooks, s.altitude, s.created_at
    from public.scores s
   order by s.user_id, s.score desc, s.created_at asc
) b
join public.profiles p on p.id = b.user_id
order by b.score desc, b.created_at asc;

grant select on public.leaderboard to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. my_rank() - what the game-over screen asks for
-- ---------------------------------------------------------------------------
-- Computing "where am I?" client-side would mean downloading the whole board.
-- This answers it in one round trip and returns null for a signed-out caller.

create or replace function public.my_rank()
returns table (rank bigint, score integer, username text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select l.rank, l.score, l.username
    from public.leaderboard l
    join public.profiles p on lower(p.username) = lower(l.username)
   where p.id = auth.uid()
   limit 1;
$$;

grant execute on function public.my_rank() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. ship paint - the ship the player painted, one colour per part
-- ---------------------------------------------------------------------------
-- Cosmetic, and the only thing in this file that is. It lives on profiles
-- because it belongs to the ACCOUNT rather than to a run: the point of storing
-- it at all is that a ship painted on a laptop is painted on the phone too.
-- The game works with these columns absent - js/ui_ship.js keeps the paint in
-- localStorage and treats every server answer as optional - so an unmigrated
-- project loses cross-device sync and nothing else.
--
-- Four parts, four columns: ship_nose, ship_window, ship_body, ship_fire.
-- NULL means "never chosen", i.e. the game's shipped default for that part:
-- the default is a property of the game, and writing today's default into
-- every row would freeze it there.
--
-- THREE RULES, TWO ENFORCED HERE
--
--   1. Every column holds an ALLOW-LIST, and it is the same list js/ship.js
--      shows. The client is attacker-controlled, so "that colour is not on the
--      menu" has to be a constraint, not a UI affordance. The list is written
--      ONCE, in ship_colour_allowed() below, and all four CHECKs call it - four
--      copies of an eleven-item list is how one of them drifts.
--
--   2. Champion gold (#ffc21a) is deliberately NOT on the list. Gold is a
--      rank, not a choice: the game paints it while the leaderboard says you
--      are #1 and never stores it, so there is nothing to forge. Writing gold
--      into your own row fails the constraint, on any part.
--
--   3. The COMBINATION must leave the ship readable (a pale window on a pale
--      hull vanishes even though both colours are on the menu). That rule is
--      NOT restated here, on purpose: it is measured on the colours the
--      renderer paints, and a second copy in SQL would be a second derivation
--      to keep in step with js/rocket.js. It does not need one. Every paint
--      that comes out of this table passes SK.Ship.normalise() before it is
--      drawn, which corrects a combination that does not read - and the only
--      ship a row can ever affect is its own author's, on their own screen.
--
-- Note what is still true after this section. Whatever UPDATE a player is
-- granted on their own profile row is COLUMN-SCOPED, and none of the ship_*
-- columns is in it: a player holding nothing but the anon key and their own
-- session cannot write these columns directly. The only way to write them is
-- the security-definer function below, which writes auth.uid()'s row and no
-- other, and touches no other column - so the paint path cannot rename
-- anybody, and no rename path can repaint anybody.

create or replace function public.ship_colour_allowed(c text)
returns boolean
language sql
immutable
as $$
  select c is null or c in (
    '#35e6ff',  -- Signal Cyan (the default)
    '#1a9dff',  -- Azure
    '#8a72ff',  -- Ion Blue
    '#c957ff',  -- Nebula
    '#ff2bd6',  -- Magenta
    '#ff4d94',  -- Hot Pink
    '#ff3b30',  -- Warning Red
    '#ff7a1a',  -- Ember
    '#a8ff1f',  -- Acid
    '#1affb0',  -- Mint
    '#ffffff'   -- Nova White
  );
$$;

alter table public.profiles
  add column if not exists ship_nose   text,
  add column if not exists ship_window text,
  add column if not exists ship_body   text,
  add column if not exists ship_fire   text;

alter table public.profiles drop constraint if exists profiles_ship_nose_allowed;
alter table public.profiles drop constraint if exists profiles_ship_window_allowed;
alter table public.profiles drop constraint if exists profiles_ship_body_allowed;
alter table public.profiles drop constraint if exists profiles_ship_fire_allowed;

-- The single-colour build stored one hex in ship_colour. Anybody who painted
-- a ship with it keeps that ship: the colour is copied onto all four parts
-- (exactly how that build drew it), and only then is the old column dropped.
-- A no-op on a project that never had it.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles'
                and column_name = 'ship_colour') then
    update public.profiles
       set ship_nose   = coalesce(ship_nose,   ship_colour),
           ship_window = coalesce(ship_window, ship_colour),
           ship_body   = coalesce(ship_body,   ship_colour),
           ship_fire   = coalesce(ship_fire,   ship_colour)
     where ship_colour is not null;
    alter table public.profiles drop constraint if exists profiles_ship_colour_allowed;
    alter table public.profiles drop column ship_colour;
  end if;
end;
$$;
drop function if exists public.set_ship_colour(text);

-- 2026-09-23: the menu went from pastel to saturated (the measurements are
-- above SWATCHES in js/ship.js). A row painted with the first menu is carried
-- to the same family on the new one rather than failing the CHECKs below.
-- ONE list, in one function, and it is the same map as SK.Ship.RENAMED -
-- test/ship.mjs holds the two to each other. It runs AFTER the single-colour
-- migration above (whose values are first-menu hexes too) and BEFORE the
-- constraints come back, so both paths land on the new list. Anything not in
-- the map comes back unchanged, so a re-run is a no-op.
create or replace function public.ship_colour_renamed(c text)
returns text
language sql
immutable
as $$
  select case c
    when '#8af4ff' then '#35e6ff'  -- Ice        -> Signal Cyan
    when '#ecf6ff' then '#ffffff'  -- Hull White -> Nova White
    when '#9db4d6' then '#1a9dff'  -- Gunmetal   -> Azure
    when '#7c8cff' then '#8a72ff'  -- Ion Blue
    when '#b98cff' then '#c957ff'  -- Nebula
    when '#ff7edb' then '#ff2bd6'  -- Magenta
    when '#ff6b7d' then '#ff3b30'  -- Warning Red
    when '#ff9d4d' then '#ff7a1a'  -- Ember
    when '#ffd166' then '#ff7a1a'  -- Solar      -> Ember
    when '#b6ff6a' then '#a8ff1f'  -- Acid
    when '#4dffb4' then '#1affb0'  -- Mint
    else c
  end;
$$;

update public.profiles
   set ship_nose   = public.ship_colour_renamed(ship_nose),
       ship_window = public.ship_colour_renamed(ship_window),
       ship_body   = public.ship_colour_renamed(ship_body),
       ship_fire   = public.ship_colour_renamed(ship_fire)
 where ship_nose   is distinct from public.ship_colour_renamed(ship_nose)
    or ship_window is distinct from public.ship_colour_renamed(ship_window)
    or ship_body   is distinct from public.ship_colour_renamed(ship_body)
    or ship_fire   is distinct from public.ship_colour_renamed(ship_fire);

alter table public.profiles
  add constraint profiles_ship_nose_allowed   check (public.ship_colour_allowed(ship_nose)),
  add constraint profiles_ship_window_allowed check (public.ship_colour_allowed(ship_window)),
  add constraint profiles_ship_body_allowed   check (public.ship_colour_allowed(ship_body)),
  add constraint profiles_ship_fire_allowed   check (public.ship_colour_allowed(ship_fire));

create or replace function public.set_ship_paint(
  p_nose text, p_window text, p_body text, p_fire text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- An empty string means "back to the shipped default" and is stored as
  -- NULL. No other validation here on purpose: the CHECK constraints above
  -- are the rule, and duplicating them in this function is how the two drift
  -- apart. One statement, so a half-saved ship cannot exist.
  update public.profiles
     set ship_nose   = nullif(lower(btrim(coalesce(p_nose,   ''))), ''),
         ship_window = nullif(lower(btrim(coalesce(p_window, ''))), ''),
         ship_body   = nullif(lower(btrim(coalesce(p_body,   ''))), ''),
         ship_fire   = nullif(lower(btrim(coalesce(p_fire,   ''))), '')
   where id = auth.uid();
end;
$$;

revoke execute on function public.set_ship_paint(text, text, text, text) from anon, public;
grant  execute on function public.set_ship_paint(text, text, text, text) to authenticated;

-- ===========================================================================
-- Verification - run these after the script and read the answers.
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public';                    -- both must be true
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' order by tablename; -- SELECT + INSERT only
--
--   select * from public.leaderboard limit 5;        -- empty, no error
-- ===========================================================================
