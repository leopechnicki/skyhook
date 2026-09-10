/* SKYHOOK - celestial art.
 *
 * Everything about how a body LOOKS lives here. Nothing about how a body
 * BEHAVES does. game.js owns mass, radius, orbit geometry and collision; this
 * file is handed a body that already exists and answers one question: what
 * pixels go on the screen for it.
 *
 * Why it is a separate file: js/game.js was 1731 lines and the two draw
 * routines it carried (_drawStar, _drawPlanet) were the only place in the
 * codebase where "art" and "simulation" shared a scope. Splitting them makes
 * the guarantee this pass has to make - zero physics change - structural
 * rather than a promise. There is no reachable path from this module back into
 * the sim: it never calls game.rand(), never writes to a body, and every
 * function here is pure given (body, radius, clock).
 *
 * -------------------------------------------------------------------------
 * THE SEED RULE (read before adding anything)
 * -------------------------------------------------------------------------
 * The world is generated from ONE seeded RNG chain (game.rand). Draw code runs
 * a variable number of times per simulation tick, so a single game.rand() call
 * made for a visual detail would shift every later draw from that chain and
 * silently regenerate the whole game - scores move, balance.mjs moves, and it
 * looks like a tuning change nobody made. So:
 *
 *     nothing in this file may call game.rand(), and nothing may call
 *     Math.random() either (that would make the art crawl frame to frame).
 *
 * All variation comes from values the sim already stored: `n.art` (a stable
 * per-body random assigned once in _pushNode), `n.mass`, `n.idx`, `n.phase`,
 * and for hazards their `homeX`/`y`/`phase`. `hash()` below turns those into
 * as many stable pseudo-random streams as an effect needs, for free.
 * test/world.mjs is the gate that enforces this.
 *
 * -------------------------------------------------------------------------
 * WHY SPRITES, AND WHY ONE BLIT PER BODY
 * -------------------------------------------------------------------------
 * The old draw path built a createRadialGradient PER BODY PER FRAME, then
 * clipped and stroked on top. Adding formation classes, craters, rings, caps
 * and storms to that would have multiplied the most expensive call in the
 * frame. Instead each visual class is painted ONCE into an offscreen canvas
 * (the same trick SK.makeGlow already uses for the halos) and blitted with a
 * single drawImage, scaled to the body's actual radius.
 *
 * That works because the lighting direction is GLOBAL and constant (LX, LY):
 * the whole field is lit from the same place, so the lit side can be baked in
 * and the sprite never needs to rotate. Sprites are therefore keyed by
 * (class, variant) only - not by radius, not by alive/spent - so the cache is
 * small and bounded, and a body's pop animation (a continuously varying
 * radius) costs nothing because it is just a different destination rectangle.
 *
 * Sprites are painted at SPRITE_R = 50 px radius while bodies draw at 10-23
 * logical px and the canvas transform maxes out around 2.05x device scale
 * (main.js caps dpr at 2), i.e. ~47 device px at the very largest. So every
 * blit is a MINIFICATION and stays sharp. The one detail deliberately left
 * live is the limb crescent: it is the edge the eye judges sharpness by, so it
 * is stroked at final resolution instead of being resampled.
 */
(function (global) {
  'use strict';

  var SK = global.SK;
  var TAU = SK.TAU, clamp = SK.clamp;

  /* Global light direction. Every body in the column is lit from the same
     place - the column reads as one scene, and it is what lets the shading be
     baked into a sprite at all. Matches the values the old _drawPlanet used,
     so this pass does not visibly relight the game. */
  var LX = -0.42, LY = -0.52;

  var SPRITE_R = 50;     // internal radius every class sprite is painted at
  var CACHE_MAX = 96;    // hard ceiling; see sprite()

  /* ---------------------------------------------------------------- utils */

  /* Stable hash: turns any (value, salt) pair into a repeatable 0..1. This is
     how one stored `n.art` becomes a dozen independent-looking decisions
     without touching the seeded RNG chain. Pure, so the same body always
     paints the same way, this frame and next week. */
  function hash(x, salt) {
    var t = Math.sin((x + 1) * 127.1 + salt * 311.7) * 43758.5453;
    return t - Math.floor(t);
  }
  function pick(list, x, salt) {
    return list[Math.min(list.length - 1, Math.floor(hash(x, salt) * list.length))];
  }
  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)];
  }
  function shade(c, k) { return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]; }

  /* ------------------------------------------------------- planet classes */

  /* Formation classes, and the reason each one exists as a distinct read.
     `pal.base` is the surface albedo, `hi` the sunward highlight, `lo` the
     terminator side, `feat` the surface feature colour, `glow` the halo the
     body throws, `accent` what its hook particles burst in.
     `pad` is how far past the disc the sprite has to reach (rings need room).

     Colours are chosen for what a real body of that formation reflects -
     iron-grey, basalt-black, sulfur-yellow, methane-teal - then pushed a step
     in saturation so a 12 px disc still reads on a phone. Honest about that
     trade: hue is faithful, saturation is not. */
  var PLANETS = {
    iron: {
      id: 'iron', label: 'iron core remnant', feature: 'crater',
      pal: { base: [150, 152, 160], hi: [206, 209, 217], lo: [44, 47, 58],
             feat: [96, 99, 110], glow: [150, 170, 200], accent: [200, 210, 230] },
      craters: 7, pad: 1.14
    },
    rocky: {
      id: 'rocky', label: 'silicate terrestrial', feature: 'crater',
      pal: { base: [156, 128, 106], hi: [214, 186, 156], lo: [46, 36, 32],
             feat: [104, 82, 68], glow: [210, 160, 120], accent: [230, 190, 150] },
      craters: 5, maria: true, pad: 1.14
    },
    desert: {
      id: 'desert', label: 'arid terrestrial', feature: 'dune band',
      pal: { base: [206, 158, 92], hi: [242, 208, 146], lo: [64, 44, 28],
             feat: [166, 118, 62], glow: [240, 180, 100], accent: [250, 210, 140] },
      bands: 6, bandA: 0.16, pad: 1.14
    },
    ocean: {
      id: 'ocean', label: 'water world', feature: 'continent',
      pal: { base: [42, 104, 186], hi: [126, 196, 246], lo: [10, 24, 62],
             feat: [86, 150, 112], glow: [80, 170, 255], accent: [150, 220, 255] },
      continents: 4, specular: true, pad: 1.14
    },
    ice: {
      id: 'ice', label: 'frozen terrestrial', feature: 'polar cap',
      pal: { base: [186, 214, 226], hi: [238, 250, 255], lo: [52, 74, 96],
             feat: [136, 176, 202], glow: [170, 220, 245], accent: [220, 245, 255] },
      caps: true, fractures: 4, pad: 1.14
    },
    lava: {
      id: 'lava', label: 'young volcanic', feature: 'lava fissure',
      pal: { base: [64, 42, 42], hi: [116, 78, 68], lo: [18, 10, 12],
             feat: [255, 122, 38], glow: [255, 110, 40], accent: [255, 170, 80] },
      fissures: 5, pad: 1.14
    },
    carbon: {
      id: 'carbon', label: 'carbon planet', feature: 'graphite sheen',
      pal: { base: [56, 52, 60], hi: [128, 120, 132], lo: [10, 9, 14],
             feat: [92, 86, 96], glow: [150, 140, 170], accent: [190, 180, 205] },
      craters: 3, sheen: true, pad: 1.14
    },
    toxic: {
      id: 'toxic', label: 'sulfur cloud world', feature: 'cloud swirl',
      pal: { base: [206, 196, 106], hi: [244, 240, 176], lo: [70, 62, 26],
             feat: [172, 150, 70], glow: [230, 220, 110], accent: [245, 240, 160] },
      bands: 5, bandA: 0.22, swirl: true, pad: 1.14
    },
    gasGiant: {
      id: 'gasGiant', label: 'banded gas giant', feature: 'storm oval',
      pal: { base: [196, 148, 108], hi: [240, 208, 168], lo: [58, 40, 32],
             feat: [140, 92, 66], glow: [240, 180, 130], accent: [250, 215, 170] },
      bands: 9, bandA: 0.30, storm: true, pad: 1.14
    },
    iceGiant: {
      id: 'iceGiant', label: 'ice giant', feature: 'methane band',
      pal: { base: [58, 146, 178], hi: [138, 216, 236], lo: [10, 40, 66],
             feat: [36, 106, 140], glow: [70, 200, 230], accent: [150, 230, 245] },
      bands: 5, bandA: 0.16, pad: 1.14
    },
    ringed: {
      id: 'ringed', label: 'ringed giant', feature: 'ring system',
      pal: { base: [214, 188, 132], hi: [246, 230, 190], lo: [66, 54, 34],
             feat: [166, 138, 88], glow: [245, 215, 150], accent: [252, 235, 190] },
      bands: 7, bandA: 0.22, ring: true, pad: 1.66
    },

    /* Burn-out bodies. R4 of the brief is explicit: `type === 'decay'` must
       stay instantly readable as amber and hazardous, and a random formation
       class must never bury that. So decay does NOT get the normal class
       roster - it gets its own three scorched variants, all locked to the
       same amber register the game has always used for "this one is about to
       drop you". The variety is in the surface damage, never in the hue. */
    scorchedCracked: {
      id: 'scorchedCracked', label: 'scorched, fracturing', feature: 'fracture',
      pal: { base: [176, 106, 44], hi: [255, 196, 104], lo: [56, 24, 8],
             feat: [255, 176, 58], glow: [255, 176, 58], accent: [255, 200, 110] },
      fissures: 6, decay: true, pad: 1.14
    },
    scorchedAshen: {
      id: 'scorchedAshen', label: 'scorched, ash-covered', feature: 'ash field',
      pal: { base: [158, 100, 48], hi: [240, 182, 100], lo: [48, 22, 8],
             feat: [255, 176, 58], glow: [255, 176, 58], accent: [255, 200, 110] },
      craters: 6, decay: true, pad: 1.14
    },
    scorchedMolten: {
      id: 'scorchedMolten', label: 'scorched, molten', feature: 'melt pool',
      pal: { base: [186, 112, 40], hi: [255, 208, 120], lo: [60, 26, 8],
             feat: [255, 158, 40], glow: [255, 176, 58], accent: [255, 190, 90] },
      fissures: 3, melt: true, decay: true, pad: 1.14
    }
  };

  /* Mass bands. Physically this is the argument that a heavier body was more
     able to hold on to light gas during formation, so the giants live at the
     top of the band and bare rock and iron at the bottom. As gameplay it is a
     free readability win: a big banded giant on screen is also a heavy body,
     which is information the player can act on.
     Planet mass runs PLANET_M_LO 0.55 to PLANET_M_HI 1.15 (game.js). */
  var PLANET_BANDS = [
    { upTo: 0.34, set: ['iron', 'rocky', 'ice', 'carbon'] },
    { upTo: 0.67, set: ['rocky', 'desert', 'ocean', 'toxic', 'ice'] },
    { upTo: 1.01, set: ['ocean', 'lava', 'gasGiant', 'iceGiant', 'ringed', 'desert'] }
  ];
  var SCORCHED = ['scorchedCracked', 'scorchedAshen', 'scorchedMolten'];

  /* --------------------------------------------------------- star classes */

  /* Real spectral sequence, and the whole point of using it: the hue order
     O/B -> A -> F -> G -> K -> M is a TEMPERATURE order, and temperature here
     is mass. game.js slides the star mass band upward with depth
     (STAR_M_LO 2.20 -> STAR_M_DEEP 4.20, plus the band width), so the sky
     genuinely shifts from red dwarfs to blue-white giants as the run gets
     harder - and since a heavier body slings you further, a blue star is a
     visible warning that this one will throw you off the screen.
     True blackbody colours above ~5500 K are all near-white and would be
     indistinguishable at 20 px, so saturation is pushed while the hue order
     is kept exact. `up` is the exclusive upper mass bound. */
  var STARS = [
    { id: 'M', up: 2.60, label: 'M red dwarf',
      core: [255, 246, 232], mid: [255, 176, 118], limb: [212, 82, 42],
      corona: [255, 128, 72], glow: [255, 140, 96], accent: [255, 180, 130] },
    { id: 'K', up: 3.00, label: 'K orange dwarf',
      core: [255, 250, 236], mid: [255, 202, 132], limb: [230, 126, 40],
      corona: [255, 162, 72], glow: [255, 172, 96], accent: [255, 206, 150] },
    { id: 'G', up: 3.45, label: 'G yellow star',
      core: [255, 255, 248], mid: [255, 232, 152], limb: [246, 168, 52],
      corona: [255, 202, 96], glow: [255, 224, 140], accent: [255, 238, 176] },
    { id: 'F', up: 3.95, label: 'F yellow-white star',
      core: [255, 255, 253], mid: [255, 246, 206], limb: [244, 202, 116],
      corona: [255, 232, 168], glow: [255, 242, 196], accent: [255, 248, 218] },
    { id: 'A', up: 4.55, label: 'A white star',
      core: [255, 255, 255], mid: [238, 244, 255], limb: [176, 200, 246],
      corona: [206, 226, 255], glow: [222, 236, 255], accent: [240, 248, 255] },
    { id: 'B', up: Infinity, label: 'B blue-white giant',
      core: [252, 254, 255], mid: [206, 228, 255], limb: [120, 160, 246],
      corona: [140, 182, 255], glow: [166, 200, 255], accent: [200, 226, 255] }
  ];

  function starClass(mass) {
    for (var i = 0; i < STARS.length; i++) if (mass < STARS[i].up) return STARS[i];
    return STARS[STARS.length - 1];
  }

  /* The one place that answers "which visual class is this body?".
     Deterministic in (kind, type, mass, art) and nothing else. */
  function classOf(n) {
    if (!n) return PLANETS.rocky;
    if (n.kind === 'star') return starClass(n.mass);
    if (n.type === 'decay') return PLANETS[pick(SCORCHED, n.art, 5)];
    var m01 = clamp((n.mass - 0.55) / 0.60, 0, 1);
    for (var i = 0; i < PLANET_BANDS.length; i++) {
      if (m01 <= PLANET_BANDS[i].upTo) return PLANETS[pick(PLANET_BANDS[i].set, n.art, 1)];
    }
    return PLANETS.rocky;
  }

  /* Surface-detail variant. Three per class is enough that neighbouring
     bodies of the same class never look copy-pasted, while keeping the sprite
     cache to (classes x 3) entries. */
  function variantOf(n) { return Math.floor(hash(n.art, 9) * 3); }

  /* -------------------------------------------------------- sprite cache */

  var cache = {};
  var cacheN = 0;

  /* Paint once, blit forever. `paint(g, cx, cy, r)` gets a fresh 2d context
     with the disc centred at (cx, cy) and radius r = SPRITE_R.
     The ceiling exists so a future change that accidentally keys sprites on
     something continuous (a radius, a timer) degrades into "slow" instead of
     "out of memory on a phone". */
  function sprite(key, pad, paint) {
    var hit = cache[key];
    if (hit) return hit;
    if (cacheN >= CACHE_MAX) { cache = {}; cacheN = 0; }
    var r = SPRITE_R;
    var size = Math.ceil(r * pad * 2);
    var c = global.document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    paint(g, size / 2, size / 2, r);
    c.__r = r; c.__pad = pad;
    cache[key] = c; cacheN++;
    return c;
  }

  /* Blit a class sprite so its disc lands exactly on radius R at (x, y). */
  function blit(ctx, spr, x, y, R, alpha) {
    var half = (spr.width / 2) * (R / SPRITE_R);
    ctx.globalAlpha = alpha;
    ctx.drawImage(spr, x - half, y - half, half * 2, half * 2);
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------ paint: helpers */

  function clipDisc(g, cx, cy, r) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.clip();
  }

  /* Base sphere: albedo lit from (LX, LY), easing to a dark terminator. This
     single gradient is what used to be rebuilt for every body every frame. */
  function paintSphere(g, cx, cy, r, pal) {
    var gr = g.createRadialGradient(cx + LX * r * 0.72, cy + LY * r * 0.72, r * 0.06, cx, cy, r * 1.06);
    gr.addColorStop(0, rgb(pal.hi));
    gr.addColorStop(0.34, rgb(pal.base));
    gr.addColorStop(0.78, rgb(shade(pal.base, 0.55)));
    gr.addColorStop(1, rgb(pal.lo));
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
  }

  /* Craters: the read for an airless, unresurfaced body. Each gets a shadowed
     floor and a rim lit on the sunward side, which is what actually sells
     "hole" rather than "dot". */
  function paintCraters(g, cx, cy, r, pal, count, v) {
    clipDisc(g, cx, cy, r);
    for (var i = 0; i < count; i++) {
      var a = hash(i + v * 7, 21) * TAU;
      var d = Math.sqrt(hash(i + v * 7, 22)) * r * 0.82;
      var cr = r * (0.09 + hash(i + v * 7, 23) * 0.14);
      var x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      g.fillStyle = rgba(shade(pal.feat, 0.72), 0.55);
      g.beginPath(); g.arc(x, y, cr, 0, TAU); g.fill();
      g.strokeStyle = rgba(pal.hi, 0.34);
      g.lineWidth = Math.max(1, r * 0.022);
      g.beginPath();
      g.arc(x, y, cr, Math.atan2(LY, LX) - 1.25, Math.atan2(LY, LX) + 1.25);
      g.stroke();
    }
    g.restore();
  }

  /* Latitude banding. Bands are drawn as chords of the disc rather than
     straight rows so they curve with the sphere; a giant gets many and with
     high contrast, an ice giant gets few and faint. */
  function paintBands(g, cx, cy, r, pal, count, amp, v) {
    clipDisc(g, cx, cy, r);
    var tilt = (hash(v, 31) - 0.5) * 0.34;   // small axial tilt per variant
    g.translate(cx, cy); g.rotate(tilt); g.translate(-cx, -cy);
    for (var b = 0; b < count; b++) {
      var t = (b + 0.5) / count;
      var y = cy - r + t * r * 2;
      var h = (r * 2 / count) * (0.5 + hash(b + v * 5, 32) * 0.7);
      var dark = hash(b + v * 5, 33) < 0.5;
      var col = dark ? shade(pal.feat, 0.85) : pal.hi;
      g.fillStyle = rgba(col, amp * (0.55 + hash(b + v * 5, 34) * 0.6));
      g.fillRect(cx - r, y - h / 2, r * 2, h);
    }
    g.restore();
  }

  /* Polar caps: two bright ellipses clipped to the disc. The cheapest signal
     in the whole set that says "this world is frozen". */
  function paintCaps(g, cx, cy, r, pal, v) {
    clipDisc(g, cx, cy, r);
    var w = r * (0.86 + hash(v, 41) * 0.2);
    g.fillStyle = rgba(pal.hi, 0.82);
    g.beginPath(); g.ellipse(cx, cy - r * 0.94, w, r * 0.30, 0, 0, TAU); g.fill();
    g.fillStyle = rgba(pal.hi, 0.6);
    g.beginPath(); g.ellipse(cx, cy + r * 0.98, w * 0.9, r * 0.26, 0, 0, TAU); g.fill();
    g.restore();
  }

  /* Continents / maria: irregular blotches, built from overlapping circles so
     the outline is lumpy without needing a path per landmass. */
  function paintBlobs(g, cx, cy, r, col, count, alpha, v, salt) {
    clipDisc(g, cx, cy, r);
    g.fillStyle = rgba(col, alpha);
    for (var i = 0; i < count; i++) {
      var a = hash(i + v * 3, salt) * TAU;
      var d = Math.sqrt(hash(i + v * 3, salt + 1)) * r * 0.72;
      var bx = cx + Math.cos(a) * d, by = cy + Math.sin(a) * d;
      var br = r * (0.16 + hash(i + v * 3, salt + 2) * 0.2);
      for (var k = 0; k < 4; k++) {
        var ka = hash(i * 4 + k + v * 3, salt + 3) * TAU;
        var kd = br * hash(i * 4 + k + v * 3, salt + 4) * 0.9;
        g.beginPath();
        g.arc(bx + Math.cos(ka) * kd, by + Math.sin(ka) * kd, br * (0.55 + hash(i * 4 + k, salt + 5) * 0.5), 0, TAU);
        g.fill();
      }
    }
    g.restore();
  }

  /* Glowing fissures: lava, and the fracture damage on a burning-out body.
     Drawn with 'lighter' so the crack looks emissive instead of painted, then
     twice - a wide dim pass for the heat bloom, a thin bright one for the
     crack itself. */
  function paintFissures(g, cx, cy, r, pal, count, v) {
    clipDisc(g, cx, cy, r);
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < count; i++) {
      var a = hash(i + v * 11, 51) * TAU;
      var d = hash(i + v * 11, 52) * r * 0.55;
      var x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      var dir = hash(i + v * 11, 53) * TAU;
      var len = r * (0.4 + hash(i + v * 11, 54) * 0.6);
      var segs = 3;
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = rgba(pal.feat, pass === 0 ? 0.20 : 0.85);
        g.lineWidth = pass === 0 ? Math.max(2, r * 0.13) : Math.max(1, r * 0.045);
        g.beginPath();
        g.moveTo(x, y);
        var px = x, py = y, pa = dir;
        for (var s = 0; s < segs; s++) {
          pa += (hash(i * 8 + s + v * 11, 55) - 0.5) * 1.5;
          px += Math.cos(pa) * (len / segs); py += Math.sin(pa) * (len / segs);
          g.lineTo(px, py);
        }
        g.stroke();
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.restore();
  }

  /* The single specular glint that makes an ocean world read as liquid. */
  function paintSpecular(g, cx, cy, r, pal) {
    clipDisc(g, cx, cy, r);
    var s = g.createRadialGradient(cx + LX * r * 0.55, cy + LY * r * 0.55, 0, cx + LX * r * 0.55, cy + LY * r * 0.55, r * 0.5);
    s.addColorStop(0, rgba([255, 255, 255], 0.55));
    s.addColorStop(1, rgba([255, 255, 255], 0));
    g.fillStyle = s;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    g.restore();
  }

  /* A storm oval - the one feature that makes a gas giant a PLACE rather than
     a striped ball. Sits off-centre in a band, like the real ones. */
  function paintStorm(g, cx, cy, r, pal, v) {
    clipDisc(g, cx, cy, r);
    var sx = cx + (hash(v, 61) - 0.5) * r * 1.0;
    var sy = cy + (hash(v, 62) - 0.35) * r * 0.9;
    var rw = r * (0.24 + hash(v, 63) * 0.14), rh = rw * 0.62;
    var gr = g.createRadialGradient(sx, sy, 0, sx, sy, rw);
    gr.addColorStop(0, rgba(mix(pal.hi, [255, 236, 226], 0.5), 0.95));
    gr.addColorStop(0.6, rgba(mix(pal.feat, [220, 120, 90], 0.6), 0.8));
    gr.addColorStop(1, rgba(pal.feat, 0));
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(sx, sy, rw, rh, 0, 0, TAU); g.fill();
    g.strokeStyle = rgba(pal.lo, 0.45); g.lineWidth = Math.max(1, r * 0.03);
    g.beginPath(); g.ellipse(sx, sy, rw, rh, 0, 0, TAU); g.stroke();
    g.restore();
  }

  /* Terminator: a soft darkening on the anti-sunward side, over the top of
     every surface feature. Baked because the light never moves. */
  function paintTerminator(g, cx, cy, r, pal) {
    clipDisc(g, cx, cy, r);
    var t = g.createRadialGradient(cx + LX * r * 0.6, cy + LY * r * 0.6, r * 0.25, cx - LX * r * 0.4, cy - LY * r * 0.4, r * 1.5);
    t.addColorStop(0, 'rgba(6,10,26,0)');
    t.addColorStop(0.55, 'rgba(6,10,26,0.30)');
    t.addColorStop(1, 'rgba(4,7,20,0.90)');
    g.fillStyle = t;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    g.restore();
  }

  /* Ring system. Painted in two halves - the far arc before the planet, the
     near arc after - so the disc genuinely occludes the ring. Doing that once
     into a sprite is what makes it affordable at all. */
  function paintRingHalf(g, cx, cy, r, pal, v, near) {
    var rw = r * 1.62, rh = r * 0.42;
    var tilt = -0.30 - hash(v, 71) * 0.22;
    g.save();
    g.translate(cx, cy); g.rotate(tilt);
    if (near) { g.beginPath(); g.rect(-rw, 0, rw * 2, rh * 2); g.clip(); }
    else { g.beginPath(); g.rect(-rw, -rh * 2, rw * 2, rh * 2); g.clip(); }
    var lanes = [[1.00, 0.34], [0.88, 0.55], [0.80, 0.20], [0.70, 0.42]];
    for (var i = 0; i < lanes.length; i++) {
      g.strokeStyle = rgba(i % 2 ? pal.hi : pal.feat, lanes[i][1] * (near ? 1 : 0.7));
      g.lineWidth = Math.max(1, r * 0.075);
      g.beginPath();
      g.ellipse(0, 0, rw * lanes[i][0], rh * lanes[i][0], 0, 0, TAU);
      g.stroke();
    }
    g.restore();
  }

  /* --------------------------------------------------- paint: the classes */

  function paintPlanet(cls, v) {
    return function (g, cx, cy, r) {
      var pal = cls.pal;
      if (cls.ring) paintRingHalf(g, cx, cy, r, pal, v, false);
      paintSphere(g, cx, cy, r, pal);
      if (cls.bands) paintBands(g, cx, cy, r, pal, cls.bands, cls.bandA, v);
      if (cls.continents) paintBlobs(g, cx, cy, r, pal.feat, cls.continents, 0.85, v, 81);
      if (cls.maria) paintBlobs(g, cx, cy, r, shade(pal.feat, 0.7), 3, 0.5, v, 91);
      if (cls.craters) paintCraters(g, cx, cy, r, pal, cls.craters, v);
      if (cls.caps) paintCaps(g, cx, cy, r, pal, v);
      if (cls.fractures) paintFissures(g, cx, cy, r, { feat: pal.feat }, cls.fractures, v);
      if (cls.melt) paintBlobs(g, cx, cy, r, pal.feat, 2, 0.55, v, 101);
      if (cls.swirl) paintBlobs(g, cx, cy, r, pal.hi, 2, 0.28, v, 111);
      if (cls.sheen) paintSpecular(g, cx, cy, r, pal);
      if (cls.specular) paintSpecular(g, cx, cy, r, pal);
      if (cls.storm) paintStorm(g, cx, cy, r, pal, v);
      if (cls.fissures) paintFissures(g, cx, cy, r, pal, cls.fissures, v);
      paintTerminator(g, cx, cy, r, pal);
      if (cls.ring) paintRingHalf(g, cx, cy, r, pal, v, true);
    };
  }

  /* Star photosphere. Core -> mid -> limb follows the spectral class, so an M
     dwarf is a dull red coal and a B giant is a hard blue-white arc-light,
     with the granulation cells tinted from the same triple rather than the
     old hardcoded orange. */
  function paintStar(cls, v) {
    return function (g, cx, cy, r) {
      var pg = g.createRadialGradient(cx - r * 0.18, cy - r * 0.18, r * 0.1, cx, cy, r);
      pg.addColorStop(0, rgb(cls.core));
      pg.addColorStop(0.55, rgb(cls.mid));
      pg.addColorStop(1, rgb(cls.limb));
      g.fillStyle = pg;
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();

      clipDisc(g, cx, cy, r);
      g.fillStyle = rgba(shade(cls.limb, 0.86), 0.30);
      for (var i = 0; i < 5; i++) {
        var a = hash(i + v * 13, 121) * TAU;
        var d = Math.sqrt(hash(i + v * 13, 122)) * r * 0.72;
        g.beginPath();
        g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.13 + hash(i + v * 13, 123) * 0.12), 0, TAU);
        g.fill();
      }
      g.restore();

      /* Limb darkening, the real effect that makes a star look spherical
         instead of like a flat disc of light. */
      var ld = g.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      ld.addColorStop(0, rgba(cls.limb, 0));
      ld.addColorStop(1, rgba(shade(cls.limb, 0.6), 0.55));
      g.fillStyle = ld;
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    };
  }

  /* Corona, as its own sprite. It breathes with the body's pulse, and scaling
     a blit is free where rebuilding a radial gradient every frame for every
     star was the single most expensive thing the old draw path did. */
  var CORONA_R = 72;
  function coronaSprite(cls) {
    var key = 'corona:' + cls.id;
    var hit = cache[key];
    if (hit) return hit;
    if (cacheN >= CACHE_MAX) { cache = {}; cacheN = 0; }
    var size = CORONA_R * 2;
    var c = global.document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(CORONA_R, CORONA_R, CORONA_R * 0.19, CORONA_R, CORONA_R, CORONA_R);
    gr.addColorStop(0, rgba(cls.core, 0.34));
    gr.addColorStop(0.42, rgba(cls.corona, 0.13));
    gr.addColorStop(1, rgba(cls.corona, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
    cache[key] = c; cacheN++;
    return c;
  }

  /* Per-class halo, so the light a body throws matches the light it is made
     of. Same SK.makeGlow the rest of the game already uses. */
  function glowSprite(cls, isStar) {
    var key = 'glow:' + cls.id;
    var hit = cache[key];
    if (hit) return hit;
    if (cacheN >= CACHE_MAX) { cache = {}; cacheN = 0; }
    var col = isStar ? cls.glow : cls.pal.glow;
    var c = SK.makeGlow(isStar ? 96 : 64, col.join(','), isStar ? 0.9 : 0.85);
    cache[key] = c; cacheN++;
    return c;
  }

  function discSprite(n) {
    var cls = classOf(n);
    var v = variantOf(n);
    var isStar = n.kind === 'star';
    var key = (isStar ? 'star:' : 'planet:') + cls.id + ':' + v;
    return sprite(key, isStar ? 1.14 : cls.pad, isStar ? paintStar(cls, v) : paintPlanet(cls, v));
  }

  /* ------------------------------------------------------------ the body */

  /* Draws one body. Called from Game.prototype._drawNode and, like it, MUST
     stay free of side effects: no writes to `n`, no RNG, no state on `game`.
     `pulse` and `time` are read-only inputs from the caller. */
  function drawBody(ctx, n, R, alive, pulse, time) {
    var cls = classOf(n);
    var isStar = n.kind === 'star';
    var a = alive ? 1 : 0.34;

    if (isStar) {
      /* corona first, behind everything */
      var cr = R * (2.9 + pulse * 0.30);
      var cs = coronaSprite(cls);
      ctx.globalAlpha = a;
      ctx.drawImage(cs, n.x - cr, n.y - cr, cr * 2, cr * 2);
      ctx.globalAlpha = 1;
    }

    blit(ctx, discSprite(n), n.x, n.y, R, a);

    /* Limb crescent, stroked live at final resolution. This is the one piece
       deliberately not baked: it is a 1-2 px feature on the silhouette, which
       is exactly where resampling a sprite would show, and it costs a single
       arc. */
    var edge = isStar ? cls.core : cls.pal.hi;
    var la = Math.atan2(LY, LX);
    ctx.save();
    ctx.strokeStyle = rgba(edge, (0.85 * a).toFixed(2));
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(n.x, n.y, R - 0.6, la - 1.15, la + 1.15); ctx.stroke();
    ctx.strokeStyle = rgba(isStar ? cls.limb : cls.pal.base, (0.30 * a).toFixed(2));
    ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(n.x, n.y, R - 0.6, 0, TAU); ctx.stroke();
    ctx.restore();

    if (isStar) {
      /* Flare spikes in the class colour - the "this is a STAR" read, and now
         also the "this is a HOT star" read. */
      ctx.save();
      ctx.strokeStyle = rgba(cls.corona, (0.55 * a).toFixed(2));
      ctx.lineWidth = 1.4;
      for (var k = 0; k < 4; k++) {
        var fa = n.phase * 0.4 + k * (Math.PI / 2) + time * 0.12;
        var f0 = R * 1.15, f1 = R * (1.75 + pulse * 0.35);
        ctx.beginPath();
        ctx.moveTo(n.x + Math.cos(fa) * f0, n.y + Math.sin(fa) * f0);
        ctx.lineTo(n.x + Math.cos(fa) * f1, n.y + Math.sin(fa) * f1);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------- meteoroids */

  /* The hazard used to be a naval sea mine: a spiked ball, in a game with no
     sea. It is now what it should always have been in a sky full of planets -
     a lost meteoroid, tumbling and ablating.
     Readability rules it has to keep (R4 of the brief):
       - it is DANGER, so it stays in the red register and keeps a red halo;
       - it must not be confusable with an amber decay body. Hue alone cannot
         carry that (red and amber collapse together under deuteranopia), so
         the discriminator is LUMINANCE and SHAPE: the rock body is dark, its
         outline is irregular, it has a trail, and it has no latch ring. Every
         one of those survives any colour-vision deficiency.
       - and not with a shard: shards are small bright spinning diamonds. */
  var METEOR = {
    rock:  [58, 46, 48],
    rockHi:[122, 96, 94],
    rockLo:[20, 14, 18],
    hot:   [255, 138, 62],
    fire:  [255, 92, 58],
    danger:[255, 77, 109]
  };

  /* Irregular silhouette, stable per variant: a closed polygon whose vertex
     radii are hashed, so no two variants tumble the same way. Baked, with the
     ablating rim on the +x side; the blit is then rotated by the sim clock so
     the glowing edge sweeps around as the rock turns. */
  function paintMeteor(v) {
    return function (g, cx, cy, r) {
      var N = 11, i, a, rad;
      var pts = [];
      for (i = 0; i < N; i++) {
        a = (i / N) * TAU;
        rad = r * (0.62 + hash(i + v * 17, 131) * 0.38);
        pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
      }
      function trace() {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (var k = 1; k < N; k++) g.lineTo(pts[k][0], pts[k][1]);
        g.closePath();
      }

      /* body: basalt, lit from the same global direction as everything else */
      var gr = g.createRadialGradient(cx + LX * r * 0.6, cy + LY * r * 0.6, r * 0.05, cx, cy, r);
      gr.addColorStop(0, rgb(METEOR.rockHi));
      gr.addColorStop(0.5, rgb(METEOR.rock));
      gr.addColorStop(1, rgb(METEOR.rockLo));
      trace(); g.fillStyle = gr; g.fill();

      /* pitting, so the rock has texture at the size it is actually drawn */
      g.save(); trace(); g.clip();
      for (i = 0; i < 6; i++) {
        a = hash(i + v * 17, 132) * TAU;
        var d = Math.sqrt(hash(i + v * 17, 133)) * r * 0.7;
        g.fillStyle = rgba(METEOR.rockLo, 0.55);
        g.beginPath();
        g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * (0.07 + hash(i + v * 17, 134) * 0.1), 0, TAU);
        g.fill();
      }
      g.restore();

      /* ablation: the leading rim is melting. Two passes, wide-and-dim then
         thin-and-hot, drawn additively so it reads as glowing rock. */
      g.save(); trace(); g.clip();
      g.globalCompositeOperation = 'lighter';
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = rgba(pass ? METEOR.hot : METEOR.fire, pass ? 0.9 : 0.35);
        g.lineWidth = pass ? r * 0.16 : r * 0.42;
        g.beginPath();
        g.arc(cx, cy, r * 0.82, -1.05, 1.05);
        g.stroke();
      }
      g.globalCompositeOperation = 'source-over';
      g.restore();

      /* hard outline: keeps the jagged silhouette legible at 11 px */
      trace();
      g.strokeStyle = rgba(METEOR.rockHi, 0.85);
      g.lineWidth = Math.max(1, r * 0.05);
      g.stroke();
    };
  }

  function meteorSprite(m) {
    var v = Math.floor(meteorArt(m) * 6);
    return sprite('meteor:' + v, 1.06, paintMeteor(v));
  }

  /* A hazard's stable 0..1, WITHOUT adding a field to the spawner. Asking the
     generator for one more this.rand() would have shifted the whole seeded
     chain and regenerated every world (test/world.mjs is the gate that
     catches exactly that), so the variation is hashed out of the identity the
     hazard already has: where it lives and how it bobs. */
  function meteorArt(m) {
    if (m.art !== undefined) return m.art;
    return hash(m.homeX * 0.013 + m.y * 0.0071, 141);
  }

  function meteorGlow() {
    var key = 'glow:meteor';
    var hit = cache[key];
    if (hit) return hit;
    if (cacheN >= CACHE_MAX) { cache = {}; cacheN = 0; }
    var c = SK.makeGlow(40, METEOR.danger.join(','), 0.8);
    cache[key] = c; cacheN++;
    return c;
  }

  /* Draws one meteoroid. `R` is the collision radius the sim uses, so the art
     can never grow past the hitbox and lie about where the danger is.
     Side-effect free: `m.x` is advanced by the sim in _tick, never here. */
  function drawMeteor(ctx, m, R, time) {
    var spin = time * 1.1 + m.phase;

    /* Apparent motion. The rock drifts on its bob and the world scrolls
       downward past the climbing player, so the trail leans up-and-against
       the drift. That is the direction a real entry trail would take. */
    var vx = Math.cos(time * 0.9 + m.phase) * m.amp * 0.9;
    var tl = Math.hypot(vx, 34) || 1;
    var tx = -vx / tl, ty = -34 / tl;

    /* Ablation trail. This started life as three round-capped strokes of
       constant width, and at the size the hazard is actually played at
       (R = 11) that read as a mallet handle, not as motion: a round cap is
       blunt, three overlapping strokes pile up alpha at the base, and nothing
       about it got thinner with distance. It is now a WEDGE - full width at
       the rock, converging to a point - with an alpha gradient along its
       length, which is what a trail does. Two gradients and two fills, which
       measured no slower than the three strokes it replaced: 3.2 ms vs 3.5 ms
       synthetic render p95 at 4x CPU throttle, same fps. See
       test/baseline/perf_after.json and perf_strokes_control.json. */
    var tipL = R * 3.4;                       // how far back the trail reaches
    var halfW = R * 0.62;                     // half-width where it leaves the rock
    var bx = m.x + tx * R * 0.35, by = m.y + ty * R * 0.35;   // base, just off the rock
    var px = -ty, py = tx;                    // perpendicular to travel

    var tg = ctx.createLinearGradient(bx, by, bx + tx * tipL, by + ty * tipL);
    tg.addColorStop(0, rgba(METEOR.hot, 0.55));
    tg.addColorStop(0.35, rgba(METEOR.fire, 0.28));
    tg.addColorStop(1, rgba(METEOR.fire, 0));

    ctx.save();
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.moveTo(bx + px * halfW, by + py * halfW);
    ctx.lineTo(bx + tx * tipL, by + ty * tipL);
    ctx.lineTo(bx - px * halfW, by - py * halfW);
    ctx.closePath();
    ctx.fill();

    /* A hotter, narrower core down the middle of the wedge, so the trail has
       a bright spine instead of being one flat wash. */
    var cg = ctx.createLinearGradient(bx, by, bx + tx * tipL * 0.62, by + ty * tipL * 0.62);
    cg.addColorStop(0, rgba([255, 226, 180], 0.7));
    cg.addColorStop(1, rgba(METEOR.hot, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.moveTo(bx + px * halfW * 0.34, by + py * halfW * 0.34);
    ctx.lineTo(bx + tx * tipL * 0.62, by + ty * tipL * 0.62);
    ctx.lineTo(bx - px * halfW * 0.34, by - py * halfW * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    SK.drawGlow(ctx, meteorGlow(), m.x, m.y, 0.8, 0.6);

    var spr = meteorSprite(m);
    var half = (spr.width / 2) * (R / SPRITE_R);
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(spin);
    ctx.drawImage(spr, -half, -half, half * 2, half * 2);
    ctx.restore();

    /* Hot leading edge, live and unrotated: the rock tumbles but the side
       facing its travel is always the one burning. One arc, and it is what
       makes the hazard read as INCOMING rather than as scenery. */
    var lead = Math.atan2(-ty, -tx);
    ctx.save();
    ctx.strokeStyle = rgba(METEOR.hot, 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m.x, m.y, R * 0.86, lead - 0.85, lead + 0.85); ctx.stroke();
    ctx.strokeStyle = rgba(METEOR.danger, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(m.x, m.y, R * 0.98, lead - 1.2, lead + 1.2); ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------- exports */

  SK.Celestial = {
    LX: LX, LY: LY,
    PLANETS: PLANETS,
    STARS: STARS,
    METEOR: METEOR,

    classOf: classOf,
    variantOf: variantOf,
    starClass: starClass,
    hash: hash,

    /* The colour a body uses for its GAMEPLAY signals - halo tint aside, this
       is the latch ring, the tether and the hook particles.
       Deliberately NOT the art palette for planets: cyan has meant "safe
       anchor" and amber has meant "this one burns out" since the first build,
       and a formation class must not be allowed to overwrite either signal.
       Stars are the exception, and on purpose: their spectral colour IS
       gameplay information, because mass is what sets it and mass is what
       decides how far this body will sling you. */
    signalCol: function (n) {
      if (!n) return [53, 230, 255];
      if (n.type === 'decay') return [255, 176, 58];
      if (n.kind === 'star') return starClass(n.mass).glow;
      return [53, 230, 255];
    },

    /* What a body's hook burst is made of - the art accent, so a lava planet
       throws orange sparks and a blue giant throws blue-white ones. */
    accentCol: function (n) {
      var cls = classOf(n);
      return n && n.kind === 'star' ? cls.accent : cls.pal.accent;
    },

    glowFor: function (n) { return glowSprite(classOf(n), n.kind === 'star'); },
    discSprite: discSprite,
    drawBody: drawBody,
    drawMeteor: drawMeteor,
    meteorArt: meteorArt,

    /* For the harness: proves the cache is bounded and actually being hit. */
    cacheStats: function () { return { entries: cacheN, keys: Object.keys(cache) }; }
  };

}(typeof window !== 'undefined' ? window : this));
