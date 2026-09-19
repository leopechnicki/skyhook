# Deploying SKYHOOK

SKYHOOK is a folder of static files. It is served from **Fly.io**, app
`skyhook-game`, region `ams` - the same pattern already running for
`leopechnicki/safirdj`. The app name is `skyhook-game` and not `skyhook`
because Fly app names are one global namespace and `skyhook` was taken; that
is stated here, in the first sentence, because this is the paragraph somebody
copies a command out of.

GitHub Pages still serves the same commit at
<https://leopechnicki.github.io/skyhook/>. That is deliberate for now - it is
a free fallback while Fly is new - but it is not free of consequence: see
"Two live origins" below.

Netlify is not used and must never be reintroduced.

---

## What is already done

Everything that lives in the repo:

| File | What it does |
|---|---|
| `Dockerfile` | Copies the game into `nginx:1.27-alpine`. No build step, no bundler. Pre-gzips `js/` and `css/` at image-build time. |
| `conf/site.conf.template` | The nginx server block. Health endpoint, compression, cache policy, real 404s, and the `SITE_ORIGIN` rewrite. |
| `conf/404.html` | A 404 page that looks like the game instead of like nginx. |
| `fly.toml` | App name, region, port, health check, machine size. |
| `.dockerignore` | Keeps the test suite, docs and `node_modules` out of the build context. |
| `.github/workflows/deploy.yml` | Test suite -> container smoke test -> `flyctl deploy --remote-only` on push to `main`. |

The deploy job is **gated on the `FLY_API_TOKEN` secret**. Until that secret
exists the workflow still runs the tests and still builds and curls the
container - it just skips the deploy and prints the commands below into the
run summary. Nothing is broken and nothing needs editing.

## Provisioning status

Done, 2026-09-18:

1. **The Fly app exists.** `skyhook-game`, org `personal`, region `ams`. The
   name is `skyhook-game` and not `skyhook` because `skyhook` was already
   taken - Fly app names are a single global namespace, not per-account.
2. **`FLY_API_TOKEN` is set** on `leopechnicki/skyhook`. It is a
   *deploy-scoped* token bound to this one app with a 1-year expiry, not a
   personal access token: if it leaked, the worst it can do is redeploy this
   game.
3. **No custom domain.** Deliberate - Leo has not picked a name. Nothing in
   this repo hardcodes one; see "Custom domain" below for the single line that
   changes when it exists.

### Reproducing it from scratch

If the app is ever destroyed, or a second environment is wanted:

```sh
# 1. Create the app. The name must match `app` in fly.toml.
fly apps create skyhook-game --org personal

# 2. Mint a deploy-scoped token (NOT a personal access token) and copy it.
fly tokens create deploy -a skyhook-game -x 8760h

# 3. Hand it to GitHub Actions. Paste the token when prompted.
gh secret set FLY_API_TOKEN --repo leopechnicki/skyhook
```

Then either push anything to `main`, or trigger the workflow by hand:

```sh
gh workflow run deploy.yml --repo leopechnicki/skyhook
```

The first deploy takes a few minutes (Fly's remote builder has a cold cache).
When it finishes the workflow asserts the live site itself - `/health`, the
page, and every asset - so a green tick means the game is genuinely playable
at <https://skyhook-game.fly.dev>, not merely that `flyctl` exited zero.

### Custom domain, when it exists

**`skyhook.com` is not available and is not worth chasing.** Checked
2026-09-18: registered since 2003, held by Skyhook Wireless through
MarkMonitor - a corporate brand-protection registrar. That is not a domain
that lapses or sells to a hobby project, so no plan in this repo assumes it.
Any other name works identically; the point of `SITE_ORIGIN` is that the game
does not care which one it turns out to be.

```sh
fly certs add skyhook.example.com          # Fly prints the DNS records to add
fly certs show skyhook.example.com         # poll until it says Ready
```

#### What is attached today - and why none of it resolves

`fly certs list -a skyhook-game` is **not empty**, which is misleading unless
the rest is written down. Verified 2026-09-19:

| Hostname on the app | Cert status | Does the domain exist? |
|---|---|---|
| `skyhook.run` | Not verified | **No.** Registry RDAP returns `404 Object not found` and the name has no NS records. |
| `www.skyhook.run` | Not verified | **No** - same unregistered name. |
| `skyhook.pechnicki.com` | Not verified | Parent yes, this host no. `pechnicki.com` is Leo's (GoDaddy, `*.domaincontrol.com` NS); no record for this subdomain exists yet. |

So three certs were added with `fly certs add` **before anything was bought**.
Fly will hold a cert request for a domain that does not exist; it simply never
verifies. They cost nothing and serve nothing, and they are the reason
`certs list` can look like a custom domain is half-configured when in fact
**no domain has been purchased.**

`skyhook.run` and `skyhook.game` are both unregistered and therefore buyable.
`skyhook.gg` is taken - it answers with Route 53 nameservers and serves no
site, i.e. somebody else is parking it.

The cheapest real option needs no purchase at all: **`skyhook.pechnicki.com`**,
on a domain Leo already owns. One CNAME at GoDaddy plus the ownership record
`fly certs setup` prints, and the cert that is already requested verifies by
itself.

To drop the dead ones:

```sh
fly certs remove skyhook.run     -a skyhook-game
fly certs remove www.skyhook.run -a skyhook-game
```

Then change **one line** in `fly.toml`:

```toml
[env]
  SITE_ORIGIN = 'https://skyhook.example.com'
```

That variable is the only place the public hostname appears in the whole
deployment. `conf/site.conf.template` uses it to rewrite `<link rel=canonical>`,
`og:url` and `og:image` in `index.html` at serve time, which is how the repo
avoids hardcoding a hostname without acquiring a build step. Its default is the
GitHub Pages origin already written into `index.html`, so with no override the
rewrite is a no-op and the page is byte-identical to the repo.

---

## Two live origins

Both of these serve SKYHOOK from the same commit right now:

| Origin | Served by | `<link rel=canonical>` it reports |
|---|---|---|
| <https://skyhook-game.fly.dev/> | Fly (this Dockerfile) | `https://skyhook-game.fly.dev/` - rewritten by `sub_filter` |
| <https://leopechnicki.github.io/skyhook/> | GitHub Pages, source `main:/` | `https://leopechnicki.github.io/skyhook/` - the literal in the repo |

Two origins each claiming to be canonical is not a crash, and while Fly is new
the Pages copy is a genuinely useful fallback. It is also not a stable resting
place: it splits any inbound links, and the day the two commits differ, a
player following an old link plays a different build than the one being
tested.

The decision is Leo's, and it is a one-liner either way:

```sh
# Option A - Fly is the site. Turn Pages off; the fly.dev URL stands alone.
gh api -X DELETE repos/leopechnicki/skyhook/pages

# Option B - Pages stays as the advertised home. Then SITE_ORIGIN should be
# set to the Pages URL so Fly stops claiming canonical, and Fly becomes a
# mirror rather than a second front door.
```

Until that is decided, `README.md` and `package.json:homepage` continue to
point at Pages, because that is still where the published link goes. They move
in the same change that resolves this, not before - a README that advertises a
URL nobody has agreed on is the worse of the two errors.

---

## Design notes

### Why nginx and not Node

safirdj runs `node server.js` because it has a `/ical-proxy` endpoint and a
calendar to fetch. SKYHOOK has neither. Putting Node in front of static files
would add a runtime dependency, a `npm install` in the image, and a process
that can crash, in exchange for nothing.

### Why the 404 is a real 404

The reflex for a single-page app is `try_files $uri /index.html`, which serves
the app for every unknown path. SKYHOOK is one page, not a routed SPA: it reads
no path, has no routes, and `?seed=N` is a query string, which nginx never
touches. Falling back to the game would return HTTP 200 and a playable game at
`/anything-at-all`, telling crawlers the site has unlimited duplicate pages.

### Why nothing is cached `immutable`

Asset filenames are not content-hashed, because content hashing needs a build
step and this project's whole pitch is that it does not have one. So:

* `index.html` - `no-cache`. It names every other file; a stale copy of it is
  the one stale copy that matters. ETag makes the revalidation a 304.
* `js/`, `css/` - `max-age=600, must-revalidate`.
* images - `max-age=86400`.

A deploy is therefore fully live within ten minutes for a returning player and
immediately for a new one. If that ever becomes the bottleneck, the fix is
content-hashed filenames, which means accepting a build step - a real trade to
make deliberately, not a header to loosen.

### What the container smoke test covers that the game tests do not

`test.yml` proves the game works. It says nothing about whether the thing nginx
hands to a browser *is* that game. The `image` job in `deploy.yml` asserts, on a
real running container: the page is served, every script tag it references
resolves, `SITE_ORIGIN` genuinely reached the HTML, `js/game.js` arrives
gzipped, an unknown path is a 404 carrying our own page, and `test/`,
`package.json` and `supabase/schema.sql` are **not** publicly reachable.

### Security headers

`X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` are set.
There is deliberately **no `Content-Security-Policy` yet**: the game currently
loads zero third-party script, so a CSP would pass trivially today and then be
the first thing to break - silently, at runtime, in a player's browser - the
day a rewarded-video SDK is added. It should be written together with that SDK,
against its real domain list, and tested in the container job.

---

## Rolling back

```sh
fly releases --app skyhook            # find the version that was good
fly deploy --image <image-ref-from-that-release> --app skyhook
```

GitHub Pages is untouched by any of this and keeps serving the last commit to
`main`, so it remains a working fallback for as long as it is enabled.
