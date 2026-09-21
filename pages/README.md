# `pages/` - the GitHub Pages redirect stub

**This folder is not the game.** The game is the repo root, and it is served
from <https://skyhookplay.com/> by Fly (`Dockerfile`, `fly.toml`).

`pages/` is the two-file site that GitHub Pages publishes instead of a second
copy of the game, so that every link ever shared as
<https://leopechnicki.github.io/skyhook/> keeps resolving to the real home.

| File | What it is for |
|---|---|
| `index.html` | The root of the old Pages site. Redirects to `https://skyhookplay.com/`, **carrying the query string and the hash** so `?seed=123` and a Supabase auth callback both survive. |
| `404.html` | Everything that is not the root. Same redirect, and it carries the sub-path through too, so an old deep link lands on its counterpart. |
| `.nojekyll` | Stops GitHub running Jekyll over the folder. Nothing here needs it and Jekyll is one more thing that can go wrong between a push and a live page. |
| `README.md` | This file. **Not published** - the `pages-stub` job copies the three files above by name, so the retired URL serves the redirect and nothing else. |

## Why this is not just `gh api -X DELETE .../pages`

Deleting Pages makes every already-shared `github.io` link a hard 404. Links
live in other people's messages, bookmarks and Discord history; they cannot be
recalled. A redirect stub costs nothing to host and keeps them all working, and
its `<link rel=canonical>` hands the old URL's search ranking to the new one
rather than throwing it away.

## Publishing

`pages/` is the source of truth **on `main`**. CI (`.github/workflows/deploy.yml`,
job `pages-stub`) mirrors it to the `gh-pages` branch on every push to main.

Pointing GitHub Pages at that branch is a **repo-settings change and cannot be
done from CI**. See `docs/DEPLOY.md`, "Retiring the Pages mirror", for the exact
click path.

## Editing

Both HTML files contain the same inline redirect script. `test/pages_stub.mjs`
executes both of them against fake locations and fails if they behave
differently, so the duplication cannot silently rot - but if you change one,
change the other in the same commit.
