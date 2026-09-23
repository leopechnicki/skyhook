/* SKYHOOK leaderboard bot review - calibration gate.
 *
 * supabase/schema.sql (scores_review) holds a run for review when its
 * telemetry says it was played by a machine. A threshold like that is only
 * as good as the two numbers it sits between, so this harness measures both,
 * on the real game logic, headlessly, in the same vm sandbox as latency.mjs:
 *
 *   BOT     the release rule of test/bot.js - public, in this repo, and the
 *           obvious thing to point at the leaderboard - polled at 60 Hz the
 *           way a requestAnimationFrame loop polls it.
 *   HUMAN   the same aim, released with Gaussian timing error of a given
 *           spread (ms), anticipating as well as reacting. Documented human
 *           coincidence-timing spread is ~20-40 ms; 12 ms is modelled as an
 *           exceptionally consistent player and must still pass.
 *
 * The rule under test is js/online.js reviewRun(), the client mirror of the
 * SQL; test/online.mjs asserts the two carry the same numbers.
 *
 * Gates (exit non-zero on any):
 *   - the bot is flagged superhuman_timing on (nearly) every run
 *   - no modelled human at >= 12 ms spread is flagged, on any run
 *   - no run the game actually produced trips telemetry_mismatch
 *   - input the game did not receive as a trusted event is counted as synthetic
 *
 * Run:  node test/botdef.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---- sandbox (same shape as latency.mjs / balance.mjs) ------------------ */

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

const sandMath = Object.create(Math);
let source = Math.random;
sandMath.random = () => source();
const sandbox = { Math: sandMath, Date, console, JSON, Proxy };
vm.createContext(sandbox);
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.document = { createElement: () => fakeCanvas() };
const run = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
run('js/utils.js');
const noop = () => {};
sandbox.SK.Audio = {
  muted: true, ready: false, ctx: null,
  init: noop, resume: noop, setMuted: noop,
  hook: noop, shard: noop, warn: noop, snap: noop, death: noop, start: noop, best: noop, ui: noop
};
run('js/celestial.js');
run('js/rocket.js');
run('js/game.js');
run('js/online.js');
const SK = sandbox.SK;

const gameSrc = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
const STEP = 1 / parseFloat(gameSrc.match(/var\s+STEP\s*=\s*1\s*\/\s*([0-9.]+)/)[1]);

/* ---- reporting --------------------------------------------------------- */

const fails = [];
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ->  ' + detail : ''));
  if (!cond) fails.push(label);
}
function note(label, detail) { console.log('      ' + label + ': ' + detail); }

/* ---- players ----------------------------------------------------------- */

function nearest(g) {
  const p = g.player;
  let t = null, bd = Infinity;
  for (const n of g.nodes) {
    if (n.spent || n === p.node) continue;
    const d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d < bd) { bd = d; t = n; }
  }
  return t;
}

function aimAt(g, target, ang) {
  const p = g.player;
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const rx = p.node.x + cs * p.r, ry = p.node.y + sn * p.r;
  const vx = -sn * p.dir, vy = cs * p.dir;
  const tx = target.x - rx, ty = target.y - ry;
  return { along: tx * vx + ty * vy, perp: Math.abs(tx * vy - ty * vx) };
}

/* Deterministic standard normal, from the harness's own seeded stream so the
   gate gives the same answer on every machine. */
function gaussFrom(rand) {
  return () => {
    let u = 0, v = 0;
    while (!u) u = rand();
    while (!v) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/* sdMs === null -> the test/bot.js rule at 60 Hz. Otherwise a human with that
   much timing spread. `trusted` marks every tap as a real browser event, the
   way main.js would; false leaves them untrusted, the way dispatchEvent is. */
function play(seed, sdMs, opts) {
  opts = opts || {};
  const maxS = opts.maxS || 180;
  source = mulberry32(seed ^ 0x5eed);
  const gauss = gaussFrom(mulberry32(seed * 7919 + 17));
  const g = new SK.Game();
  g.skipTutorial(false);
  g.start(seed);
  const tap = () => { if (opts.trusted !== false) g.inputTrusted = true; g.action(); };

  let planNode = null, plan = null, ticks = 0;
  while (g.state === 'playing' && ticks < maxS / STEP) {
    const p = g.player;
    if (sdMs === null) {
      if (ticks % 2 === 0 && p.mode === 'orbit' && p.node) {
        const t = nearest(g);
        if (t) {
          const now = aimAt(g, t, p.ang), soon = aimAt(g, t, p.ang + g.angRate(p) * STEP * 2);
          const tol = 70 * ((t.captureR || 92) / 92);
          if (now.along > 0 && now.perp < tol && soon.perp >= now.perp) tap();
        }
      }
    } else if (p.mode !== 'orbit' || !p.node) {
      planNode = null; plan = null;
    } else {
      /* One intention per anchor: the error is drawn once, then executed -
         early by anticipating the optimum, or late by reacting after it. */
      if (planNode !== p.node) {
        planNode = p.node;
        plan = { e: Math.round(gauss() * (sdMs / 1000) / STEP), optT: null, done: false };
      }
      if (!plan.done) {
        const t = nearest(g);
        let kopt = null;
        if (t) {
          const w = g.angRate(p) * STEP, tol = 70 * ((t.captureR || 92) / 92);
          let bp = Infinity;
          for (let k = 0; k < 600; k++) {
            const a = aimAt(g, t, p.ang + w * k);
            if (a.along > 0 && a.perp < tol) { if (a.perp < bp) { bp = a.perp; kopt = k; } else break; }
            else if (kopt !== null) break;
          }
        }
        if (plan.e <= 0) {
          if (kopt !== null && kopt <= -plan.e) { tap(); plan.done = true; }
        } else {
          if (plan.optT === null && kopt === 0) plan.optT = ticks;
          if (plan.optT !== null && ticks >= plan.optT + plan.e) { tap(); plan.done = true; }
        }
      }
    }
    g.update(STEP);
    ticks++;
  }
  const r = { score: g.score, hooks: g.hooks, telemetry: g.telemetry() };
  r.reasons = SK.Online.reviewRun(r);
  return r;
}

const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const SEEDS = Array.from({ length: 16 }, (_, i) => 2001 + i);

console.log('SKYHOOK bot review calibration\n');
note('rule', JSON.stringify(SK.Online.REVIEW));
console.log('');

/* ---- A. the public bot ------------------------------------------------- */

const bot = SEEDS.map(s => play(s, null));
const botFlagged = bot.filter(r => r.reasons.includes('superhuman_timing')).length;
note('bot', 'median score ' + median(bot.map(r => r.score)) + ', median hooks ' + median(bot.map(r => r.hooks)));
ok(botFlagged >= SEEDS.length - 1,
  'test/bot.js release rule is flagged superhuman_timing on (nearly) every run',
  botFlagged + '/' + SEEDS.length);

/* ---- B. modelled humans ------------------------------------------------ */

const allRuns = [...bot];
for (const sd of [12, 20, 30]) {
  const runs = SEEDS.map(s => play(s, sd));
  allRuns.push(...runs);
  const flagged = runs.filter(r => r.reasons.includes('superhuman_timing')).length;
  note('human ' + sd + ' ms', 'median score ' + median(runs.map(r => r.score)) +
    ', max ' + Math.max(...runs.map(r => r.score)) + ', median hooks ' + median(runs.map(r => r.hooks)));
  ok(flagged === 0, 'a human with ' + sd + ' ms timing spread is never flagged', flagged + '/' + SEEDS.length + ' flagged');
}

/* Timing precision IS score in this game. That is what makes the timing rule
   worth having: a bot that adds enough noise to pass it scores like a human. */
const h8 = median(SEEDS.slice(0, 8).map(s => play(s, 8).score));
const h30 = median(SEEDS.slice(0, 8).map(s => play(s, 30).score));
note('score vs spread', '8 ms -> ' + h8 + ', 30 ms -> ' + h30);
ok(h8 > h30 * 3, 'timing precision drives score (8 ms player out-scores 30 ms player 3x+)', h8 + ' vs ' + h30);

/* ---- C. consistency: nothing the game produces trips the mismatch rule -- */

const mism = allRuns.filter(r => r.reasons.includes('telemetry_mismatch')).length;
ok(mism === 0, 'no genuine run trips telemetry_mismatch', mism + '/' + allRuns.length);
ok(allRuns.every(r => r.telemetry.off.length <= 400), 'offsets are capped at 400 per run');

/* ---- D. trusted vs synthetic input ------------------------------------- */

const trusted = play(2001, 20, { maxS: 30 });
const synthetic = play(2001, 20, { maxS: 30, trusted: false });
ok(trusted.telemetry.syn === 0 && !trusted.reasons.includes('synthetic_input'),
  'taps marked trusted (main.js path) count zero synthetic inputs', 'syn=' + trusted.telemetry.syn);
ok(synthetic.telemetry.syn > 0 && synthetic.reasons.includes('synthetic_input'),
  'taps that bypass a trusted DOM event are counted synthetic and flagged', 'syn=' + synthetic.telemetry.syn);
ok(trusted.score === synthetic.score && trusted.hooks === synthetic.hooks,
  'trust is recorded, never enforced: identical taps play identically', trusted.score + ' vs ' + synthetic.score);

/* ---- E. the trust flag is consumed per input --------------------------- */
{
  source = mulberry32(99);
  const g = new SK.Game();
  g.skipTutorial(false);
  g.start(99);
  g.inputTrusted = true;
  g.action();
  for (let i = 0; i < 12; i++) g.update(STEP);
  g.action();                 // no trusted flag set this time
  ok(g.inputTrusted === false && g.telemetry().n === 2 && g.telemetry().syn === 1,
    'action() consumes the trust flag, so one trusted tap cannot vouch for the next',
    JSON.stringify({ n: g.telemetry().n, syn: g.telemetry().syn }));
}

console.log('\n' + (checks - fails.length) + '/' + checks + ' checks passed');
if (fails.length) {
  console.log('\nbot review calibration FAIL');
  process.exit(1);
}
console.log('\nbot review calibration PASS');
