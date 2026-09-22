# The staging site

<https://skyhook-staging.fly.dev/>

A second Fly app, `skyhook-staging`, region `ams`. Every branch that is not
`main` deploys to it automatically, so a change can be played on a real URL
before it is allowed anywhere near <https://skyhookplay.com>.

Production is untouched by all of this: `main` still deploys to `skyhook-game`
through `fly.toml`, exactly as it did before, and no branch can reach that app.

---

## The one thing worth understanding

**A run played on staging is never written to the leaderboard.**

Staging talks to the *production* Supabase project. That is a deliberate
choice, not an oversight, and the isolation is aimed narrowly at the thing
that actually matters.

### Why the same project

A separate Supabase project is the textbook answer and was the first choice.
It is not available:

* The only credential this repo has is a **project-scoped** personal access
  token (`~/skyhook_supabase.local.txt`, expires 2026-09-28).
  `GET /v1/organizations` returns `[]` with it, so it cannot create a project.
  Creating one is an account-level action Leo would have to take by hand.
* And once created it would be a second stack - schema, RLS policies, auth
  settings, email templates, the OAuth redirect allow-list - that drifts from
  the first one silently, with nothing in CI comparing them.

### Why it is safe anyway

`public.leaderboard` is a **view** over `public.scores` joined to `profiles`
(`supabase/schema.sql`, section 6). A user with no row in `scores` has no row
on the board: no rank, no entry, nothing rendered.

So blocking the one `INSERT` into `scores` is sufficient to keep the visible
leaderboard clean - and it leaves everything else working against real data:

| On staging | Works? |
|---|---|
| Read the leaderboard | Yes |
| Sign up, sign in, sign out | Yes |
| Password recovery, Google OAuth | Yes |
| `my_rank()`, profile row | Yes |
| **Write a score** | **No - refused, and not queued** |

That is what makes the staging site worth deploying. A staging build with the
backend switched off could not test a leaderboard feature at all, which is
most of what is currently being built.

### Where it is enforced

`js/online.js`, in `submitRun()` - the single function every score that has
ever reached the board went through. A check any higher up is a check a future
call site can forget to make.

The run is **dropped, not queued**. Queueing is what every other failure path
does, and here it would be exactly wrong: a queued run is a run waiting for a
session that *can* write, and no such moment may ever arrive for a score
rolled on staging. `test/staging.mjs` fails the build if that changes.

### What this does not protect against

A tester who opens devtools and calls PostgREST by hand can still write a
score - the anon key and the RLS policies are the production ones. That is
accepted: the tester is Leo. This guards against the accident, not its author.

---

## How a branch becomes a URL

```
push to any branch except main
  -> tests (the whole suite, called from test.yml)
  -> container build + serve checks, for BOTH variants
  -> flyctl deploy --remote-only --config fly.staging.toml
  -> curl the live site: /health, the game, every asset,
     readOnlyScores, robots.txt, X-Robots-Tag
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
| `readOnlyScores` | absent | `true` |
| `SITE_ORIGIN` | `https://skyhookplay.com` | `https://skyhook-staging.fly.dev` |
| `X-Robots-Tag` | `all` (the documented no-op) | `noindex, nofollow` |
| `/robots.txt` | 404 | `Disallow: /` |
| Banner | none | orange `STAGING - scores are not saved` |
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
| The **live** staging site is read-only and unindexed | `deploy.yml`, `staging` job |

`test/staging.mjs` runs in the cheap `logic` job, so it gates every PR rather
than only the ones that reach a deploy.

---

## If a dedicated staging Supabase project is ever created

Change the two strings at the top of `staging/config.staging.js` and set
`readOnlyScores: false`. Nothing else has to move: the test that pins the
read-only rule is written as an implication - *if staging points at
production's project, it must be read-only* - so a genuinely separate project
lifts the restriction instead of fighting it.

Apply `supabase/schema.sql` to the new project first, and add
`https://skyhook-staging.fly.dev` to its auth redirect allow-list.

---

## Rolling back staging

There is nothing to roll back. Push the branch you want to look at, or run the
workflow on `main` - staging is disposable by construction, which is the point
of having it.
