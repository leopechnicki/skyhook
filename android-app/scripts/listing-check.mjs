/*
 * listing-check.mjs - the Play listing limits, as a test instead of a memory.
 *
 * Reads store-listing/LISTING.md, pulls each indented copy block out from
 * under its heading, and fails if a field is over the length Play Console
 * enforces (title 30, short description 80, full description 4000) or if a
 * listing image is not exactly the size Play requires. Run by `npm test`
 * in android-app/ so the next edit to the copy cannot ship an overflow.
 *
 * Also fails if a feature graphic or screenshot carries an alpha channel
 * (Play wants 24-bit PNG or JPEG for those) or a screenshot is not 9:16.
 *
 * Run:  node scripts/listing-check.mjs      (from android-app/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const LISTING = path.join(APP, 'store-listing');

const LIMITS = { 'App name': 30, 'Short description': 80, 'Full description': 4000 };
const IMAGES = {
  'icon-512.png': { size: [512, 512], alpha: 'allowed' },
  'feature-graphic-1024x500.jpg': { size: [1024, 500], alpha: 'forbidden' }
};

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed++;
}

/* The copy block under "## <heading> (max N)": every following line indented
   by four spaces, up to the next heading. Blank lines inside the block are
   kept (paragraph breaks in the full description), leading indent stripped. */
function block(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith('## ' + heading));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('## ')) break;
    if (l.startsWith('    ')) out.push(l.slice(4));
    else if (l.trim() === '' && out.length) out.push('');
  }
  return out.join('\n').replace(/\n+$/, '');
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/* IHDR colour type: 2 = RGB (24-bit, what Play calls "no alpha"), 6 = RGBA.
   Play accepts the icon with alpha but refuses a feature graphic or a
   screenshot that has an alpha channel, so those must be 2. */
function pngColourType(file) {
  const b = fs.readFileSync(file);
  if (b.length < 26) return -1;
  return b.readUInt8(25);
}

/* Baseline or progressive JPEG: walk the markers to the first SOF and read
   height/width. Play accepts JPEG for the feature graphic and screenshots. */
function jpegSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16BE(0) !== 0xffd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function imageSize(file) {
  return /\.jpe?g$/i.test(file) ? jpegSize(file) : pngSize(file);
}

const md = fs.readFileSync(path.join(LISTING, 'LISTING.md'), 'utf8');
for (const [field, max] of Object.entries(LIMITS)) {
  const text = block(md, field);
  check(field + ' present', text !== null && text.length > 0);
  if (text === null) continue;
  check(field + ' <= ' + max + ' chars', text.length <= max, text.length + ' chars');
}
const full = block(md, 'Full description') || '';
check('full description says there are no ads', /no ads/i.test(full));
check('full description links the privacy policy', full.includes('https://skyhookplay.com/privacy.html'));

for (const [file, { size: [w, h], alpha }] of Object.entries(IMAGES)) {
  const p = path.join(LISTING, file);
  const exists = fs.existsSync(p);
  check(file + ' exists', exists);
  if (!exists) continue;
  const size = imageSize(p);
  const isJpeg = /\.jpe?g$/i.test(file);
  check(file + ' is ' + w + 'x' + h + (isJpeg ? ' JPEG' : ' PNG'), !!size && size[0] === w && size[1] === h, size ? size.join('x') : 'not a ' + (isJpeg ? 'JPEG' : 'PNG'));
  check(file + ' under 1 MB', fs.statSync(p).size < 1024 * 1024, fs.statSync(p).size + ' bytes');
  if (alpha === 'forbidden' && !isJpeg) check(file + ' has no alpha channel (24-bit PNG)', pngColourType(p) === 2, 'colour type ' + pngColourType(p));
}

const shotsDir = path.join(LISTING, 'screenshots');
const shots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter(f => /^phone-\d\d-.*\.(png|jpe?g)$/i.test(f)) : [];
check('at least 2 and at most 8 phone screenshots', shots.length >= 2 && shots.length <= 8, shots.length + ' found');
check('at least 4 phone screenshots (Play promotion eligibility)', shots.length >= 4, shots.length + ' found');
for (const f of shots) {
  const p = path.join(shotsDir, f);
  const s = imageSize(p);
  const ok = s && s[0] >= 320 && s[0] <= 3840 && s[1] >= 320 && s[1] <= 3840 && Math.max(s[0], s[1]) / Math.min(s[0], s[1]) <= 2;
  check('screenshot ' + f + ' within Play bounds', ok, s ? s.join('x') : 'not a readable PNG/JPEG');
  check('screenshot ' + f + ' is 9:16 at >= 1080x1920 (promotion eligible)', !!s && s[0] >= 1080 && s[1] * 9 === s[0] * 16, s ? s.join('x') : 'unreadable');
  if (/\.png$/i.test(f)) check('screenshot ' + f + ' has no alpha channel (24-bit PNG)', pngColourType(p) === 2, 'colour type ' + pngColourType(p));
  check('screenshot ' + f + ' under 8 MB', fs.statSync(p).size < 8 * 1024 * 1024, fs.statSync(p).size + ' bytes');
}

console.log('\n' + (failed ? failed + ' check(s) FAILED' : 'listing within Play limits'));
process.exit(failed ? 1 : 0);
