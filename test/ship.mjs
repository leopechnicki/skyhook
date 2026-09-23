/* SKYHOOK ship-paint gate  -  the customiser, made falsifiable.
 *
 * Painting the ship touched three things that are easy to break quietly, so
 * each one is asserted here rather than looked at:
 *
 *   1. THE DEFAULT SHIP DID NOT CHANGE. js/rocket.js used to hold six colour
 *      constants; it now DERIVES them from one hex. A player who never opens
 *      the customiser must see the ship they already had, so resolve('#35e6ff')
 *      is measured against the literal old constants.
 *
 *   2. NO COLOUR CAN MAKE THE SHIP INVISIBLE. Every swatch has to clear a
 *      luminance floor against the near-black starfield. Adding a fashionable
 *      near-black to the menu has to fail the build, not ship.
 *
 *   3. THE CROWN IS EARNED, NOT STORED. Gold is not on the menu, so it cannot
 *      be selected, persisted or hand-edited into localStorage; it is only
 *      ever worn while the leaderboard says this player is #1, and every way
 *      of NOT knowing that (offline, unconfigured, empty board, a failed read)
 *      has to degrade to the player's own colour rather than to gold or to a
 *      blank ship.
 *
 * And one cost check: making the paint configurable turned two "one entry,
 * forever" sprite caches into per-colour caches, which is the one way this
 * change could have undone the art pass. Both are walked past their ceilings
 * here and must evict rather than grow.
 *
 * Pure Node, no browser, sub-second - js/ship.js is deliberately loadable with
 * no DOM and js/rocket.js only needs a canvas factory.
 *
 * Run:  node test/ship.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

/* Same no-op canvas the world-stream harness uses: js/rocket.js bakes sprites
   on load-ish paths and must not need a real 2d context to be reasoned about. */
function fakeCanvas() {
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'canvas') return null;
      return typeof t[k] === 'function' ? t[k] : () => {};
    },
    set: () => true
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

/* A sandbox per case, so one test's stored colour cannot leak into the next.
   `storage` is handed back so persistence can be asserted at the bytes rather
   than by asking the module what it thinks it saved. */
function load() {
  const storage = new Map();
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }
  };

  const sandbox = { Math, Date, console, JSON, Proxy, localStorage };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => fakeCanvas() };

  for (const f of ['js/utils.js', 'js/ship.js', 'js/rocket.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
  }
  return { SK: sandbox.SK, storage };
}

const dist = (a, b) => Math.sqrt(
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/* ==========================================================================
 * 1. The menu itself
 * ======================================================================= */
{
  const { SK } = load();
  const S = SK.Ship;

  check('the customiser loads with no DOM at all', !!S && typeof S.current === 'function');

  const hexes = S.SWATCHES.map(s => s.hex);
  check('every swatch is a lowercase 6-digit hex',
    hexes.every(h => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(hexes.filter(h => !/^#[0-9a-f]{6}$/.test(h))));
  check('no colour appears twice in the menu', new Set(hexes).size === hexes.length);
  check('every swatch has a name a screen reader can act on',
    S.SWATCHES.every(s => typeof s.name === 'string' && s.name.length >= 3));

  /* The one that matters. The ship is a ~40px sprite on a #060713 field; a
     colour under the floor is a ship the player cannot see, and "I painted it
     and now the game is broken" is indistinguishable from a bug. */
  const dark = S.SWATCHES.filter(s => S.luma(s.hex) < S.LUMA_FLOOR);
  check(`every swatch clears the luminance floor (${S.LUMA_FLOOR})`,
    dark.length === 0, JSON.stringify(dark.map(s => `${s.name} ${S.luma(s.hex).toFixed(3)}`)));
  const dimmest = S.SWATCHES.reduce((a, b) => (S.luma(a.hex) <= S.luma(b.hex) ? a : b));
  console.log(`      dimmest swatch: ${dimmest.name} at ${S.luma(dimmest.hex).toFixed(3)}` +
              `, backdrop #060713 at ${S.luma('#060713').toFixed(5)}`);

  check('the default is on the menu', S.isSwatch(S.DEFAULT));

  /* Gold is a rank, not a taste. The moment it is selectable it stops meaning
     anything. */
  check('champion gold is NOT on the menu', !S.isSwatch(S.GOLD));

  /* ...and it must not be confusable with the nearest thing that IS. */
  const g = S.rgb(S.GOLD);
  const closest = S.SWATCHES
    .map(s => ({ s, d: dist(g, S.rgb(s.hex)) }))
    .sort((a, b) => a.d - b.d)[0];
  const GOLD_GAP = 48;
  check(`the nearest selectable colour is clearly not gold (>= ${GOLD_GAP})`,
    closest.d >= GOLD_GAP, `${closest.s.name} at ${closest.d.toFixed(1)}`);
}

/* ==========================================================================
 * 2. Nothing off the menu can ever be painted
 * ======================================================================= */
{
  const { SK, storage } = load();
  const S = SK.Ship;

  const junk = ['', null, undefined, '#000', 'red', '#00000', 'javascript:1',
    '#0000zz', '  ', '#060713', S.GOLD];
  const leaked = junk.filter(v => S.normalise(v) !== S.DEFAULT);
  check('anything not on the menu normalises to the default - including gold',
    leaked.length === 0, JSON.stringify(leaked));

  check('set() refuses an off-menu colour', S.set('#000000') === false);
  check('...and refusing it did not change the ship', S.current() === S.DEFAULT);
  check('set() refuses gold specifically', S.set(S.GOLD) === false && S.current() === S.DEFAULT);

  const pick = S.SWATCHES[6].hex;
  check('set() accepts a menu colour and reports the change', S.set(pick) === true);
  check('...and the ship is that colour', S.current() === pick);
  check('setting the same colour twice is a no-op', S.set(pick) === false);
  check('the choice is written to local storage, not just held in memory',
    storage.get(S.STORE_KEY) === pick, String(storage.get(S.STORE_KEY)));

  check('reset() puts the shipped ship back', S.reset() === true && S.current() === S.DEFAULT);
}

/* ==========================================================================
 * 3. A hand-edited localStorage entry cannot mint a gold ship
 * ======================================================================= */
{
  const { SK, storage } = load();
  storage.set(SK.Ship.STORE_KEY, SK.Ship.GOLD);
  SK.Ship._reload();
  check('a forged gold value in storage loads as the default, not as gold',
    SK.Ship.current() === SK.Ship.DEFAULT, SK.Ship.current());
}
{
  const { SK, storage } = load();
  storage.set(SK.Ship.STORE_KEY, '#ff7edb');
  SK.Ship._reload();
  check('a real saved colour survives a reload', SK.Ship.current() === '#ff7edb');
}

/* ==========================================================================
 * 4. The crown: who gets it, and what every kind of "don't know" does
 * ======================================================================= */
{
  const { SK } = load();
  const S = SK.Ship;
  S.set('#ff7edb');

  /* The degradation table. Each row is a real state the game reaches: no
     backend, a dead read, an empty board, a signed-out player. Every one of
     them has to land on the player's own colour - never gold, never blank. */
  const cases = [
    ['no backend at all (champion never set)', '', '', false],
    ['signed out, board readable', 'someone', '', false],
    ['signed in, board unreachable', '', 'leo', false],
    ['signed in, board empty', '', 'leo', false],
    ['signed in, someone else is #1', 'klaudia', 'leo', false],
    ['signed in and #1', 'leo', 'leo', true],
    ['#1, name cased differently by the server', 'LEO', 'leo', true]
  ];
  for (const [what, champ, me, want] of cases) {
    S.setChampionName(champ);
    S.setPlayerName(me);
    check(`${what}: ${want ? 'gold' : 'own colour'}`,
      S.isChampion() === want && S.current() === (want ? S.GOLD : '#ff7edb'),
      S.current());
  }

  /* The bug this shape is most likely to grow: two empty names comparing
     equal and handing the crown to every offline player at once. */
  S.setChampionName('');
  S.setPlayerName('');
  check('an unknown champion does not match an unknown player', !S.isChampion());

  /* Losing the top spot mid-session gives the player their colour straight
     back, without them having to do anything. */
  S.setChampionName('leo'); S.setPlayerName('leo');
  const crowned = S.current();
  S.setChampionName('klaudia');
  check('losing #1 returns the ship to the colour underneath the crown',
    crowned === S.GOLD && S.current() === '#ff7edb');

  check('the crown never overwrites the stored colour', S.saved() === '#ff7edb');

  /* Every appearance change has to reach the renderer and the panel. */
  let beats = 0;
  S.onChange(() => { beats++; });
  S.setChampionName('leo');
  S.set('#4dffb4');
  check('onChange fires for both a new crown and a new colour', beats === 2, String(beats));

  /* A listener that throws must not take the paint - or the game - down. */
  S.onChange(() => { throw new Error('bad listener'); });
  let survived = true;
  try { S.set('#ffd166'); } catch (e) { survived = false; }
  check('a broken listener cannot break the ship', survived);

  /* forceChampion is the local preview hook (?gold=1, screenshots, this
     file). It must be cosmetic: visible, and never written down. */
  const { SK: SK2, storage } = load();
  SK2.Ship.set('#b6ff6a');
  SK2.Ship.forceChampion(true);
  check('a previewed crown paints gold', SK2.Ship.current() === SK2.Ship.GOLD);
  check('...but is not a real crown', SK2.Ship.isChampion() && !SK2.Ship.isCrowned());
  check('...and is never persisted', storage.get(SK2.Ship.STORE_KEY) === '#b6ff6a');
}

/* ==========================================================================
 * 5. The default ship did not change
 * ======================================================================
 * The six constants js/rocket.js held before the paint was configurable. If
 * the derivation drifts, a player who never opened the customiser gets a
 * restyled ship - the one regression this whole feature could cause for
 * somebody who never used it. */
{
  const { SK } = load();
  const R = SK.Rocket;
  const OLD = {
    hull: [236, 246, 255],
    hullD: [104, 132, 158],
    trim: [53, 230, 255],
    glass: [140, 240, 255],
    fire: [120, 226, 255]
  };
  const c = R.resolve('#35e6ff');

  check('the trim is the colour itself, exactly', dist(c.trim, OLD.trim) === 0, JSON.stringify(c.trim));
  check('the shaded flank is the old constant, exactly',
    dist(c.hullD, OLD.hullD) === 0, JSON.stringify(c.hullD));
  check('the plating is the old plating within 8 channel steps',
    near(c.hull, OLD.hull, 8), `${JSON.stringify(c.hull)} vs ${JSON.stringify(OLD.hull)}`);
  check('the glass is the old glass within 8 channel steps',
    near(c.glass, OLD.glass, 8), `${JSON.stringify(c.glass)} vs ${JSON.stringify(OLD.glass)}`);
  /* Looser, and deliberately so: the plume's mid stop is the one value the
     derivation moves on purpose, so that a gold ship does not trail a cyan
     exhaust. Still gated, to catch a gross drift. */
  check('the plume mid-tone is in the neighbourhood of the old one',
    near(c.fire, OLD.fire, 16), `${JSON.stringify(c.fire)} vs ${JSON.stringify(OLD.fire)}`);

  /* Whatever arrives, a channel is never NaN: a NaN channel renders as
     transparent black, which is the invisible ship the menu exists to
     prevent. */
  const bad = ['', null, undefined, 'not-a-colour', '#zzzzzz'];
  const broken = bad.filter(v => {
    const r = R.resolve(v);
    return [r.hull, r.hullD, r.trim, r.glass, r.fire, r.fireCool]
      .some(ch => ch.some(n => !Number.isFinite(n)));
  });
  check('an unreadable colour falls back rather than painting NaN',
    broken.length === 0, JSON.stringify(broken));

  /* And the fallback is the shipped ship, so js/rocket.js is still loadable
     on its own with js/ship.js absent. */
  check('with no colour given, the resolved key is a real colour',
    /^#[0-9a-f]{6}$/.test(R.resolve().key), R.resolve().key);

  /* Gold has to resolve to a ship that reads as gold rather than as
     yellow-white plating with a gold rim. */
  const gold = R.resolve(SK.Ship.GOLD);
  check('the champion hull is visibly warmer than the default one',
    gold.hull[0] > c.hull[0] && gold.hull[2] < c.hull[2],
    `${JSON.stringify(gold.hull)} vs ${JSON.stringify(c.hull)}`);
}

/* ==========================================================================
 * 6. Per-colour sprite caches stay bounded
 * ======================================================================
 * Before this change both caches were "one entry, forever". Keying them by
 * colour is what makes the customiser instant, and it is also how the art
 * pass could silently become a memory leak. Walk far more colours than a
 * player could produce and the ceilings must hold. */
{
  const { SK } = load();
  const R = SK.Rocket;
  const g = fakeCanvas().getContext('2d');

  const before = R.cacheStats();
  check('the caches declare their own ceilings',
    before.hullMax > 0 && before.flameMax > 0 && before.bloomMax > 0,
    JSON.stringify(before));

  /* 64 distinct colours, each at several burn levels - two orders of
     magnitude past the one or two a session actually sees. */
  for (let i = 0; i < 64; i++) {
    const hex = '#' + ((i * 4013 + 0x2244aa) & 0xffffff).toString(16).padStart(6, '0');
    for (const burn of [0, 0.25, 0.5, 0.75, 1]) {
      R.draw(g, 100, 100, 0, 14, i * 0.1, { burn, thrust: 0.4, colour: hex });
    }
  }

  const after = R.cacheStats();
  check('the hull cache evicted rather than grew',
    after.hull <= after.hullMax, `${after.hull}/${after.hullMax}`);
  check('the flame cache evicted rather than grew',
    after.flame <= after.flameMax, `${after.flame}/${after.flameMax}`);
  check('the bloom cache is still per-burn-bucket only (colour-independent)',
    after.bloom <= after.bloomMax, `${after.bloom}/${after.bloomMax}`);
  console.log(`      after 64 colours x 5 burn levels: hull ${after.hull}/${after.hullMax}` +
              `  flame ${after.flame}/${after.flameMax}  bloom ${after.bloom}/${after.bloomMax}`);
}

/* ==========================================================================
 * 7. The markup and the model cannot drift apart
 * ======================================================================
 * The swatch grid is built from SK.Ship.SWATCHES at runtime, so there is one
 * definition of the menu. What can still drift is the wiring: the panel's
 * elements, the script tag that loads the model, and the title-screen button
 * that is the entire answer to "I don't see the option". */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

  for (const id of ['sh', 'sh-close', 'sh-canvas', 'sh-crown', 'sh-swatches',
    'sh-msg', 'sh-done', 'sh-reset']) {
    check(`index.html still has #${id}`, html.includes(`id="${id}"`));
  }
  /* Script ORDER, matched on the tags rather than on the filenames: the
     panel's own comments name these files too, so a plain indexOf finds the
     prose long before the <script>. */
  const tag = f => html.indexOf(`src="${f}"`);
  check('js/ship.js is loaded BEFORE js/rocket.js paints with it',
    tag('js/ship.js') > 0 && tag('js/ship.js') < tag('js/rocket.js'),
    `${tag('js/ship.js')} vs ${tag('js/rocket.js')}`);
  check('js/ui_ship.js is loaded after the game instance exists',
    tag('js/ui_ship.js') > tag('js/main.js'),
    `${tag('js/ui_ship.js')} vs ${tag('js/main.js')}`);

  /* Discoverability, asserted. The feature "exists" in a build where the only
     way to reach it is to know it is there - which is the same as it not
     existing, and is exactly the state this change was opened to fix. */
  check('the title screen draws a labelled CUSTOMISE SHIP button',
    /_drawPanelButton\([^)]*shipRect[^)]*CUSTOMISE SHIP/.test(game.replace(/\s+/g, ' ')));
  check('that button is hit-tested on the title screen',
    /inRect\(this\.shipRect/.test(game));
  check('the panel it opens is styled rather than shipped bare',
    css.includes('.sh-swatch') && css.includes('.sh-preview'));
}

/* ==========================================================================
 * 8. The colour follows the account - without becoming a dependency
 * ======================================================================
 * Two claims, and they pull in opposite directions, so both are asserted:
 *
 *   - the menu the client shows and the allow-list the DATABASE enforces are
 *     the same list. The client is attacker-controlled; if the server does
 *     not hold the same rule, "you cannot paint yourself invisible" and "gold
 *     cannot be stored" are decorations rather than rules.
 *
 *   - and none of it is load-bearing. Signed out, unconfigured or offline,
 *     both calls have to answer quietly rather than reject, because the
 *     colour is already saved locally and already on screen.
 */
{
  const { SK } = load();
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();

  check('the column exists and is added idempotently',
    norm.includes('add column if not exists ship_colour text'));

  const listed = ((/check \(ship_colour is null or ship_colour in \(([^)]*)\)/i
    .exec(sql.replace(/--.*/g, '')) || [, ''])[1]
    .match(/#[0-9a-f]{6}/gi) || []).map(h => h.toLowerCase());
  const menu = SK.Ship.SWATCHES.map(s => s.hex).slice().sort();
  check('the database allow-list is exactly the menu the client shows',
    JSON.stringify(listed.slice().sort()) === JSON.stringify(menu),
    JSON.stringify(listed));
  check('champion gold cannot be stored on an account either',
    !listed.includes(SK.Ship.GOLD));

  /* Why a cosmetic column did not cost the schema its central rule. */
  /* This used to assert that profiles had NO update policy at all. That was
     true when the colour landed and stopped being true when account settings
     landed: renaming yourself needs profiles_update_own. The assertion did
     not catch the change - its regex wanted "for update" BEFORE
     "on public.profiles" and the schema writes them the other way round - so
     it kept passing while describing a schema that no longer existed.
     Replaced with the invariant that actually protects this column: whatever
     UPDATE a player has been granted, it is column-scoped and ship_colour is
     not one of the columns. */
  check('the UPDATE a player is granted is column-scoped, not the whole row',
    /grant\s+update\s*\(/.test(norm) && !/grant\s+update\s+on\s+public\.profiles/.test(norm));
  check('ship_colour is NOT in that column grant - the rename path cannot repaint',
    !/grant\s+update\s*\([^)]*ship_colour[^)]*\)\s*on\s+public\.profiles/.test(norm));
  check('the only write path is a security-definer function scoped to auth.uid()',
    norm.includes('create or replace function public.set_ship_colour') &&
    norm.includes('security definer') &&
    norm.includes('update public.profiles set ship_colour = want where id = auth.uid()'));
  check('...and that function is not callable with the anon key',
    norm.includes('revoke execute on function public.set_ship_colour(text) from anon, public') &&
    norm.includes('grant execute on function public.set_ship_colour(text) to authenticated'));
  check('the rename path is untouched - the function writes ship_colour and nothing else',
    !/set_ship_colour[\s\S]*?\$\$;/i.exec(sql)[0].toLowerCase().includes('username'));
}

{
  /* Offline, both calls must be non-events rather than errors. No fetch at
     all in this sandbox: the harshest version of "there is no network". */
  const sandbox = { Math, Date, console, JSON, Promise, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.location = { href: 'https://skyhookplay.com/', origin: 'https://skyhookplay.com', pathname: '/', search: '', hash: '' };
  sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  sandbox.document = { createElement: () => fakeCanvas() };
  for (const f of ['js/utils.js', 'js/online.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
  }
  const O = sandbox.SK.Online;
  check('js/online.js exposes both halves of the account sync',
    typeof O.saveShipColour === 'function' && typeof O.loadShipColour === 'function');

  const saved = await O.saveShipColour('#ff7edb');
  const loaded = await O.loadShipColour();
  check('saving with no backend resolves false rather than rejecting', saved === false, String(saved));
  check('loading with no backend resolves empty rather than rejecting', loaded === '', JSON.stringify(loaded));
}

console.log(`\n${fails === 0
  ? 'ship paint holds: the default ship is unchanged, no colour hides the ship, and gold is worn not picked'
  : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
