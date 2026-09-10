/* SKYHOOK shipping images - the pictures that represent the game to people
 * who have not played it yet. Generated, never pasted in.
 *
 *   screenshot.png                (1200x630)  og:image / twitter:image
 *   docs/screenshot-title.png     (400x732)   README hero row
 *   docs/screenshot-playing.png   (400x732)
 *   docs/screenshot-gameover.png  (400x732)
 *
 * These four are the files that go stale silently: nothing loads them, no test
 * asserts on them, and they keep advertising whatever build shipped the day
 * they were made. Before this pass all four still showed the v1.0.0 game -
 * "HOOK - SWING - CLIMB", "TAP / SPACE to let go of the tether", a white dot
 * for the player, flat cyan bodies and no meteoroids - i.e. every single claim
 * on them had stopped being true, across two shipped feature passes.
 *
 * So they are produced FROM the live build, through the real page and the real
 * input path. Re-run this after any change to the first screen or the art and
 * the marketing cannot drift from the game again.
 *
 * Run:  node test/shipping_shots.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS = path.join(ROOT, 'docs');
const CARD = path.join(ROOT, 'screenshot.png');
const BOT = fs.readFileSync(path.join(HERE, 'bot.js'), 'utf8');

/* Where in the demo orbit the rocket should sit. The demo runs at
   omega = sqrt(G / r^3) = 4.77 rad/s with r = 88, so this clock puts the ship
   at ~200 deg round the ring - left of the body, nose up and to the right,
   i.e. mid-climb - and lands the thruster near the top of its flare cycle. */
const TITLE_CLOCK = 0.732;

/* The README shots are 400x732, matching the three already committed there so
   the markdown layout does not move. */
const DOC_W = 400, DOC_H = 732;

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

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(16, 24);
  return head.readUInt32BE(0) + 'x' + head.readUInt32BE(4);
}

/* Pin the title animation to a chosen frame. The loop keeps running, so the
   clock has to be pinned by the GETTER, not assigned once. */
const pinTitle = clock => new Promise(resolve => {
  const g = window.__SKYHOOK.game;
  Object.defineProperty(g, 'titleT', { get: () => clock, set: () => {}, configurable: true });
  let n = 0;
  (function spin() {
    if (++n > 8) return resolve({ state: g.state, best: g.best });
    requestAnimationFrame(spin);
  }());
});

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
let browser;
const written = [];
const errors = [];

try {
  const opts = { args: ['--mute-audio', '--hide-scrollbars'] };
  try { browser = await chromium.launch({ channel: 'chrome', ...opts }); }
  catch { browser = await chromium.launch(opts); }

  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const watch = page => {
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  };

  /* ---------------------------------------------------------- social card */
  {
    const page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.__SKYHOOK && window.SK && window.SK.Rocket));
    const st = await page.evaluate(pinTitle, TITLE_CLOCK);
    if (st.state !== 'title') throw new Error('social card: not on the title screen (' + st.state + ')');
    fs.writeFileSync(CARD, await page.screenshot({ type: 'png', scale: 'css' }));
    written.push(CARD);
    await page.close();
  }

  /* ------------------------------------------------------- README triptych */
  {
    const page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width: DOC_W, height: DOC_H });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.__SKYHOOK && window.SK && window.SK.Rocket));
    fs.mkdirSync(DOCS, { recursive: true });
    const stage = page.locator('#stage');

    /* title - same pinned frame as the card, so the two agree */
    await page.evaluate(pinTitle, TITLE_CLOCK);
    let f = path.join(DOCS, 'screenshot-title.png');
    await stage.screenshot({ path: f, scale: 'css' }); written.push(f);

    /* playing - a real run, driven by the shared bot through the real input
       path. Held until the combo has actually built, because a x1 shot would
       advertise the game as easier and emptier than it is. */
    await page.evaluate(() => {
      const g = window.__SKYHOOK.game;
      delete g.titleT;                 // release the pin before the run starts
      g.titleT = 0;
      window.__SKYHOOK.skipTutorial(true);
    });
    await page.evaluate(BOT);
    await page.evaluate(() => window.__SKYHOOK.tap());
    await page.waitForFunction(() => {
      const s = window.__SKYHOOK.snapshot();
      return s.state === 'playing' && s.hooks >= 8 && s.combo >= 3;
    }, null, { timeout: 60000 });
    f = path.join(DOCS, 'screenshot-playing.png');
    await stage.screenshot({ path: f, scale: 'css' }); written.push(f);

    /* game over - end the SAME run for real rather than faking the state.
       The aiming bot is genuinely hard to kill: the run is endless while you
       keep succeeding, and it survived past a 120 s wait on one attempt and
       not on the next, which is a flaky screenshot. So the bot is switched
       off and replaced by careless play - real taps on the real input path at
       a fixed cadence, ignoring where the next body is. That drifts off the
       column within seconds and dies of the actual fail condition, so the
       screen being captured is a true game over, just an earned one. */
    await page.evaluate(() => {
      window.__bot.on = false;
      const fire = () => {
        if (window.__SKYHOOK.snapshot().state !== 'playing') return;
        const r = window.__SKYHOOK.canvas.getBoundingClientRect();
        window.__SKYHOOK.stage.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, isPrimary: true, pointerId: 1,
          pointerType: 'mouse', button: 0, buttons: 1,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        }));
        setTimeout(fire, 140);
      };
      fire();
    });
    await page.waitForFunction(() => window.__SKYHOOK.snapshot().state === 'over',
      null, { timeout: 120000 });
    await page.waitForTimeout(500);        // let the overlay finish sliding in
    f = path.join(DOCS, 'screenshot-gameover.png');
    await stage.screenshot({ path: f, scale: 'css' }); written.push(f);
    await page.close();
  }

  console.log('\n=== shipping images ===');
  written.forEach(f => console.log('  ' + f + '  ' + pngSize(f) + '  (' + fs.statSync(f).size + ' bytes)'));

  const cardSize = pngSize(CARD);
  if (cardSize !== '1200x630') {
    console.log('  FAIL  ' + cardSize + ' does not match the og:image meta tags (1200x630)');
    process.exitCode = 1;
  }
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
