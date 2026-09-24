/* SKYHOOK palette metrics - how strong, how visible, how distinct.
 *
 * Measures the ship menu (SK.Ship.SWATCHES) the way the game actually shows
 * it, and prints a table. Not a pass/fail gate - test/ship.mjs is that - but
 * the numbers the palette is chosen by, so a future "make it pop" change is
 * argued from measurements instead of from taste.
 *
 * Per swatch:
 *   CR      WCAG contrast ratio against the sky (#060713)
 *   L, C, h OKLCH lightness / chroma / hue. C is saturation as the eye reads
 *           it; "washed out" is low C, not low contrast.
 *   dE sky  OKLab distance to the sky
 *   dE gold OKLab distance to the #1 crown
 *   near    the closest OTHER swatch and its OKLab distance
 *
 * Summary: mean / min chroma, min pairwise distance, the nearest swatch to
 * gold, and how many (body, nose) / (body, window) pairs the readability rule
 * has to refuse - the fewer, the more of the menu a player can actually use.
 *
 * Run:  node test/palette_metrics.mjs              (the menu in js/ship.js)
 *       node test/palette_metrics.mjs '<json>'     (a candidate: [{hex,name}])
 *       node test/palette_metrics.mjs --json       (machine-readable)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const ctx = new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient')
    ? () => ({ addColorStop() {} }) : () => {}, set: () => true });
  const sandbox = { Math, JSON, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.document = { createElement: () => ({ getContext: () => ctx }) };
  for (const f of ['js/utils.js', 'js/ship.js', 'js/rocket.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
  }
  return sandbox.SK;
}

const SK = load();
const S = SK.Ship, R = SK.Rocket;
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const cand = args.find(a => a.trim().startsWith('['));
const menu = cand ? JSON.parse(cand) : S.SWATCHES.map(s => ({ hex: s.hex, name: s.name }));

function linear(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function oklch(hex) {
  const c = S.rgb(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}
const cr = (a, b) => { const x = S.luma(a), y = S.luma(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const rows = menu.map(sw => {
  const o = oklch(sw.hex);
  let near = null;
  for (const other of menu) {
    if (other.hex === sw.hex) continue;
    const d = S.deltaE(sw.hex, other.hex);
    if (!near || d < near.d) near = { name: other.name, d };
  }
  return { name: sw.name, hex: sw.hex, luma: S.luma(sw.hex), cr: cr(sw.hex, S.SKY),
    L: o.L, C: o.C, h: o.h, dSky: S.deltaE(sw.hex, S.SKY), dGold: S.deltaE(sw.hex, S.GOLD), near };
});

/* The readability rule on the pairs it judges: a nose or a window drawn on
   the plating the body colour produces. Same measurement SK.Ship.readable()
   makes, on the renderer's own derivation. */
let noseBad = 0, winBad = 0;
for (const body of menu) for (const mark of menu) {
  const c = R.resolve({ nose: mark.hex, window: mark.hex, body: body.hex, fire: body.hex });
  if (S.deltaE(c.nose, c.hull) < S.MARK_DE) noseBad++;
  if (S.deltaE(c.glass, c.hull) < S.MARK_DE) winBad++;
}

const pairs = [];
for (let i = 0; i < menu.length; i++) for (let j = i + 1; j < menu.length; j++) {
  pairs.push({ a: menu[i].name, b: menu[j].name, d: S.deltaE(menu[i].hex, menu[j].hex) });
}
pairs.sort((x, y) => x.d - y.d);
const goldNear = rows.slice().sort((x, y) => x.dGold - y.dGold)[0];
const summary = {
  count: menu.length,
  meanChroma: rows.reduce((s, r) => s + r.C, 0) / rows.length,
  minChroma: Math.min(...rows.map(r => r.C)),
  minContrastVsSky: Math.min(...rows.map(r => r.cr)),
  meanContrastVsSky: rows.reduce((s, r) => s + r.cr, 0) / rows.length,
  minLuma: Math.min(...rows.map(r => r.luma)),
  minPairDeltaE: pairs[0].d, closestPair: pairs[0].a + ' / ' + pairs[0].b,
  nearestToGold: goldNear.name, nearestToGoldDeltaE: goldNear.dGold,
  refusedBodyNosePairs: noseBad, refusedBodyWindowPairs: winBad, pairsJudged: menu.length * menu.length
};

if (asJson) {
  console.log(JSON.stringify({ rows, summary }, null, 2));
} else {
  const f = (v, n = 3) => v.toFixed(n);
  console.log('name           hex       luma   CR:sky   L      C      h     dE sky  dE gold  nearest');
  for (const r of rows) {
    console.log(`${r.name.padEnd(14)} ${r.hex}  ${f(r.luma)}  ${f(r.cr, 2).padStart(6)}  ${f(r.L)}  ${f(r.C)}  ${f(r.h, 0).padStart(3)}  ${f(r.dSky)}   ${f(r.dGold)}   ${r.near.name} ${f(r.near.d)}`);
  }
  console.log('\n' + Object.entries(summary).map(([k, v]) => `${k}: ${typeof v === 'number' ? +v.toFixed(3) : v}`).join('\n'));
}
