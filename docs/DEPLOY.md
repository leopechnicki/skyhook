# Deploying SKYHOOK

SKYHOOK is a folder of static files. It is served from **Fly.io**, app
`skyhook-game`, region `ams` - the same pattern already running for
`leopechnicki/safirdj`. The app name is `skyhook-game` and not `skyhook`
because Fly app names are one global namespace and `skyhook` was taken; that
is stated here, in the first sentence, because this is the paragraph somebody
copies a command out of.

The one home is <https://skyhookplay.com/>, served by Fly, and `index.html`
now says so itself - the canonical, `og:url`, `og:image` and `twitter:image`
tags name it directly instead of naming GitHub Pages and relying on nginx to
correct them on the way out. GitHub Pages is not switched off: it publishes a
two-file REDIRECT to the same place, so links already shared as
<https://leopechnicki.github.io/skyhook/> keep working. See "Retiring the Pages
mirror" below - it ends in one setting Leo has to flip by hand.

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
| `pages/` | The GitHub Pages redirect stub - two files, not the game. Published to the `gh-pages` branch by the `pages-stub` job so the retired `github.io` URL keeps working. See "Retiring the Pages mirror". |
| `test/pages_stub.mjs` | Asserts the one canonical origin: that `index.html`, `conf/site.conf.template`, the `Dockerfile` default and `fly.toml` all agree, and that the stub redirects with the query string and hash intact. |

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

`conf/site.conf.template` uses that variable to rewrite `<link rel=canonical>`,
`og:url` and `og:image` in `index.html` at serve time. **The rewrite is no longer
what makes production correct.** `index.html` declares `https://skyhookplay.com`
itself, the `Dockerfile` default and `fly.toml` both set the same string, so the
rewrite is an identity no-op on every path that matters and the served page is
byte-identical to the repo. What it still buys is the ability to serve the game
from somewhere that genuinely is not skyhookplay.com - a staging machine that
should not claim the canonical - without editing a tracked file.

Three files hold that one origin string and nothing in the language connects
them: `index.html` (the literal), `conf/site.conf.template` (the literal it
searches for) and the `Dockerfile` (the identity default). `test/pages_stub.mjs`
compares all three on every PR, and the `image` job in `deploy.yml` runs the
container with a **deliberately different** `SITE_ORIGIN` so that "the rewrite
happened" is an assertion that can still fail. Set CI to the production value
and that assertion passes even with `sub_filter` deleted.

**Deploying that value before the cert is Ready is the failure mode to avoid.**
The game would still be served perfectly well on `skyhook-game.fly.dev`, but
every copy of the page would declare itself canonical at a hostname that does
not resolve - which is worse than claiming the wrong origin, because a crawler
that cannot reach the canonical target may drop the page entirely. Confirm
`fly certs check skyhookplay.com -a skyhook-game` reports **Ready** first.

---

## Retiring the Pages mirror

`skyhookplay.com` is the single home. Three hostnames still answer, and only one
of them claims to be the site:

| Origin | Served by | `<link rel=canonical>` it reports |
|---|---|---|
| <https://skyhookplay.com/> | Fly (this Dockerfile) - the home | `https://skyhookplay.com/` - the literal in `index.html`, not a rewrite |
| <https://skyhook-game.fly.dev/> | Fly (this Dockerfile) | `https://skyhookplay.com/` - the same file; the app answers on both names |
| <https://leopechnicki.github.io/skyhook/> | GitHub Pages, publishing the `gh-pages` branch | nothing - it is a redirect to `https://skyhookplay.com/` |

### What was wrong before

Two problems, and only one of them was the obvious one.

1. **Pages served a second copy of the game that declared itself canonical.**
   That splits inbound links, and the day the two commits differ a player
   following an old link plays a different build than the one being tested.

2. **The repo declared the wrong home.** `index.html` named the GitHub Pages URL
   and `conf/site.conf.template` corrected it with `sub_filter` at serve time.
   That made the deployed page right and the *checked-in file* wrong, so
   anything serving the folder without nginx - a `file://` open, `npm start`,
   a fork, a crawler reading the raw file - advertised a URL being retired. A
   band-aid at the edge is not a canonical.

Both are fixed: `index.html` names `https://skyhookplay.com/` directly, and
`SITE_ORIGIN` is now an escape hatch rather than a correction.

### Why Pages is redirected and not deleted

The tempting one-liner is:

```sh
gh api -X DELETE repos/leopechnicki/skyhook/pages   # DO NOT
```

Every link already shared as `https://leopechnicki.github.io/skyhook/` lives in
somebody else's WhatsApp history, bookmarks and Discord scrollback. None of them
can be recalled, and deleting Pages turns all of them into a hard 404. A
redirect costs nothing to host, keeps them working, and its
`<link rel=canonical>` hands the old URL's accumulated ranking to the new one
instead of throwing it away.

So `pages/` (on `main`) holds a two-file site:

| File | Role |
|---|---|
| `pages/index.html` | The old site root. Redirects to `https://skyhookplay.com/`, **carrying the query string and the hash**. |
| `pages/404.html` | Every other path. The same redirect, carrying the sub-path through as well. |

The query and hash are the whole point. `?seed=123` selects a world, and a
Supabase auth callback arrives as `?code=...` (PKCE) or `#access_token=...`
(implicit / recovery). A redirect that drops either one looks like it works and
silently breaks sign-in. The stub therefore redirects with an inline
`location.replace()` **before** the `<meta http-equiv="refresh">`, because a
meta refresh cannot carry a query string; the meta tag is the no-JavaScript
fallback and the visible link is the fallback to that.
`test/pages_stub.mjs` executes the stub's own script against fake locations and
asserts each of those cases, rather than grepping the HTML and hoping.

### Publishing it

`.github/workflows/deploy.yml`, job `pages-stub`, force-pushes `pages/` to an
orphan `gh-pages` branch on every push to `main`. So the branch exists and stays
current automatically.

**One step is manual and CI cannot do it.** The Pages publishing source is a
repository setting; no workflow token can change it:

> **Settings > Pages > Build and deployment > Source: Deploy from a branch >
> Branch: `gh-pages` / `(root)` > Save**

Until that is flipped, Pages keeps publishing `main:/` - which after this change
is the game with a canonical pointing at `skyhookplay.com`. That is already the
correct signal to a crawler, just not yet a redirect for a human. Nothing is
broken in the interim; the flip is an improvement, not a repair.

### Supabase redirect allow-list

`leopechnicki.github.io/skyhook/` stays on the project's redirect allow-list
(`docs/LEADERBOARD_SETUP.md`) and must not be removed yet. A confirmation or
password-reset mail sent from the old origin before the cutover carries
`redirect_to=https://leopechnicki.github.io/skyhook/`, and GoTrue refuses a
`redirect_to` that is not allow-listed. Dropping the entry would break links
that are already in people's inboxes. Remove it only once links that old have
expired - the recovery link TTL is one hour, the signup confirmation longer.

`redirect_to` is derived from `location.origin + location.pathname`, never
hardcoded, which is what lets all three origins send a player back to the page
they actually started on. `test/online.mjs` section 14 asserts that for all
three and asserts they produce three *different* answers, so hardcoding the home
fails the build.

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

GitHub Pages is **not** a fallback for this. It publishes the redirect stub, not
the game, so a bad Fly release cannot be worked around by sending people to the
old URL - it sends them straight back. Roll the Fly release back instead; that
is the only lever, which is why the release history above matters.
