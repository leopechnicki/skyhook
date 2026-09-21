/* SKYHOOK input-latency gate  -  "it feels laggy" made falsifiable.
 *
 * A player reported (PT-BR) "tem um delay quando o planeta fica com
 * highlighted e click" - a delay between the planet lighting up and the tap
 * doing something. "Feels laggy" is not a bug report a diff can answer, so
 * this harness turns every suspected cause into a NUMBER measured on the real
 * game logic, headlessly, in the same vm sandbox balance.mjs and world.mjs use.
 *
 * What it measures
 *   A  hitstop swallow   - extra ms a tap waits when it lands inside the
 *                          35 ms tight-catch freeze
 *   B  debounce window   - ms of input the gameplay debounce silently drops
 *   C  real-play census  - how often A and B actually fire in a played run
 *   D  visual commit     - degrees the drawn hull lags the true launch vector,
 *                          and ms until the ship has visibly committed
 *   E  lock-on latch     - the target lock is a binary event on the sim clock
 *   F  determinism       - a seeded tap schedule replays identically, and
 *                          identically at 60 Hz and 120 Hz
 *
 * Run:  node test/latency.mjs            (gate: exits non-zero on regression)
 *       node test/latency.mjs --report   (print the numbers, never fail)
 *
 * Measured, not asserted-by-adjective: every line carries the ms.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPORT_ONLY = process.argv.includes('--report');

/* ---- sandbox (same shape as balance.mjs / world.mjs) -------------------- */

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

function mulberry32(seed) {
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

  const gameSrc = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8'), sandbox);
  const noop = () => {};
  sandbox.SK.Audio = {
    muted: true, ready: false, ctx: null,
    init: noop, resume: noop, setMuted: noop,
    hook: noop, shard: noop, warn: noop, snap: noop, death: noop, start: noop, best: noop, ui: noop
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'js/celestial.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/rocket.js'), 'utf8'), sandbox);
  vm.runInContext(gameSrc, sandbox);

  /* Read the tuning constants OUT OF the build under test. A latency harness
     that hardcodes the numbers it measures is measuring its own source. */
  const num = (re, what) => {
    const m = gameSrc.match(re);
    if (!m) throw new Error('latency.mjs: cannot find ' + what + ' in js/game.js');
    return parseFloat(m[1]);
  };

  return {
    SK: sandbox.SK,
    setRandom: (fn) => { source = fn; },
    K: {
      STEP_DEN: num(/var\s+STEP\s*=\s*1\s*\/\s*([0-9.]+)/, 'var STEP'),
      DEBOUNCE: num(/var\s+ACT_DEBOUNCE\s*=\s*([0-9.]+)/, 'var ACT_DEBOUNCE'),
      AIM_HALF: num(/var\s+AIM_HALF\s*=\s*([0-9.]+)/, 'var AIM_HALF'),
      HITSTOP: num(/if\s*\(tight\)\s*this\.hitstop\s*=\s*([0-9.]+)/, 'the tight-catch hitstop')
    }
  };
}

const { SK, setRandom, K } = loadGame(ROOT);
const STEP = 1 / K.STEP_DEN;
const MS = STEP * 1000;                       // one sim tick, in ms
const TAU = Math.PI * 2;

/* ---- reporting --------------------------------------------------------- */

const fails = [];
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ->  ' + detail : ''));
  if (!cond) fails.push(label);
}
function note(label, detail) { console.log('      ' + label + ': ' + detail); }

/* ---- helpers ----------------------------------------------------------- */

function newRun(seed) {
  setRandom(mulberry32(seed ^ 0x5eed));
  const g = new SK.Game();
  g.skipTutorial(false);
  g.start(seed);
  return g;
}

/* One tick per call. dt === STEP exactly, so update() runs the accumulator
   through exactly one _tick(). */
const tick = (g) => g.update(STEP);

function degDiff(a, b) {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return Math.abs(d) * 180 / Math.PI;
}

/* The expert release rule, identical to test/bot.js and balance.mjs: let go on
   the angle whose closest approach to the nearest body is minimal. */
function expertWouldRelease(g, dt) {
  const p = g.player;
  if (p.mode !== 'orbit' || !p.node) return false;
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
  const step = g.angRate(p) * dt;
  const now = aim(p.ang), soon = aim(p.ang + step);
  const tol = 70 * ((target.captureR || 92) / 92);
  return now.along > 0 && now.perp < tol && soon.perp >= now.perp;
}

console.log('SKYHOOK input latency\n');
note('sim step', MS.toFixed(2) + ' ms (' + K.STEP_DEN + ' Hz)');
note('ACT_DEBOUNCE', (K.DEBOUNCE * 1000).toFixed(0) + ' ms');
note('tight-catch hitstop', (K.HITSTOP * 1000).toFixed(0) + ' ms');
console.log('');

/* =========================================================================
 * A. HITSTOP SWALLOW
 * A tight catch freezes the sim for 35 ms of juice. If queued input is read
 * AFTER that freeze, a tap that lands inside it waits out the whole freeze -
 * and a tight catch is exactly the moment a good player taps again.
 * ====================================================================== */

function hitstopExtraMs(offsetTicks) {
  const g = newRun(4242);
  for (let i = 0; i < 40 && g.state === 'playing'; i++) tick(g);
  if (g.player.mode !== 'orbit') throw new Error('latency.mjs: expected orbit');

  /* Exactly the state _hook() leaves behind on a tight catch. */
  g.hitstop = K.HITSTOP;
  for (let i = 0; i < offsetTicks; i++) tick(g);

  let releasedAt = -1, t = 0;
  const real = g._release.bind(g);
  g._release = function (forced) { if (releasedAt < 0) releasedAt = t; return real(forced); };

  g.action();                       // the tap
  while (releasedAt < 0 && t < 600) { tick(g); t++; }
  /* One tick of quantisation is the CONTRACT (input is consumed at the head of
     the next tick so replays are frame-rate independent). Anything past that
     first tick is the freeze eating the input. */
  return releasedAt < 0 ? Infinity : releasedAt * MS;
}

const freezeTicks = Math.ceil(K.HITSTOP / STEP);
const worstHitstop = hitstopExtraMs(0);
const midHitstop = hitstopExtraMs(Math.max(0, Math.floor(freezeTicks / 2)));
const noHitstop = (function () {
  const g = newRun(4242);
  for (let i = 0; i < 40 && g.state === 'playing'; i++) tick(g);
  let releasedAt = -1, t = 0;
  const real = g._release.bind(g);
  g._release = function (f) { if (releasedAt < 0) releasedAt = t; return real(f); };
  g.action();
  while (releasedAt < 0 && t < 600) { tick(g); t++; }
  return releasedAt * MS;
}());

note('freeze length', freezeTicks + ' ticks (' + (freezeTicks * MS).toFixed(1) + ' ms)');
note('tap with no freeze active', '+' + noHitstop.toFixed(1) + ' ms beyond the 1-tick consumption');
note('tap mid-freeze', '+' + midHitstop.toFixed(1) + ' ms');
note('tap at the head of a freeze (worst case)', '+' + worstHitstop.toFixed(1) + ' ms');
ok(noHitstop === 0, 'a tap outside a freeze releases on the very next tick',
  '+' + noHitstop.toFixed(1) + ' ms');
ok(worstHitstop === 0, 'a tap INSIDE a hitstop freeze still releases on the next tick',
  '+' + worstHitstop.toFixed(1) + ' ms (freeze is ' + (freezeTicks * MS).toFixed(1) + ' ms long)');

/* =========================================================================
 * B. DEBOUNCE WINDOW
 * The debounce exists to kill a synthesised duplicate event, which arrives
 * within a couple of ms. Anything wider silently deletes real taps.
 * ====================================================================== */

function tapAccepted(gapSeconds) {
  const g = newRun(4242);
  for (let i = 0; i < 40 && g.state === 'playing'; i++) tick(g);
  g.lastActionT = g.time - gapSeconds;
  g.queuedAction = false;
  g.action();
  return g.queuedAction === true;
}

const ghostDropped = !tapAccepted(0.004);          // 4 ms: a synthesised ghost
const fastTapKept = tapAccepted(0.05);             // 50 ms: a real fast double tap
note('debounce window', (K.DEBOUNCE * 1000).toFixed(0) + ' ms of real input dropped with zero feedback');
ok(K.DEBOUNCE <= 0.05, 'debounce is tight enough to be invisible to a human',
  (K.DEBOUNCE * 1000).toFixed(0) + ' ms (gate: <= 50 ms)');
ok(ghostDropped, 'a 4 ms ghost event is still dropped');
ok(fastTapKept, 'a deliberate 50 ms double tap is HONOURED, not deleted');

/* =========================================================================
 * C. REAL-PLAY CENSUS
 * How often do A and B actually bite in a played run? Four seeds, the expert
 * release rule, 120 s cap each.
 * ====================================================================== */

function census(seed) {
  const g = newRun(seed);
  let taps = 0, inFreeze = 0, debounced = 0, frozenMs = 0, ghostGap = 0;
  let pendingAt = -1, t = 0;
  const real = g._release.bind(g);
  g._release = function (forced) {
    if (!forced && pendingAt >= 0) { frozenMs += (t - pendingAt) * MS; pendingAt = -1; }
    return real(forced);
  };
  const cap = Math.round(120 / STEP);
  while (g.state === 'playing' && t < cap) {
    if (expertWouldRelease(g, STEP)) {
      taps++;
      const gap = g.time - g.lastActionT;
      const wouldDebounce = gap < K.DEBOUNCE;
      const wouldFreeze = g.hitstop > 0;
      g.action();
      if (wouldDebounce) {
        debounced++;
        /* A tap this close to the previous one is a synthesised duplicate, not
           a human: it would be dropped by ANY sane debounce. Separating the
           two populations is the whole point - one is protection, the other is
           deleted gameplay. */
        if (gap < 0.02) ghostGap++;
      } else { if (wouldFreeze) inFreeze++; pendingAt = t; }
    }
    tick(g); t++;
  }
  return {
    taps: taps, inFreeze: inFreeze, debounced: debounced, ghostGap: ghostGap,
    frozenMs: frozenMs, seconds: t * STEP
  };
}

const cens = [4242, 1, 99991, 777777].map(census);
const sum = (k) => cens.reduce((a, c) => a + c[k], 0);
const totalTaps = sum('taps');
const accepted = totalTaps - sum('debounced');
const pctFreeze = totalTaps ? (sum('inFreeze') / totalTaps) * 100 : 0;
const pctDebounced = totalTaps ? (sum('debounced') / totalTaps) * 100 : 0;
const msPerTap = accepted ? sum('frozenMs') / accepted : 0;
note('played', sum('seconds').toFixed(0) + ' s over 4 seeds, ' + totalTaps + ' taps');
note('taps landing inside a hitstop freeze', sum('inFreeze') + ' (' + pctFreeze.toFixed(1) + '%)');
note('taps deleted by the debounce', sum('debounced') + ' (' + pctDebounced.toFixed(1) + '%)'
  + ', of which ' + sum('ghostGap') + ' were <20 ms ghosts');
note('mean queued-to-release delay', msPerTap.toFixed(2) + ' ms per accepted tap');
ok(msPerTap <= 0.01, 'accepted taps release on the next tick, every time',
  msPerTap.toFixed(2) + ' ms mean extra delay');
/* The gate is on HUMAN taps deleted. Sub-20 ms duplicates are what a debounce
   is for, so they are excluded rather than counted as a defect. */
const humanDeleted = sum('debounced') - sum('ghostGap');
ok(humanDeleted === 0, 'no human-timed tap is deleted by the debounce during play',
  humanDeleted + ' deleted (' + ((humanDeleted / Math.max(1, totalTaps)) * 100).toFixed(1) + '% of taps)');

/* =========================================================================
 * D. VISUAL COMMIT
 * Physics fires instantly; the player reads the SHIP. If the hull eases into
 * the launch vector over several frames the release LOOKS late even when the
 * velocity was right on time.
 * ====================================================================== */

function commit(seed) {
  const g = newRun(seed);
  for (let i = 0; i < 90 && g.state === 'playing'; i++) tick(g);
  const p = g.player;
  const orbitLag = degDiff(p.aim, SK.Rocket.heading(p));   // steady-state lag while orbiting

  g.action();
  tick(g);                                                 // the release tick
  const atRelease = degDiff(p.aim, SK.Rocket.heading(p));
  let ticks = 0;
  while (degDiff(p.aim, SK.Rocket.heading(p)) > 2 && ticks < 600 && g.state === 'playing') {
    tick(g); ticks++;
  }
  return { orbitLag: orbitLag, atRelease: atRelease, settleMs: ticks * MS, mode: p.mode };
}

const cm = commit(4242);
note('hull lag while orbiting', cm.orbitLag.toFixed(1) + ' deg behind the launch vector');
note('hull error on the release tick', cm.atRelease.toFixed(2) + ' deg');
note('time until the hull has visibly committed (<2 deg)', cm.settleMs.toFixed(1) + ' ms after the tap');
ok(cm.mode === 'fly', 'the tap did release the player', 'mode=' + cm.mode);
ok(cm.atRelease < 1, 'the ship commits to the launch vector on the exact release tick',
  cm.atRelease.toFixed(2) + ' deg error');
ok(cm.settleMs === 0, 'no post-tap swing-in', cm.settleMs.toFixed(1) + ' ms');

/* =========================================================================
 * E. LOCK-ON LATCH
 * Perceived latency is mostly feedback timing. The target lock has to be a
 * discrete EVENT on the sim clock, not a distance gradient, so the renderer
 * can snap on it instead of fading it in.
 * ====================================================================== */

(function lockCheck() {
  const g = newRun(4242);
  let sawLock = false, resets = 0, badReset = 0, monotonic = true, leaked = false;
  let prevNode = null, prevT = 0, prevMode = g.player.mode;
  for (let i = 0; i < 2400 && g.state === 'playing'; i++) {
    tick(g);
    const node = (g.lockNode === undefined) ? null : g.lockNode;
    const t = g.lockT;
    if (node) {
      sawLock = true;
      if (node !== prevNode) { resets++; if (t !== 0) badReset++; }
      else if (t < prevT) monotonic = false;
    }
    if (g.player.mode !== 'orbit' && node) leaked = true;
    prevNode = node; prevT = t; prevMode = g.player.mode;
  }
  note('lock acquisitions in 20 s', String(resets));
  ok(sawLock, 'the game exposes a lock-on target (game.lockNode)');
  ok(resets > 0 && badReset === 0,
    'lockT is 0 on the exact tick the target changes (snap, not fade)',
    resets + ' acquisitions, ' + badReset + ' without a clean reset');
  ok(monotonic, 'lockT advances on the sim clock while the lock holds');
  ok(!leaked, 'the lock clears the moment the player leaves orbit');
}());

/* =========================================================================
 * F. DETERMINISM
 * Everything above moved WHEN input is consumed. The contract it must not
 * break: identical taps at identical sim ticks produce an identical run, at
 * any refresh rate.
 * ====================================================================== */

function hashRun(seed, schedule, ticksPerFrame) {
  const g = newRun(seed);
  const h = crypto.createHash('sha1');
  const want = new Set(schedule);
  const dt = STEP * ticksPerFrame;
  let t = 0;
  const cap = Math.max.apply(null, schedule.concat([0])) + 600;
  while (t < cap) {
    if (want.has(t)) g.action();
    g.update(dt);
    t += ticksPerFrame;
    /* Sample on EVEN tick boundaries only. A 60 Hz driver can only observe the
       world every 2 ticks; hashing every tick at 120 Hz would compare two
       different sampling rates and call the game non-deterministic when the
       only thing that differed was how often we looked. */
    if (t % 2 === 0) {
      const s = g.snapshot();
      h.update(JSON.stringify([s.state, s.simTime, s.score, s.hooks, s.combo, s.altitude,
        s.mode, s.px, s.py, s.ang, s.r, s.dir, s.speed, s.predict]));
    }
    if (g.state !== 'playing') break;
  }
  return { hash: h.digest('hex'), ticks: t, score: g.score, hooks: g.hooks, state: g.state };
}

/* Record a real expert tap schedule, snapped to EVEN tick indices so the same
   schedule is expressible at 60 Hz (2 ticks/frame) and at 120 Hz (1). */
const schedule = (function record() {
  const g = newRun(123);
  const out = [];
  for (let t = 0; t < 3600 && g.state === 'playing'; t++) {
    if (t % 2 === 0 && expertWouldRelease(g, STEP)) { g.action(); out.push(t); }
    tick(g);
  }
  return out;
}());

const a = hashRun(123, schedule, 1);
const b = hashRun(123, schedule, 1);
const c = hashRun(123, schedule, 2);
note('seed 123 schedule', schedule.length + ' taps, ' + a.ticks + ' ticks, score ' + a.score
  + ', ' + a.hooks + ' hooks, ended ' + a.state);
ok(a.hash === b.hash, 'seed 123 replays byte-identically', a.hash.slice(0, 12));
ok(a.hash === c.hash, 'seed 123 is identical at 120 Hz and 60 Hz (fixed-step contract holds)',
  a.hash.slice(0, 12) + ' vs ' + c.hash.slice(0, 12));

/* ---- verdict ----------------------------------------------------------- */

console.log('\n' + (checks - fails.length) + '/' + checks + ' checks passed');
if (fails.length && !REPORT_ONLY) {
  console.log('\nlatency gate FAIL');
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
console.log(fails.length ? '\n(--report: failures are not gating)' : '\ninput latency gate PASS');
