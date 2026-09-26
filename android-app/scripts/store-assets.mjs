/*
 * store-assets.mjs - the Play Store listing art and the Android launcher /
 * splash images, generated FROM THE GAME'S OWN RENDERER, never pasted in.
 *
 * Why generated: the mipmaps and splash.png Capacitor scaffolds are its stock
 * placeholder (a blue cross on white), which is what a player would have seen
 * on the launcher and at every cold start. And the Play listing needs an icon
 * and a feature graphic at exact sizes. A hand-drawn PNG goes stale the day
 * the ship's silhouette changes; this script draws the real rocket with
 * SK.Rocket.draw and a real planet with SK.Celestial.drawBody from a page
 * that loaded the real index.html - the same code path the game uses - so the
 * store art is by construction what the game paints.
 *
 * Outputs (all overwritten):
 *   store-listing/icon-512.png                 Play "app icon", 512x512, 32-bit PNG, no alpha
 *   store-listing/feature-graphic-1024x500.jpg Play "feature graphic", 1024x500 JPEG (Play refuses a PNG with alpha here, and a canvas can only export RGBA PNG)
 *   android/app/src/main/res/mipmap-<density>/ic_launcher.png            48..192 legacy icon
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_round.png      48..192 legacy round icon
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png 108..432 adaptive foreground
 *   android/app/src/main/res/drawable(-<qualifier>)/splash.png                per-density splash (dark)
 *
 * Play's exact specs (verified 2026-09-25, support.google.com/googleplay/android-developer/answer/9866151):
 *   app icon        512 x 512 px, PNG (32-bit), max 1 MB, no transparency in the final icon
 *   feature graphic 1024 x 500 px, JPEG or 24-bit PNG (no alpha), max 15 MB
 *   phone shots     16:9 or 9:16, 320..3840 px on each side, 2-8 of them (taken from the emulator, not here)
 *
 * Run:  node scripts/store-assets.mjs        (from android-app/, needs the
 *       repo root's `npm ci` for playwright; no Android SDK needed)
 *       node scripts/store-assets.mjs --listing   only the two store-listing files,
 *       leaving res/ untouched (so a copy edit cannot dirty the icons the
 *       signed AAB was built with)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');                 // android-app/
const ROOT = path.resolve(APP, '..');                 // the game
const RES = path.join(APP, 'android', 'app', 'src', 'main', 'res');
const LISTING = path.join(APP, 'store-listing');

/* playwright is a devDependency of the GAME (test/*.mjs), not of this
   wrapper, so resolve it from the game's node_modules explicitly rather than
   hoping the two trees happen to share one. */
const requireFromGame = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = requireFromGame('playwright');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ------------------------------------------------------------------------
 * Everything below `render` runs IN THE PAGE. One function, one string, so
 * the icon, the feature graphic and the splash share the same background,
 * planet, rocket and tether helpers and cannot drift from each other.
 * ---------------------------------------------------------------------- */
function render(jobs) {
  const R = window.SK.Rocket, C = window.SK.Celestial;
  const TAU = Math.PI * 2;
  const BG = '#060713';
  const CYAN = '53,230,255';
  const CLOCK = 0.73;

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  }

  /* The title screen's own look: near-black navy, a soft cyan-violet glow
     somewhere off-centre, and three depths of stars. */
  function space(g, w, h, opts) {
    const o = opts || {};
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const gx = o.gx === undefined ? w * 0.5 : o.gx, gy = o.gy === undefined ? h * 0.45 : o.gy;
    const rad = g.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.75);
    rad.addColorStop(0, 'rgba(60,50,120,0.55)');
    rad.addColorStop(0.55, 'rgba(20,24,60,0.25)');
    rad.addColorStop(1, 'rgba(6,7,19,0)');
    g.fillStyle = rad; g.fillRect(0, 0, w, h);
    const r = rng(o.seed || 1337);
    const layers = [[0.0009, 1.0, 0.30], [0.0005, 1.7, 0.50], [0.0002, 2.6, 0.75]];
    for (const [density, size, alpha] of layers) {
      const n = Math.round(w * h * density * (o.starMul || 1));
      for (let i = 0; i < n; i++) {
        const x = r() * w, y = r() * h, s = size * (0.6 + r() * 0.8) * (o.scale || 1);
        g.globalAlpha = alpha * (0.5 + r() * 0.5);
        g.fillStyle = r() < 0.15 ? 'rgb(' + CYAN + ')' : '#ffffff';
        g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  /* A body shaped like the ones the sim creates (same fields _pushNode sets).
     `art` seeds the class; 0.5 at mass 1.4 is a ringed gas giant on the
     current roster, which is the most recognisable silhouette at icon size. */
  function body(o) {
    return Object.assign({
      kind: 'planet', type: 'normal', mass: 1.4, art: 0.5, idx: 0,
      phase: 1.1, x: 0, y: 0, radius: 16, spent: false, pop: 0, decay: 0,
      minR: 60, maxR: 100, captureR: 92, hooked: false
    }, o);
  }

  /* Orbit ring + tether + rocket, like the title screen's demo. Angle `a` is
     where on the ring the ship sits (radians, 0 = right, clockwise on
     screen); the rocket flies tangentially, prograde. */
  function shipOnRing(g, cx, cy, ringR, a, shipR, opts) {
    const o = opts || {};
    const sx = cx + Math.cos(a) * ringR, sy = cy + Math.sin(a) * ringR;
    if (!o.noRing) {
      g.strokeStyle = 'rgba(' + CYAN + ',0.22)'; g.lineWidth = Math.max(1, shipR * 0.12);
      g.beginPath(); g.arc(cx, cy, ringR, 0, TAU); g.stroke();
    }
    g.strokeStyle = 'rgba(' + CYAN + ',0.85)'; g.lineWidth = Math.max(1.5, shipR * 0.16);
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(sx, sy); g.stroke();
    /* prograde = tangent; -1 flips direction so the nose points "up" when
       the ship is on the left of the ring. */
    const heading = a + (o.retro ? Math.PI / 2 : -Math.PI / 2);
    R.draw(g, sx, sy, heading, shipR, CLOCK, { burn: o.burn === undefined ? 0.85 : o.burn, thrust: 0.6 });
    return [sx, sy];
  }

  function planet(g, cx, cy, rad, mass) {
    const n = body({ x: cx, y: cy, radius: rad, mass: mass || 1.4 });
    C.drawBody(g, n, rad, true, 0.5, CLOCK);
  }

  function title(g, text, x, y, size, weight, glow) {
    g.font = (weight || 800) + ' ' + size + 'px "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.shadowColor = 'rgba(' + CYAN + ',0.9)'; g.shadowBlur = glow || size * 0.5;
    g.fillStyle = '#ffffff'; g.fillText(text, x, y);
    g.shadowBlur = 0; g.shadowColor = 'transparent';
  }

  /* ---- the one composition, at any size, with or without background ---- */
  function emblem(g, S, withBg, pad) {
    /* pad = fraction of the canvas the art must stay inside (adaptive icons
       are masked to a 66/108 circle, so their foreground keeps to ~0.6). */
    const k = pad || 1;
    const cx = S * 0.5, cy = S * 0.5;
    if (withBg) space(g, S, S, { gx: S * 0.42, gy: S * 0.6, seed: 4242, scale: S / 512, starMul: 1.2 });
    const ringR = S * 0.30 * k;
    const pr = S * 0.135 * k;
    planet(g, cx + S * 0.02 * k, cy + S * 0.10 * k, pr, 1.4);
    shipOnRing(g, cx + S * 0.02 * k, cy + S * 0.10 * k, ringR, -TAU * 0.36, S * 0.075 * k, { burn: 0.9 });
  }

  const out = {};
  for (const job of jobs) {
    if (job.kind === 'icon') {
      const [c, g] = canvas(job.size, job.size);
      emblem(g, job.size, true, 1);
      if (job.round) {
        g.globalCompositeOperation = 'destination-in';
        g.beginPath(); g.arc(job.size / 2, job.size / 2, job.size / 2, 0, TAU); g.fill();
        g.globalCompositeOperation = 'source-over';
      }
      out[job.name] = c.toDataURL('image/png');
    } else if (job.kind === 'foreground') {
      const [c, g] = canvas(job.size, job.size);
      emblem(g, job.size, false, 0.62);
      out[job.name] = c.toDataURL('image/png');
    } else if (job.kind === 'feature') {
      const W = job.w, H = job.h;
      const [c, g] = canvas(W, H);
      space(g, W, H, { gx: W * 0.72, gy: H * 0.5, seed: 777, scale: 1.4, starMul: 1.3 });
      /* Right half: the planet and the ship mid-swing. */
      const pcx = W * 0.745, pcy = H * 0.56;
      planet(g, pcx, pcy, 78, 1.4);
      shipOnRing(g, pcx, pcy, 158, -TAU * 0.33, 34, { burn: 0.95 });
      /* Left half: the name and the line under it, in the title screen's own
         typography (white, cyan glow; tracked caps beneath). */
      title(g, 'SKYHOOK', W * 0.06, H * 0.50, 108, 800, 40);
      g.font = '600 26px "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
      g.fillStyle = 'rgba(' + CYAN + ',0.92)'; g.textAlign = 'left';
      const sub = 'O R B I T   -   R E L E A S E   -   C L I M B';
      g.fillText(sub, W * 0.065, H * 0.50 + 46);
      g.font = '500 20px "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
      g.fillStyle = '#8fb6d4';
      g.fillText('One-touch neon arcade. No ads. How high can you climb?', W * 0.065, H * 0.50 + 88);
      out[job.name] = c.toDataURL('image/jpeg', 0.95);
    } else if (job.kind === 'splash') {
      const W = job.w, H = job.h;
      const [c, g] = canvas(W, H);
      const S = Math.min(W, H);
      space(g, W, H, { gx: W * 0.5, gy: H * 0.5, seed: 99, scale: S / 720, starMul: 0.9 });
      /* Centred emblem at ~38% of the short side, so it clears the safe
         area on every ratio Capacitor hands the drawable to. */
      const E = Math.round(S * 0.38);
      const [ec, eg] = canvas(E, E);
      emblem(eg, E, false, 0.9);
      g.drawImage(ec, Math.round((W - E) / 2), Math.round((H - E) / 2));
      out[job.name] = c.toDataURL('image/png');
    }
  }
  return out;
}

const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
/* Same sizes the Capacitor scaffold shipped, so nothing else has to change. */
const SPLASH = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280],
  'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920]
};

function jobs() {
  const listingOnly = process.argv.includes('--listing');
  const j = [
    { kind: 'icon', name: 'store-icon', size: 512, file: path.join(LISTING, 'icon-512.png') },
    { kind: 'feature', name: 'feature', w: 1024, h: 500, file: path.join(LISTING, 'feature-graphic-1024x500.jpg') }
  ];
  if (listingOnly) return j;
  for (const [d, k] of Object.entries(DENSITY)) {
    j.push({ kind: 'icon', name: 'ic_' + d, size: 48 * k, file: path.join(RES, 'mipmap-' + d, 'ic_launcher.png') });
    j.push({ kind: 'icon', name: 'icr_' + d, size: 48 * k, round: true, file: path.join(RES, 'mipmap-' + d, 'ic_launcher_round.png') });
    j.push({ kind: 'foreground', name: 'fg_' + d, size: 108 * k, file: path.join(RES, 'mipmap-' + d, 'ic_launcher_foreground.png') });
  }
  for (const [dir, [w, h]] of Object.entries(SPLASH)) {
    j.push({ kind: 'splash', name: 'splash_' + dir, w, h, file: path.join(RES, dir, 'splash.png') });
  }
  return j;
}

async function main() {
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 480, height: 880 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(base + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.SK && window.SK.Rocket && window.SK.Celestial && window.__SKYHOOK);
    const list = jobs();
    const data = await page.evaluate(render, list.map(({ file, ...rest }) => rest));
    if (errors.length) throw new Error('page errors: ' + errors.join('; '));
    fs.mkdirSync(LISTING, { recursive: true });
    for (const job of list) {
      const url = data[job.name];
      if (!url) throw new Error('no output for ' + job.name);
      fs.writeFileSync(job.file, Buffer.from(url.split(',')[1], 'base64'));
      console.log('wrote ' + path.relative(APP, job.file));
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
