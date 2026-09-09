/* SKYHOOK world-stream gate  -  "this was an ART pass" made falsifiable.
 *
 * The procedural-art pass (planet classes, spectral star colours, meteor
 * hazards) was allowed to change how bodies LOOK and nothing else. The risk is
 * subtle and one-directional: the world is generated from a single seeded RNG
 * chain, so a single extra `this.rand()` call added for a visual detail shifts
 * every draw after it and silently regenerates the entire game. Scores move,
 * balance.mjs moves, and it looks like a tuning change nobody made.
 *
 * So this file records the exact generated world - every body's position, mass,
 * derived geometry, kind and type, plus every hazard and shard - into a golden
 * fixture, and then asserts byte-equality against it. balance.mjs proves the
 * OUTCOMES did not move; this proves the INPUT did not move, which is the
 * stronger and much faster statement.
 *
 * Run:      node test/world.mjs
 * Record:   node test/world.mjs --record     (only when a physics change is
 *                                             intended and reviewed)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'world_stream.json');
const RECORD = process.argv.includes('--record');

const SEEDS = [4242, 1, 99991, 777777];
const BODIES = 80;          // how deep to generate - well past STAR_FROM/DEEP_OVER
const PRECISION = 6;        // decimals kept, so float noise is not a failure

/* Minimal DOM stub. Same shape balance.mjs uses: canvases exist and every 2d
   context call is a no-op, because nothing here renders. */
function fakeCanvas() {
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'canvas') return null;
      return typeof t[k] === 'function' ? t[k] : () => {};
    },
    set: () => true
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

function loadGame() {
  const sandMath = Object.create(Math);
  let source = Math.random;
  sandMath.random = () => source();

  const sandbox = { Math: sandMath, Date, console, JSON, Proxy };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => fakeCanvas() };
  sandbox.navigator = undefined;
  sandbox.localStorage = undefined;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8'), sandbox);
  const noop = () => {};
  sandbox.SK.Audio = {
    muted: true, ready: false, ctx: null,
    init: noop, resume: noop, setMuted: noop,
    hook: noop, shard: noop, warn: noop, snap: noop, death: noop, start: noop, best: noop, ui: noop
  };
  /* The art module is optional so this harness can also record a fixture from
     a build that predates it. */
  const art = path.join(ROOT, 'js/celestial.js');
  if (fs.existsSync(art)) vm.runInContext(fs.readFileSync(art, 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8'), sandbox);
  return { SK: sandbox.SK, setRandom: fn => { source = fn; } };
}

const r6 = v => +Number(v).toFixed(PRECISION);

/* Walk the generator forward by raising the camera, exactly the way play does,
   and record everything the simulation created on the way up. Never touches
   the player, so no input model can colour the result. */
function streamFor(SK, seed) {
  const g = new SK.Game(seed);
  g.skipTutorial(false);
  g.start(seed);

  const bodies = [];
  const seen = new Set();
  let guard = 0;
  while (bodies.length < BODIES && guard++ < 4000) {
    for (const n of g.nodes) {
      if (seen.has(n.idx)) continue;
      seen.add(n.idx);
      bodies.push([
        n.idx, n.kind, n.type,
        r6(n.x), r6(n.y), r6(n.mass), r6(n.radius),
        r6(n.minR), r6(n.maxR), r6(n.captureR), r6(n.decay)
      ]);
    }
    g.camY -= 140;
    g._ensureAhead();
  }
  bodies.sort((a, b) => a[0] - b[0]);

  const haz = (g.meteors || g.mines).map(m => [r6(m.homeX), r6(m.y), r6(m.amp), r6(m.phase)]);
  const shards = g.shards.map(s => [r6(s.x), r6(s.y), r6(s.phase)]);

  return { seed, bodies: bodies.slice(0, BODIES), hazards: haz, shards };
}

const { SK, setRandom } = loadGame();
setRandom(() => 0.5);   // Math.random is only used for cosmetic particles here

const streams = SEEDS.map(s => streamFor(SK, s));
const payload = {
  note: 'Golden world stream. Regenerate ONLY with an intended, reviewed physics change: node test/world.mjs --record',
  bodies: BODIES,
  precision: PRECISION,
  seeds: SEEDS,
  streams
};

if (RECORD) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, JSON.stringify(payload, null, 1) + '\n');
  console.log(`recorded ${streams.length} seeds x ${BODIES} bodies -> ${FIXTURE}`);
  for (const s of streams) {
    console.log(`  seed ${String(s.seed).padStart(7)}  bodies ${s.bodies.length}  hazards ${String(s.hazards.length).padStart(3)}  shards ${s.shards.length}`);
  }
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.error(`FAIL  no fixture at ${FIXTURE} - run: node test/world.mjs --record`);
  process.exit(1);
}

const want = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

check('fixture depth matches', want.bodies === BODIES, `fixture=${want.bodies} harness=${BODIES}`);
check('fixture seeds match', JSON.stringify(want.seeds) === JSON.stringify(SEEDS));

for (let i = 0; i < streams.length; i++) {
  const got = streams[i], exp = want.streams[i];
  const seed = got.seed;
  if (!exp) { check(`seed ${seed} present in fixture`, false); continue; }

  /* Compare field by field so a failure names the body and the property that
     drifted, instead of printing two 80-element blobs. */
  let firstDiff = null;
  const FIELDS = ['idx', 'kind', 'type', 'x', 'y', 'mass', 'radius', 'minR', 'maxR', 'captureR', 'decay'];
  for (let b = 0; b < Math.max(got.bodies.length, exp.bodies.length) && !firstDiff; b++) {
    const a = got.bodies[b], e = exp.bodies[b];
    if (!a || !e) { firstDiff = `body ${b} missing (${a ? 'fixture' : 'build'} has none)`; break; }
    for (let f = 0; f < FIELDS.length; f++) {
      if (a[f] !== e[f]) { firstDiff = `body ${b} ${FIELDS[f]}: build=${a[f]} fixture=${e[f]}`; break; }
    }
  }
  check(`seed ${seed}: ${BODIES} bodies identical (position, mass, radius, minR, maxR, captureR, kind, type)`,
    !firstDiff, firstDiff || '');
  check(`seed ${seed}: hazard stream identical`,
    JSON.stringify(got.hazards) === JSON.stringify(exp.hazards),
    got.hazards.length !== exp.hazards.length ? `count build=${got.hazards.length} fixture=${exp.hazards.length}` : '');
  check(`seed ${seed}: shard stream identical`,
    JSON.stringify(got.shards) === JSON.stringify(exp.shards),
    got.shards.length !== exp.shards.length ? `count build=${got.shards.length} fixture=${exp.shards.length}` : '');
}

/* A rename that only half-lands is the other way this pass can break: the
   hazard array must exist under exactly one name. */
const probe = new SK.Game(1);
probe.skipTutorial(false);
probe.start(1);
check('hazard array is reachable', Array.isArray(probe.meteors || probe.mines));
check('hazard array is not defined under BOTH names (half-finished rename)',
  !(Array.isArray(probe.meteors) && Array.isArray(probe.mines)));

console.log(`\n${fails === 0 ? 'world stream unchanged - physics untouched' : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
