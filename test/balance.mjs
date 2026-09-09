/* SKYHOOK balance harness.
 *
 * Loads the REAL game logic (js/utils.js + js/game.js) into a tiny DOM stub
 * and simulates hundreds of runs headlessly at fixed 60 Hz. No browser, no
 * rendering - so a 500-run sweep takes seconds instead of hours.
 *
 * Two synthetic players:
 *   expert - releases at the angle that aims closest at the next node
 *   casual - releases on first "good enough" angle, with reaction lag and
 *            a chance to miss the window entirely
 *
 * Run:  node test/balance.mjs [runs]
 *       node test/balance.mjs 200 --game=../sandbox/gravity   (A/B a prototype)
 *
 * ---------------------------------------------------------------------------
 * 2026-09-09 correctness pass (Crew). Three defects made this instrument lie:
 *
 *   F3a  shouldRelease() modelled the orbit with a hardcoded SPEED = 468.
 *        The game ramps 360 -> 468 over the first 20 hooks (game.js:_speed),
 *        so for the whole early game the harness believed the player was
 *        rotating ~30% faster than they were.
 *   F3b  shouldRelease() divided by the raw p.r. The game floors the divisor
 *        at MIN_R (game.js:693, `Math.max(p.r, MIN_R)`). After a tight catch
 *        p.r starts at the achieved distance - which can be near zero - so the
 *        harness computed an angular step that could be an order of magnitude
 *        too large. Both errors land in the same place: the expert's one-frame
 *        lookahead, i.e. the only thing that makes "expert" better than "good".
 *   F4   a run that hit the 240 s frame cap was recorded as a normal death
 *        carrying Game's *initial* this.cause = 'rift'. Survivors were being
 *        counted as rift kills. The harness could not tell "the game killed
 *        you" from "we stopped watching".
 *
 * Also fixed: the tutorial was played by the very first run of a sweep only
 * (Store falls back to a module-level object shared by every Game instance),
 * so exactly one run in each sweep ran at TUTOR_SPEED with a frozen rift.
 * playOne() now calls the skipTutorial() hook the game already provides.
 *
 * Added: paired seeding. With --seed, run i of every profile and of every
 * build faces the identical world, so an A/B measures the change and not the
 * RNG. Math.random is stubbed per-sandbox (never the host's).
 * -------------------------------------------------------------------------*/
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const has = (name) => argv.includes(`--${name}`);

/* Which build are we measuring? Lets the same corrected harness run against a
   sandbox prototype without forking the harness itself. */
const ROOT = path.resolve(flag('game', process.env.SKYHOOK_GAME_DIR || DEFAULT_ROOT));

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

/* mulberry32 - same generator the game uses, so "deterministic" means the
   same thing on both sides of the fence. */
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadGame(root) {
  /* Object.create(Math) inherits every Math method but gives us somewhere to
     shadow .random - the host's Math is never mutated. */
  const sandMath = Object.create(Math);
  let source = Math.random;
  sandMath.random = () => source();

  const sandbox = { Math: sandMath, Date, console, JSON, Proxy };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => fakeCanvas() };
  sandbox.navigator = undefined;
  sandbox.localStorage = undefined;   // exercises the in-memory Store fallback

  const utilsSrc = fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');

  vm.runInContext(utilsSrc, sandbox);
  const noop = () => {};
  sandbox.SK.Audio = {
    muted: true, ready: false, ctx: null,
    init: noop, resume: noop, setMuted: noop,
    hook: noop, shard: noop, warn: noop, snap: noop, death: noop, start: noop, best: noop, ui: noop
  };
  vm.runInContext(gameSrc, sandbox);

  /* Read the tuning constants OUT OF the build under test instead of
     restating them here. A harness that hardcodes the numbers it is supposed
     to be measuring drifts silently the moment someone tunes the game - which
     is exactly how F3a happened. */
  const num = (name, fallback) => {
    const m = gameSrc.match(new RegExp('var\\s+' + name + '\\s*=\\s*([0-9.]+)'));
    if (!m) {
      if (fallback === undefined) throw new Error(`balance.mjs: cannot find "var ${name}" in ${root}/js/game.js`);
      return fallback;
    }
    return parseFloat(m[1]);
  };

  return {
    SK: sandbox.SK,
    setRandom: (fn) => { source = fn; },
    K: {
      MIN_R: num('MIN_R'),
      CAPTURE_R: num('CAPTURE_R'),
      SPEED: num('SPEED'),
      FLIGHT_MAX: num('FLIGHT_MAX', null)
    }
  };
}

const build = loadGame(ROOT);
const { SK, setRandom, K } = build;

/* Per-body geometry. The current build has one global NODE_R / CAPTURE_R /
   MIN_R; the gravity prototype gives every body its own. Read the per-body
   value when it exists so ONE harness measures both. */
const minRFor = (n) => (n && typeof n.minR === 'number') ? n.minR : K.MIN_R;
const captureFor = (n) => (n && typeof n.captureR === 'number') ? n.captureR : K.CAPTURE_R;

/* Decide whether this synthetic player releases on this frame. */
function shouldRelease(g, skill) {
  const p = g.player;
  if (p.mode !== 'orbit' || !p.node) return false;

  /* F5 (2026-09-09): PANIC TAPS.
     Every profile here used to fail in exactly one way - by NOT releasing.
     A player who never lets go at a bad moment can only ever be killed by a
     hazard, so the harness was structurally incapable of observing a death
     caused by a bad release. That was tolerable while the rift and the flight
     timer existed; with the endless build it means the instrument cannot see
     the ONLY fail condition the game has left. `panic` is a per-second
     probability of letting go regardless of aim. */
  if (skill.panic && Math.random() < skill.panic / 60) return true;

  let target = null, bd = Infinity;
  for (const n of g.nodes) {
    if (n.spent || n === p.node) continue;
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d < bd) { bd = d; target = n; }
  }
  if (!target) return false;

  const aim = (ang) => {
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const rx = p.node.x + cs * p.r, ry = p.node.y + sn * p.r;
    const vx = -sn * p.dir, vy = cs * p.dir;
    const tx = target.x - rx, ty = target.y - ry;
    return { along: tx * vx + ty * vy, perp: Math.abs(tx * vy - ty * vx) };
  };

  /* F3: mirror the game's angular integrator exactly.
     game.js:693  p.ang += p.dir * (p.speed / Math.max(p.r, MIN_R)) * dt
     - p.speed, not a frozen 468 (it ramps with hooks)
     - the MIN_R floor on the divisor, per-body in the gravity build
     - dt = 1/60, the harness's decision granularity (input is queued and
       consumed at the head of the next tick, so the release fires at exactly
       the p.ang we are evaluating here). */
  const rate = typeof g.angRate === 'function'
    ? g.angRate(p)                                  // prototype exposes it
    : p.dir * (p.speed / Math.max(p.r, minRFor(p.node)));
  const step = rate * (1 / 60);

  const now = aim(p.ang);
  if (now.along <= 0) return false;

  /* Aim tolerances scale with the TARGET's latch ring so the same profile
     means the same thing on a small planet and a big star. 0.76 * 92 = 70,
     i.e. identical to the previous hardcoded value on the current build. */
  const scale = captureFor(target) / K.CAPTURE_R;

  if (skill.mode === 'expert') {
    const soon = aim(p.ang + step);
    return now.perp < 70 * scale && soon.perp >= now.perp;
  }
  // casual: fires on the first angle that looks acceptable, sometimes late,
  // sometimes not at all
  if (now.perp < skill.tolerance * scale) {
    if (Math.random() < skill.missChance) return false;
    return true;
  }
  return false;
}

const CAP_SECONDS = 240;

function playOne(SK, skill, seed) {
  const g = new SK.Game();
  /* The game ships this hook specifically for us (game.js:404). Without it the
     first run of a sweep - and only the first - plays the tutorial. */
  g.skipTutorial(false);
  g.start(seed);
  let frames = 0;
  const capFrames = 60 * CAP_SECONDS;
  while (g.state === 'playing' && frames < capFrames) {
    if (shouldRelease(g, skill)) g.action();
    g.update(1 / 60);
    frames++;
  }
  /* F4: a capped run is NOT a death. Reporting it as g.cause laundered every
     survivor into the constructor's default cause ('rift'). */
  const capped = g.state === 'playing';
  return {
    score: g.score, hooks: g.hooks, altitude: g.altitude,
    cause: capped ? 'CAP' : g.cause,
    capped,
    seconds: frames / 60
  };
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = f => s[Math.min(s.length - 1, Math.floor(s.length * f))];
  return {
    min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  };
}

function report(label, runs) {
  const sc = stats(runs.map(r => r.score));
  const hk = stats(runs.map(r => r.hooks));
  const tm = stats(runs.map(r => r.seconds));
  const capped = runs.filter(r => r.capped);
  const died = runs.filter(r => !r.capped);
  const causes = {};
  died.forEach(r => { causes[r.cause] = (causes[r.cause] || 0) + 1; });

  console.log(`\n=== ${label}  (${runs.length} runs) ===`);
  console.log(`  score    min ${sc.min}  p25 ${sc.p25}  median ${sc.median}  p75 ${sc.p75}  p90 ${sc.p90}  max ${sc.max}`);
  console.log(`  hooks    min ${hk.min}  median ${hk.median}  p90 ${hk.p90}  max ${hk.max}`);
  console.log(`  run len  median ${tm.median.toFixed(1)}s   max ${tm.max.toFixed(1)}s`);
  /* F4: survivors are reported on their own line, never folded into a cause. */
  const capPct = (capped.length / runs.length * 100);
  console.log(`  SURVIVED ${CAP_SECONDS}s cap: ${capped.length}/${runs.length} (${capPct.toFixed(1)}%)`);
  if (died.length) {
    const dl = stats(died.map(r => r.seconds));
    console.log(`  time-to-death (deaths only)  median ${dl.median.toFixed(1)}s  p90 ${dl.p90.toFixed(1)}s  max ${dl.max.toFixed(1)}s`);
    console.log(`  deaths   ${Object.entries(causes).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v / died.length * 100)}%`).join('  ')}   (n=${died.length})`);
  } else {
    console.log('  deaths   NONE - every run hit the cap');
  }
  return { sc, hk, tm, capPct, causes, nDied: died.length, deathTm: died.length ? stats(died.map(r => r.seconds)) : null };
}

const N = parseInt(argv.find(a => /^\d+$/.test(a)) || '150', 10);
const SEED_BASE = parseInt(flag('seed', ''), 10);
const PAIRED = Number.isFinite(SEED_BASE);

const profiles = [
  /* panic = per-second chance of letting go with no aim at all. Calibrated on
     the SHIPPED (pre-gravity) build so that first-timer runs land in the 4-30s
     window the health check already asserts: 0.40/s put the median at 5.4 s
     with a p25 score of ZERO, i.e. most first-timers died before their first
     hook, which is harsher than the game a human actually meets. */
  ['first-timer', { mode: 'casual', tolerance: 78, missChance: 0.34, panic: 0.13 }],
  ['casual',      { mode: 'casual', tolerance: 62, missChance: 0.16, panic: 0.06 }],
  ['good',        { mode: 'casual', tolerance: 44, missChance: 0.06, panic: 0.02 }],
  ['expert',      { mode: 'expert', panic: 0 }]
];

console.log(`build: ${ROOT}`);
console.log(`constants read from build: MIN_R=${K.MIN_R}  CAPTURE_R=${K.CAPTURE_R}  SPEED=${K.SPEED}  FLIGHT_MAX=${K.FLIGHT_MAX === null ? 'absent' : K.FLIGHT_MAX}`);
console.log(PAIRED ? `paired seeding: base ${SEED_BASE} (run i faces the same world in every profile/build)` : 'seeding: random (use --seed=N for a paired A/B)');

const out = {};
for (const [label, skill] of profiles) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    let seed;
    if (PAIRED) {
      seed = (SEED_BASE + i * 2654435761) >>> 0;
      /* Determinism has to cover the synthetic player's own coin flips and the
         game's cosmetic Math.random calls, not just the world seed. */
      const r = rng((SEED_BASE ^ 0x9e3779b9) + i);
      setRandom(r);
      const saved = Math.random;
      Math.random = r;
      try { runs.push(playOne(SK, skill, seed)); } finally { Math.random = saved; }
      continue;
    }
    runs.push(playOne(SK, skill, seed));
  }
  out[label] = report(label, runs);
}

/* A casual arcade game wants: first runs short (a few seconds), a clear
   skill gradient, and a long tail so mastery keeps paying out. */
console.log('\n--- health checks ---');
const g1 = out['first-timer'].tm.median, g2 = out['expert'].sc.median;
const gradient = out['expert'].sc.median / Math.max(1, out['first-timer'].sc.median);
console.log(`  first run length (median): ${g1.toFixed(1)}s  ${g1 >= 4 && g1 <= 30 ? 'OK' : 'OUT OF RANGE'}`);
console.log(`  skill gradient expert/first-timer score: ${gradient.toFixed(1)}x  ${gradient >= 3 ? 'OK' : 'TOO FLAT'}`);
console.log(`  expert median score: ${g2}`);

/* F4 follow-through: the cap is a measurement boundary, so say out loud when
   it is distorting the numbers instead of burying it in a percentile. */
console.log('\n--- cap pressure (a capped run is an unfinished measurement, not a win) ---');
for (const [label] of profiles) {
  const o = out[label];
  const verdict = o.capPct >= 50 ? 'MEASUREMENT INVALID - most runs never ended'
    : o.capPct >= 15 ? 'DISTORTED - raise the cap or the game is too easy'
    : 'ok';
  console.log(`  ${label.padEnd(12)} capped ${o.capPct.toFixed(1).padStart(5)}%   ${verdict}`);
}
const mediocreImmortal = out['casual'].capPct >= 50;
if (mediocreImmortal) {
  console.log('\n  !! LOSABILITY FAILURE: the "casual" profile survives the cap in most runs.');
  console.log('     A mediocre player cannot lose. This is a design failure regardless of');
  console.log('     what the difficulty numbers look like.');
}
if (has('json')) console.log('\nJSON ' + JSON.stringify(out));
