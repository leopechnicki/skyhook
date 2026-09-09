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
       the p.ang we are evaluating here).

     A build that predates the speed ramp has no p.speed at all (the currently
     live main integrates with the module-level SPEED constant). Reading the
     missing field gave `undefined / r` = NaN, so `soon.perp >= now.perp` was
     always false and the expert profile NEVER released: 0.0 hooks/min and a
     ~9 s median life, which reads as a catastrophic game defect and is purely
     an artefact of this harness. Fall back to the constant the build actually
     uses before dividing. */
  const linSpeed = Number.isFinite(p.speed) ? p.speed : K.SPEED;
  const rate = typeof g.angRate === 'function'
    ? g.angRate(p)                                  // prototype exposes it
    : p.dir * (linSpeed / Math.max(p.r, minRFor(p.node)));
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

/* ---------------------------------------------------------------------------
 * ENDLESS-MODE TERMINATION MODEL (2026-09-09, Crew)
 *
 * The rift and the flight timer are gone on purpose: a run now lasts as long
 * as the player keeps the ball on screen. That breaks every per-run TOTAL this
 * harness used to print. "Median score 47813" was really "median score of a
 * population where 57% of runs were stopped by our own stopwatch mid-flight" -
 * a censored total, which is not a statistic about the game at all. The old
 * code knew something was wrong (it printed MEASUREMENT INVALID) but had no
 * model to replace it with, so it just refused to answer.
 *
 * The cap is not a failure and not a win. It is RIGHT-CENSORING: we know the
 * run lasted AT LEAST 240 s and we stopped watching. That is a solved problem,
 * so use the standard tools instead of inventing one:
 *
 *   1. Kaplan-Meier survival curve  - the fraction still alive at time t,
 *      with censored runs correctly removed from the risk set rather than
 *      counted as deaths (which deflates survival) or dropped entirely
 *      (which inflates it). Gives S(30s), S(60s)... and a median when the
 *      curve actually reaches 0.5.
 *   2. Hazard rate = deaths / total exposure time. Unbiased under censoring
 *      because every second any run spent alive counts as exposure whether or
 *      not that run ended. This is THE headline number for an endless game:
 *      "how dangerous is a second of play to this player".
 *   3. Exponential-fit median (ln2 / hazard) - reports an expected run length
 *      even when most runs outlive the cap, which is exactly the case the old
 *      harness gave up on. Only trustworthy when the hazard is roughly flat
 *      over time, so hazard-by-phase is printed next to it and the estimate is
 *      labelled when the hazard is climbing.
 *   4. Progress RATES (score/min, hooks/min) pooled over exposure. A rate is
 *      censoring-proof; a total is not.
 *   5. Score AT fixed checkpoints, conditional on still being alive. Answers
 *      "what does a 60-second run look like" without any cap contamination.
 *
 * Consequence: a high cap-survival percentage is no longer an error. The thing
 * that actually invalidates the measurement is too few OBSERVED DEATHS, since
 * that is what the hazard estimate is built from - so that is what the
 * validity verdict now checks.
 * ------------------------------------------------------------------------- */
const CAP_SECONDS = parseFloat(flag('cap', '240'));
const CHECKPOINTS = [30, 60, 120, 240].filter(t => t <= CAP_SECONDS);

function playOne(SK, skill, seed) {
  const g = new SK.Game();
  /* The game ships this hook specifically for us (game.js:546). Without it the
     first run of a sweep - and only the first - plays the tutorial.
     Guarded because --game= is advertised for A/B against another build, and
     any build WITHOUT a tutorial (e.g. the currently-live main) has no such
     hook - an unguarded call made the A/B mode throw instead of measuring. */
  if (typeof g.skipTutorial === 'function') g.skipTutorial(false);
  g.start(seed);
  let frames = 0;
  const capFrames = Math.round(60 * CAP_SECONDS);
  /* Sample progress while the run is alive, so "score at 60 s" is a real
     observation and not something reconstructed from a truncated total. */
  const at = {};
  let nextCp = 0;
  while (g.state === 'playing' && frames < capFrames) {
    if (shouldRelease(g, skill)) g.action();
    g.update(1 / 60);
    frames++;
    while (nextCp < CHECKPOINTS.length && frames >= CHECKPOINTS[nextCp] * 60) {
      at[CHECKPOINTS[nextCp]] = { score: g.score, hooks: g.hooks };
      nextCp++;
    }
  }
  /* F4: a capped run is NOT a death. Reporting it as g.cause laundered every
     survivor into the constructor's default cause ('rift'). */
  const capped = g.state === 'playing';
  return {
    score: g.score, hooks: g.hooks, altitude: g.altitude,
    cause: capped ? 'CAP' : g.cause,
    capped,
    seconds: frames / 60,
    at
  };
}

/* ---- survival analysis over right-censored run lengths ------------------ */

/* Kaplan-Meier. `died` runs are events; `capped` runs leave the risk set
   without an event. */
function kaplanMeier(runs) {
  const pts = runs.map(r => ({ t: r.seconds, died: !r.capped }))
                  .sort((a, b) => a.t - b.t);
  let atRisk = pts.length, S = 1;
  const curve = [{ t: 0, S: 1 }];
  for (let i = 0; i < pts.length;) {
    const t = pts[i].t;
    let d = 0, c = 0;
    while (i < pts.length && pts[i].t === t) { pts[i].died ? d++ : c++; i++; }
    if (d > 0 && atRisk > 0) { S *= (1 - d / atRisk); curve.push({ t, S }); }
    atRisk -= (d + c);
  }
  return curve;
}
function survivalAt(curve, t) {
  let S = 1;
  for (const p of curve) { if (p.t <= t) S = p.S; else break; }
  return S;
}
/* The median is only "reached" if the curve actually crosses 0.5 before the
   cap. Otherwise say so instead of printing the cap as if it were an answer. */
function kmMedian(curve) {
  for (const p of curve) if (p.S <= 0.5) return p.t;
  return null;
}

/* Deaths per minute of play, and how that changes as a run gets longer.
   A flat hazard means run length is exponential and ln2/lambda is a real
   median; a rising hazard means the difficulty ramp is biting. */
function hazardByPhase(runs, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    let exposure = 0, deaths = 0;
    for (const r of runs) {
      exposure += Math.max(0, Math.min(r.seconds, hi) - lo);
      if (!r.capped && r.seconds > lo && r.seconds <= hi) deaths++;
    }
    out.push({ lo, hi, deaths, exposure, rate: exposure > 0 ? deaths / (exposure / 60) : null });
  }
  return out;
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

  /* Exposure: every second any run spent alive. The denominator that makes
     the rest of this block immune to where we put the cap. */
  const exposure = runs.reduce((a, r) => a + r.seconds, 0);
  const hazard = exposure > 0 ? died.length / (exposure / 60) : 0;   // deaths/min
  const meanLife = hazard > 0 ? 1 / hazard : Infinity;               // minutes
  const expMedian = hazard > 0 ? Math.LN2 / hazard : Infinity;       // minutes

  const km = kaplanMeier(runs);
  const kmMed = kmMedian(km);
  const phases = hazardByPhase(runs, [0, 30, 60, 120, CAP_SECONDS].filter((v, i, a) => a.indexOf(v) === i && v <= CAP_SECONDS));
  const rated = phases.filter(p => p.rate !== null && p.exposure > 30);
  const rising = rated.length >= 2 && rated[rated.length - 1].rate > rated[0].rate * 1.5;

  const capPct = (capped.length / runs.length * 100);

  console.log(`\n=== ${label}  (${runs.length} runs) ===`);
  console.log(`  exposure ${(exposure / 60).toFixed(1)} min    deaths ${died.length}    reached ${CAP_SECONDS}s cap ${capped.length} (${capPct.toFixed(1)}%)`);

  /* -- survival: the cap is censoring, not an outcome -- */
  console.log(`  -- survival (right-censored at the ${CAP_SECONDS}s cap) --`);
  console.log(`    still alive at   ` + CHECKPOINTS
    .map(t => `${t}s ${(survivalAt(km, t) * 100).toFixed(0)}%`).join('   '));
  console.log(`    median run length  ${kmMed !== null
    ? `${kmMed.toFixed(1)}s (Kaplan-Meier)`
    : `not reached within the cap; exponential fit ${(expMedian * 60).toFixed(0)}s${rising ? ' (hazard is RISING, so this is an over-estimate)' : ''}`}`);
  console.log(`    hazard  ${hazard.toFixed(3)} deaths/min   mean run ${meanLife === Infinity ? 'infinite' : (meanLife * 60).toFixed(0) + 's'}`);
  console.log(`    hazard by phase  ` + phases.map(p =>
    `${p.lo}-${p.hi}s ${p.rate === null ? '--' : p.rate.toFixed(2)}`).join('  ') +
    `  deaths/min${rising ? '   [RISING - difficulty ramp is biting]' : ''}`);

  /* -- rates: censoring-proof, unlike per-run totals -- */
  console.log(`  -- progress rate (pooled over exposure; cap-independent) --`);
  console.log(`    ${(runs.reduce((a, r) => a + r.score, 0) / (exposure / 60)).toFixed(0)} score/min` +
    `    ${(runs.reduce((a, r) => a + r.hooks, 0) / (exposure / 60)).toFixed(1)} hooks/min`);

  /* -- what a run of a given length actually looks like -- */
  const cps = CHECKPOINTS.map(t => {
    const alive = runs.filter(r => r.at[t]);
    if (!alive.length) return `${t}s n=0`;
    return `${t}s ${stats(alive.map(r => r.at[t].score)).median} (n=${alive.length})`;
  });
  console.log(`  -- median score among runs still alive --`);
  console.log(`    ${cps.join('   ')}`);

  /* Totals are kept, but flagged: for capped runs they are a LOWER BOUND. */
  console.log(`  final score (censored: capped runs are lower bounds)  median ${sc.median}  p90 ${sc.p90}  max ${sc.max}`);

  if (died.length) {
    console.log(`  deaths   ${Object.entries(causes).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v / died.length * 100)}%`).join('  ')}   (n=${died.length})`);
  } else {
    console.log(`  deaths   NONE observed - this player is unkillable within ${CAP_SECONDS}s`);
  }
  return {
    sc, hk, tm, capPct, causes, nDied: died.length,
    deathTm: died.length ? stats(died.map(r => r.seconds)) : null,
    exposure, hazard, meanLife, expMedian, km, kmMed, phases, rising,
    scorePerMin: runs.reduce((a, r) => a + r.score, 0) / (exposure / 60),
    survAt: Object.fromEntries(CHECKPOINTS.map(t => [t, survivalAt(km, t)])),
    /* Median run length in seconds, from KM when it is observed and from the
       exponential fit when the cap hid it. This is the number the health
       checks below consume, so they never read a censored median again. */
    medianLife: kmMed !== null ? kmMed : expMedian * 60
  };
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
   skill gradient, and a long tail so mastery keeps paying out.
   All three are now measured on cap-independent quantities. */
console.log('\n--- health checks (endless mode: rates and survival, never censored totals) ---');
const g1 = out['first-timer'].medianLife;
/* Gradient on score-per-minute, not on final score. Final score is censored
   for exactly the profile that matters most (expert), so the old gradient was
   biased DOWNWARD by the cap - it flattered a change that made experts die
   sooner, because dying sooner uncaps the total. */
const gradient = out['expert'].scorePerMin / Math.max(1, out['first-timer'].scorePerMin);
/* Second gradient: how much longer mastery keeps you alive. */
const lifeGradient = out['expert'].medianLife / Math.max(0.1, out['first-timer'].medianLife);
console.log(`  first run length (median): ${g1.toFixed(1)}s  ${g1 >= 4 && g1 <= 30 ? 'OK' : 'OUT OF RANGE'}`);
console.log(`  skill gradient expert/first-timer score RATE: ${gradient.toFixed(1)}x  ${gradient >= 3 ? 'OK' : 'TOO FLAT'}`);
console.log(`  survival gradient expert/first-timer median life: ${lifeGradient.toFixed(1)}x  ${lifeGradient >= 3 ? 'OK' : 'TOO FLAT'}`);
console.log(`  expert: ${out['expert'].scorePerMin.toFixed(0)} score/min, median life ${out['expert'].medianLife.toFixed(0)}s`);

/* The cap no longer decides validity - the number of OBSERVED DEATHS does,
   because that is what the hazard estimate is built from. An endless game is
   SUPPOSED to have runs that outlive the stopwatch. */
console.log('\n--- measurement validity (endless game: the cap censors, it does not fail) ---');
for (const [label] of profiles) {
  const o = out[label];
  const verdict = o.nDied === 0
    ? `NO DEATHS - cannot estimate hazard; this player is unkillable within ${CAP_SECONDS}s`
    : o.nDied < 10 ? 'INSUFFICIENT - too few deaths to estimate hazard; raise --cap or run count'
    : o.nDied < 30 ? 'THIN - hazard estimate is noisy; raise --cap or run count'
    : 'ok';
  console.log(`  ${label.padEnd(12)} deaths ${String(o.nDied).padStart(4)}   capped ${o.capPct.toFixed(1).padStart(5)}%   ${verdict}`);
}

/* Losability, restated for an endless game. "Survives our stopwatch" was never
   the right question - a good player SHOULD outlive a 4-minute cap. The real
   question is whether a mediocre player faces meaningful risk in a normal
   sitting, so ask the survival curve directly. */
const casualSurvives2min = out['casual'].survAt[120] !== undefined
  ? out['casual'].survAt[120] : survivalAt(out['casual'].km, 120);
console.log(`\n  losability: a "casual" player still alive after 2 min: ${(casualSurvives2min * 100).toFixed(1)}%  ` +
  `${casualSurvives2min < 0.5 ? 'OK' : 'FAILURE'}`);
if (casualSurvives2min >= 0.5 || out['casual'].nDied === 0) {
  console.log('  !! LOSABILITY FAILURE: a mediocre player is more likely than not to still be');
  console.log('     alive after two minutes. Endless is not the same as consequence-free.');
}
/* The mirror-image failure, which the old harness could not express at all:
   a game with no ceiling. If even a deliberately clumsy profile has ~zero
   hazard, the endless mode has stopped being a game. */
if (out['expert'].nDied > 0 && out['expert'].hazard < 0.01) {
  console.log('  !! CEILING WARNING: expert hazard is near zero - mastery ends the challenge.');
}
if (has('json')) console.log('\nJSON ' + JSON.stringify(out));
