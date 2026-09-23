/* SKYHOOK - the customiser is reachable MID-SESSION, in a real browser.
 *
 * Leo, 2026-09-23: "user is not able to change spaceship after start
 * playing". The customiser used to have one door, on the title screen, and
 * the title is never seen again after the first tap. This proves the two new
 * doors with real clicks on the canvas - no SK.UIShip.open() shortcuts:
 *
 *   PAUSED     HUD pause button -> CUSTOMISE SHIP -> repaint -> close.
 *              The run must not move while the panel is open: same state,
 *              same sim clock to the tick, same position. Space typed while
 *              the panel is open must not resume it, Esc closes the panel
 *              without resuming, and the new paint is on the (frozen) ship
 *              before the resume tap. Then the resume tap flies it.
 *   GAME OVER  CUSTOMISE SHIP -> repaint -> DONE -> still on game over ->
 *              RETRY, and the new run flies the new paint.
 *   KEYS       P toggles pause, Esc only ever pauses.
 *   RELOAD     the paint chosen mid-session is still there after a reload.
 *
 * Backend or not: the customiser is a local feature, so nothing here signs in.
 *
 * Run:  node test/ship_access.mjs   [--headed]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'screenshots');
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
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
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* A click at a LOGICAL game coordinate (the 480x880 space game.js hit-tests
   in), through the real mouse, at wherever the canvas is on screen. */
async function tapAt(page, lx, ly) {
  const r = await page.evaluate(() => {
    const b = window.__SKYHOOK.canvas.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height, W: window.SK.Game.W, H: window.SK.Game.H };
  });
  await page.mouse.click(r.x + lx / r.W * r.w, r.y + ly / r.H * r.h);
}
const centre = r => [r.x + r.w / 2, r.y + r.h / 2];
const rect = (page, name) => page.evaluate(n => ({ ...window.__SKYHOOK.game[n] }), name);
const snap = page => page.evaluate(() => {
  const s = window.__SKYHOOK.snapshot();
  return { state: s.state, simTime: s.simTime, px: s.px, py: s.py, score: s.score, altitude: s.altitude, ang: s.ang };
});
const state = page => page.evaluate(() => window.__SKYHOOK.game.state);
const saved = page => page.evaluate(() => window.SK.Ship.saved());
const flying = page => page.evaluate(() => window.SK.Rocket.resolve().key);
const panelOpen = page => page.evaluate(() => !document.getElementById('sh').hidden);
const cell = (page, hex) => page.locator(`#sh-swatches .sh-swatch[data-hex="${hex}"]`);
const tab = (page, part) => page.locator(`#sh-parts .sh-part[data-part="${part}"]`);
/* The canvas pixels in a box around the player's rocket, as a summed
   [r, g, b] - enough to tell a cyan ship from a magenta one. */
const shipPixels = page => page.evaluate(() => {
  const g = window.__SKYHOOK.game, c = window.__SKYHOOK.canvas;
  const sx = c.width / window.SK.Game.W, sy = c.height / window.SK.Game.H;
  const x = Math.round(g.player.x * sx), y = Math.round((g.player.y - g.camY) * sy), R = Math.round(26 * sx);
  const d = c.getContext('2d').getImageData(x - R, y - R, 2 * R, 2 * R).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
  return { x, y, sum };
});

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/?seed=4242`;
  const errors = [];

  const launchOpts = { headless: !HEADED, args: ['--mute-audio'] };
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', ...launchOpts }); }
  catch { browser = await chromium.launch(launchOpts); }

  try {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction('!!(window.__SKYHOOK && window.SK && window.SK.UIShip)');
    await page.evaluate(() => window.__SKYHOOK.skipTutorial(true));

    /* ================================================== PAUSED ======= */
    await tapAt(page, 240, 300);                         // TAP TO START
    await page.waitForFunction('window.__SKYHOOK.game.state === "playing"');
    await page.waitForTimeout(700);

    check('no customise door while flying',
      await page.evaluate(() => window.__SKYHOOK.game._shipRectNow() === null));

    const pauseHit = await rect(page, 'pauseRect');
    await tapAt(page, ...centre(pauseHit));
    check('the HUD pause button pauses the run', (await state(page)) === 'paused', await state(page));

    const before = await snap(page);
    const keyBefore = await flying(page);
    const pixBefore = await shipPixels(page);
    await page.screenshot({ path: path.join(SHOTS, 'access_paused_before.png') });

    const shipPause = await rect(page, 'shipRectPause');
    await tapAt(page, ...centre(shipPause));
    check('CUSTOMISE SHIP on the pause screen opens the customiser', await panelOpen(page));
    check('...and the game is still paused under it', (await state(page)) === 'paused');

    /* Sit in the panel a while, and type the key that means "resume" with
       focus nowhere in particular - the case the keyboard guard exists for. */
    await page.waitForTimeout(900);
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press('Space');
    check('Space while the panel is open does not resume the run', (await state(page)) === 'paused');

    await tab(page, 'body').click();
    await cell(page, '#ff2bd6').click();                 // Magenta body
    await tab(page, 'fire').click();
    await cell(page, '#a8ff1f').click();                 // Acid fire
    await page.keyboard.press('Escape');
    check('Esc closes the panel', !(await panelOpen(page)));
    check('...without resuming the run', (await state(page)) === 'paused', await state(page));

    const after = await snap(page);
    check('the run did not move by a single tick while customising',
      JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));

    const keyAfter = await flying(page);
    check('the ship being flown now carries the new paint',
      keyAfter !== keyBefore && keyAfter.includes('#ff2bd6') && keyAfter.includes('#a8ff1f'),
      `${keyBefore} -> ${keyAfter}`);
    await page.screenshot({ path: path.join(SHOTS, 'access_paused_after.png') });

    /* The frozen rocket is drawn over the scrim, so the repaint is VISIBLE
       on the pause screen, before any resume - compare the actual pixels
       where the ship is. Cyan -> magenta body: red up, green down. */
    const pixAfter = await shipPixels(page);
    check('the repaint is visible on the pause screen itself, at the ship',
      pixAfter.x === pixBefore.x && pixAfter.y === pixBefore.y &&
      pixAfter.sum[0] > pixBefore.sum[0] * 1.15 && pixAfter.sum[1] < pixBefore.sum[1],
      JSON.stringify({ before: pixBefore.sum, after: pixAfter.sum }));

    await tapAt(page, 240, 760);                         // TAP TO RESUME
    check('a tap resumes the run', (await state(page)) === 'playing', await state(page));
    await page.waitForTimeout(400);
    const moving = await snap(page);
    check('...and it carries on from where it stopped', moving.simTime > after.simTime,
      `${after.simTime} -> ${moving.simTime}`);
    await page.screenshot({ path: path.join(SHOTS, 'access_resumed_new_paint.png') });

    /* ================================================== KEYS ========= */
    await page.keyboard.press('KeyP');
    check('P pauses', (await state(page)) === 'paused');
    await page.keyboard.press('Escape');
    check('Esc on the pause screen does not resume', (await state(page)) === 'paused');
    await page.keyboard.press('KeyP');
    check('P resumes', (await state(page)) === 'playing');
    await page.keyboard.press('Escape');
    check('Esc pauses', (await state(page)) === 'paused');
    await page.keyboard.press('KeyP');

    /* ================================================== GAME OVER ==== */
    await page.evaluate(() => window.__SKYHOOK.game.die('fell'));
    await page.waitForFunction('window.__SKYHOOK.game.state === "over" && window.__SKYHOOK.game.overT > 0.5');
    const shipOver = await page.evaluate(() => ({ ...window.__SKYHOOK.game._shipRectNow() }));
    /* js/config.js decides whether there is a LEADERBOARD button above it;
       either way there must be a door, in the row the layout promises. */
    const online = await page.evaluate(() => window.__SKYHOOK.game.online.ready);
    check(`game over has a customise door (${online ? 'under LEADERBOARD' : 'in the leaderboard row'})`,
      shipOver.y === (await rect(page, online ? 'shipRectOver' : 'shipRectOverSolo')).y, JSON.stringify(shipOver));
    if (online) {
      const board = await rect(page, 'boardRectOver');
      check('...clear of the LEADERBOARD button', shipOver.y >= board.y + board.h, `${shipOver.y} vs ${board.y + board.h}`);
    }
    const retry = await rect(page, 'retryRect');
    check('...clear of the RETRY button', shipOver.y >= retry.y + retry.h, `${shipOver.y} vs ${retry.y + retry.h}`);
    await page.screenshot({ path: path.join(SHOTS, 'access_over_before.png') });

    await tapAt(page, ...centre(shipOver));
    check('CUSTOMISE SHIP on game over opens the customiser', await panelOpen(page));
    await tab(page, 'body').click();
    await cell(page, '#ff7a1a').click();                 // Ember body
    await tab(page, 'nose').click();
    await cell(page, '#8a72ff').click();                 // Ion Blue nose
    await page.click('#sh-done');
    check('DONE closes it back onto game over, not into a new run',
      !(await panelOpen(page)) && (await state(page)) === 'over', await state(page));
    await page.screenshot({ path: path.join(SHOTS, 'access_over_after.png') });

    await tapAt(page, ...centre(retry));
    check('RETRY starts a new run', (await state(page)) === 'playing', await state(page));
    const retryKey = await flying(page);
    check('...flying the paint chosen on the game-over screen',
      retryKey.startsWith('#ff7a1a|#8a72ff|') && retryKey.endsWith('|#a8ff1f'), retryKey);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'access_retry_new_paint.png') });

    /* ================================================== RELOAD ======= */
    const want = await saved(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!(window.SK && window.SK.Ship)');
    check('the paint chosen mid-session survives a reload',
      JSON.stringify(await saved(page)) === JSON.stringify(want), JSON.stringify(await saved(page)));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${fails === 0
    ? 'the customiser is reachable mid-session: pause and game over both open it, nothing moves, the paint lands'
    : fails + ' FAILURE(S)'}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
