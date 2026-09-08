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
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
  const sandbox = { Math, Date, console, JSON, Proxy };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => fakeCanvas() };
  sandbox.navigator = undefined;
  sandbox.localStorage = undefined;   // exercises the in-memory Store fallback

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8'), sandbox);
  const noop = () => {};
  sandbox.SK.Audio = {
    muted: true, ready: false, ctx: null,
    init: noop, resume: noop, setMuted: noop,
    hook: noop, shard: noop, warn: noop, snap: noop, death: noop, start: noop, best: noop, ui: noop
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8'), sandbox);
  return sandbox.SK;
}

const SPEED = 468;

/* Decide whether this synthetic player releases on this frame. */
function shouldRelease(g, skill) {
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

  const step = p.dir * (SPEED / p.r) * (1 / 60);
  const now = aim(p.ang);
  if (now.along <= 0) return false;

  if (skill.mode === 'expert') {
    const soon = aim(p.ang + step);
    return now.perp < 70 && soon.perp >= now.perp;
  }
  // casual: fires on the first angle that looks acceptable, sometimes late,
  // sometimes not at all
  if (now.perp < skill.tolerance) {
    if (Math.random() < skill.missChance) return false;
    return true;
  }
  return false;
}

function playOne(SK, skill) {
  const g = new SK.Game();
  g.start();
  let frames = 0;
  while (g.state === 'playing' && frames < 60 * 240) {
    if (shouldRelease(g, skill)) g.action();
    g.update(1 / 60);
    frames++;
  }
  return { score: g.score, hooks: g.hooks, altitude: g.altitude, cause: g.cause, seconds: frames / 60 };
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
  const causes = {};
  runs.forEach(r => { causes[r.cause] = (causes[r.cause] || 0) + 1; });
  console.log(`\n=== ${label}  (${runs.length} runs) ===`);
  console.log(`  score    min ${sc.min}  p25 ${sc.p25}  median ${sc.median}  p75 ${sc.p75}  p90 ${sc.p90}  max ${sc.max}`);
  console.log(`  hooks    min ${hk.min}  median ${hk.median}  p90 ${hk.p90}  max ${hk.max}`);
  console.log(`  run len  median ${tm.median.toFixed(1)}s   max ${tm.max.toFixed(1)}s`);
  console.log(`  deaths   ${Object.entries(causes).map(([k, v]) => `${k} ${Math.round(v / runs.length * 100)}%`).join('  ')}`);
  return { sc, hk, tm };
}

const N = parseInt(process.argv[2] || '150', 10);
const SK = loadGame();

const profiles = [
  ['first-timer', { mode: 'casual', tolerance: 78, missChance: 0.34 }],
  ['casual',      { mode: 'casual', tolerance: 62, missChance: 0.16 }],
  ['good',        { mode: 'casual', tolerance: 44, missChance: 0.06 }],
  ['expert',      { mode: 'expert' }]
];

const out = {};
for (const [label, skill] of profiles) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(playOne(SK, skill));
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
