# SKYHOOK

A one-touch neon climbing arcade game. Hook onto nodes, swing on your tether, release to fly upward, and latch onto the next node before the rising rift consumes you.

**[▶ Play it here](https://leopechnicki.github.io/skyhook/)** — no install, works on desktop and mobile.

<p align="center">
  <img src="docs/screenshot-title.png" alt="SKYHOOK title screen" width="240">
  <img src="docs/screenshot-playing.png" alt="SKYHOOK gameplay: swinging between nodes with a x9 combo" width="240">
  <img src="docs/screenshot-gameover.png" alt="SKYHOOK game over screen" width="240">
</p>

## Concept

You orbit a glowing node on a tether. Tap (or press Space) to release -- you fly in a straight line and automatically latch onto the next node you pass near. Miss, and the rising rift swallows you.

**Core mechanics:**

- **Hook** -- Release at the right angle to aim at the next node. Closer latches ("tight hooks") score more and build your combo multiplier (up to x9).
- **Swing** -- While orbiting, your direction and timing determine where you launch. The single input (tap/space) is all you have.
- **Climb** -- The rift rises faster the higher you go. Gold shards push it back. Amber nodes burn out on a timer -- don't linger.

**Hazards:**

- **The Rift** -- A rising wall of energy that accelerates over time. If it catches you, the run ends.
- **Mines** -- Red spiked orbs that appear from about the 12th node up. They sit *off* the direct line between two nodes (bobbing on a small arc), so a clean release is always safe -- only a sloppy wide swing or a greedy detour for a shard clips one.
- **Amber nodes** -- Decaying nodes that crumble after ~1.5 seconds, forcing an early release.
- **Drift timeout** -- If you fly for more than 1.5 seconds without hooking, your tether loses charge.

**Scoring:**

- Tight hook (close latch): 15 points x combo
- Loose hook: 8 points x combo (combo resets if too sloppy)
- Gold shard: 25 points x half-combo, plus pushes the rift back

## Controls

| Input | Action |
|---|---|
| Tap / click anywhere | Release the tether (and start / restart a run) |
| `Space`, `Enter`, `W`, `↑` | Release the tether |
| `M` | Toggle mute |

Add `?seed=123` to the URL to replay a deterministic layout.

## How to run locally

Open `index.html` in any modern browser. That's it.

No build step, no dependencies, no server required. The game uses plain `<script>` tags (not ES modules) specifically so it works when opened directly from disk via `file://` protocol. All audio is synthesized at runtime via Web Audio API -- there are no asset files to load.

```
# Option A: just double-click index.html

# Option B: use a local server (if you want localStorage to work reliably)
npx serve .
# then open http://localhost:3000
```

## How to deploy

SKYHOOK is a fully static site -- four JS files, one CSS file, one HTML file. No server-side logic.

**GitHub Pages** (how the live build above is hosted):
1. Push this folder to a GitHub repo.
2. Settings > Pages > Source: Deploy from a branch > `main` / `/ (root)`.
3. The game is live at `https://<user>.github.io/<repo>/`.

**Netlify:**
1. Drag-and-drop this folder onto [app.netlify.com/drop](https://app.netlify.com/drop).
2. Done. No build command needed.

**itch.io:**
1. Zip the contents of this folder (index.html at the root of the zip).
2. Upload to [itch.io](https://itch.io) as an HTML game.
3. Set viewport dimensions to 480x880 (the game's logical resolution).

**Any static host:** Upload `index.html`, `css/`, and `js/` to any web server or CDN. No configuration needed.

## Ad slot

The game ships with **no ads and no ad-network code**. There is a single reserved
mount point -- the `<aside id="ad-slot">` element at the bottom of `index.html` --
and it is **hidden by default** (`#ad-slot { display: none; }` in `css/style.css`),
so the shipped game shows no empty banner furniture.

To activate a banner later:

1. Delete the `#ad-slot { display: none; }` rule in `css/style.css`.
2. Put your ad unit markup inside `#ad-slot-inner`.
3. Add the ad network's loader script at the bottom of `<body>`, after the game scripts.

The slot then reserves a fixed height (54px on mobile, 96px on wide screens), so the
banner appears with zero layout shift (CLS). It is the only place an ad unit should
ever be inserted -- no publisher IDs, no external scripts, and nothing tracking-related
exists anywhere else in the codebase.

## Architecture

| File | Lines | Purpose |
|---|---|---|
| `index.html` | 71 | Shell: canvas, ad slot, script loading |
| `css/style.css` | 116 | Layout only (all game visuals are canvas-drawn) |
| `js/utils.js` | 145 | Math helpers, PRNG, localStorage wrapper, particle system, glow sprites |
| `js/audio.js` | 159 | Fully synthesized audio via Web Audio API (no sample files) |
| `js/game.js` | 1050 | Core game: nodes, orbiting, flying, latching, rift, mines, shards, rendering |
| `js/main.js` | 142 | Bootstrap: canvas fitting, input handling (pointer + keyboard), main loop |
| `test/smoke.mjs` | 309 | Playwright end-to-end smoke test (21 checks) |
| `test/balance.mjs` | 153 | Headless difficulty/balance harness (no browser) |

Runtime dependencies: none. The only dev dependency is Playwright, and only for the smoke test.

## Tests

```
npm install          # only needed once, pulls Playwright for the smoke test
npx playwright install chromium

npm run test:smoke     # node test/smoke.mjs          - 21 end-to-end checks
npm run test:headed    # node test/smoke.mjs --headed - watch the bot play
npm run test:balance   # node test/balance.mjs        - difficulty sweep
```

`test/smoke.mjs` spins up a local HTTP server, boots the game in a real browser (Google Chrome if installed, otherwise Playwright's bundled Chromium), runs an in-page bot that plays through the real input path, and verifies the full lifecycle: title screen, gameplay (hooks, scoring, combos), game over, restart, localStorage persistence, mute toggle, ad slot hidden and ad-code-free, mobile viewport, `file://` protocol, and a clean console. It writes screenshots to `test/screenshots/` (git-ignored).

`test/balance.mjs` loads the real game logic into a DOM stub and simulates hundreds of runs at fixed 60 Hz across four synthetic skill profiles, then prints score distributions, death causes, and run lengths. It is a reporting tool, not a pass/fail gate.

## Browser support

Any browser with Canvas 2D and Web Audio API (Chrome, Firefox, Safari, Edge -- all modern versions). Designed mobile-first with `touch-action: none` and `viewport-fit=cover` for fullscreen on iOS. Falls back gracefully when localStorage is unavailable (e.g. `file://` on some Chromium builds).

## License

MIT -- see [LICENSE](LICENSE).
