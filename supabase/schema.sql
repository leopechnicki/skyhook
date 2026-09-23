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
--   * The single exception is a player's own display name. Renaming is an
--     UPDATE, so it needs a policy AND a grant, and both are written to be as
--     narrow as the operation actually is: your row, that one column.
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

-- Rename bookkeeping, added when players were given a way to change their
-- name. It is an ALTER rather than two more lines in the CREATE above because
-- the table already exists on the live project, where `create table if not
-- exists` does exactly nothing - a column added to that block would be a
-- change that only ever reaches a project nobody has yet.
--
-- Neither column is writable by a player: the grant at the bottom of this file
-- hands out UPDATE on `username` and on nothing else, and the trigger in
-- section 5 sets both itself. They are readable, like every other column on
-- this table - "when did this pilot last change their name" is not a secret,
-- and the UI uses it to say how many changes are left.
alter table public.profiles
  add column if not exists username_changed_at timestamptz;
alter table public.profiles
  add column if not exists username_changes integer not null default 0;

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
-- 5. Renames - the one UPDATE a player is allowed, and its limits
-- ---------------------------------------------------------------------------
-- A player may change their display name. Because the leaderboard is a VIEW
-- that joins this table (section 7), the new name appears on every one of
-- their past scores the moment this UPDATE commits: there is no copy of the
-- username on a score row and therefore nothing to backfill.
--
-- The rules below are in a trigger for the same reason the score rate limit
-- is: a trigger sits under every write path, so there is no request shape that
-- goes around it.
--
--   * Only the name moves. `id` IS the account and `created_at` is history.
--     The column grant at the bottom of this file is the real lock on those
--     two; forcing them back to their old values here is the belt for it.
--   * The shape CHECK and the case-insensitive unique index in section 1 apply
--     to an UPDATE exactly as they do to an INSERT, so a collision surfaces as
--     23505 on both paths and the client has one thing to handle, not two.
--   * Renaming is not free. Five changes a day is more than a person needs to
--     fix a typo and fewer than a script wants.
--
-- What this deliberately does NOT do is retire a released name. When a player
-- renames, their old name is immediately free and anyone may take it - by
-- renaming into it or by signing up with it. Holding names in quarantine would
-- mean a second table and a check on the signup path as well as this one, and
-- a bug there fails a SIGN-UP, which is a worse outcome than the squatting it
-- prevents on a board this size. The limit above is the part that was worth
-- having: it stops a script from watching for a name to come free.

-- security INVOKER, unlike its neighbour in section 3: this function reads and
-- writes nothing but the row already in front of it, so it needs no privilege
-- the caller does not have, and handing it the owner's rights would be a gift
-- with no purpose. search_path is still pinned - an unpinned one is a hijack
-- surface in any function, definer or not.
create or replace function public.profiles_rename_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Not the player's to edit, whatever the request body said.
  new.id         := old.id;
  new.created_at := old.created_at;

  -- An UPDATE that does not touch the name is not a rename and must not spend
  -- one of the day's changes. `is not distinct from` rather than `=` so a null
  -- on either side compares as data instead of poisoning the branch.
  if new.username is not distinct from old.username then
    new.username_changed_at := old.username_changed_at;
    new.username_changes    := old.username_changes;
    return new;
  end if;

  if old.username_changed_at is null
     or old.username_changed_at < now() - interval '24 hours' then
    -- First rename, or the first one in a fresh day: the window starts here.
    new.username_changes := 1;
  else
    if old.username_changes >= 5 then
      raise exception 'rename limit: a name can be changed 5 times a day'
        using errcode = '54000';
    end if;
    new.username_changes := old.username_changes + 1;
  end if;

  new.username_changed_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_rename_guard_trg on public.profiles;
create trigger profiles_rename_guard_trg
  before update on public.profiles
  for each row execute function public.profiles_rename_guard();

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

-- profiles: the world may read display names (that is what a leaderboard is).
-- A signed-in user may create their own row - which normally the trigger in
-- section 4 already did - may rename themselves, and may never touch anyone
-- else's row. There is no DELETE policy, so deleting a profile is denied to
-- everyone; an account goes away by deleting the auth.users row, which
-- cascades.
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

-- The rename. USING picks the row you are allowed to touch, WITH CHECK judges
-- the row you are trying to leave behind, and they say the same thing on
-- purpose: without the WITH CHECK half, a player could update their own row
-- into someone else's id and walk off with that account's scores.
--
-- This policy is half of the permission. The other half is the column grant at
-- the bottom of this file, and neither works alone: a policy with no grant is
-- refused at the privilege check before RLS is consulted (which is what this
-- project shipped with - the rename UI was written against a table that would
-- silently update nothing), and a grant with no policy is refused by RLS's
-- default deny.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
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

-- ...and then hand back the one column a rename needs, to the one role that
-- can own a row. A column-level grant is not decoration here: table-level
-- UPDATE would also let a player rewrite `username_changed_at` and
-- `username_changes`, which are the only record of how often they have
-- renamed, so the limit in section 5 would be a limit the limited party is
-- allowed to reset. It is stated AFTER the blanket revoke above, so a re-run
-- of this file top to bottom always ends in this state rather than in
-- whichever order the two happened to be applied.
grant update (username) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The public board
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
-- 8. my_rank() - what the game-over screen asks for
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
-- 8. ship_colour - the hull the player painted
-- ---------------------------------------------------------------------------
-- Cosmetic, and the only thing in this file that is. It lives on profiles
-- because it belongs to the ACCOUNT rather than to a run: the point of storing
-- it at all is that a ship painted on a laptop is painted on the phone too.
-- The game works with this column absent - js/ui_ship.js keeps the colour in
-- localStorage and treats every server answer as optional - so an unmigrated
-- project loses cross-device sync and nothing else.
--
-- TWO RULES, BOTH ENFORCED HERE RATHER THAN IN THE CLIENT
--
--   1. The menu is an ALLOW-LIST, and it is the same list js/ship.js shows.
--      The client is attacker-controlled, so "you cannot paint yourself
--      invisible" has to be a constraint, not a UI affordance. A colour off
--      this list is rejected by Postgres.
--
--   2. Champion gold (#ffc21a) is deliberately NOT on the list. Gold is a
--      rank, not a choice: the game paints it while the leaderboard says you
--      are #1 and never stores it, so there is nothing to forge. Writing gold
--      into your own row fails this constraint.
--
-- Note what is still true after this section, and what is NOT. Section 6 does
-- grant a player UPDATE on their own profile row - profiles_update_own plus
-- `grant update (username)` - because renaming yourself is a feature. That
-- grant is COLUMN-SCOPED and ship_colour is not in it, which is the whole
-- point: a player holding nothing but the anon key and their own session
-- still cannot write this column directly, because the grant that would let
-- them names only `username`. The only way to write ship_colour is the
-- security-definer function below, which writes auth.uid()'s row and no
-- other, and touches no other column - so it cannot be used to rename
-- anybody, including yourself, and the rename path cannot be used to repaint
-- anybody, including yourself. The two writes stay disjoint.

alter table public.profiles
  add column if not exists ship_colour text;

alter table public.profiles
  drop constraint if exists profiles_ship_colour_allowed;
alter table public.profiles
  add constraint profiles_ship_colour_allowed
  check (ship_colour is null or ship_colour in (
    '#35e6ff',  -- Signal Cyan (the default)
    '#8af4ff',  -- Ice
    '#ecf6ff',  -- Hull White
    '#9db4d6',  -- Gunmetal
    '#7c8cff',  -- Ion Blue
    '#b98cff',  -- Nebula
    '#ff7edb',  -- Magenta
    '#ff6b7d',  -- Warning Red
    '#ff9d4d',  -- Ember
    '#ffd166',  -- Solar
    '#b6ff6a',  -- Acid
    '#4dffb4'   -- Mint
  ));

create or replace function public.set_ship_colour(colour text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  want text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  want := lower(btrim(coalesce(colour, '')));

  -- An empty string means "back to the shipped default", which is stored as
  -- NULL rather than as a hex: the default is a property of the game, and
  -- writing today's default into every row would freeze it there.
  if want = '' then
    update public.profiles set ship_colour = null where id = auth.uid();
    return '';
  end if;

  -- No validation here on purpose. The CHECK constraint above is the rule,
  -- and duplicating it in this function is how the two drift apart.
  update public.profiles set ship_colour = want where id = auth.uid();
  return want;
end;
$$;

revoke execute on function public.set_ship_colour(text) from anon, public;
grant  execute on function public.set_ship_colour(text) to authenticated;

-- ===========================================================================
-- Verification - run these after the script and read the answers.
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public';                    -- both must be true
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' order by tablename;
--     -- profiles: SELECT, INSERT, UPDATE.  scores: SELECT, INSERT, and
--     -- nothing else ever.
--
--   select privilege_type, column_name from information_schema.column_privileges
--    where table_name = 'profiles' and grantee = 'authenticated';
--     -- exactly one row: UPDATE on username.
--
--   select * from public.leaderboard limit 5;        -- empty, no error
-- ===========================================================================
