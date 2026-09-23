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
--   * Everything above stops a FORGED run. None of it stops a bot that
--     actually plays the game and submits the genuine run it played - that
--     run passes every constraint honestly. Section 3b answers that one, and
--     answers it by FLAGGING, not rejecting: a flagged run stays in the
--     ledger, drops off the public board, and waits for a human to look.
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

-- Bot review columns (section 3b). Added with IF NOT EXISTS so re-running the
-- file on a live project migrates it in place; every run already on the board
-- lands as flagged = false, because there is no telemetry to judge it by.
alter table public.scores add column if not exists telemetry    jsonb;
alter table public.scores add column if not exists flagged      boolean not null default false;
alter table public.scores add column if not exists flag_reasons text[]  not null default '{}';

-- The client sends at most 400 release offsets - a few KB. Anything much
-- bigger did not come from the game and is not worth storing.
alter table public.scores drop constraint if exists scores_telemetry_size;
alter table public.scores add constraint scores_telemetry_size
  check (telemetry is null or octet_length(telemetry::text) <= 16384);

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
  -- Counted against the CALLER, not against whatever user_id the body
  -- carries: that value is overwritten below, so counting it let a client
  -- dodge this limit by naming somebody else's id in the POST.
  select count(*) into recent
    from public.scores
   where user_id = coalesce(auth.uid(), new.user_id)
     and created_at > now() - interval '60 seconds';

  if recent >= 10 then
    raise exception 'rate limit: too many scores submitted, try again in a minute'
      using errcode = '54000';
  end if;

  -- Daily cap. The per-minute limit still allows 14,400 runs a day, which is
  -- a search budget: a bot can play thousands of runs and keep the best.
  -- 500 a day is several hours of back-to-back human play, and cuts that
  -- budget ~29x. Its own error code so the client can say the true thing
  -- ("come back tomorrow") instead of "wait a minute".
  select count(*) into recent
    from public.scores
   where user_id = coalesce(auth.uid(), new.user_id)
     and created_at > now() - interval '24 hours';

  if recent >= 500 then
    raise exception 'daily limit: too many scores submitted today, try again tomorrow'
      using errcode = 'SKDAY';
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
-- 3b. Bot review - flag, never reject, never delete
-- ---------------------------------------------------------------------------
-- The game attaches a small telemetry object to every run (js/game.js
-- _teleRelease, sent by js/online.js payloadFor):
--
--   { v, hz, n, syn, rel, miss, forced, off: [int, ...] }
--     n       inputs that reached the game during the run
--     syn     of those, how many were NOT real browser input events
--             (dispatchEvent, __SKYHOOK.tap(), a script)
--     rel     manual releases; miss = releases that were not going to latch
--     forced  releases forced by a decay anchor
--     off     per manual release: offset in sim ticks (1/120 s) from the
--             frame-perfect release for the body it latched. Negative = early.
--
-- The rules, and why each one is safe for a human:
--   synthetic_input     a person's finger or key is always isTrusted. Only a
--                       script produces an untrusted event.
--   telemetry_mismatch  every hook after the first needs a release, and every
--                       release needs an input. hooks > rel + forced + 1, or
--                       rel > n, cannot come out of the game.
--   superhuman_timing   of the releases within +-6 ticks (50 ms) of optimal,
--                       90%+ landed within +-1 tick (8 ms), over 25+ releases.
--                       test/bot.js (public, in the repo) lands there on
--                       98-100% of runs. A modelled human with 12 ms of timing
--                       spread - already a ~10k-point player - tops out at
--                       0.84; documented human coincidence-timing spread is
--                       20-40 ms. test/botdef.mjs pins both numbers.
--   no_telemetry        a run without it is either a client older than this
--                       file or a hand-made POST. Held for review, not refused.
--
-- A flagged run is INSERTED, kept in the ledger, and simply not shown on the
-- public board. The trigger overwrites whatever flagged / flag_reasons the
-- client sent. Clearing a flag is a dashboard action (see the review queue
-- at the end of this file) - no client can do it.
--
-- What this does NOT stop: all of the telemetry is produced by the client,
-- so a bot author who reads this file can forge it. What forging it costs
-- them is the point - to pass, the bot must release with human-sized timing
-- error, and in this game timing error IS score (see test/botdef.mjs: the
-- same player loses most of its points going from 8 ms to 20 ms of spread).

create or replace function public.scores_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tel     jsonb := new.telemetry;
  reasons text[] := '{}';
  n_in    numeric;
  n_syn   numeric;
  n_rel   numeric;
  n_force numeric;
  graded  integer := 0;
  core    integer := 0;
begin
  if tel is null or jsonb_typeof(tel) <> 'object' then
    reasons := array_append(reasons, 'no_telemetry');
  else
    begin
      n_in    := coalesce((tel ->> 'n')::numeric, 0);
      n_syn   := coalesce((tel ->> 'syn')::numeric, 0);
      n_rel   := coalesce((tel ->> 'rel')::numeric, 0);
      n_force := coalesce((tel ->> 'forced')::numeric, 0);

      select count(*) filter (where abs(v) <= 6),
             count(*) filter (where abs(v) <= 1)
        into graded, core
        from (select (e #>> '{}')::numeric as v
                from jsonb_array_elements(coalesce(tel -> 'off', '[]'::jsonb)) e
               limit 400) x;

      if n_syn > 0 then
        reasons := array_append(reasons, 'synthetic_input');
      end if;
      if new.hooks > n_rel + n_force + 1 or n_rel > n_in then
        reasons := array_append(reasons, 'telemetry_mismatch');
      end if;
      if graded >= 25 and core >= 0.9 * graded then
        reasons := array_append(reasons, 'superhuman_timing');
      end if;
    exception when others then
      -- Wrong types, a non-array `off`, numbers too large to cast: the
      -- telemetry did not come from the game. Flag, do not refuse the row.
      reasons := array_append(reasons, 'telemetry_malformed');
    end;
  end if;

  new.flag_reasons := reasons;
  new.flagged := cardinality(reasons) > 0;
  return new;
end;
$$;

drop trigger if exists scores_review_trg on public.scores;
create trigger scores_review_trg
  before insert on public.scores
  for each row execute function public.scores_review();

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
   -- Flagged runs stay in the ledger and off the board. A player with a
   -- flagged best still shows with their best UNflagged run, if any.
   where not s.flagged
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
-- 8. Review queue - dashboard only
-- ---------------------------------------------------------------------------
-- Every flagged run, newest first, with the reasons. For the SQL editor in
-- the Supabase dashboard (which runs as the owner); revoked from the public
-- roles so PostgREST does not serve it. No email: username only.
--
--   select * from public.scores_review_queue;
--
--   -- A flag that was wrong: put the run back on the board. The reasons are
--   -- kept, so the record of why it was held survives the decision.
--   update public.scores set flagged = false where id = <id>;

create or replace view public.scores_review_queue
with (security_invoker = on)
as
select s.id, p.username, s.score, s.hooks, s.altitude, s.duration_ms,
       s.flag_reasons, s.telemetry, s.created_at
  from public.scores s
  join public.profiles p on p.id = s.user_id
 where s.flagged
 order by s.created_at desc;

revoke all on public.scores_review_queue from anon, authenticated;

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
