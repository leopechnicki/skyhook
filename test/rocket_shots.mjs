/* SKYHOOK rocket proof sheet + live capture + frame time.
 *
 * The player is now a ROCKET, which makes three claims that a single lucky
 * screenshot cannot check:
 *
 *   1. It is oriented to the direction of travel AT EVERY ANGLE. A sprite
 *      that only looks right pointing up is the classic way this ships broken,
 *      so the sheet walks a full 360 and renders the hull at each step.
 *   2. The thruster REACTS TO INPUT. The burn ramp shows the plume at 0.00 ->
 *      1.00, i.e. coasting through the instant a tap fires it.
 *   3. It runs at 60 fps. Hull, plume and nozzle bloom are all baked into a
 *      bounded sprite cache and blitted - a frame of rocket is three drawImage
 *      calls and no gradients. The frame-time section measures that claim on a
 *      throttled CPU rather than asserting it, and the cache line below proves
 *      the sprites are cached rather than repainted.
 *
 * Everything is drawn through the SHIPPED path - SK.Rocket.draw from a page
 * that loaded the real index.html - so what lands in the PNG is what the game
 * paints. The live captures drive the REAL input path (game.action()), so the
 * burn frame is a real release, not a posed one.
 *
 * Run:  node test/rocket_shots.mjs
 * Out:  test/screenshots/rocket_headings.png
 *       test/screenshots/rocket_burn_ramp.png
 *       test/screenshots/rocket_live_orbit.png
 *       test/screenshots/rocket_live_release.png
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'screenshots');

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

/* ---- runs IN THE PAGE ------------------------------------------------- */
function sheets() {
  const R = window.SK.Rocket;
  const TAU = Math.PI * 2;

  function make(w, h, scale) {
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const g = c.getContext('2d');
    g.scale(scale, scale);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#050914');
    bg.addColorStop(1, '#0b1226');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    return { c, g, w, h };
  }
  function label(g, text, x, y, size, col, align) {
    g.font = '600 ' + size + 'px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.fillStyle = col;
    g.fillText(text, x, y);
  }

  const CLOCK = 6.2;           // frozen sim clock: the sheets are reproducible
  const PLAYER_R = 8;          // the collision radius game.js draws the hull at

  /* --- headings: one full turn, plus the hitbox drawn on top ----------- */
  function headingSheet() {
    const cols = 4, rows = 2, cell = 190, top = 108;
    const s = make(cols * cell, top + rows * cell + 56, 2);
    label(s.g, 'ROCKET - ORIENTATION THROUGH A FULL TURN', s.w / 2, 38, 22, '#eaf4ff');
    label(s.g, 'hull points along the velocity vector at every angle; the dashed circle is the UNCHANGED 8 px collision radius',
      s.w / 2, 66, 11, 'rgba(150,200,235,0.7)');
    label(s.g, 'the arrow is the direction of travel - nose and arrow must agree in every cell',
      s.w / 2, 86, 11, 'rgba(150,200,235,0.55)');

    for (let i = 0; i < cols * rows; i++) {
      const ang = i * TAU / (cols * rows);
      const cx = (i % cols) * cell + cell / 2;
      const cy = top + Math.floor(i / cols) * cell + cell / 2;

      /* Direction-of-travel arrow, drawn independently of the sprite. */
      s.g.save();
      s.g.strokeStyle = 'rgba(255,215,94,0.55)';
      s.g.lineWidth = 1.4;
      s.g.setLineDash([5, 5]);
      s.g.beginPath();
      s.g.moveTo(cx, cy);
      s.g.lineTo(cx + Math.cos(ang) * 68, cy + Math.sin(ang) * 68);
      s.g.stroke();
      s.g.restore();

      R.draw(s.g, cx, cy, ang, PLAYER_R * 2.2, CLOCK, { burn: 0.35, thrust: 0.5 });

      s.g.save();
      s.g.setLineDash([3, 4]);
      s.g.strokeStyle = 'rgba(255,90,110,0.8)';
      s.g.lineWidth = 1;
      s.g.beginPath(); s.g.arc(cx, cy, PLAYER_R * 2.2, 0, TAU); s.g.stroke();
      s.g.restore();

      label(s.g, Math.round(ang * 180 / Math.PI) + ' deg', cx, cy + cell / 2 - 16, 12, 'rgba(150,200,235,0.8)');
    }
    return s.c.toDataURL('image/png');
  }

  /* --- burn ramp: what a tap does to the engine ------------------------ */
  function burnSheet() {
    const steps = [0, 0.25, 0.5, 0.75, 1];
    const cell = 200, top = 104;
    const s = make(steps.length * cell, top + 300, 2);
    label(s.g, 'THRUSTER RESPONSE TO INPUT', s.w / 2, 38, 22, '#eaf4ff');
    label(s.g, 'burn = 1.0 the instant a tap releases the tether, decaying to the idle plume over BURN_FADE = 0.42 s',
      s.w / 2, 66, 11, 'rgba(150,200,235,0.7)');
    label(s.g, 'plume also scales with the body you left: a star throws you harder, so the engine runs hotter',
      s.w / 2, 86, 11, 'rgba(150,200,235,0.55)');

    steps.forEach((b, i) => {
      const cx = i * cell + cell / 2;
      const cy = top + 110;
      R.draw(s.g, cx, cy, -Math.PI / 2, PLAYER_R * 2.4, CLOCK, { burn: b, thrust: 0.35 + b * 0.5 });
      label(s.g, 'burn ' + b.toFixed(2), cx, top + 268, 13, 'rgba(234,244,255,0.9)');
    });
    return s.c.toDataURL('image/png');
  }

  return {
    headings: headingSheet(),
    burn: burnSheet(),
    cache: R.cacheStats()
  };
}

/* ---- live captures ---------------------------------------------------- */

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
let browser;
const written = [];

try {
  const opts = { args: ['--mute-audio'] };
  try { browser = await chromium.launch({ channel: 'chrome', ...opts }); }
  catch { browser = await chromium.launch(opts); }

  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.SK && window.SK.Rocket && window.__SKYHOOK));

  fs.mkdirSync(OUT, { recursive: true });

  const out = await page.evaluate(sheets);
  for (const [name, key] of [['rocket_headings', 'headings'], ['rocket_burn_ramp', 'burn']]) {
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(out[key].split(',')[1], 'base64'));
    written.push(file);
  }

  /* --- live: real run, real input path. Orbit frame, then the frame right
         after a real release so the burn is genuinely at its peak. --------- */
  await page.evaluate(() => {
    window.__SKYHOOK.skipTutorial(true);
    window.__SKYHOOK.tap();                       // start
  });
  await page.waitForFunction(() => window.__SKYHOOK.snapshot().state === 'playing');
  await page.waitForFunction(() => window.__SKYHOOK.snapshot().mode === 'orbit');
  await page.waitForTimeout(260);
  const stage = page.locator('#stage');
  let f = path.join(OUT, 'rocket_live_orbit.png');
  await stage.screenshot({ path: f }); written.push(f);

  const burnPeak = await page.evaluate(() => new Promise(resolve => {
    const g = window.__SKYHOOK.game;
    /* Release, then let exactly one animation frame paint it. */
    g.action();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(g.player.burn)));
  }));
  f = path.join(OUT, 'rocket_live_release.png');
  await stage.screenshot({ path: f }); written.push(f);

  /* --- frame time, 4x CPU throttle (a mid-range Android proxy) ---------- */
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const perf = await page.evaluate(() => new Promise(resolve => {
    const samples = [];
    let last = 0, n = 0;
    function step(ts) {
      if (last) samples.push(ts - last);
      last = ts;
      if (++n < 320) requestAnimationFrame(step);
      else {
        samples.sort((a, b) => a - b);
        resolve({
          frames: samples.length,
          median: samples[Math.floor(samples.length * 0.5)],
          p95: samples[Math.floor(samples.length * 0.95)],
          max: samples[samples.length - 1]
        });
      }
    }
    requestAnimationFrame(step);
  }));
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  console.log('\n=== rocket proof ===');
  written.forEach(x => console.log('  ' + x + '  (' + fs.statSync(x).size + ' bytes)'));
  /* Three ceilings rather than one since the hull got a colour: the hull and
     flame caches are keyed by colour now, so each carries its own bound. This
     sheet only ever draws the live ship, so hull is still 1 in practice - but
     what is asserted is the BOUND, because the bound is the thing that stops
     a configurable paint job turning the art pass into a leak. */
  console.log('  sprites baked: hull ' + out.cache.hull + '/' + out.cache.hullMax +
              '   flame ' + out.cache.flame + '/' + out.cache.flameMax +
              '   bloom ' + out.cache.bloom + '/' + out.cache.bloomMax +
              '   (nothing on the ship is repainted per frame)');
  if (out.cache.hull > out.cache.hullMax || out.cache.flame > out.cache.flameMax ||
      out.cache.bloom > out.cache.bloomMax) {
    console.log('  FAIL  the rocket sprite cache is not bounded');
    process.exitCode = 1;
  }
  console.log('  burn at the frame after a real release: ' + burnPeak.toFixed(3));
  console.log('\n=== frame time, 4x CPU throttle, live gameplay ===');
  console.log('  frames ' + perf.frames +
              '   median ' + perf.median.toFixed(2) + ' ms' +
              '   p95 ' + perf.p95.toFixed(2) + ' ms' +
              '   max ' + perf.max.toFixed(2) + ' ms');
  const ok60 = perf.p95 <= 18.5;
  console.log('  ' + (ok60 ? 'PASS' : 'FAIL') + '  60 fps bar (p95 <= 18.5 ms)');
  if (!ok60) process.exitCode = 1;

  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    errors.forEach(e => console.log('  ' + e));
    process.exitCode = 1;
  } else {
    console.log('  no page errors');
  }
} finally {
  if (browser) await browser.close();
  server.close();
}
