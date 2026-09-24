# The staging site

<https://skyhook-staging.fly.dev/>

A second Fly app, `skyhook-staging`, region `ams`, where a branch can be played
on a real URL before it is allowed anywhere near <https://skyhookplay.com>.

**Staging is OFF by default and comes up only when asked** (Leo, 2026-09-24:
"let's only make staging up when need test some new feature"). Nothing
deploys to it on a push. It is brought up on one branch, tested, and turned
off again:

```sh
# up - put a branch on https://skyhook-staging.fly.dev/
gh workflow run staging.yml -R leopechnicki/skyhook -f action=up -f branch=<branch>

# down - zero machines, nothing served, nothing billed for compute
gh workflow run staging.yml -R leopechnicki/skyhook -f action=down
```

Or, with no terminal: **GitHub -> Actions -> staging -> Run workflow**, pick
`up` or `down`, type the branch, press the green button.

Production is untouched by all of this: `main` still deploys to `skyhook-game`
through `fly.toml`, exactly as it did before, and no branch can reach that app.

---

## The one thing worth understanding

**Staging has its own Supabase project. Its database starts empty.**

Your production account does not exist on staging. Signing in with it will
fail; testing staging means **signing up on staging**. That is expected, not a
bug - and it is the whole point.

### What changed on 2026-09-23

Staging used to share production's Supabase project, and bought its safety with
a single flag: `readOnlyScores: true`, which `js/online.js` honours by refusing
to submit a score. That blocked exactly one write.

A score is not the only write the game makes. Signing up created a *real
production account*. Changing a username renamed a *real production profile*.
The account-settings work is precisely a feature whose writes are not scores,
so testing it against the shared project meant editing production rows to find
out whether the editor worked.

Leo created a second project (Central EU / Frankfurt, free tier).
`supabase/schema.sql` was applied to it whole, so staging has its own tables,
its own RLS policies, its own triggers and its own leaderboard view - the same
schema from the same file, and none of the data.

`readOnlyScores` is now **false** on staging. The flag existed to protect
production's board; staging owns its board, so refusing to write would only
mean the leaderboard could never be tested end to end.

| On staging | Works? |
|---|---|
| Read the leaderboard | Yes - staging's own, starts empty |
| Sign up | Yes - and you must, your production account is not here |
| Sign in, sign out | Yes, with a staging account |
| Password recovery | Yes |
| Change username / password | Yes - against a staging profile |
| **Write a score** | **Yes - to staging's board** |

### The half that is not in this repo

Applying `supabase/schema.sql` gives staging the right tables, policies and
triggers. It does not give it the right **auth settings**, because those live
in the Supabase project and in no file here - and a project created from the
dashboard defaults gets these:

| Setting | New-project default | What it does to a tester |
|---|---|---|
| `MAILER_AUTOCONFIRM` | `false` | Sign-up returns no session. The player is told to check an inbox for a mail the built-in SMTP (2/hour) will probably never deliver. |
| `SITE_URL` | `http://localhost:3000` | Every confirmation and recovery link points at a port on the tester's own machine. |
| `URI_ALLOW_LIST` | empty | `redirect_to` is ignored, so the game cannot even send them back to the page they started on. |

Production hit the first of these on 2026-09-17 and turned autoconfirm ON.
Staging was created on 2026-09-23, after that lesson, and inherited the
default anyway - so on the day it went up the schema was right, the image was
right, the deploy was green, and signing up did nothing. Sign-in, the account
panel, the ship colour and the leaderboard all sit behind sign-up, so all four
were unreachable while every gate in this repo was passing.

Staging now matches production, with staging's own URL:

```
MAILER_AUTOCONFIRM = true
SITE_URL           = https://skyhook-staging.fly.dev/
URI_ALLOW_LIST     = https://skyhook-staging.fly.dev/**
```

`deploy.yml` re-checks the first and the sign-up switch against the LIVE
project on every staging deploy, using the anon key out of the served config -
public by design, so no secret is needed and the gate works on a fork. A
staging project that quietly goes back to wanting confirmations is a red build
now, not a confused tester.

### The guard is off, not gone

`js/online.js` still reads and honours `readOnlyScores`, and `test/staging.mjs`
still proves the guard works - against a fixture that forces it on, rather than
against the live config where it is off. A guard only ever exercised in the
configuration that disables it is a guard nobody is testing.

That matters because the safety property is now an *implication*, not a
constant:

```
staging is NOT production's project  =>  staging may write freely
staging IS  production's project     =>  staging MUST be read-only
```

`test/staging.mjs` pins that implication, and the deploy workflow re-checks it
against the served artefact and again against the live site. Pointing staging
back at production without turning the flag on is a red build, not a quiet
accident. So is shipping a staging URL with production's anon key - the key's
`ref` claim is decoded and compared, because a production key under a staging
URL is still a `role: anon` key and a role check alone cannot see it.

### What this does not protect against

Nothing here is a secret, and nothing here is a sandbox. The anon key is public
by design and RLS in `supabase/schema.sql` decides what it may do, on staging
exactly as on production. The separation is between two **databases**, not
between a trusted and an untrusted client.
---

## How a branch becomes a URL (on demand)

`.github/workflows/staging.yml`, `workflow_dispatch` only - no push, no
pull_request, no schedule. `test/staging.mjs` fails the build if any of those
triggers is ever added back, and fails it if `deploy.yml` starts deploying
staging again.

```
action=up, branch=<branch>
  -> the branch can build an ISOLATED staging image?  (fly.staging.toml names
     skyhook-staging, the Dockerfile honours SKYHOOK_ENV, staging/config.staging.js
     names a project that is not production's) - refused before any build if not
  -> flyctl deploy --remote-only --ha=false --config fly.staging.toml -a skyhook-staging
     (from zero machines this creates the one machine it needs)
  -> curl the live site: /health, the game, every asset, the Supabase project
     ref, production's ref nowhere in it, sign-up yields a session,
     robots.txt, X-Robots-Tag, no production canonical
  -> any of those fails: staging is scaled straight back to zero
  -> the URL is printed into the run summary

action=down
  -> flyctl scale count 0 -a skyhook-staging
  -> assert 0 machines, and that the URL no longer serves the game
```

The staging URL is always the same - <https://skyhook-staging.fly.dev/> -
because it is one app that gets redeployed, not a URL per branch. Whatever was
brought up most recently is what is there; the run summary says which branch
and commit.

Tests are not re-run by `up`: the branch's own CI (test.yml on its PR, and
the `image` job in deploy.yml, which builds and checks the staging variant on
every PR) already did that. `up` is a deploy, and its gates are the ones only a
deploy can check.

**Old branches.** A branch cut before the staging pipeline existed cannot build
a staging image - its Dockerfile ignores `SKYHOOK_ENV` and would build the
production image, pointed at production's database. `up` refuses it with
"merge main into '<branch>' first". Merge main, push, run `up` again.

**Down is zero, not asleep.** An idle machine already stops itself, but a
stopped machine with `auto_start_machines` on wakes for the next request - any
crawler or old link brings the game back. `scale count 0` removes the machines
and keeps everything else: the app, its IPs, its certificate, its release
history and this config. Coming back is the `up` action; nothing is recreated.

Operations are serialised on the app (`concurrency: fly-skyhook-staging`,
`cancel-in-progress: false`), so an `up` and a `down` pressed a moment apart
queue rather than race.

---

## How the two images differ

One build argument, and nothing else.

```sh
docker build .                                  # production
docker build --build-arg SKYHOOK_ENV=staging .  # staging
```

A build argument rather than a runtime environment variable on purpose: a
runtime flag is a flag production can be started with by mistake, whereas a
build that did not pass `SKYHOOK_ENV=staging` has no staging bytes in it at
all. Any value other than `production` or `staging` fails the build.

| | production | staging |
|---|---|---|
| `js/config.js` | `js/config.js` | overlaid with `staging/config.staging.js` |
| Supabase project | `ievfcqnyrekdixxbsite` | `qlaenczyhzjkmqkraiup` (its own) |
| `readOnlyScores` | absent | `false` |
| `SITE_ORIGIN` | `https://skyhookplay.com` | `https://skyhook-staging.fly.dev` |
| `X-Robots-Tag` | `all` (the documented no-op) | `noindex, nofollow` |
| `/robots.txt` | 404 | `Disallow: /` |
| Banner | none | orange `STAGING - separate database ...` |
| Fly app | `skyhook-game` | `skyhook-staging` |
| Config file | `fly.toml` | `fly.staging.toml` |
| Secret | `FLY_API_TOKEN` | `FLY_STAGING_API_TOKEN` |

Three independent noindex signals, because "the staging copy of the game
outranked the game" is not a mistake that can be undone quickly: the
`X-Robots-Tag` header (needs no JavaScript), `robots.txt`, and a `noindex`
meta tag injected by the staging config.

The banner is `pointer-events: none`. This game is played by tapping anywhere
on the screen, and a banner that could swallow the first tap would make
staging behave differently from production - the one thing a staging site must
not do.

---

## Credentials

Two Fly tokens, and they are not interchangeable. Both are **deploy-scoped**,
which on Fly means bound to exactly one app:

| Secret | Can redeploy | Cannot |
|---|---|---|
| `FLY_API_TOKEN` | `skyhook-game` | anything else |
| `FLY_STAGING_API_TOKEN` | `skyhook-staging` | anything else |

Reusing one token for both would have been one fewer secret and would also
have meant every feature branch in the repo held a credential for the app
serving skyhookplay.com.

Reproducing the staging half from scratch:

```sh
fly apps create skyhook-staging --org personal
fly tokens create deploy -a skyhook-staging -x 8760h   # copy the output
gh secret set FLY_STAGING_API_TOKEN --repo leopechnicki/skyhook
```

Without that secret the `up` job fails on its first step and says so. It is
only ever run by hand, so a red run that names the missing secret is the
useful answer, not a skipped one.

---

## Cost

**Down (the default): zero.** No machine exists, so there is no compute and no
machine rootfs to bill. What remains is the app record, its IPs and its
certificate, which Fly does not charge for on this account.

**Up:** one shared CPU, 256 MB, `auto_stop_machines = 'stop'`,
`min_machines_running = 0` - even while up, the machine stops itself when
nobody has the tab open and cold-starts in a few hundred ms. Turn it `down`
when the feature is tested.

**The staging Supabase project** (`qlaenczyhzjkmqkraiup`, org `skyhook`) is on
the **Free** plan: $0. It is deliberately left in place while the Fly app is
down - deleting it would mean re-applying the schema and re-doing the auth
settings below on every `up`. Supabase pauses a Free project after about a
week with no traffic. If `up` fails with "the staging Supabase project did not
answer /auth/v1/settings", that is what happened: Supabase dashboard ->
skyhook-staging -> **Restore project**, wait for it to report healthy, run `up`
again.

---

## What CI proves, and where

| Check | Where |
|---|---|
| The flag is in the staging config and reachable at runtime | `test/staging.mjs` |
| `submitRun` refuses, and does not queue | `test/staging.mjs` |
| Reads still work (the backend is not just switched off) | `test/staging.mjs` |
| Production still POSTs scores | `test/staging.mjs` |
| Production deploys only from `main`; staging only on a manual `workflow_dispatch`, never on push | `test/staging.mjs` |
| `down` scales to zero and proves it; nothing can destroy the app | `test/staging.mjs` |
| Every `${VAR}` in the nginx template has a default | `test/staging.mjs` |
| The overlay actually lands in the built image | `deploy.yml`, `image` job |
| Production's image did not pick the overlay up | `deploy.yml`, `image` job |
| A misspelled `SKYHOOK_ENV` fails the build | `deploy.yml`, `image` job |
| A branch that would build the production image is refused before `up` builds | `staging.yml`, `up` job |
| The **live** staging site is on its own project and unindexed | `staging.yml`, `up` job |
| After `down`: 0 machines and the URL no longer serves the game | `staging.yml`, `down` job |

`test/staging.mjs` runs in the cheap `logic` job, so it gates every PR rather
than only the ones that reach a deploy.

---

## The dedicated staging project (done 2026-09-23)

This section used to describe a plan. It has been carried out, and it went
exactly as written: the two strings at the top of `staging/config.staging.js`
changed and `readOnlyScores` went to `false`. The implication-shaped test did
its job - it needed relaxing in one place (the assertion that the flag is
literally `true`) and the invariant itself was not touched.

What was done, in order:

1. `supabase/schema.sql` applied **whole** to the new project, then applied a
   second time to confirm the idempotence the file claims.
2. Verified against `pg_policies` and `information_schema.column_privileges`:
   RLS on for `profiles` and `scores`, `profiles_update_own`, the column-level
   `grant update (username)` and nothing wider, the `profiles_rename_guard`
   trigger, the `scores_rate_limit` trigger, the `on_auth_user_created` trigger
   and the `leaderboard` view.
3. Proved isolation with a live probe: a score written to staging's board
   through the public anon key appeared on staging's leaderboard and did **not**
   appear on production's. The probe account was then deleted, so staging's
   database is empty again.

### Still outstanding

`https://skyhook-staging.fly.dev` must be added to the **auth redirect
allow-list** of the staging project (Dashboard -> Authentication -> URL
Configuration). Without it, password-recovery links and any OAuth return leg
will bounce on staging. This needs dashboard access and cannot be done from the
repo. Email/password sign-up and sign-in work without it.

---

## Rolling back staging

There is nothing to roll back. Run `up` on the branch you want to look at, or
on `main` - staging is disposable by construction, which is the point of having
it. And when you are finished, run `down`.
