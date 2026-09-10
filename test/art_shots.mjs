/* SKYHOOK art contact sheets  -  visual proof for the procedural-art pass.
 *
 * Renders the WHOLE class roster, not a lucky screenshot of one run. A single
 * in-game capture cannot show fourteen formation classes and six spectral
 * classes, so the only honest visual proof is a contact sheet that walks the
 * roster deliberately.
 *
 * It draws through the SHIPPED code path - SK.Celestial.drawBody and
 * SK.Celestial.drawMeteor, from a real page that loaded index.html - so what
 * lands in the PNG is exactly what the game paints. It fabricates only the
 * body objects, using the same fields the sim sets (kind, type, mass, art,
 * idx, phase, x, y, radius), which is also a check that nothing in the draw
 * path secretly depends on some other piece of game state.
 *
 * Run:  node test/art_shots.mjs
 * Out:  test/screenshots/art_planet_classes.png
 *       test/screenshots/art_star_classes.png
 *       test/screenshots/art_meteor_closeup.png
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'screenshots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

/* Everything below runs IN THE PAGE. Kept as one function so the sheets share
   the background, label and grid helpers. Returns three PNG data URLs. */
function sheets() {
  const C = window.SK.Celestial;
  const TAU = Math.PI * 2;

  function make(w, h, scale) {
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const g = c.getContext('2d');
    g.scale(scale, scale);
    /* Same deep-sky backdrop the game uses, so contrast in the sheet is the
       contrast a player actually sees - not a flattering white page. */
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#050914');
    bg.addColorStop(1, '#0b1226');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    return { c, g, w, h };
  }

  function label(g, text, x, y, size, col, align) {
    g.font = '600 ' + size + 'px ui-monospace, Menlo, Consolas, monospace';
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.fillStyle = col;
    g.fillText(text, x, y);
  }

  /* A body shaped exactly like the ones _pushNode creates. `art` is the seed
     hook the art module keys off, so setting it here is how a specific class
     and variant get requested. */
  function body(o) {
    return Object.assign({
      kind: 'planet', type: 'normal', mass: 0.8, art: 0.5, idx: 0,
      phase: 1.1, x: 0, y: 0, radius: 16, spent: false, pop: 0, decay: 0,
      minR: 60, maxR: 100, captureR: 92, hooked: false
    }, o);
  }

  /* Find an `art` value that lands a body in the class we want to show. The
     art module maps art -> class internally; rather than duplicate that
     mapping here (and risk the sheet lying when the mapping changes) we
     search for a seed that produces it. If a class stops being reachable at
     any mass, this loop fails to find it and the cell is left empty - which
     is a real finding, not a rendering bug. */
  function seedFor(want, mass, type, variant) {
    for (let i = 0; i < 4000; i++) {
      const art = i / 4000;
      const n = body({ mass, art, type: type || 'normal' });
      if (C.classOf(n).id === want && (variant === undefined || C.variantOf(n) === variant)) return art;
    }
    return null;
  }

  const CLOCK = 6.2;   // frozen sim clock, so every sheet is reproducible

  /* ---------------------------------------------------- planet classes */
  function planetSheet() {
    const ids = ['iron', 'rocky', 'desert', 'ocean', 'ice', 'lava', 'carbon',
                 'toxic', 'gasGiant', 'iceGiant', 'ringed',
                 'scorchedCracked', 'scorchedAshen', 'scorchedMolten'];
    const cols = 5, cell = 168, top = 96, rows = Math.ceil(ids.length / cols);
    const s = make(cols * cell, top + rows * cell + 40, 2);
    label(s.g, 'PLANET FORMATION CLASSES', s.w / 2, 38, 22, '#eaf4ff');
    label(s.g, 'one row of mass bands - class is chosen from the body\'s seeded n.art and its mass, never from Math.random()',
          s.w / 2, 66, 11, 'rgba(150,200,235,0.7)');

    ids.forEach((id, i) => {
      const cx = (i % cols) * cell + cell / 2;
      const cy = top + Math.floor(i / cols) * cell + cell / 2 - 8;
      const decay = id.indexOf('scorched') === 0;
      /* Giants only exist in the top mass band, bare rock only in the
         bottom - so ask each class at a mass where it is reachable. */
      let art = null, mass = 0;
      for (const m of [0.62, 0.80, 1.05, 1.15, 0.55]) {
        art = seedFor(id, m, decay ? 'decay' : 'normal');
        if (art !== null) { mass = m; break; }
      }
      if (art === null) { label(s.g, id + ' UNREACHABLE', cx, cy, 11, '#ff5c6c'); return; }
      const n = body({ mass, art, type: decay ? 'decay' : 'normal', x: cx, y: cy, radius: 30 });
      const cls = C.classOf(n);
      C.drawBody(s.g, n, 30, true, 0.5, CLOCK);
      label(s.g, cls.label, cx, cy + 54, 11, decay ? '#ffb03a' : '#cfe6f5');
      label(s.g, cls.feature, cx, cy + 69, 9.5, 'rgba(140,185,220,0.65)');
    });

    label(s.g, 'amber = type "decay" (burn-out). Its variety is in the surface damage only; the amber tell is never overwritten by a formation class.',
          s.w / 2, s.h - 22, 10.5, 'rgba(255,176,58,0.8)');
    return s.c.toDataURL('image/png');
  }

  /* ------------------------------------------------------ star classes */
  function starSheet() {
    const masses = [2.4, 2.8, 3.2, 3.7, 4.2, 4.8];
    const cell = 210, s = make(masses.length * cell, 396, 2);
    label(s.g, 'STELLAR SPECTRAL CLASSES', s.w / 2, 38, 22, '#eaf4ff');
    label(s.g, 'class is mapped from MASS, so hue order is temperature order - and mass is what decides how far a star slings you',
          s.w / 2, 66, 11, 'rgba(150,200,235,0.7)');

    masses.forEach((m, i) => {
      const cx = i * cell + cell / 2, cy = 196;
      const n = body({ kind: 'star', mass: m, art: 0.41, x: cx, y: cy, radius: 26 });
      const cls = C.starClass(m);
      C.drawBody(s.g, n, 26, true, 0.5, CLOCK);
      label(s.g, cls.label, cx, cy + 92, 12, '#e8f2ff');
      label(s.g, 'mass ' + m.toFixed(2), cx, cy + 110, 10.5, 'rgba(140,185,220,0.7)');
    });

    label(s.g, 'the star band slides upward with depth (STAR_M_LO 2.20 -> STAR_M_DEEP 4.20), so the sky really does turn bluer as the run gets harder',
          s.w / 2, s.h - 24, 10.5, 'rgba(150,200,235,0.6)');
    return s.c.toDataURL('image/png');
  }

  /* ---------------------------------------------------- meteor close-up */
  function meteorSheet() {
    const s = make(880, 470, 2);
    label(s.g, 'METEOROID HAZARD', s.w / 2, 38, 22, '#eaf4ff');
    label(s.g, 'was a spiked naval sea mine, in a game with no sea. Six seeded silhouettes, drawn at 6x and at true size.',
          s.w / 2, 66, 11, 'rgba(150,200,235,0.7)');

    /* Blown up 6x so the ablation rim, pitting and jagged outline are
       inspectable, then again at the size it is actually played at. */
    const hero = { homeX: 300, x: 300, y: 210, amp: 12, phase: 0.7, art: 0.14 };
    C.drawMeteor(s.g, hero, 66, CLOCK);
    label(s.g, '6x  -  ablation rim, pitting, hot leading edge', 300, 310, 11, 'rgba(200,225,245,0.85)');

    for (let i = 0; i < 6; i++) {
      const x = 560 + (i % 3) * 110, y = 160 + Math.floor(i / 3) * 100;
      C.drawMeteor(s.g, { homeX: x, x: x, y: y, amp: 10, phase: i * 1.04, art: i / 6 + 0.02 }, 11, CLOCK);
    }
    label(s.g, 'true size (METEOR_R = 11, the collision radius)', 670, 310, 11, 'rgba(200,225,245,0.85)');

    /* The readability claim, shown rather than asserted: the two things a
       meteoroid must never be confused with, side by side with it. */
    const amber = body({ type: 'decay', mass: 0.8, art: seedFor('scorchedMolten', 0.8, 'decay') ?? 0.5, x: 180, y: 394, radius: 22 });
    C.drawBody(s.g, amber, 22, true, 0.5, CLOCK);
    label(s.g, 'decay body (amber)', 180, 434, 10.5, 'rgba(255,176,58,0.9)');

    C.drawMeteor(s.g, { homeX: 400, x: 400, y: 394, amp: 10, phase: 2.2, art: 0.55 }, 22, CLOCK);
    label(s.g, 'meteoroid: dark, jagged, trailing, no latch ring', 400, 434, 10.5, 'rgba(255,138,62,0.95)');

    s.g.save();
    s.g.translate(640, 394);
    s.g.rotate(0.5);
    s.g.beginPath();
    s.g.moveTo(0, -11); s.g.lineTo(8, 0); s.g.lineTo(0, 11); s.g.lineTo(-8, 0);
    s.g.closePath();
    s.g.fillStyle = '#fff3c4'; s.g.fill();
    s.g.strokeStyle = 'rgba(255,215,94,0.9)'; s.g.lineWidth = 1.6; s.g.stroke();
    s.g.restore();
    label(s.g, 'shard pickup', 640, 434, 10.5, 'rgba(255,215,94,0.9)');

    label(s.g, 'the discriminators are LUMINANCE and SHAPE, not hue - so they survive deuteranopia, where red and amber collapse together',
          s.w / 2, s.h - 16, 10.5, 'rgba(150,200,235,0.6)');
    return s.c.toDataURL('image/png');
  }

  return {
    planets: planetSheet(),
    stars: starSheet(),
    meteor: meteorSheet(),
    cache: C.cacheStats()
  };
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  const opts = { args: ['--mute-audio'] };
  try { browser = await chromium.launch({ channel: 'chrome', ...opts }); }
  catch { browser = await chromium.launch(opts); }

  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.SK && window.SK.Celestial));

  const out = await page.evaluate(sheets);

  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  for (const [name, key] of [['art_planet_classes', 'planets'],
                             ['art_star_classes', 'stars'],
                             ['art_meteor_closeup', 'meteor']]) {
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(out[key].split(',')[1], 'base64'));
    written.push(file);
  }

  console.log('\n=== art contact sheets ===');
  written.forEach(f => console.log('  ' + f + '  (' + fs.statSync(f).size + ' bytes)'));
  console.log('  sprite cache after drawing the whole roster: ' + out.cache.entries + ' entries (ceiling 96)');
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    errors.forEach(e => console.log('  ' + e));
    process.exitCode = 1;
  } else {
    console.log('  no page errors');
  }
} finally {
  if (browser) await browser.close();
  server.close();
}
