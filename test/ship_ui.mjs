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
    check('twelve colours plus the locked gold', (await page.locator('#sh-swatches .sh-swatch').count()) === 13);

    /* --- the refusal, through a real click --- */
    await tab(page, 'window').click();
    check('clicking the Window tab selects it',
      (await tab(page, 'window').getAttribute('aria-selected')) === 'true' &&
      (await page.getAttribute('#sh-swatches', 'aria-label')) === 'Window colour');
    const blocked = await page.$$eval('#sh-swatches .sh-swatch.is-blocked', ns => ns.map(n => n.getAttribute('data-hex')));
    check('on the default hull, Ice and Hull White windows are greyed out',
      blocked.includes('#8af4ff') && blocked.includes('#ecf6ff'), JSON.stringify(blocked));
    check('a greyed colour tells a screen reader why',
      /unavailable: .*vanish/i.test(await cell(page, '#ecf6ff').getAttribute('aria-label') || ''),
      await cell(page, '#ecf6ff').getAttribute('aria-label'));

    const before = await saved(page);
    const pic0 = await preview(page);
    /* force: Playwright will not click an aria-disabled element, but a
       player's finger will - aria-disabled is an explanation, not a wall -
       and what happens when it does is exactly what is being tested. Still a
       real mouse event at the element's position. */
    await cell(page, '#ecf6ff').click({ force: true });
    check('a real click on a refused colour changes nothing',
      JSON.stringify(await saved(page)) === JSON.stringify(before));
    check('...and says why', /vanish/i.test(await page.textContent('#sh-msg')), await page.textContent('#sh-msg'));
    check('...and the preview did not move', (await preview(page)) === pic0);

    /* --- a legal click, per part, live --- */
    await cell(page, '#ff7edb').click();
    const pic1 = await preview(page);
    check('a legal window colour is painted', (await saved(page)).window === '#ff7edb');
    check('the preview repainted live', pic1 !== pic0);
    check('the Window tab dot shows the new colour',
      (await tab(page, 'window').locator('.sh-dot').evaluate(n => getComputedStyle(n).backgroundColor)) === 'rgb(255, 126, 219)');

    await tab(page, 'nose').click();
    await cell(page, '#ff9d4d').click();
    await tab(page, 'fire').click();
    await cell(page, '#b6ff6a').click();
    await tab(page, 'body').click();
    await cell(page, '#ff6b7d').click();
    const want = { nose: '#ff9d4d', window: '#ff7edb', body: '#ff6b7d', fire: '#b6ff6a' };
    check('each part took its own colour, independently',
      JSON.stringify(await saved(page)) === JSON.stringify(want), JSON.stringify(await saved(page)));
    await page.screenshot({ path: path.join(SHOTS, 'ship_panel_parts.png') });

    /* --- keyboard: arrows skip what cannot be chosen --- */
    await page.evaluate(() => window.SK.Ship.reset());
    await tab(page, 'window').click();
    await cell(page, '#35e6ff').focus();
    await page.keyboard.press('ArrowRight');
    const landed = await page.evaluate(() => document.activeElement.getAttribute('data-hex'));
    check('ArrowRight from Signal Cyan skips the refused Ice and Hull White',
      landed === '#9db4d6' && (await saved(page)).window === '#9db4d6', landed);

    /* --- persistence across a reload --- */
    for (const k of Object.keys(want)) {
      await page.evaluate(([p, h]) => window.SK.Ship.set(p, h), [k, want[k]]);
    }
    await page.reload({ waitUntil: 'load' });
    await openPanel(page);
    check('the four-part paint survives a reload',
      JSON.stringify(await saved(page)) === JSON.stringify(want), JSON.stringify(await saved(page)));

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
