/* SKYHOOK ship customiser - the panel, in a real browser.
 *
 * test/ship.mjs proves the MODEL: every combination readable, gold over the
 * parts, the paint persisted. This file proves the thing a player touches
 * actually drives that model, with real clicks rather than calls:
 *
 *   - four part tabs, and the grid paints whichever one is selected
 *   - a colour that would hide a part on THIS ship is greyed, says why, and
 *     a real click on it changes nothing
 *   - a legal click repaints the live preview and the part's tab dot
 *   - the keyboard skips refused colours instead of dead-ending on them
 *   - the paint survives a reload
 *   - ?gold=1 shows gold without touching the paint underneath
 *
 * No backend: the customiser is a local feature and must work with none.
 *
 * Run:  node test/ship_ui.mjs   [--headed]
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

const saved = page => page.evaluate(() => window.SK.Ship.saved());
const preview = page => page.evaluate(() => document.getElementById('sh-canvas').toDataURL());
const cell = (page, hex) => page.locator(`#sh-swatches .sh-swatch[data-hex="${hex}"]`);
const tab = (page, part) => page.locator(`#sh-parts .sh-part[data-part="${part}"]`);

async function openPanel(page) {
  await page.waitForFunction('!!(window.SK && window.SK.UIShip)', null, { timeout: 8000 });
  await page.evaluate(() => window.SK.UIShip.open());
  await page.waitForSelector('#sh:not([hidden])');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
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
    await openPanel(page);

    /* --- structure --- */
    const labels = await page.$$eval('#sh-parts .sh-part', ns => ns.map(n => n.textContent.trim()));
    check('four part tabs: Nose, Window, Body, Fire', JSON.stringify(labels) === '["Nose","Window","Body","Fire"]',
      JSON.stringify(labels));
    check('Body is the part selected on open',
      (await tab(page, 'body').getAttribute('aria-selected')) === 'true');
    const menuSize = await page.evaluate(() => window.SK.Ship.SWATCHES.length);
    check('every menu colour plus the locked gold', (await page.locator('#sh-swatches .sh-swatch').count()) === menuSize + 1,
      String(menuSize));

    /* --- the refusal, through a real click --- */
    await tab(page, 'window').click();
    check('clicking the Window tab selects it',
      (await tab(page, 'window').getAttribute('aria-selected')) === 'true' &&
      (await page.getAttribute('#sh-swatches', 'aria-label')) === 'Window colour');
    const blocked = await page.$$eval('#sh-swatches .sh-swatch.is-blocked', ns => ns.map(n => n.getAttribute('data-hex')));
    check('on the default hull, the Nova White window - and only it - is greyed out',
      JSON.stringify(blocked) === '["#ffffff"]', JSON.stringify(blocked));
    check('a greyed colour tells a screen reader why',
      /unavailable: .*vanish/i.test(await cell(page, '#ffffff').getAttribute('aria-label') || ''),
      await cell(page, '#ffffff').getAttribute('aria-label'));

    const before = await saved(page);
    const pic0 = await preview(page);
    /* force: Playwright will not click an aria-disabled element, but a
       player's finger will - aria-disabled is an explanation, not a wall -
       and what happens when it does is exactly what is being tested. Still a
       real mouse event at the element's position. */
    await cell(page, '#ffffff').click({ force: true });
    check('a real click on a refused colour changes nothing',
      JSON.stringify(await saved(page)) === JSON.stringify(before));
    check('...and says why', /vanish/i.test(await page.textContent('#sh-msg')), await page.textContent('#sh-msg'));
    check('...and the preview did not move', (await preview(page)) === pic0);

    /* --- a legal click, per part, live --- */
    await cell(page, '#ff2bd6').click();
    const pic1 = await preview(page);
    check('a legal window colour is painted', (await saved(page)).window === '#ff2bd6');
    check('the preview repainted live', pic1 !== pic0);
    check('the Window tab dot shows the new colour',
      (await tab(page, 'window').locator('.sh-dot').evaluate(n => getComputedStyle(n).backgroundColor)) === 'rgb(255, 43, 214)');

    await tab(page, 'nose').click();
    await cell(page, '#ff7a1a').click();
    await tab(page, 'fire').click();
    await cell(page, '#a8ff1f').click();
    await tab(page, 'body').click();
    await cell(page, '#ff3b30').click();
    const want = { nose: '#ff7a1a', window: '#ff2bd6', body: '#ff3b30', fire: '#a8ff1f' };
    check('each part took its own colour, independently',
      JSON.stringify(await saved(page)) === JSON.stringify(want), JSON.stringify(await saved(page)));
    await page.screenshot({ path: path.join(SHOTS, 'ship_panel_parts.png') });

    /* --- keyboard: arrows skip what cannot be chosen --- */
    await page.evaluate(() => window.SK.Ship.reset());
    await tab(page, 'window').click();
    await cell(page, '#35e6ff').focus();
    await page.keyboard.press('ArrowRight');
    let landed = await page.evaluate(() => document.activeElement.getAttribute('data-hex'));
    check('ArrowRight from Signal Cyan paints the next colour, Azure',
      landed === '#1a9dff' && (await saved(page)).window === '#1a9dff', landed);
    /* Signal Cyan is first in the grid, so ArrowLeft wraps round the end of
       it: past the locked gold AND the refused Nova White, onto Mint. */
    await cell(page, '#35e6ff').click();
    await cell(page, '#35e6ff').focus();
    await page.keyboard.press('ArrowLeft');
    landed = await page.evaluate(() => document.activeElement.getAttribute('data-hex'));
    check('ArrowLeft from Signal Cyan wraps past the locked gold and the refused Nova White',
      landed === '#1affb0' && (await saved(page)).window === '#1affb0', landed);

    /* --- persistence across a reload --- */
    for (const k of Object.keys(want)) {
      await page.evaluate(([p, h]) => window.SK.Ship.set(p, h), [k, want[k]]);
    }
    await page.reload({ waitUntil: 'load' });
    await openPanel(page);
    check('the four-part paint survives a reload',
      JSON.stringify(await saved(page)) === JSON.stringify(want), JSON.stringify(await saved(page)));

    /* --- backdrop dismiss, Android WebView order (see js/ui_ship.js) ---
       The click the WebView synthesises after the opening tap lands on the
       backdrop with no pointerdown of its own: the panel must stay. */
    const synthClick = (p) => p.evaluate(() => {
      document.getElementById('sh').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await synthClick(page);
    await page.waitForTimeout(150);
    check('a click synthesised onto the backdrop right after opening does not close the panel',
      (await page.locator('#sh').isVisible()) === true);
    /* A pointerdown on the backdrop whose click never comes (Escape closes
       first) must not stay armed and close the NEXT open on its own. */
    await page.evaluate(() => {
      document.getElementById('sh').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sh[hidden]', { state: 'attached' });
    await openPanel(page);
    await synthClick(page);
    await page.waitForTimeout(150);
    check('a stale backdrop pointerdown from before an Escape does not close the next open',
      (await page.locator('#sh').isVisible()) === true);
    /* ...and a tap that genuinely starts on the backdrop still closes it. */
    await page.locator('#sh').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    check('a tap that starts on the backdrop still closes the panel',
      (await page.locator('#sh').isVisible()) === false);
    await openPanel(page);

    /* --- the crown preview --- */
    const gold = await ctx.newPage();
    gold.on('pageerror', e => errors.push(e.message));
    await gold.goto(base + '?gold=1', { waitUntil: 'load' });
    await openPanel(gold);
    const g = await gold.evaluate(() => ({
      cur: window.SK.Ship.current(), mine: window.SK.Ship.saved(), GOLD: window.SK.Ship.GOLD,
      note: document.getElementById('sh-crown').textContent, hidden: document.getElementById('sh-crown').hidden
    }));
    check('?gold=1 flies gold on every part',
      ['nose', 'window', 'body', 'fire'].every(k => g.cur[k] === g.GOLD), JSON.stringify(g.cur));
    check('...while the paint underneath is untouched', JSON.stringify(g.mine) === JSON.stringify(want),
      JSON.stringify(g.mine));
    check('...and it is labelled a preview, not a rank', !g.hidden && /^Preview/.test(g.note), g.note);
    await gold.screenshot({ path: path.join(SHOTS, 'ship_panel_gold.png') });

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${fails === 0 ? 'ship customiser holds in a real browser' : fails + ' FAILURE(S)'}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
