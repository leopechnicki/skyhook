# The staging site

<https://skyhook-staging.fly.dev/>

A second Fly app, `skyhook-staging`, region `ams`. Every branch that is not
`main` deploys to it automatically, so a change can be played on a real URL
before it is allowed anywhere near <https://skyhookplay.com>.

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

## How a branch becomes a URL

```
push to any branch except main
  -> tests (the whole suite, called from test.yml)
  -> container build + serve checks, for BOTH variants
  -> flyctl deploy --remote-only --config fly.staging.toml
  -> curl the live site: /health, the game, every asset,
     the Supabase project ref, robots.txt, X-Robots-Tag
  -> the URL is printed into the run summary
```

The staging URL is always the same - <https://skyhook-staging.fly.dev/> -
because it is one app that gets redeployed, not a URL per branch. Whatever was
pushed most recently is what is there. `flyctl status -a skyhook-staging` and
the run summary both say which commit.

Deploys are serialised on the app (`concurrency: fly-skyhook-staging`,
`cancel-in-progress: false`), so two branches pushed a minute apart queue
rather than race for the single machine.

To redeploy without pushing: **Actions -> deploy -> Run workflow**, and pick
the branch.

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

Without that secret the `staging` job prints those three commands into the run
summary and skips - the same shape as the production `preflight` gate. Nothing
goes red for a missing credential.

---

## Cost

`auto_stop_machines = 'stop'`, `min_machines_running = 0`, one shared CPU,
256 MB. A machine exists while somebody has the tab open and stops itself
afterwards; the next request cold-starts it in a few hundred ms. Idle cost is
the disk the image sits on.

---

## What CI proves, and where

| Check | Where |
|---|---|
| The flag is in the staging config and reachable at runtime | `test/staging.mjs` |
| `submitRun` refuses, and does not queue | `test/staging.mjs` |
| Reads still work (the backend is not just switched off) | `test/staging.mjs` |
| Production still POSTs scores | `test/staging.mjs` |
| `main` and a branch cannot reach each other's deploy job | `test/staging.mjs` |
| Every `${VAR}` in the nginx template has a default | `test/staging.mjs` |
| The overlay actually lands in the built image | `deploy.yml`, `image` job |
| Production's image did not pick the overlay up | `deploy.yml`, `image` job |
| A misspelled `SKYHOOK_ENV` fails the build | `deploy.yml`, `image` job |
| The **live** staging site is on its own project and unindexed | `deploy.yml`, `staging` job |

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

There is nothing to roll back. Push the branch you want to look at, or run the
workflow on `main` - staging is disposable by construction, which is the point
of having it.
