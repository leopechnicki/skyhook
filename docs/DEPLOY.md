# Deploying SKYHOOK

SKYHOOK is a folder of static files. It is served today from GitHub Pages and
is being moved to **Fly.io**, app `skyhook`, region `ams` - the same pattern
already running for `leopechnicki/safirdj`.

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

## What is NOT done, and needs Leo

Three things, none of which an agent can or should do on its own:

1. **The Fly app does not exist.** `fly apps create` bills to an account.
2. **There is no `FLY_API_TOKEN` secret** on `leopechnicki/skyhook`, and no
   Fly access token on this machine, so `flyctl` here is unauthenticated.
3. **No custom domain has been bought.** Nothing in this repo hardcodes one -
   see "Custom domain" below for the one line that changes when it exists.

### The exact commands

Run these once, from anywhere with `flyctl` and `gh` logged in:

```sh
# 1. Create the app. The name must match `app` in fly.toml.
fly apps create skyhook --org personal

# 2. Mint a deploy-scoped token (NOT a personal access token) and copy it.
fly tokens create deploy -x 8760h

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
at <https://skyhook.fly.dev>, not merely that `flyctl` exited zero.

### Custom domain, when it exists

```sh
fly certs add skyhook.example.com          # Fly prints the DNS records to add
fly certs show skyhook.example.com         # poll until it says Ready
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
