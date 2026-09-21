# Deploying SKYHOOK

SKYHOOK is a folder of static files. It is served from **Fly.io**, app
`skyhook-game`, region `ams` - the same pattern already running for
`leopechnicki/safirdj`. The app name is `skyhook-game` and not `skyhook`
because Fly app names are one global namespace and `skyhook` was taken; that
is stated here, in the first sentence, because this is the paragraph somebody
copies a command out of.

The advertised home is <https://skyhookplay.com/>, served by Fly. GitHub Pages
still serves the same commit at <https://leopechnicki.github.io/skyhook/> as a
free fallback, but it is not free of consequence: see "Two live origins" below.

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
3. **The custom domain exists.** `skyhookplay.com`, bought on GoDaddy
   2026-09-19. Fly certs are requested for it and for `www.`; both read
   *Not verified* until the DNS records below are added. See "Custom domain"
   for the records and for the one line in `fly.toml` that depends on them.

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

### Custom domain

The domain is **`skyhookplay.com`**, registered on **GoDaddy** on 2026-09-19.
Nameservers are `ns65.domaincontrol.com` / `ns66.domaincontrol.com`, i.e. the
zone is edited in the GoDaddy DNS panel and nowhere else.

(`skyhook.com` was never an option: registered since 2003, held by Skyhook
Wireless through MarkMonitor. `skyhookplay.com` is the name that was actually
bought, and it is the only one this repo refers to.)

#### DNS records to add at GoDaddy

GoDaddy ships a new zone with a parked `A @` and a `CNAME www -> @`. The parked
A records are **replaced**, not appended to - as of 2026-09-19 the apex still
answers `76.223.105.230` / `13.248.243.5`, which is GoDaddy's parking page.

| Type | Name | Value | Note |
|---|---|---|---|
| `A` | `@` | `66.241.124.247` | Fly shared IPv4 ingress. Delete both parked A records first. |
| `AAAA` | `@` | `2a09:8280:1::192:edd5:0` | Fly **dedicated** IPv6 for `skyhook-game`. Not optional - see below. |
| `CNAME` | `www` | `@` | Already present by default. Leave it: once the apex points at Fly, `www` follows. |

The `AAAA` record is what makes the cert verify without extra steps. The IPv4
address is *shared* across many Fly apps, so an A record alone does not prove
which app owns the name; the IPv6 address is dedicated to `skyhook-game`, so
pointing at it is the proof. Skip the AAAA and Fly instead demands
`TXT _fly-ownership.skyhookplay.com -> app-lzwjdg3`.

If a cert is wanted *before* traffic is cut over, the ACME challenge route
works too and needs no A/AAAA at all:

```
CNAME _acme-challenge.skyhookplay.com     -> skyhookplay.com.lzwjdg3.flydns.net.
CNAME _acme-challenge.www.skyhookplay.com -> www.skyhookplay.com.lzwjdg3.flydns.net.
```

`www` can also be pointed straight at the app with
`CNAME www -> lzwjdg3.skyhook-game.fly.dev` instead of at `@`. Either is
correct; `@` is one fewer record to maintain if the IPs ever change.

#### Cert status, and how to check it

```sh
fly certs list -a skyhook-game                   # both hostnames, one line each
fly certs check skyhookplay.com -a skyhook-game  # force a re-check after a DNS edit
fly certs show  skyhookplay.com -a skyhook-game  # what Fly is still waiting for
fly certs setup skyhookplay.com -a skyhook-game  # re-print the records above
```

As of 2026-09-19:

| Hostname | Cert status | Blocked on |
|---|---|---|
| `skyhookplay.com` | Not verified | The `A`/`AAAA` records above. Apex still resolves to GoDaddy parking. |
| `www.skyhookplay.com` | Not verified | Follows the apex, via the default `CNAME www -> @`. |

The three certs that used to sit on this app - `skyhook.run`, `www.skyhook.run`
and `skyhook.pechnicki.com` - were added before any domain was bought, never
verified, and were **removed on 2026-09-19**. `fly certs list` now shows the two
`skyhookplay.com` entries and nothing else. If a fourth ever reappears,
somebody added a cert for a name that does not exist; remove it.

#### The one line that depends on all of this

```toml
[env]
  SITE_ORIGIN = 'https://skyhookplay.com'
```

That variable is the only place the public hostname appears in the whole
deployment. `conf/site.conf.template` uses it to rewrite `<link rel=canonical>`,
`og:url` and `og:image` in `index.html` at serve time, which is how the repo
avoids hardcoding a hostname without acquiring a build step. Its default is the
GitHub Pages origin already written into `index.html`, so with no override the
rewrite is a no-op and the page is byte-identical to the repo.

**Deploying that value before the cert is Ready is the failure mode to avoid.**
The game would still be served perfectly well on `skyhook-game.fly.dev`, but
every copy of the page would declare itself canonical at a hostname that does
not resolve - which is worse than claiming the wrong origin, because a crawler
that cannot reach the canonical target may drop the page entirely. Confirm
`fly certs check skyhookplay.com -a skyhook-game` reports **Ready** first.

---

## Two live origins

Both of these serve SKYHOOK from the same commit right now:

| Origin | Served by | `<link rel=canonical>` it reports |
|---|---|---|
| <https://skyhookplay.com/> | Fly (this Dockerfile) - the advertised home | `https://skyhookplay.com/` - `SITE_ORIGIN`, rewritten by `sub_filter` |
| <https://skyhook-game.fly.dev/> | Fly (this Dockerfile) | `https://skyhookplay.com/` - the same rewrite; the app answers on both names |
| <https://leopechnicki.github.io/skyhook/> | GitHub Pages, source `main:/` | `https://leopechnicki.github.io/skyhook/` - the literal in the repo |

Buying `skyhookplay.com` settles which name *should* win but does not on its own
close this down to one origin. Fly serves the game under both the custom domain
and `skyhook-game.fly.dev`, which is harmless - one canonical is declared and it
names the custom domain. GitHub Pages is the one that genuinely competes: it
serves a second copy that declares *itself* canonical. That splits inbound links,
and the day the two commits differ a player following an old link plays a
different build than the one being tested.

The decision is Leo's:

```sh
# Option A - skyhookplay.com is the site. Turn Pages off once the cert is Ready.
gh api -X DELETE repos/leopechnicki/skyhook/pages

# Option B - Pages stays as a mirror. Then it should carry a canonical pointing
# at skyhookplay.com rather than at itself, which means editing index.html - and
# index.html's github.io literal is exactly what conf/site.conf.template rewrites
# against, so that edit is not free. Option A is the cheaper end state.
```

Until that is decided, `README.md` and `package.json:homepage` continue to
point at Pages, because that is still where the published link goes and
`skyhookplay.com` does not resolve yet. They move to `https://skyhookplay.com/`
in the same change that resolves this, not before - a README that advertises a
URL that 404s is the worse of the two errors.

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
