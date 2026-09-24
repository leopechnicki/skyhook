/* SKYHOOK ship-paint gate  -  the customiser, made falsifiable.
 *
 * Painting the ship per part (nose / window / body / fire) touches several
 * things that are easy to break quietly, so each one is asserted here rather
 * than looked at:
 *
 *   1. THE DEFAULT SHIP DID NOT CHANGE. js/rocket.js used to hold six colour
 *      constants; it now DERIVES them from the paint. A player who never opens
 *      the customiser must see the ship they already had, so the default paint
 *      is measured against the literal old constants.
 *
 *   2. NO COMBINATION CAN MAKE THE SHIP UNREADABLE. With one colour, a menu of
 *      individually-visible colours was enough. With four it is not - a pale
 *      window on a pale hull vanishes - so the rule is on the COMBINATION, and
 *      every one of the N^4 menu combinations is walked through both the
 *      gate (normalise) and the tap path (set).
 *
 *   3. THE CROWN IS EARNED, NOT STORED, AND IT GIVES THE PAINT BACK. Gold
 *      covers all four parts while the leaderboard says this player is #1,
 *      is never persisted, and the moment the crown goes the player's own
 *      four parts come back exactly.
 *
 *   4. THE PAINT PERSISTS. Choose, save, reload - locally, and through the
 *      account against a stand-in server that enforces the same allow-list
 *      supabase/schema.sql does. (test/ship_live.mjs does the same round trip
 *      against the real staging project.)
 *
 * And one cost check: per-part paint means per-paint sprite caches, which is
 * the one way this could undo the art pass. Both are walked far past their
 * ceilings and must evict rather than grow.
 *
 * Pure Node, no browser, no network, about a second.
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

/* A sandbox per case, so one test's stored paint cannot leak into the next.
   `storage` is handed back - or handed IN, to simulate a reload of the same
   browser - so persistence is asserted at the bytes rather than by asking the
   module what it thinks it saved. `extra` adds scripts (js/online.js) and
   globals (a fake fetch). */
function load({ storage = new Map(), files = [], globals = {} } = {}) {
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }
  };

  const sandbox = { Math, Date, console, JSON, Proxy, Promise, setTimeout, clearTimeout,
    localStorage, ...globals };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => fakeCanvas() };

  for (const f of ['js/utils.js', 'js/ship.js', 'js/rocket.js', ...files]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
  }
  return { SK: sandbox.SK, storage };
}

const dist = (a, b) => Math.sqrt(
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = o => JSON.parse(JSON.stringify(o));   // out of the vm realm

/* ==========================================================================
 * 1. The menu and the parts
 * ======================================================================= */
{
  const { SK } = load();
  const S = SK.Ship;

  check('the customiser loads with no DOM at all', !!S && typeof S.current === 'function');
  check('the four parts are nose, window, body, fire',
    same(plain(S.PARTS), ['nose', 'window', 'body', 'fire']), JSON.stringify(S.PARTS));

  const hexes = S.SWATCHES.map(s => s.hex);
  check('every swatch is a lowercase 6-digit hex',
    hexes.every(h => /^#[0-9a-f]{6}$/.test(h)), JSON.stringify(hexes.filter(h => !/^#[0-9a-f]{6}$/.test(h))));
  check('no colour appears twice in the menu', new Set(hexes).size === hexes.length);
  check('every swatch has a name a screen reader can act on',
    S.SWATCHES.every(s => typeof s.name === 'string' && s.name.length >= 3));

  /* The ship is a ~40px sprite on a #060713 field; a colour under the floor
     is a ship the player cannot see. */
  const dark = S.SWATCHES.filter(s => S.luma(s.hex) < S.LUMA_FLOOR);
  check(`every swatch clears the luminance floor (${S.LUMA_FLOOR})`,
    dark.length === 0, JSON.stringify(dark.map(s => `${s.name} ${S.luma(s.hex).toFixed(3)}`)));

  check('the default is on the menu', S.isSwatch(S.DEFAULT));
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
 * 2. Nothing off the menu can ever be painted, on any part
 * ======================================================================= */
{
  const { SK, storage } = load();
  const S = SK.Ship;

  const junk = ['', null, undefined, '#000', 'red', '#00000', 'javascript:1',
    '#0000zz', '  ', '#060713', S.GOLD];
  const leaked = junk.filter(v => S.normaliseColour(v) !== S.DEFAULT);
  check('anything not on the menu normalises to the default - including gold',
    leaked.length === 0, JSON.stringify(leaked));

  for (const part of S.PARTS) {
    check(`set('${part}') refuses an off-menu colour`, S.set(part, '#000000') === false);
    check(`set('${part}') refuses gold`, S.set(part, S.GOLD) === false);
  }
  check('set() refuses a part that does not exist', S.set('wings', '#ff2bd6') === false);
  check('...and none of those refusals changed the ship', S.isDefault());

  check('set() accepts a menu colour on one part and reports the change',
    S.set('fire', '#ff2bd6') === true);
  check('...only that part changed',
    same(plain(S.saved()), { nose: S.DEFAULT, window: S.DEFAULT, body: S.DEFAULT, fire: '#ff2bd6' }),
    JSON.stringify(S.saved()));
  check('setting the same colour twice is a no-op', S.set('fire', '#ff2bd6') === false);
  check('the choice is written to local storage, not just held in memory',
    JSON.parse(storage.get(S.STORE_KEY) || '{}').fire === '#ff2bd6', String(storage.get(S.STORE_KEY)));

  check('reset() puts the shipped ship back on every part', S.reset() === true && S.isDefault());
}

/* ==========================================================================
 * 3. THE INVARIANT: every surface discernible, the ship readable as a ship
 * ======================================================================
 * The rule lives in SK.Ship.readable(). These checks prove three things about
 * it: that it BITES (menu combinations exist that it refuses, including the
 * obvious ones), that the gate always produces a ship that passes it, and
 * that the tap path can never reach a ship that fails it. */
{
  const { SK } = load();
  const S = SK.Ship;
  const R = SK.Rocket;
  const hexes = S.SWATCHES.map(s => s.hex);

  /* --- the rule measures what it claims to --- */
  check('the shipped default reads', S.readable(S.DEFAULTS).length === 0,
    JSON.stringify(S.readable(S.DEFAULTS)));
  const gold = { nose: S.GOLD, window: S.GOLD, body: S.GOLD, fire: S.GOLD };
  check('the gold crown reads', S.readable(gold).length === 0, JSON.stringify(S.readable(gold)));

  const pale = { ...plain(S.DEFAULTS), window: '#ffffff' };
  check('a Nova White window on the default hull is refused by the rule',
    S.readable(pale).some(b => b.part === 'window'), JSON.stringify(S.readable(pale)));
  const blunt = { ...plain(S.DEFAULTS), nose: '#ffffff' };
  check('a Nova White nose - the ship loses its front - is refused by the rule',
    S.readable(blunt).some(b => b.part === 'nose'), JSON.stringify(S.readable(blunt)));

  /* Input that did not come from the menu: the rule has to catch a colour
     that vanishes against the SKY on its own, not only the pair rules. */
  for (const part of S.PARTS) {
    const p = { ...plain(S.DEFAULTS), [part]: '#101018' };
    check(`a near-black ${part} is refused by the rule`,
      S.readable(p).some(b => b.part === part), JSON.stringify(S.readable(p)));
  }

  /* The rule is judged on the PAINTED colours. Prove the measurement is not
     vacuous: on the default ship, the porthole and the cone really are the
     distances the thresholds were calibrated against. */
  const c = R.resolve(S.DEFAULTS);
  const dW = S.deltaE(c.glass, c.hull), dN = S.deltaE(c.nose, c.hull);
  check(`the default porthole clears MARK_DE (${S.MARK_DE}) with margin`,
    dW >= S.MARK_DE * 1.2, dW.toFixed(3));
  check('the default nose cone clears MARK_DE with margin', dN >= S.MARK_DE * 1.2, dN.toFixed(3));

  /* --- every N^4 menu combination (11^4 = 14641 today) --- */
  let total = 0, failing = 0, gateBroken = [], gateChangedGood = [],
    gateUnstable = [], gateNotIdem = [], offMenu = [];
  const failingParts = { nose: 0, window: 0, body: 0, fire: 0 };
  for (const nose of hexes) for (const window of hexes) for (const body of hexes) for (const fire of hexes) {
    total++;
    const p = { nose, window, body, fire };
    const bad = S.readable(p);
    if (bad.length) { failing++; for (const b of bad) failingParts[b.part]++; }

    const n = plain(S.normalise(p));
    if (S.readable(n).length) gateBroken.push(p);
    if (!bad.length && !same(n, p)) gateChangedGood.push(p);
    if (!same(plain(S.normalise(p)), n)) gateUnstable.push(p);
    if (!same(plain(S.normalise(n)), n)) gateNotIdem.push(p);
    if (!S.PARTS.every(k => S.isSwatch(n[k]))) offMenu.push(p);
  }
  console.log(`      ${total} combinations: ${failing} would not read ` +
              `(by part: ${JSON.stringify(failingParts)})`);
  check('the rule actually bites on the real menu - some combinations are refused',
    failing > 0 && failing < total, `${failing}/${total}`);
  check('the gate turns EVERY combination into a readable ship',
    gateBroken.length === 0, JSON.stringify(gateBroken.slice(0, 3)));
  check('the gate leaves every already-readable combination exactly as chosen',
    gateChangedGood.length === 0, JSON.stringify(gateChangedGood.slice(0, 3)));
  check('the gate is deterministic - same input, same ship',
    gateUnstable.length === 0, JSON.stringify(gateUnstable.slice(0, 3)));
  check('the gate is idempotent - a corrected ship is not corrected again',
    gateNotIdem.length === 0, JSON.stringify(gateNotIdem.slice(0, 3)));
  check('the gate never produces an off-menu colour', offMenu.length === 0);

  /* The correction is the documented one: the failing part goes back to its
     default, and nothing else moves. */
  const fixed = plain(S.normalise({ nose: '#ff3b30', window: '#ffffff', body: '#8a72ff', fire: '#a8ff1f' }));
  check('a vanishing window is corrected to the default window, the rest untouched',
    same(fixed, { nose: '#ff3b30', window: S.DEFAULT, body: '#8a72ff', fire: '#a8ff1f' }),
    JSON.stringify(fixed));

  /* Garbage from storage or the network, part by part. */
  const garbage = [
    { nose: '#000000', window: '#000000', body: '#000000', fire: '#000000' },
    { body: '#060713' }, { window: 'url(evil)' }, null, 42, '{"nose":', '#ffc21a',
    { nose: '#ECF6FF', window: '#ECF6FF', body: '#ECF6FF', fire: '#ECF6FF' }
  ];
  const leaks = garbage.map(g => plain(S.normalise(g))).filter(n => S.readable(n).length ||
    !S.PARTS.every(k => S.isSwatch(n[k])) || S.PARTS.some(k => n[k] === S.GOLD));
  check('untrusted input of every shape comes out readable, on the menu, and never gold',
    leaks.length === 0, JSON.stringify(leaks));
}

{
  /* --- the tap path can never reach an unreadable ship ---
     A long seeded walk of taps across every part and every swatch, in an
     order nobody would choose. After every single tap the stored ship reads,
     and every refusal left the ship exactly as it was. */
  const { SK } = load();
  const S = SK.Ship;
  const hexes = S.SWATCHES.map(s => s.hex);
  let seed = 0x5eed;
  const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };

  let accepted = 0, refused = 0, broke = null, refusalMoved = null, silent = null;
  for (let i = 0; i < 6000; i++) {
    const part = S.PARTS[rnd(4)], hex = hexes[rnd(hexes.length)];
    const before = plain(S.saved());
    const reason = S.why(part, hex);
    const ok = S.set(part, hex);
    if (ok) accepted++;
    else if (before[part] !== hex) {
      refused++;
      if (!same(plain(S.saved()), before)) refusalMoved = { part, hex, before };
      if (!reason) silent = { part, hex, before };
    }
    if (S.readable(S.saved()).length) { broke = { part, hex, before }; break; }
  }
  console.log(`      6000 seeded taps: ${accepted} painted, ${refused} refused`);
  check('no sequence of taps reaches a ship that does not read', broke === null, JSON.stringify(broke));
  check('the walk exercised both outcomes', accepted > 100 && refused > 100, `${accepted}/${refused}`);
  check('a refused tap changes nothing', refusalMoved === null, JSON.stringify(refusalMoved));
  check('every refusal comes with a reason the player can read', silent === null, JSON.stringify(silent));

  /* The ordering trap. On the first, pastel menu a BODY change could strand
     the current window (an Ice window on a Warning Red body, then the body
     to Signal Cyan: the window vanished, so the body change was refused).
     The saturated menu has no such pair - every chromatic mark reads on
     every body - and the one refused mark, Nova White, is refused on EVERY
     body. Both halves are asserted, so a future pastel that brings the trap
     back fails here instead of in a player's hands. why() is still asked
     against the current paint every time; this only pins what it answers. */
  S.reset();
  const chroma = hexes.filter(h => h !== '#ffffff');
  let stranded = null, whiteOk = null;
  for (const body of hexes) for (const mark of chroma) {
    const bad = S.readable({ nose: mark, window: mark, body, fire: body });
    if (bad.length) { stranded = { body, mark, bad: plain(bad) }; break; }
  }
  for (const body of hexes) {
    if (!S.readable({ ...plain(S.DEFAULTS), body, window: '#ffffff' }).some(b => b.part === 'window')) whiteOk = body;
  }
  check('every chromatic nose and window reads on every body on the menu', stranded === null,
    JSON.stringify(stranded));
  check('a Nova White window is refused on every body, not just some', whiteOk === null, String(whiteOk));
  S.set('body', '#ff3b30');
  const why = S.why('window', '#ffffff');
  check('...and the refusal names the window and leaves the paint alone',
    S.set('window', '#ffffff') === false && /window/i.test(why) && S.saved().window === S.DEFAULT, why);
}

/* ==========================================================================
 * 4. The crown: gold over every part, and the paint comes back intact
 * ======================================================================= */
{
  const { SK, storage } = load();
  const S = SK.Ship;
  const R = SK.Rocket;
  const mine = { nose: '#ff3b30', window: '#8a72ff', body: '#1affb0', fire: '#ff2bd6' };
  for (const k of S.PARTS) S.set(k, mine[k]);
  check('a four-part custom paint is set', same(plain(S.saved()), mine), JSON.stringify(S.saved()));
  const GOLDP = { nose: S.GOLD, window: S.GOLD, body: S.GOLD, fire: S.GOLD };

  /* The degradation table. Each row is a real state the game reaches: no
     backend, a dead read, an empty board, a signed-out player. Every one of
     them has to land on the player's own paint - never gold, never blank. */
  const cases = [
    ['no backend at all (champion never set)', '', '', false],
    ['signed out, board readable', 'someone', '', false],
    ['signed in, board unreachable', '', 'leo', false],
    ['signed in, someone else is #1', 'klaudia', 'leo', false],
    ['signed in and #1', 'leo', 'leo', true],
    ['#1, name cased differently by the server', 'LEO', 'leo', true]
  ];
  for (const [what, champ, me, want] of cases) {
    S.setChampionName(champ);
    S.setPlayerName(me);
    check(`${what}: ${want ? 'gold on every part' : 'own paint'}`,
      S.isChampion() === want && same(plain(S.current()), want ? GOLDP : mine),
      JSON.stringify(S.current()));
  }

  S.setChampionName('');
  S.setPlayerName('');
  check('an unknown champion does not match an unknown player', !S.isChampion());

  /* Crowned: the renderer paints gold on EVERY surface - not a gold hull with
     somebody's magenta nose. Compared on the painted colours, not the paint
     object, because the painted colours are what the player sees. */
  S.setChampionName('leo'); S.setPlayerName('leo');
  const live = R.resolve(), crown = R.resolve(S.GOLD);
  check('while #1, every painted surface is the gold ship\'s',
    ['hull', 'hullD', 'trim', 'nose', 'glass', 'fire', 'fireCool'].every(k => same(live[k], crown[k])),
    `${live.key} vs ${crown.key}`);
  check('the crown does not overwrite the stored paint', same(plain(S.saved()), mine));
  check('the crown is never written to storage',
    !String(storage.get(S.STORE_KEY)).includes(S.GOLD), String(storage.get(S.STORE_KEY)));

  /* A pick made while crowned is saved and waits under the crown. */
  S.set('fire', '#a8ff1f');
  check('a pick made while crowned is saved but the ship stays gold',
    S.saved().fire === '#a8ff1f' && S.current().fire === S.GOLD);

  /* Losing the top spot mid-session gives every part straight back. */
  S.setChampionName('klaudia');
  const back = { ...mine, fire: '#a8ff1f' };
  check('losing #1 restores all four parts exactly', same(plain(S.current()), back),
    JSON.stringify(S.current()));
  const after = R.resolve();
  check('...and the renderer paints them, not a gold leftover',
    same(after.nose, S.rgb(back.nose)) && same(after.trim, S.rgb(back.body)) && after.key !== crown.key,
    after.key);

  /* Survives a reload while crowned: the stored paint is the custom one. */
  S.setChampionName('leo');
  const { SK: SK2 } = load({ storage });
  check('reloading while #1 still loads the custom paint underneath',
    same(plain(SK2.Ship.saved()), back) && !SK2.Ship.isChampion(), JSON.stringify(SK2.Ship.saved()));

  /* Every appearance change has to reach the renderer and the panel. */
  let beats = 0;
  S.onChange(() => { beats++; });
  S.setChampionName('someone-else');
  S.set('nose', '#ff7a1a');
  check('onChange fires for both a lost crown and a new colour', beats === 2, String(beats));

  S.onChange(() => { throw new Error('bad listener'); });
  let survived = true;
  try { S.set('nose', '#ff7a1a'); } catch (e) { survived = false; }
  check('a broken listener cannot break the ship', survived);

  /* forceChampion is the local preview hook (?gold=1). Cosmetic: visible,
     never written down. */
  const { SK: SK3, storage: st3 } = load();
  SK3.Ship.set('body', '#a8ff1f');
  SK3.Ship.forceChampion(true);
  check('a previewed crown paints gold', SK3.Ship.current().body === SK3.Ship.GOLD);
  check('...but is not a real crown', SK3.Ship.isChampion() && !SK3.Ship.isCrowned());
  check('...and is never persisted', JSON.parse(st3.get(SK3.Ship.STORE_KEY)).body === '#a8ff1f');
}

/* ==========================================================================
 * 5. Persistence, locally: choose, save, reload
 * ======================================================================= */
{
  const storage = new Map();
  const { SK } = load({ storage });
  const want = { nose: '#ff7a1a', window: '#ff3b30', body: '#c957ff', fire: '#1affb0' };
  for (const k of SK.Ship.PARTS) SK.Ship.set(k, want[k]);
  const { SK: again } = load({ storage });
  check('a four-part paint survives a page reload', same(plain(again.Ship.saved()), want),
    JSON.stringify(again.Ship.saved()));

  /* What goes to the account: default parts as '' (NULL in the row), so the
     default stays the game's to change. */
  again.Ship.set('fire', again.Ship.DEFAULT);
  check('the account copy sends a default part as empty, a chosen one as its hex',
    same(plain(again.Ship.toStored()), { ...want, fire: '' }), JSON.stringify(again.Ship.toStored()));
}
{
  /* A hand-edited storage entry cannot mint gold, nor an unreadable ship. */
  const storage = new Map();
  storage.set('skyhook.shipPaint', JSON.stringify({ nose: '#ffc21a', window: '#ffffff', body: '#35e6ff', fire: '#000000' }));
  const { SK } = load({ storage });
  check('a forged stored paint loads corrected: no gold, window readable, fire on the menu',
    same(plain(SK.Ship.saved()), plain(SK.Ship.DEFAULTS)), JSON.stringify(SK.Ship.saved()));
}
{
  /* Somebody who painted a ship with the single-colour build keeps it. */
  /* (Stored with the first menu's Magenta, so it also crosses RENAMED.) */
  const storage = new Map([['skyhook.shipColour', '#ff7edb']]);
  const { SK } = load({ storage });
  check('the old single-colour choice migrates onto all four parts, in the new Magenta',
    SK.Ship.PARTS.every(k => SK.Ship.saved()[k] === '#ff2bd6'), JSON.stringify(SK.Ship.saved()));
}
{
  /* The palette swap must not reset anybody. A paint saved with the first
     (pastel) menu loads as the same family on the saturated one. */
  const S0 = load().SK.Ship;
  const targets = Object.values(plain(S0.RENAMED));
  check('every renamed colour lands on the current menu', targets.every(h => S0.isSwatch(h)),
    JSON.stringify(targets.filter(h => !S0.isSwatch(h))));
  check('no current swatch is also an old name (the map cannot loop)',
    Object.keys(plain(S0.RENAMED)).every(h => !S0.isSwatch(h)));
  const storage = new Map([['skyhook.shipPaint',
    JSON.stringify({ nose: '#ff9d4d', window: '#7c8cff', body: '#b98cff', fire: '#ffd166' })]]);
  const { SK } = load({ storage });
  check('a first-menu paint loads as its saturated equivalent, part by part',
    same(plain(SK.Ship.saved()), { nose: '#ff7a1a', window: '#8a72ff', body: '#c957ff', fire: '#ff7a1a' }),
    JSON.stringify(SK.Ship.saved()));
}

/* ==========================================================================
 * 6. The default ship did not change, and each part paints only itself
 * ======================================================================
 * The six constants js/rocket.js held before the paint was configurable. */
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
  const c = R.resolve(SK.Ship.DEFAULTS);

  check('the default paint and the single default hex resolve identically',
    same(plain(c), plain(R.resolve('#35e6ff'))));
  check('the trim is the colour itself, exactly', dist(c.trim, OLD.trim) === 0, JSON.stringify(c.trim));
  check('the nose cone is the old trim, exactly', dist(c.nose, OLD.trim) === 0, JSON.stringify(c.nose));
  check('the shaded flank is the old constant, exactly',
    dist(c.hullD, OLD.hullD) === 0, JSON.stringify(c.hullD));
  check('the plating is the old plating within 8 channel steps',
    near(c.hull, OLD.hull, 8), `${JSON.stringify(c.hull)} vs ${JSON.stringify(OLD.hull)}`);
  check('the glass is the old glass within 8 channel steps',
    near(c.glass, OLD.glass, 8), `${JSON.stringify(c.glass)} vs ${JSON.stringify(OLD.glass)}`);
  check('the plume mid-tone is in the neighbourhood of the old one',
    near(c.fire, OLD.fire, 16), `${JSON.stringify(c.fire)} vs ${JSON.stringify(OLD.fire)}`);

  /* Independence: each part moves its own surfaces and nothing else. This is
     what "per part" means at the pixel level. */
  const SURF = { nose: ['nose'], window: ['glass'], body: ['hull', 'hullD', 'trim'], fire: ['fire', 'fireCool'] };
  const ALL = ['hull', 'hullD', 'trim', 'nose', 'glass', 'fire', 'fireCool'];
  for (const part of SK.Ship.PARTS) {
    const p = { ...plain(SK.Ship.DEFAULTS), [part]: '#ff3b30' };
    const r = R.resolve(p);
    const moved = ALL.filter(k => !same(r[k], c[k]));
    check(`changing only the ${part} changes only the ${part}'s surfaces`,
      same(moved.sort(), SURF[part].slice().sort()), JSON.stringify(moved));
  }

  const bad = ['', null, undefined, 'not-a-colour', '#zzzzzz', { nose: 'x', body: null }];
  const broken = bad.filter(v => {
    const r = R.resolve(v);
    return ALL.map(k => r[k]).some(ch => ch.some(n => !Number.isFinite(n)));
  });
  check('an unreadable colour falls back rather than painting NaN',
    broken.length === 0, JSON.stringify(broken));

  const gold = R.resolve(SK.Ship.GOLD);
  check('the champion hull is visibly warmer than the default one',
    gold.hull[0] > c.hull[0] && gold.hull[2] < c.hull[2],
    `${JSON.stringify(gold.hull)} vs ${JSON.stringify(c.hull)}`);
}

/* ==========================================================================
 * 7. Per-paint sprite caches stay bounded
 * ======================================================================= */
{
  const { SK } = load();
  const R = SK.Rocket;
  const g = fakeCanvas().getContext('2d');
  const hexes = SK.Ship.SWATCHES.map(s => s.hex);

  const before = R.cacheStats();
  check('the caches declare their own ceilings',
    before.hullMax > 0 && before.flameMax > 0 && before.bloomMax > 0,
    JSON.stringify(before));

  /* 96 distinct paints, each at several burn levels - far past what a player
     browsing the customiser produces. */
  for (let i = 0; i < 96; i++) {
    const n = hexes.length;
    const paint = { nose: hexes[i % n], window: hexes[(i * 5) % n],
      body: hexes[(i * 7) % n], fire: hexes[(i * 11 + 3) % n] };
    for (const burn of [0, 0.25, 0.5, 0.75, 1]) {
      R.draw(g, 100, 100, 0, 14, i * 0.1, { burn, thrust: 0.4, paint });
    }
  }

  const after = R.cacheStats();
  check('the hull cache evicted rather than grew', after.hull <= after.hullMax, `${after.hull}/${after.hullMax}`);
  check('the flame cache evicted rather than grew', after.flame <= after.flameMax, `${after.flame}/${after.flameMax}`);
  check('the bloom cache is still per-burn-bucket only (colour-independent)',
    after.bloom <= after.bloomMax, `${after.bloom}/${after.bloomMax}`);
  console.log(`      after 96 paints x 5 burn levels: hull ${after.hull}/${after.hullMax}` +
              `  flame ${after.flame}/${after.flameMax}  bloom ${after.bloom}/${after.bloomMax}`);
}

/* ==========================================================================
 * 8. The markup and the model cannot drift apart
 * ======================================================================= */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'js/ui_ship.js'), 'utf8');

  for (const id of ['sh', 'sh-close', 'sh-canvas', 'sh-crown', 'sh-parts', 'sh-swatches',
    'sh-msg', 'sh-done', 'sh-reset']) {
    check(`index.html still has #${id}`, html.includes(`id="${id}"`));
    check(`js/ui_ship.js still wires #${id}`, ui.includes(`'${id}'`));
  }
  const tag = f => html.indexOf(`src="${f}"`);
  check('js/ship.js is loaded BEFORE js/rocket.js paints with it',
    tag('js/ship.js') > 0 && tag('js/ship.js') < tag('js/rocket.js'),
    `${tag('js/ship.js')} vs ${tag('js/rocket.js')}`);
  check('js/ui_ship.js is loaded after the game instance exists',
    tag('js/ui_ship.js') > tag('js/main.js'),
    `${tag('js/ui_ship.js')} vs ${tag('js/main.js')}`);

  check('the title screen draws a labelled CUSTOMISE SHIP button',
    /_drawPanelButton\([^)]*shipRect[^)]*CUSTOMISE SHIP/.test(game.replace(/\s+/g, ' ')));
  check('that button\'s dot is a colour, not the paint object',
    /SK\.Ship\.current\(\)\.body/.test(game));
  /* One helper answers "where is the button on this screen" for BOTH the
     hit test and the draw, and it has a door on each still screen. The
     behaviour - open from pause, nothing moves, the paint lands - is proven
     in a real browser by test/ship_access.mjs. */
  const now = /_shipRectNow = function \(\) \{([\s\S]*?)\n  \};/.exec(game.replace(/\r\n/g, '\n'));
  const body = now ? now[1] : '';
  check('the customise button has a door on the title, PAUSED and game-over screens',
    /'title'\) return this\.shipRect;/.test(body) && /'paused'\) return this\.shipRectPause;/.test(body) &&
    /'over' && this\.overT > RETRY_LOCK/.test(body), body.trim().slice(0, 120));
  check('...and the SAME answer is what gets hit-tested and what gets drawn',
    /var ship = this\._shipRectNow\(\);\s*if \(onCanvas && ship && inRect\(ship, lx, ly\)\)/.test(game) &&
    /_drawShipButton = function[\s\S]*?this\._shipRectNow\(\)/.test(game));
  check('the panel it opens is styled rather than shipped bare',
    css.includes('.sh-swatch') && css.includes('.sh-preview') && css.includes('.sh-part') &&
    css.includes('.sh-swatch.is-blocked'));
  check('the customiser asks the model why, rather than deciding legality itself',
    ui.includes('SK.Ship.why(') && ui.includes('SK.Ship.set(part'));
}

/* ==========================================================================
 * 9. The database holds the same menu, per part
 * ======================================================================= */
{
  const { SK } = load();
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const code = sql.replace(/--.*/g, '');
  const norm = code.replace(/\s+/g, ' ').toLowerCase();

  const fn = /create or replace function public\.ship_colour_allowed[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(code);
  const listed = ((fn && fn[1]) || '').match(/#[0-9a-f]{6}/gi) || [];
  const menu = SK.Ship.SWATCHES.map(s => s.hex).slice().sort();
  check('the database allow-list is exactly the menu the client shows',
    same(listed.map(h => h.toLowerCase()).sort(), menu), JSON.stringify(listed));
  check('champion gold cannot be stored on an account either',
    !listed.map(h => h.toLowerCase()).includes(SK.Ship.GOLD));

  /* The palette swap, in the database: the SQL old -> new map is the client's
     RENAMED, pair for pair, and it runs before the CHECKs are put back. */
  const ren = /create or replace function public\.ship_colour_renamed[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(code);
  const sqlMap = {};
  for (const m of ((ren && ren[1]) || '').matchAll(/when '(#[0-9a-f]{6})' then '(#[0-9a-f]{6})'/gi)) {
    sqlMap[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  const sortObj = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  check('the database remaps first-menu colours exactly as SK.Ship.RENAMED does',
    sortObj(sqlMap) === sortObj(plain(SK.Ship.RENAMED)), JSON.stringify(sqlMap));
  const at = s => norm.indexOf(s);
  check('...on every part, after the single-colour migration and before the CHECKs return',
    SK.Ship.PARTS.every(p => norm.includes(`ship_${p} = public.ship_colour_renamed(ship_${p})`)) &&
    at('drop column ship_colour') < at('ship_nose = public.ship_colour_renamed(ship_nose)') &&
    at('ship_nose = public.ship_colour_renamed(ship_nose)') <
      at('add constraint profiles_ship_nose_allowed'));

  for (const part of SK.Ship.PARTS) {
    check(`ship_${part} is added idempotently and checked against that one list`,
      norm.includes(`add column if not exists ship_${part} text`) &&
      norm.includes(`check (public.ship_colour_allowed(ship_${part}))`));
  }
  check('the single-colour column is migrated onto the parts, then retired',
    norm.includes('ship_nose = coalesce(ship_nose, ship_colour)') &&
    norm.includes('drop column ship_colour') &&
    norm.includes('drop function if exists public.set_ship_colour(text)'));

  check('no whole-row UPDATE is granted on profiles',
    !/grant\s+update\s+on\s+public\.profiles/.test(norm));
  check('no column grant lets a player write a ship_* column directly',
    !/grant\s+update\s*\([^)]*ship_/.test(norm));
  check('the only write path is a security-definer function scoped to auth.uid()',
    /create or replace function public\.set_ship_paint\([^)]*\) returns void language plpgsql security definer/.test(norm) &&
    norm.includes('where id = auth.uid()'));
  check('...and that function is not callable with the anon key',
    norm.includes('revoke execute on function public.set_ship_paint(text, text, text, text) from anon, public') &&
    norm.includes('grant execute on function public.set_ship_paint(text, text, text, text) to authenticated'));
  const body = (/function public\.set_ship_paint[\s\S]*?\$\$([\s\S]*?)\$\$/i.exec(code) || [, ''])[1].toLowerCase();
  check('the paint function writes the four ship_* columns and nothing else',
    !body.includes('username') && ['nose', 'window', 'body', 'fire'].every(k => body.includes(`ship_${k}`)));
}

/* ==========================================================================
 * 10. The paint follows the account - without becoming a dependency
 * ======================================================================= */
{
  /* Offline: no fetch at all in this sandbox, the harshest "no network". */
  const { SK } = load({ files: ['js/online.js'],
    globals: { location: { href: 'https://skyhookplay.com/', origin: 'https://skyhookplay.com', pathname: '/', search: '', hash: '', protocol: 'https:' } } });
  const O = SK.Online;
  check('js/online.js exposes both halves of the account sync',
    typeof O.saveShipPaint === 'function' && typeof O.loadShipPaint === 'function');
  const saved = await O.saveShipPaint(SK.Ship.saved());
  const loaded = await O.loadShipPaint();
  check('saving with no backend resolves false rather than rejecting', saved === false, String(saved));
  check('loading with no backend resolves null rather than rejecting', loaded === null, JSON.stringify(loaded));
}

{
  /* ROUND TRIP THROUGH THE ACCOUNT, against a stand-in PostgREST that holds
     the rule supabase/schema.sql holds: one row per user, only the RPC can
     write the ship columns, every column on the allow-list or the whole
     write fails. Device A paints and saves; device B - fresh storage, same
     account - loads and must come out with the same ship. */
  const { SK: probe } = load();
  const MENU = new Set(probe.Ship.SWATCHES.map(s => s.hex));
  const UID = '00000000-0000-4000-8000-00000000c0de';
  const db = { [UID]: { ship_nose: null, ship_window: null, ship_body: null, ship_fire: null } };
  const calls = [];

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    const reply = (status, body) => ({
      ok: status < 300, status,
      headers: { get: () => 'application/json' },
      json: async () => body
    });
    if ((init.headers || {}).Authorization !== 'Bearer tok-' + UID) return reply(401, { message: 'JWT' });
    if (u.pathname === '/rest/v1/rpc/set_ship_paint' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const row = {};
      for (const k of ['nose', 'window', 'body', 'fire']) {
        const v = String(b['p_' + k] || '').trim().toLowerCase() || null;
        if (v !== null && !MENU.has(v)) {
          return reply(400, { code: '23514', message: `violates check constraint "profiles_ship_${k}_allowed"` });
        }
        row['ship_' + k] = v;
      }
      Object.assign(db[UID], row);
      return reply(204, null);
    }
    if (u.pathname === '/rest/v1/profiles' && (init.method || 'GET') === 'GET') {
      return reply(200, [{ ...db[UID] }]);
    }
    return reply(404, { message: 'no route' });
  };

  const device = () => {
    const storage = new Map([['skyhook.session', JSON.stringify({
      access_token: 'tok-' + UID, refresh_token: 'r', expires_at: Date.now() + 3600e3,
      user: { id: UID, username: 'pilot' } })]]);
    const d = load({ storage, files: ['js/online.js'], globals: { fetch,
      location: { href: 'https://skyhook-staging.fly.dev/', origin: 'https://skyhook-staging.fly.dev', pathname: '/', search: '', hash: '', protocol: 'https:' } } });
    d.SK.Online.configure({ supabaseUrl: 'https://stand-in.supabase.co', supabaseAnonKey: 'anon-key' });
    return d.SK;
  };

  const A = device();
  const want = { nose: '#ff7a1a', window: '#8a72ff', body: '#1a9dff', fire: '#a8ff1f' };
  for (const k of A.Ship.PARTS) A.Ship.set(k, want[k]);
  check('device A painted all four parts', same(plain(A.Ship.saved()), want));
  check('device A saves the paint to the account', (await A.Online.saveShipPaint(A.Ship.saved())) === true,
    calls.join(', '));
  check('the account row holds all four parts',
    db[UID].ship_nose === want.nose && db[UID].ship_window === want.window &&
    db[UID].ship_body === want.body && db[UID].ship_fire === want.fire, JSON.stringify(db[UID]));

  const B = device();
  check('device B starts on the default ship', B.Ship.isDefault());
  const row = await B.Online.loadShipPaint();
  B.Ship.setPaint(row);
  check('device B loads the same four parts from the account', same(plain(B.Ship.saved()), want),
    JSON.stringify(B.Ship.saved()));

  check('the server refuses gold on any part, and the call reports it rather than throwing',
    (await A.Online.saveShipPaint({ ...want, body: A.Ship.GOLD })) === false &&
    db[UID].ship_body === want.body);

  /* A row somebody wrote by hand that is on the menu but does not read. It
     must be corrected on the way IN, before a pixel of it is drawn. */
  Object.assign(db[UID], { ship_window: '#ffffff', ship_body: '#35e6ff' });
  const C = device();
  C.Ship.setPaint(await C.Online.loadShipPaint());
  check('an unreadable stored combination is corrected on load, not painted',
    C.Ship.readable(C.Ship.saved()).length === 0 && C.Ship.saved().window === C.Ship.DEFAULT,
    JSON.stringify(C.Ship.saved()));
}

console.log(`\n${fails === 0
  ? 'ship paint holds: four parts, every combination readable, gold worn over them and handed back, and the paint survives a reload'
  : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
