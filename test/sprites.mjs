/* SKYHOOK sprite-cache gate.
 *
 * js/celestial.js paints every body once and blits it forever. That trade is
 * only good while the WHOLE reachable sprite set fits under CACHE_MAX. One
 * entry past the ceiling and the cache starts evicting things it is about to
 * need again, so the game silently goes back to repainting sprites - at which
 * point the art pass has quietly undone its own reason for existing. Nothing
 * about that failure is visible in a screenshot; it shows up as a phone
 * getting hot.
 *
 * The reachable set was 93 against a ceiling of 96 when this was written:
 * three slots of margin, and ONE new planet class costs four. So this file
 * exists to make adding that class fail loudly, here, instead of quietly, on
 * a player's device.
 *
 * It asserts three things, all through the shipped draw path on a real page:
 *
 *   1. COVERAGE  - the walk below really does reach every class and variant.
 *                  Without this the count assertions could pass by measuring
 *                  less than they claim to.
 *   2. CEILING   - the reachable set fits under CACHE_MAX with real margin,
 *                  nothing is evicted while walking it, and walking it twice
 *                  adds no entries (the cache is being HIT, not rebuilt).
 *   3. POLICY    - eviction is LRU and drops one cold entry, rather than
 *                  flushing the whole cache the way it used to.
 *
 * Run:  node test/sprites.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* How many slots must remain free above the reachable set. Four is one whole
   new planet class (3 disc variants + 1 glow), so this asserts there is room
   to add at least one more class before anyone has to think about it. */
const MIN_HEADROOM = 4;

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

/* ----------------------------------------------------------- in the page */

/* Walks the ENTIRE class roster through SK.Celestial.drawBody / drawMeteor -
   the same functions the game calls - and reports what the cache did. */
function walkRoster() {
  const C = window.SK.Celestial;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');

  const body = (over) => Object.assign({
    kind: 'planet', type: 'node', mass: 1, art: 0,
    x: 128, y: 128, radius: 20, idx: 0, phase: 0.7
  }, over);

  const planetCombos = new Set();   // "classId:variant"
  const starCombos = new Set();
  const planetIds = new Set();
  const starIds = new Set();

  const visit = (n, isStar) => {
    const combo = C.classOf(n).id + ':' + C.variantOf(n);
    (isStar ? starCombos : planetCombos).add(combo);
    (isStar ? starIds : planetIds).add(C.classOf(n).id);
    C.drawBody(ctx, n, 20, true, 0.5, 1.2);
    C.glowFor(n);
  };

  /* Brute force. Class is a function of (kind, type, mass, art) and variant a
     function of art alone, so sweeping both is what reaches every cell. The
     ranges are deliberately generous - this runs in well under a second once
     the sprites are cached, and under-sweeping is the one way this test could
     lie about coverage. */
  const sweepPlanets = () => {
    for (let mi = 0; mi <= 40; mi++) {
      const mass = 0.45 + mi * 0.02;
      for (let art = 0; art < 120; art++) {
        visit(body({ mass: mass, art: art }), false);
        visit(body({ mass: mass, art: art, type: 'decay' }), false);   // SCORCHED
      }
    }
  };

  sweepPlanets();
  for (let mi = 0; mi <= 60; mi++) {
    const mass = 2.0 + mi * 0.05;              // spectral range
    for (let art = 0; art < 120; art++) {
      visit(body({ kind: 'star', mass: mass, art: art }), true);
    }
  }
  for (let art = 0; art < 240; art++) {
    C.drawMeteor(ctx, {
      x: 128, y: 128, homeX: 128, amp: 20, phase: art * 0.3, art: art / 240
    }, 11, 1.2);
  }

  const after = C.cacheStats();

  /* Walk it a second time: if the cache is working, this adds nothing. */
  sweepPlanets();
  const afterTwice = C.cacheStats();

  return {
    after: after, afterTwice: afterTwice,
    nPlanetClasses: Object.keys(C.PLANETS).length,
    nStarClasses: C.STARS.length,
    planetIds: Array.from(planetIds), starIds: Array.from(starIds),
    planetCombos: planetCombos.size, starCombos: starCombos.size
  };
}

/* Proves eviction is LRU rather than a flush. Runs on a FRESH page so the
   ceiling can be lowered without disturbing the roster walk. */
function probeEviction() {
  const C = window.SK.Celestial;

  const before = C.cacheStats();
  const E0 = before.entries;
  const known = {};
  before.keys.forEach((k) => { known[k] = 1; });

  /* Collect nine bodies with nine DISTINCT disc keys that are not already
     cached, so every one of them is a guaranteed miss. */
  const picks = [];
  const taken = {};
  for (let mi = 0; mi <= 40 && picks.length < 9; mi++) {
    for (let art = 0; art < 400 && picks.length < 9; art++) {
      const n = {
        kind: 'planet', type: 'node', mass: 0.45 + mi * 0.02, art: art,
        x: 128, y: 128, radius: 20, idx: 0, phase: 0
      };
      const key = 'planet:' + C.classOf(n).id + ':' + C.variantOf(n);
      if (known[key] || taken[key]) continue;
      taken[key] = 1;
      picks.push({ n: n, key: key });
    }
  }
  if (picks.length < 9) return { error: 'could not find 9 uncached disc keys' };

  /* Ceiling sits exactly at "full after the first eight". */
  const restore = C._setCacheMax(E0 + 8);
  for (let i = 0; i < 8; i++) C.discSprite(picks[i].n);
  const atCap = C.cacheStats();

  C.discSprite(picks[0].n);   // touch: now the most recently used of the nine
  C.discSprite(picks[8].n);   // overflows by exactly one
  const after = C.cacheStats();

  C._setCacheMax(restore);

  const present = (k) => after.keys.indexOf(k) !== -1;
  return {
    E0: E0, cap: E0 + 8, restore: restore,
    atCapEntries: atCap.entries, atCapEvictions: atCap.evictions,
    entries: after.entries, evictions: after.evictions,
    touchedSurvived: present(picks[0].key),
    newestPresent: present(picks[8].key),
    /* picks[1] is the only one that may legitimately be gone - it is the
       least recently used of the nine, and it is what gets dropped when the
       page happened to boot with an empty cache (E0 === 0). */
    midSurvived: picks.slice(2, 8).every((p) => present(p.key))
  };
}

/* ------------------------------------------------------------------ main */

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function newPage(browser, server) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.SK && !!window.SK.Celestial', null, { timeout: 8000 });
  return page;
}

async function main() {
  const server = await startServer();
  const launchOpts = { headless: true, args: ['--mute-audio'] };
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', ...launchOpts }); }
  catch { browser = await chromium.launch(launchOpts); }

  try {
    /* ---------- 1. coverage + ceiling ---------- */
    const page = await newPage(browser, server);
    const r = await page.evaluate(walkRoster);

    const expectedPlanetCombos = r.nPlanetClasses * 3;
    const expectedStarCombos = r.nStarClasses * 3;
    const reachable =
      expectedPlanetCombos + expectedStarCombos +   // disc sprites
      r.nPlanetClasses + r.nStarClasses +           // per-class glows
      r.nStarClasses +                              // coronae (stars only)
      6 + 1;                                        // meteoroid silhouettes + glow

    console.log(`\nroster: ${r.nPlanetClasses} planet classes, ${r.nStarClasses} spectral classes`);
    console.log(`reachable sprites: ${reachable}   entries after walk: ${r.after.entries}   ceiling: ${r.after.max}`);

    check('walk reaches every planet class', r.planetIds.length === r.nPlanetClasses,
      `${r.planetIds.length}/${r.nPlanetClasses}`);
    check('walk reaches every spectral class', r.starIds.length === r.nStarClasses,
      `${r.starIds.length}/${r.nStarClasses}`);
    check('walk reaches all 3 variants of every planet class',
      r.planetCombos === expectedPlanetCombos, `${r.planetCombos}/${expectedPlanetCombos}`);
    check('walk reaches all 3 variants of every spectral class',
      r.starCombos === expectedStarCombos, `${r.starCombos}/${expectedStarCombos}`);

    check('cache entries match the predicted reachable set',
      r.after.entries === reachable, `entries=${r.after.entries} predicted=${reachable}`);
    check('nothing was evicted while walking the whole roster',
      r.after.evictions === 0, `evictions=${r.after.evictions}`);
    check(`reachable set leaves at least ${MIN_HEADROOM} free slots under CACHE_MAX`,
      reachable + MIN_HEADROOM <= r.after.max,
      `${reachable} + ${MIN_HEADROOM} vs ceiling ${r.after.max}` +
      (reachable + MIN_HEADROOM <= r.after.max ? '' :
        '  -- RAISE CACHE_MAX in js/celestial.js; do not lower this test'));
    check('a second full walk adds no entries (sprites are being reused)',
      r.afterTwice.entries === r.after.entries && r.afterTwice.evictions === 0,
      `entries ${r.after.entries} -> ${r.afterTwice.entries}, evictions=${r.afterTwice.evictions}`);

    /* ---------- 2. eviction policy ---------- */
    const page2 = await newPage(browser, server);
    const e = await page2.evaluate(probeEviction);
    if (e.error) {
      check('eviction probe could set up', false, e.error);
    } else {
      console.log(`\neviction probe: baseline ${e.E0} entries, ceiling lowered to ${e.cap}, restored to ${e.restore}`);
      check('cache fills to the ceiling without evicting early',
        e.atCapEntries === e.cap && e.atCapEvictions === 0,
        `entries=${e.atCapEntries} expected=${e.cap} evictions=${e.atCapEvictions}`);
      check('overflow evicts exactly one entry, not the whole cache',
        e.evictions === 1, `evictions=${e.evictions}`);
      check('cache stays full after eviction (a flush would collapse it)',
        e.entries === e.cap, `entries=${e.entries} expected=${e.cap}`);
      check('the least-recently-used entry is the one dropped',
        e.touchedSurvived && e.newestPresent && e.midSurvived,
        `touched=${e.touchedSurvived} newest=${e.newestPresent} others=${e.midSurvived}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
