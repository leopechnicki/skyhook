/* SKYHOOK frame-time harness.
 *
 * The art pass that added planet classes, spectral star colours and meteor
 * silhouettes had to prove it did not cost frame rate on the hardware people
 * actually play on. "It felt fine on my desktop" is not a measurement, so this
 * file produces two numbers instead:
 *
 *   SYNTHETIC  a fixed, hand-built scene (12 bodies covering every class, 6
 *              meteors, 6 shards) rendered N times with the sim frozen. No bot,
 *              no RNG, no timing jitter - so the A/B is the draw code and
 *              nothing else. This is the number to quote when comparing builds.
 *   LIVE       the smoke-test bot actually playing, under CPU throttling, so
 *              we also see real end-to-end fps rather than draw cost alone.
 *
 * Mid-range Android is emulated with a 390x844 viewport at dpr 2 (the same
 * phone profile smoke.mjs asserts against) plus CDP CPU throttling. 4x is the
 * commonly used stand-in for a mid-tier ARM core against a desktop x86 one.
 *
 * Run:  node test/perf.mjs
 * Flags:
 *   --frames=600    synthetic frames to render (default 600)
 *   --seconds=18    live play sample length (default 18)
 *   --throttle=4    CDP CPU throttling rate (1 = off)
 *   --label=before  tag written into the JSON/plain output
 *   --json=path     also write the raw numbers as JSON
 *   --headed        show the browser
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit === undefined ? d : hit.slice(n.length + 3);
};
const FRAMES = parseInt(flag('frames', '600'), 10);
const SECONDS = parseFloat(flag('seconds', '18'));
const THROTTLE = parseFloat(flag('throttle', '4'));
const LABEL = flag('label', 'run');
const JSON_OUT = flag('json', '');
const HEADED = argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
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

const wait = ms => new Promise(r => setTimeout(r, ms));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function summary(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  return {
    n: arr.length,
    mean: +mean.toFixed(3),
    p50: +pct(s, 50).toFixed(3),
    p95: +pct(s, 95).toFixed(3),
    p99: +pct(s, 99).toFixed(3),
    max: +(s[s.length - 1] || 0).toFixed(3)
  };
}

/* ---- in-page instrumentation ------------------------------------------
   Wraps the game instance's own render method, so we time exactly what the
   main loop calls and nothing around it. */
const INSTRUMENT = `
window.__perf = { on: false, render: [], frame: [], nodes: 0, samples: 0 };
(function () {
  var g = window.__SKYHOOK.game;
  var orig = g.render;
  var last = 0;
  g.render = function (ctx) {
    var t0 = performance.now();
    orig.call(g, ctx);
    var t1 = performance.now();
    var P = window.__perf;
    if (P.on) {
      P.render.push(t1 - t0);
      if (last) P.frame.push(t0 - last);
      P.nodes += g.nodes.length; P.samples++;
    }
    last = t0;
  };
}());
`;

/* ---- the synthetic scene ---------------------------------------------
   Built through the game's OWN _pushNode so geometry (radius, minR, maxR,
   captureR) comes from the build under test rather than from this file. Only
   `art` is overwritten, with a fixed spread, so every visual class the art
   module can produce is on screen at once. Hazards and shards are pushed as
   plain literals matching the shapes the spawner creates. */
const SCENE = `
(function () {
  var g = window.__SKYHOOK.game;
  g.start(4242);
  g.tutorial = false;
  g.nodes.length = 0;
  g.nodeCount = 0;

  /* 12 bodies: 8 planets across the whole art seed range (two of them decay)
     and 4 stars spanning the full mass band, i.e. every spectral class the
     mapping can return. */
  var plan = [
    { x:  96, y: 780, kind: 'planet', type: 'normal', mass: 0.55, art: 0.03 },
    { x: 240, y: 700, kind: 'planet', type: 'normal', mass: 0.70, art: 0.17 },
    { x: 384, y: 620, kind: 'planet', type: 'decay',  mass: 0.82, art: 0.29 },
    { x: 120, y: 540, kind: 'planet', type: 'normal', mass: 0.95, art: 0.41 },
    { x: 300, y: 460, kind: 'planet', type: 'normal', mass: 1.05, art: 0.55 },
    { x: 150, y: 380, kind: 'planet', type: 'decay',  mass: 1.10, art: 0.67 },
    { x: 360, y: 300, kind: 'planet', type: 'normal', mass: 1.15, art: 0.79 },
    { x: 110, y: 220, kind: 'planet', type: 'normal', mass: 1.12, art: 0.93 },
    { x: 300, y: 150, kind: 'star',   type: 'normal', mass: 2.30, art: 0.11 },
    { x: 130, y:  80, kind: 'star',   type: 'normal', mass: 3.10, art: 0.37 },
    { x: 380, y:  20, kind: 'star',   type: 'normal', mass: 4.10, art: 0.62 },
    { x: 220, y: -40, kind: 'star',   type: 'normal', mass: 5.10, art: 0.88 }
  ];
  var made = [];
  for (var i = 0; i < plan.length; i++) {
    var q = plan[i];
    var n = g._pushNode(q.x, q.y, q.type, q.kind, q.mass);
    n.art = q.art;
    n.phase = (i / plan.length) * Math.PI * 2;
    made.push(n);
  }

  var haz = g.meteors || g.mines;   // renamed by the art pass; accept both
  haz.length = 0;
  for (var m = 0; m < 6; m++) {
    haz.push({ homeX: 60 + m * 68, x: 60 + m * 68, y: 120 + m * 120,
               amp: 8 + m * 2, phase: (m / 6) * Math.PI * 2, art: m / 6 });
  }
  g.shards.length = 0;
  for (var s = 0; s < 6; s++) {
    g.shards.push({ x: 70 + s * 70, y: 180 + s * 110, phase: (s / 6) * Math.PI * 2, got: false });
  }

  /* Freeze the player on the first body so the scene is static: no sim ticks,
     no culling, no regeneration - render() is the only thing that runs. */
  var p = g.player;
  p.node = made[0]; p.mode = 'orbit';
  p.r = made[0].minR + 10; p.targetR = p.r; p.ang = -Math.PI / 2;
  p.x = made[0].x; p.y = made[0].y - p.r;
  g.camY = -80;
  g.state = 'playing';
  return { nodes: g.nodes.length, hazards: haz.length, shards: g.shards.length };
}());
`;

const RENDER_LOOP = `
(function () {
  var g = window.__SKYHOOK.game;
  var ctx = window.__SKYHOOK.canvas.getContext('2d');
  window.__perf.on = true;
  window.__synthDone = false;
  var left = ${FRAMES};
  /* Advance the ART clock without stepping the SIM: bumps the animated parts
     of the draw code (pulses, flare rotation, meteor spin) so the measurement
     covers the animated path, while nothing in the world can move or spawn. */
  function loop() {
    if (left-- <= 0) { window.__perf.on = false; window.__synthDone = true; return; }
    g.time += 1 / 60;
    g.render(ctx);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}());
`;

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const launchOpts = { headless: !HEADED, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] };
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', ...launchOpts }); }
  catch { browser = await chromium.launch(launchOpts); }

  const out = { label: LABEL, throttle: THROTTLE, frames: FRAMES, seconds: SECONDS };
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base + '?seed=4242', { waitUntil: 'load' });
    await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 15000 });
    await page.evaluate('window.__SKYHOOK.skipTutorial(false)');
    await page.evaluate(INSTRUMENT);

    /* ---------- 1. synthetic, deterministic scene ---------- */
    const scene = await page.evaluate(SCENE);
    await page.evaluate(RENDER_LOOP);
    await page.waitForFunction('window.__synthDone === true', null, { timeout: 120000 });
    const synth = await page.evaluate('({ render: window.__perf.render, frame: window.__perf.frame })');
    out.scene = scene;
    out.synthetic = { render: summary(synth.render), frame: summary(synth.frame) };

    /* ---------- 2. live play under the bot ---------- */
    const page2 = await ctx.newPage();
    const cdp2 = await ctx.newCDPSession(page2);
    if (THROTTLE > 1) await cdp2.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    page2.on('pageerror', e => errors.push(String(e.message)));
    await page2.goto(base + '?seed=4242', { waitUntil: 'load' });
    await page2.waitForFunction('!!window.__SKYHOOK', null, { timeout: 15000 });
    await page2.evaluate('window.__SKYHOOK.skipTutorial(true)');
    await page2.evaluate(INSTRUMENT);
    await page2.evaluate(fs.readFileSync(path.join(HERE, 'bot.js'), 'utf8'));
    const box = await page2.locator('#game').boundingBox();
    await page2.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await wait(600);
    await page2.evaluate('window.__perf.on = true');
    await wait(SECONDS * 1000);
    await page2.evaluate('window.__perf.on = false');
    const live = await page2.evaluate(`({
      render: window.__perf.render, frame: window.__perf.frame,
      avgNodes: window.__perf.samples ? window.__perf.nodes / window.__perf.samples : 0,
      hooks: (window.__SKYHOOK.game.hooks|0), state: window.__SKYHOOK.game.state
    })`);
    out.live = {
      render: summary(live.render),
      frame: summary(live.frame),
      fps: live.frame.length ? +(1000 / (live.frame.reduce((a, b) => a + b, 0) / live.frame.length)).toFixed(1) : 0,
      avgNodes: +live.avgNodes.toFixed(2),
      hooks: live.hooks,
      state: live.state
    };
    out.errors = errors;
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n=== frame time: ${LABEL}  (CPU throttle ${THROTTLE}x, 390x844 @dpr2) ===`);
  console.log(`scene: ${out.scene.nodes} bodies, ${out.scene.hazards} hazards, ${out.scene.shards} shards`);
  const row = (k, s) => `  ${k.padEnd(18)} mean ${String(s.mean).padStart(7)}  p50 ${String(s.p50).padStart(7)}  p95 ${String(s.p95).padStart(7)}  p99 ${String(s.p99).padStart(7)}  max ${String(s.max).padStart(7)}   (n=${s.n})`;
  console.log('SYNTHETIC (ms)');
  console.log(row('render', out.synthetic.render));
  console.log(row('frame', out.synthetic.frame));
  console.log('LIVE PLAY (ms)');
  console.log(row('render', out.live.render));
  console.log(row('frame', out.live.frame));
  console.log(`  fps ${out.live.fps}   avg bodies on screen ${out.live.avgNodes}   hooks ${out.live.hooks}   state ${out.live.state}`);
  const budget = 1000 / 60;
  const ok = out.synthetic.render.p95 < budget && out.live.render.p95 < budget;
  console.log(`\n  60 fps render budget ${budget.toFixed(2)} ms -> ${ok ? 'WITHIN BUDGET' : 'OVER BUDGET'} (synthetic p95 ${out.synthetic.render.p95} ms, live p95 ${out.live.render.p95} ms)`);
  if (out.errors.length) console.log(`  !! page errors: ${out.errors.slice(0, 5).join(' | ')}`);

  if (JSON_OUT) {
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 2));
    console.log(`  json -> ${path.resolve(JSON_OUT)}`);
  }
  process.exit(out.errors.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
