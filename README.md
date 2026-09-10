# SKYHOOK

A one-touch neon climbing arcade game. Fly a rocket: tether it to a planet or a star, swing, then fire the thruster to let go and latch onto the next body. The climb is endless -- as long as you stay on screen.

**[▶ Play it here](https://leopechnicki.github.io/skyhook/)** — no install, works on desktop and mobile.

<p align="center">
  <img src="docs/screenshot-title.png" alt="SKYHOOK title screen" width="240">
  <img src="docs/screenshot-playing.png" alt="SKYHOOK gameplay: swinging between nodes with a x9 combo" width="240">
  <img src="docs/screenshot-gameover.png" alt="SKYHOOK game over screen" width="240">
</p>

## Concept

Your rocket orbits a celestial body on a tether. Tap (or press Space) to fire the thruster and release -- you fly in a straight line and automatically latch onto the next body you pass near. The hull always points along your velocity, so the launch vector is readable off the ship itself. Miss everything and you drift off the screen, which is the only way the run can end.

**Gravity is real (ish).** Every body has a *mass* and a *radius*, and the orbit is derived from them rather than from one global speed:

```
mu    = G * mass                 standard gravitational parameter
omega = sqrt(mu / r^3)           orbital angular rate  (Kepler)
v     = sqrt(mu / r)  = omega*r  the speed you leave with
```

The relations are the real ones; only the constants are tuned. Consequences you can feel: a **star** (high mass, drawn large, big latch ring) spins you faster *and* slings you roughly 1.6x further than a **planet** (low mass, small, gentle). The tighter you catch a body, the faster it spins you. Every body's circle, latch ring and orbit width scale with its radius, so mass is readable at a glance.

**Core mechanics:**

- **Hook** -- Release at the right angle to aim at the next node. Closer latches ("tight hooks") score more and build your combo multiplier (up to x9).
- **Swing** -- While orbiting, your direction and timing determine where you launch. The single input (tap/space) is all you have.
- **Climb** -- The camera only ever climbs, so the bottom of the screen is a ratchet: every hook permanently raises the floor beneath you. The higher you go the heavier the sky gets -- stars become more frequent and more massive, so the release window keeps tightening. Amber planets burn out on a timer -- don't linger.

**Hazards:**

- **Falling off the screen** -- The only fail condition. Leave the column sideways, or drop through the bottom of the view, and the run ends. There is no timer of any kind: idling on an orbit is safe forever, it just scores nothing.
- **Stars** -- Not a hazard by themselves, but the fastest way to become one. They throw you far enough to overshoot the column if you release late.
- **Meteoroids** -- Tumbling rogue rocks, trailing fire, that appear from about the 12th body up. They sit *off* the direct line between two bodies (bobbing on a small arc), so a clean release is always safe -- only a sloppy wide swing or a greedy detour for a shard clips one.
- **Amber planets** -- Decaying bodies that crumble after ~1.5 seconds, forcing an early release.

**Scoring:**

- Tight hook (latch within 57% of the body's ring): 15 points x combo x mass bonus
- Loose hook: 8 points x combo x mass bonus (combo drops if you latch past 85% of the ring)
- Mass bonus: `1 + (mass - 1) * 0.22`, so a heavy star pays roughly 1.5x a planet
- Gold shard: 25 points x half-combo, and +1 combo

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
| `css/style.css` | 112 | Layout only (all game visuals are canvas-drawn) |
| `js/utils.js` | 145 | Math helpers, PRNG, localStorage wrapper, particle system, glow sprites |
| `js/audio.js` | 159 | Fully synthesized audio via Web Audio API (no sample files) |
| `js/celestial.js` | 879 | Body ART only: planet formation classes, spectral star colours, meteoroid rocks. Sprite-cached, zero physics |
| `js/rocket.js` | 396 | Player ART only: hull sprite, heading, thruster plume. Sprite-cached, zero physics |
| `js/game.js` | ~1770 | Core game: celestial bodies, gravity, orbiting, flying, latching, meteoroids, shards, rendering |
| `js/main.js` | 176 | Bootstrap: canvas fitting, input handling (pointer + keyboard), main loop |
| `test/smoke.mjs` | 372 | Playwright end-to-end smoke test (25 checks) |
| `test/balance.mjs` | 532 | Headless difficulty/balance harness (no browser) |
| `test/world.mjs` | 185 | Golden world-stream gate: proves an art change did not move the simulation |

Runtime dependencies: none. The only dev dependency is Playwright, and only for the smoke test.

## Tests

```
npm install          # only needed once, pulls Playwright for the smoke test
npx playwright install chromium

npm run test:smoke     # node test/smoke.mjs          - 25 end-to-end checks
npm run test:headed    # node test/smoke.mjs --headed - watch the bot play
npm run test:balance   # node test/balance.mjs        - difficulty sweep
npm run test:world     # node test/world.mjs          - golden world stream (fast, pass/fail)
npm run test:art       # node test/art_shots.mjs      - planet/star/meteoroid contact sheets
npm run test:rocket    # node test/rocket_shots.mjs   - rocket orientation + thruster + frame time
npm run shots          # node test/shipping_shots.mjs - regenerate README + og:image shots
```

`test/world.mjs` is the gate that keeps an art pass honest. Everything visual is
generated from one seeded RNG chain, so a single stray `rand()` taken for a visual
detail would silently regenerate the whole world. It records every body, hazard and
shard for four seeds into a golden fixture and asserts byte-equality, which is a
faster and stronger statement than re-running the balance sweep.

`test/smoke.mjs` spins up a local HTTP server, boots the game in a real browser (Google Chrome if installed, otherwise Playwright's bundled Chromium), runs an in-page bot that plays through the real input path, and verifies the full lifecycle: title screen, gameplay (hooks, scoring, combos), game over, restart, localStorage persistence, mute toggle, keyboard (SPACE starts a run and fires the thruster, M mutes), ad slot hidden and ad-code-free, mobile viewport, `file://` protocol, and a clean console. It writes screenshots to `test/screenshots/` (git-ignored).

`test/balance.mjs` loads the real game logic into a DOM stub and simulates hundreds of runs at fixed 60 Hz across four synthetic skill profiles, then prints score distributions, death causes, and run lengths. It is a reporting tool, not a pass/fail gate.

## Browser support

Any browser with Canvas 2D and Web Audio API (Chrome, Firefox, Safari, Edge -- all modern versions). Designed mobile-first with `touch-action: none` and `viewport-fit=cover` for fullscreen on iOS. Falls back gracefully when localStorage is unavailable (e.g. `file://` on some Chromium builds).

## License

MIT -- see [LICENSE](LICENSE).
