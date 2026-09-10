/* SKYHOOK smoke test.
 *
 * Runs the real game in a real Chromium (Playwright), drives it through the
 * real input path with an in-page bot, and asserts the whole loop:
 *   title -> play -> score -> die -> game over -> restart -> persistence.
 *
 * Run from the project root:   node test/smoke.mjs
 * Flags:  --headed   show the browser
 *
 * Requires Playwright:  npm install && npx playwright install chromium
 *                       (uses Google Chrome when installed, else bundled Chromium)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'screenshots');
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------------------------------------------------------
 * 2026-09-09 (Crew): the desktop half of this file was testing nothing.
 *
 * Every desktop "tap" was a hand-built `new PointerEvent('pointerdown', ...)`.
 * That constructor defaults `isPrimary` to FALSE and `pointerType` to ''.
 * main.js:87 correctly drops non-primary pointers (secondary fingers in a
 * multi-touch gesture are not gameplay input), so the game never saw a single
 * desktop tap: 10 checks failed with state=title, hooks=0, score=0.
 *
 * Proven in a real browser, not read off the source:
 *   synthetic PointerEvent  -> isTrusted=false isPrimary=false type=''
 *                              -> state stays "title"
 *   page.mouse.click()      -> isTrusted=true  isPrimary=true  type='mouse'
 *                              -> state becomes "playing"
 * The game is fine. A human with a mouse was never affected. The harness was
 * synthesising an event no browser ever emits.
 *
 * Fix, in two parts:
 *   1. Discrete taps (start / restart / mute / file://) now go through
 *      page.mouse.click - real trusted input from the browser's own input
 *      stack. This is what a player does, so it is what we test.
 *   2. The in-page bot still dispatches its own event, because it must decide
 *      and fire inside a single animation frame and a round-trip to the driver
 *      cannot hit that window. It now emits a FAITHFUL primary mouse pointer,
 *      matching what Chrome actually delivers (verified field-by-field; see
 *      test/bot.js).
 * ------------------------------------------------------------------------- */

/* A real desktop click, driven by the browser rather than dispatched by us. */
async function tapCenter(page) {
  const box = await page.locator('#game').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/* An in-page bot that plays for real: it waits for the orbit angle where
   releasing aims closest at the next node, then dispatches a genuine
   pointerdown on the stage. Same code path a human thumb uses.
   It lives in test/bot.js so test/perf.mjs measures frame time under the
   exact same player; see that file's header for why every PointerEvent field
   in it matters. */
const BOT = fs.readFileSync(path.join(HERE, 'bot.js'), 'utf8');

function attachLogs(page, bucket, label) {
  page.on('console', m => { if (m.type() === 'error') bucket.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', e => bucket.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', r => {
    const u = r.url();
    if (!u.startsWith('data:')) bucket.push(`[${label}] requestfailed: ${u} ${r.failure()?.errorText}`);
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const errors = [];

  // Prefer a locally installed Google Chrome; fall back to Playwright's
  // bundled Chromium so the test also runs on a clean checkout.
  const launchOpts = {
    headless: !HEADED,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']
  };
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', ...launchOpts });
  } catch {
    browser = await chromium.launch(launchOpts);
  }

  try {
    /* ---------- 1. desktop, over http ---------- */
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    attachLogs(page, errors, 'desktop');

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });

    let s = await page.evaluate('window.__SKYHOOK.snapshot()');
    check('boots into title screen', s.state === 'title', `state=${s.state}`);
    check('localStorage available over http', s.persistent === true);

    const canvasBox = await page.locator('#game').boundingBox();
    check('canvas has a real size', canvasBox.width > 200 && canvasBox.height > 200,
      `${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)}`);
    // The ad slot ships INACTIVE: markup present for future use, but hidden
    // so no empty banner furniture is visible, and carrying no network code.
    const adBox = await page.locator('#ad-slot').boundingBox();
    check('ad slot is hidden (no visible placeholder)', adBox === null,
      adBox ? `visible ${Math.round(adBox.width)}x${Math.round(adBox.height)}` : 'not rendered');
    const adHtml = await page.locator('#ad-slot').innerHTML();
    check('ad slot contains no ad-network code',
      !/adsbygoogle|pagead|ca-pub-|googlesyndication/i.test(adHtml));
    check('ad slot markup still available for future use',
      (await page.locator('#ad-slot-inner').count()) === 1);

    await wait(700);
    await page.screenshot({ path: path.join(SHOTS, '01-title.png') });

    /* ---------- 1b. input guard: only primary pointers are gameplay -------
       This is the exact trap that made this file green-blind for two commits.
       A hand-built PointerEvent is non-primary, and main.js is RIGHT to drop
       it - a second finger in a pinch is not a release. Pin the behaviour so
       the guard cannot be quietly deleted, and so the next person who reaches
       for dispatchEvent finds out here why nothing happens. */
    const ignoredNonPrimary = await page.evaluate(`(() => {
      const r = window.__SKYHOOK.canvas.getBoundingClientRect();
      window.__SKYHOOK.stage.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, isPrimary: false,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
      }));
      return window.__SKYHOOK.game.state;
    })()`);
    check('non-primary pointers are ignored (multi-touch guard holds)',
      ignoredNonPrimary === 'title', `state=${ignoredNonPrimary}`);

    /* ---------- 2. start + play for real ---------- */
    await tapCenter(page);
    await wait(120);
    s = await page.evaluate('window.__SKYHOOK.snapshot()');
    check('real desktop mouse click starts the run', s.state === 'playing', `state=${s.state}`);

    await page.evaluate(BOT);

    let peak = { hooks: 0, score: 0, combo: 1, altitude: 0 };
    const t0 = Date.now();
    while (Date.now() - t0 < 26000) {
      await wait(400);
      s = await page.evaluate('window.__SKYHOOK.snapshot()');
      if (s.state === 'playing') {
        peak = {
          hooks: Math.max(peak.hooks, s.hooks),
          score: Math.max(peak.score, s.score),
          combo: Math.max(peak.combo, s.combo),
          altitude: Math.max(peak.altitude, s.altitude)
        };
        if (peak.hooks === 14) await page.screenshot({ path: path.join(SHOTS, '02-playing.png') });
      } else if (s.state !== 'playing' && peak.hooks > 0) {
        // bot died; restart it so we measure a full sustained run
        if (s.state === 'over') { await tapCenter(page); }
      }
    }
    if (!fs.existsSync(path.join(SHOTS, '02-playing.png'))) {
      await page.screenshot({ path: path.join(SHOTS, '02-playing.png') });
    }

    check('core loop runs: player chains hooks', peak.hooks >= 10, `peak hooks=${peak.hooks}`);
    check('scoring works', peak.score > 100, `peak score=${peak.score}`);
    check('combo can build (tight hooks are reachable)', peak.combo >= 3, `peak combo=${peak.combo}`);
    check('altitude advances', peak.altitude > 50, `peak altitude=${peak.altitude} m`);

    /* ---------- 3. death + game over ---------- */
    await page.evaluate('window.__bot.on = false');
    /* The rift and the flight timer are gone: idling on an orbit is now
       SAFE FOREVER by design, so "stop tapping and wait to die" can no longer
       end a run. Death is caused by a bad release, so provoke one - spam
       untimed taps until the ball leaves the screen. */
    s = await page.evaluate('window.__SKYHOOK.snapshot()');
    if (s.state !== 'playing') { await tapCenter(page); await wait(200); }

    const scoreBeforeDeath = (await page.evaluate('window.__SKYHOOK.snapshot()')).score;
    let died = false;
    for (let i = 0; i < 90; i++) {
      await tapCenter(page);
      await wait(160);
      s = await page.evaluate('window.__SKYHOOK.snapshot()');
      if (s.state === 'over') { died = true; break; }
    }
    check('run ends in a game-over screen', died, `state=${s.state} cause=${s.cause}`);
    await wait(600);
    await page.screenshot({ path: path.join(SHOTS, '03-gameover.png') });

    const stored = await page.evaluate('localStorage.getItem("skyhook.best")');
    check('high score written to localStorage', Number(stored) > 0 && Number(stored) >= scoreBeforeDeath,
      `stored=${stored} scoreAtDeath=${scoreBeforeDeath}`);

    /* ---------- 4. restart ---------- */
    /* What "cleanly" has to mean: the RUN COUNTERS were reset, not that the
       new run has literally scored nothing yet. The old assertion demanded
       score === 0 after a 200 ms settle and was therefore flaky by
       construction - a shard can sit within pickup range of the opening orbit,
       so a perfectly clean restart legitimately reads score 25 with hooks 0
       (score only moves on a hook, game.js:759, or a shard, game.js:949).
       Assert the reset instead: a carried-over run would show the previous
       hooks (26) and altitude (560 m), which these bounds exclude outright. */
    await tapCenter(page);
    await wait(200);
    s = await page.evaluate('window.__SKYHOOK.snapshot()');
    const restarted = s.state === 'playing' && s.hooks === 0 && s.altitude < 20
      && s.score < 100 && s.score < scoreBeforeDeath;
    check('tap on game over restarts cleanly', restarted,
      `state=${s.state} score=${s.score} hooks=${s.hooks} altitude=${s.altitude}`);

    /* ---------- 5. persistence across a reload ---------- */
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
    s = await page.evaluate('window.__SKYHOOK.snapshot()');
    check('high score survives a reload', s.best === Number(stored), `best=${s.best} stored=${stored}`);

    /* ---------- 6. mute toggle ---------- */
    /* Real click on the mute glyph, in page coordinates derived from the
       canvas box - the button lives at logical (480-36, 36). */
    const muteBox = await page.locator('#game').boundingBox();
    const muteScale = muteBox.width / 480;
    await page.mouse.click(muteBox.x + (480 - 36) * muteScale, muteBox.y + 36 * muteScale);
    await wait(100);
    const muted = await page.evaluate('window.__SKYHOOK.game.muted');
    const stillTitle = await page.evaluate('window.__SKYHOOK.game.state');
    check('mute button toggles without starting the game', muted === true && stillTitle === 'title',
      `muted=${muted} state=${stillTitle}`);
    await page.evaluate('window.__SKYHOOK.game.toggleMute()');

    /* ---------- 7. mobile / touch ---------- */
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    });
    const mpage = await mctx.newPage();
    attachLogs(mpage, errors, 'mobile');
    await mpage.goto(base, { waitUntil: 'load' });
    await mpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
    const mbox = await mpage.locator('#game').boundingBox();
    check('canvas fits inside a 390x844 phone viewport',
      mbox.width <= 390.5 && mbox.height <= 844.5 && mbox.width > 300,
      `${Math.round(mbox.width)}x${Math.round(mbox.height)}`);
    await mpage.locator('#stage').tap();
    await wait(150);
    const mstate = await mpage.evaluate('window.__SKYHOOK.game.state');
    check('touch tap starts the game on mobile', mstate === 'playing', `state=${mstate}`);
    await wait(900);
    await mpage.screenshot({ path: path.join(SHOTS, '04-mobile.png') });
    await mctx.close();

    /* ---------- 8. offline: opened straight off disk (file://) ---------- */
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const fpage = await fctx.newPage();
    attachLogs(fpage, errors, 'file');
    await fpage.goto(pathToFileURL(path.join(ROOT, 'index.html')).href, { waitUntil: 'load' });
    await fpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
    const fs1 = await fpage.evaluate('window.__SKYHOOK.snapshot()');
    await tapCenter(fpage);
    await wait(1200);
    const fs2 = await fpage.evaluate('window.__SKYHOOK.snapshot()');
    check('runs from file:// with no server (title screen)', fs1.state === 'title');
    check('runs from file:// (loop advances, no crash)', fs2.state === 'playing' && fs2.altitude >= 0,
      `state=${fs2.state} localStorage=${fs2.persistent ? 'available' : 'unavailable (expected on file://)'}`);
    await fpage.screenshot({ path: path.join(SHOTS, '05-file-protocol.png') });
    await fctx.close();

    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  check('no console errors / page errors / failed requests', errors.length === 0,
    errors.slice(0, 6).join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots: ${SHOTS}`);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach(f => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
