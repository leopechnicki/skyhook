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
--   * A player's own display name is the one column they may UPDATE directly.
--     Renaming needs a policy AND a grant, and both are written to be as
--     narrow as the operation actually is: your row, that one column. (Ship
--     paint, section 9, is also the player's own, but it is written only
--     through a checked RPC, never by a direct UPDATE.)
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
--   * When the human has looked and decided, section 11 gives the owner -
--     and only accounts listed in public.admins, checked server-side on
--     every call - a ban (reversible) and a delete (not), from in the game.
--
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles - the only identity the leaderboard needs
-- ---------------------------------------------------------------------------
-- One row per account, holding the display name - plus, added later, the
-- rename bookkeeping below and the ship paint in section 9, and nothing
-- personal. Leo's brief was explicit: username, email, password, no extra
-- profile fields. The email
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
-- section 5 sets both itself: `username_changed_at` is when the player's
-- current 24-hour rename window opened and `username_changes` is how many
-- renames it has used. They are readable, like every other column on this
-- table - none of it is a secret - but nothing in the client reads them today;
-- the limit is enforced, and reported, by the trigger alone.
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
-- 3c. Bans - an owner decision, enforced here and nowhere else
-- ---------------------------------------------------------------------------
-- Section 3b holds a suspicious RUN. A ban is about the ACCOUNT: the owner has
-- looked at it and decided it is a bot. One row per banned account, carrying
-- who banned it, when and why. Unbanning deletes the row; the record of both
-- decisions survives in public.admin_audit (section 11).
--
-- What a ban does:
--   * the account's runs drop off the public board and out of my_rank()
--     (section 7 filters on is_banned()), and come back on unban - nothing
--     is deleted, the ledger stays append-only;
--   * the account cannot submit another run: the trigger below refuses it
--     with its own SQLSTATE, SKBAN, so the game can say the true thing, and
--     a RESTRICTIVE policy in section 6 refuses it again should the trigger
--     ever be dropped.
--
-- Nobody but the SQL editor and the admin RPCs in section 11 can read or
-- write this table: RLS is on and no policy exists for any client role. The
-- one fact that IS public - "is this account banned" - is what the public
-- board already shows by omission, and is_banned() answers exactly that and
-- nothing else (not the reason, not who, not when).

create table if not exists public.bans (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  banned_by uuid,
  reason    text not null default '',
  banned_at timestamptz not null default now(),
  constraint bans_reason_len check (char_length(reason) <= 200)
);

alter table public.bans enable row level security;
revoke all on public.bans from anon, authenticated;

create or replace function public.is_banned(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.bans b where b.user_id = p_user);
$$;

revoke execute on function public.is_banned(uuid) from public;
grant  execute on function public.is_banned(uuid) to anon, authenticated;

-- Named so it sorts, and therefore fires, BEFORE scores_rate_limit_trg and
-- scores_review_trg: a banned account's run is refused before it can count
-- against a limit or be graded. It checks the CALLER, like the rate limit,
-- because the body's user_id is not trusted for anything.
create or replace function public.scores_ban_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_banned(coalesce(auth.uid(), new.user_id)) then
    raise exception 'banned: this account can no longer submit scores'
      using errcode = 'SKBAN';
  end if;
  return new;
end;
$$;

drop trigger if exists scores_ban_guard_trg on public.scores;
create trigger scores_ban_guard_trg
  before insert on public.scores
  for each row execute function public.scores_ban_guard();

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

  -- username_changed_at is the START of the current 24-hour window, not the
  -- time of the latest rename. It moves only when a new window opens. Moving
  -- it on every rename (as the first version did) made the window slide: a
  -- player renaming once every twenty hours never saw the count reset and was
  -- refused on the sixth rename in five days, told "five times today".
  if old.username_changed_at is null
     or old.username_changed_at < now() - interval '24 hours' then
    -- First rename, or the first one after the window closed: a new window.
    new.username_changes    := 1;
    new.username_changed_at := now();
  else
    if old.username_changes >= 5 then
      raise exception 'rename limit: a name can be changed 5 times a day'
        using errcode = '54000';
    end if;
    new.username_changes    := old.username_changes + 1;
    new.username_changed_at := old.username_changed_at;
  end if;

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

-- A banned account may not insert, whatever else allows it. RESTRICTIVE, so
-- it is ANDed with the policy above instead of ORed: a future permissive
-- insert policy cannot reopen the door. The trigger in section 3c refuses
-- first and with a clearer message; this is the belt for it.
drop policy if exists scores_insert_not_banned on public.scores;
create policy scores_insert_not_banned
  on public.scores as restrictive for insert
  to authenticated
  with check (not public.is_banned(auth.uid()));

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
   -- Flagged runs stay in the ledger and off the board. A player with a
   -- flagged best still shows with their best UNflagged run, if any.
   where not s.flagged
     -- A banned account is off the board entirely (section 3c), and back
     -- with every run intact the moment it is unbanned.
     and not public.is_banned(s.user_id)
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
-- 9. ship paint - the ship the player painted, one colour per part
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

-- ---------------------------------------------------------------------------
-- 10. Review queue - dashboard only
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

-- ---------------------------------------------------------------------------
-- 11. Moderation - owner-only ban / unban / delete, from inside the game
-- ---------------------------------------------------------------------------
-- The review queue (section 10) is the dashboard's tool. This section is the
-- in-game one: an admin looking at the leaderboard can ban an account, lift
-- the ban, or delete the account outright, without opening the SQL editor.
--
-- WHO IS AN ADMIN. A row in public.admins, and nothing else. There is no
-- client-side flag, no JWT claim, no user_metadata field: the client is
-- attacker-controlled, and anything it can say about itself it can forge.
-- Every function below starts by checking auth.uid() against this table,
-- server-side, inside the same call that does the work. The game asks
-- is_admin() only to decide whether to DRAW the controls; a forged "yes"
-- draws buttons whose every press is refused here.
--
-- Nobody can make themselves an admin through the API: RLS is on, there is
-- no policy, and every client grant is revoked. Adding or removing one is a
-- SQL-editor action:
--
--   insert into public.admins (user_id, note) values ('<uuid>', 'why');
--   delete from public.admins where user_id = '<uuid>';
--
-- THE ACTIONS, and their limits (each one refused with a clear error):
--   admin_ban_user(target, reason)  reversible. Section 3c describes what a
--                                   ban does. Re-banning updates the reason.
--   admin_unban_user(target)        lifts it. Every run comes back.
--   admin_delete_user(target)       NOT reversible. Deletes the auth account;
--                                   the foreign keys cascade to its profile,
--                                   every score, and any ban row.
--   An admin cannot ban or delete themselves, or another admin - demote
--   first, in the SQL editor, so that removing an owner is never one tap.
--
-- WHY DELETE IS A DATABASE FUNCTION AND NOT AN EDGE FUNCTION. Removing an
-- auth user needs a privileged identity. The Edge Function route means
-- deploying a second piece of code that holds the project's service key -
-- the master key that bypasses RLS on every table - and exposing it to the
-- internet behind our own auth check. The route taken here keeps that key
-- out of the picture: a SECURITY DEFINER function owned by the role that
-- runs this file, with its search_path pinned, checking the caller in the
-- same transaction as the delete, and writing the audit row in that same
-- transaction (so there is no deleted account without a record, and no
-- record of a delete that did not happen). It ships with the schema, through
-- the same one paste as everything else. Deleting from auth.users is what
-- the dashboard's own "Delete user" does; the auth tables that hang off it
-- (identities, sessions, refresh tokens) cascade the same way.
--
-- EVERY ACTION IS LOGGED in public.admin_audit: who, what, to whom (id and
-- the username at that moment, so a delete stays readable), why, when. The
-- log has no foreign keys on purpose - the account it describes may no
-- longer exist, and that is exactly the row worth keeping. Dashboard-only:
--
--   select * from public.admin_audit order by created_at desc;

create table if not exists public.admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  note     text not null default '',
  added_at timestamptz not null default now()
);

alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create table if not exists public.admin_audit (
  id              bigint generated always as identity primary key,
  admin_id        uuid not null,
  action          text not null,
  target_id       uuid not null,
  target_username text,
  reason          text not null default '',
  created_at      timestamptz not null default now(),
  constraint admin_audit_action check (action in ('ban', 'unban', 'delete'))
);

alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from anon, authenticated;

-- The owner: Leo's account on the production project. Seeded through
-- profiles rather than by a bare insert so the line is a no-op on any
-- project where that account does not exist (staging, a fresh project):
-- there it inserts nothing and fails nothing. Such a project seeds its own
-- admin by hand with the insert above.
insert into public.admins (user_id, note)
select p.id, 'owner (Leo)'
  from public.profiles p
 where p.id = 'e2391165-b83a-4dc8-849f-999b418aae3b'
on conflict (user_id) do nothing;

-- For the game: may I draw the moderation controls? False for anyone signed
-- out. Deciding to draw is ALL this is for - see above.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

revoke execute on function public.is_admin() from public;
grant  execute on function public.is_admin() to anon, authenticated;

-- The gate every admin function calls first. 42501 is insufficient_privilege,
-- which PostgREST answers as 403. Not callable by any client role on its own.
create or replace function public.admin_require()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'not allowed: admins only'
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.admin_require() from public, anon, authenticated;

-- The checks shared by ban and delete: a real target, not yourself, not an
-- admin. Returns the target's current username, for the audit row.
create or replace function public.admin_target(p_target uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uname text;
begin
  if p_target is null then
    raise exception 'no account given' using errcode = '22023';
  end if;
  if p_target = auth.uid() then
    raise exception 'you cannot do that to your own account' using errcode = '22023';
  end if;
  if exists (select 1 from public.admins a where a.user_id = p_target) then
    raise exception 'that account is an admin - remove it from admins first'
      using errcode = '22023';
  end if;
  select p.username into uname from public.profiles p where p.id = p_target;
  if not found then
    raise exception 'no such account' using errcode = 'P0002';
  end if;
  return uname;
end;
$$;

revoke execute on function public.admin_target(uuid) from public, anon, authenticated;

create or replace function public.admin_ban_user(target uuid, reason text default '')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uname text;
  why   text := left(btrim(coalesce(admin_ban_user.reason, '')), 200);
begin
  perform public.admin_require();
  uname := public.admin_target(admin_ban_user.target);

  insert into public.bans (user_id, banned_by, reason, banned_at)
  values (admin_ban_user.target, auth.uid(), why, now())
  on conflict (user_id) do update
     set banned_by = excluded.banned_by,
         reason    = excluded.reason,
         banned_at = excluded.banned_at;

  insert into public.admin_audit (admin_id, action, target_id, target_username, reason)
  values (auth.uid(), 'ban', admin_ban_user.target, uname, why);
end;
$$;

revoke execute on function public.admin_ban_user(uuid, text) from public, anon;
grant  execute on function public.admin_ban_user(uuid, text) to authenticated;

-- Returns whether a ban was actually lifted. Unbanning an account that is
-- not banned is not an error (two admins, or a double tap) - but it is
-- still an admin action, so it is still logged.
create or replace function public.admin_unban_user(target uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lifted integer;
  uname  text;
begin
  perform public.admin_require();
  if admin_unban_user.target is null then
    raise exception 'no account given' using errcode = '22023';
  end if;

  delete from public.bans b where b.user_id = admin_unban_user.target;
  get diagnostics lifted = row_count;

  select p.username into uname from public.profiles p where p.id = admin_unban_user.target;
  insert into public.admin_audit (admin_id, action, target_id, target_username, reason)
  values (auth.uid(), 'unban', admin_unban_user.target, uname,
          case when lifted > 0 then '' else 'was not banned' end);
  return lifted > 0;
end;
$$;

revoke execute on function public.admin_unban_user(uuid) from public, anon;
grant  execute on function public.admin_unban_user(uuid) to authenticated;

-- The one statement in this file that removes rows a player created. It is
-- reachable only through admin_require(), and it deletes the ACCOUNT - the
-- scores go with it by the foreign key's cascade, never by a delete aimed at
-- the ledger. The audit row is written first, in the same transaction: if
-- the delete fails, both roll back together.
create or replace function public.admin_delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uname text;
  gone  integer;
begin
  perform public.admin_require();
  uname := public.admin_target(admin_delete_user.target);

  insert into public.admin_audit (admin_id, action, target_id, target_username, reason)
  values (auth.uid(), 'delete', admin_delete_user.target, uname, '');

  delete from auth.users where id = target;
  get diagnostics gone = row_count;
  if gone <> 1 then
    raise exception 'no such account' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant  execute on function public.admin_delete_user(uuid) to authenticated;

-- What the game shows an admin instead of the public board: the same
-- ranking, plus the two things an admin needs and nobody else may see - the
-- account id to act on, and the banned accounts (which the public board
-- hides, and which an admin has to be able to find to unban). Banned rows
-- come last, unranked, with the best run they have, flagged or not.
create or replace function public.admin_board(p_limit integer default 50)
returns table (
  rank       bigint,
  user_id    uuid,
  username   text,
  score      integer,
  hooks      integer,
  altitude   integer,
  created_at timestamptz,
  banned     boolean,
  ban_reason text,
  is_admin   boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  perform public.admin_require();
  return query
  with best as (
    select distinct on (s.user_id)
           s.user_id, s.score, s.hooks, s.altitude, s.created_at,
           (b.user_id is not null) as banned, b.reason as ban_reason
      from public.scores s
      left join public.bans b on b.user_id = s.user_id
     where not s.flagged or b.user_id is not null
     order by s.user_id, s.score desc, s.created_at asc
  ), ranked as (
    select case when not x.banned
                then row_number() over (partition by x.banned
                                        order by x.score desc, x.created_at asc)
           end as rnk,
           x.*
      from best x
  )
  select r.rnk, r.user_id, p.username, r.score, r.hooks, r.altitude, r.created_at,
         r.banned, coalesce(r.ban_reason, ''),
         exists (select 1 from public.admins a where a.user_id = r.user_id)
    from ranked r
    join public.profiles p on p.id = r.user_id
   where r.banned or r.rnk <= least(greatest(coalesce(p_limit, 50), 1), 200)
   order by r.banned, r.rnk, r.score desc;
end;
$$;

revoke execute on function public.admin_board(integer) from public, anon;
grant  execute on function public.admin_board(integer) to authenticated;

-- ===========================================================================
-- Verification - run these after the script and read the answers.
--
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public';                    -- both must be true
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' order by tablename;
--     -- profiles: SELECT, INSERT, UPDATE.  scores: SELECT, INSERT (plus
--     -- the restrictive not-banned INSERT), and nothing else ever. bans,
--     -- admins, admin_audit: none at all.
--
--   select * from public.admins;                     -- the owner, on prod
--
--   select privilege_type, column_name from information_schema.column_privileges
--    where table_name = 'profiles' and grantee = 'authenticated'
--      and privilege_type = 'UPDATE';
--     -- exactly one row: UPDATE on username.
--
--   select * from public.leaderboard limit 5;        -- empty, no error
-- ===========================================================================
