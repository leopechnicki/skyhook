/* SKYHOOK - the rocket.
 *
 * The thing the player IS. It used to be a white dot: a 8 px filled arc with a
 * cyan outline, drawn inline in game.js. A dot has no front, so the game's one
 * verb - "you are travelling THAT way, let go now" - had to be read entirely
 * off the dashed release guide. A rocket carries its own heading, so the
 * launch vector is legible from the player sprite itself even when the guide
 * is off screen or crowded.
 *
 * Same contract js/celestial.js signs, and for the same reason:
 *
 *   - NOTHING here calls game.rand(). The world is generated from one seeded
 *     chain and draw code runs a variable number of times per tick, so a
 *     single rand() taken for a visual detail would regenerate the world.
 *     test/world.mjs is the gate that enforces this.
 *   - NOTHING here calls Math.random() either. Flame flicker is driven by the
 *     SIM clock, so it is stable, reproducible and does not crawl.
 *   - Nothing here is physics. PLAYER_R (the collision radius, 8 px) is owned
 *     by game.js and is untouched by this file. The hull is drawn LARGER than
 *     the collision circle on purpose - see HULL_F - which is the standard
 *     arcade forgiveness bias, not a hitbox change.
 *
 * WHY A BAKED SPRITE, AND WHY NEUTRAL LIGHTING
 * --------------------------------------------
 * Bodies in celestial.js can bake their lighting because the field is lit
 * from one fixed global direction (LX, LY) and a planet never rotates. The
 * rocket rotates continuously, so a baked directional light would spin with
 * the hull and read as a light source orbiting the ship. The hull is therefore
 * lit along its OWN axis (a vehicle's own shading, which is what you expect to
 * rotate with it) and the neon rim is symmetric. That keeps the sprite valid
 * at every angle, so the hull cache is a single entry.
 *
 * The flame is baked too, in colour buckets - see the long note above
 * drawFlame for why, and for the measurement that forced it. A frame of
 * rocket is therefore exactly three drawImage calls and no gradients.
 *
 * WHERE THE COLOURS COME FROM
 * ---------------------------
 * They used to be six module-level constants. They are now DERIVED from one
 * hex that js/ship.js owns - SK.Ship.current() - which is the player's chosen
 * colour, or gold while they are #1 on the board. This file still decides how
 * a colour is USED (which part is lit, which is shaded, what the plume fades
 * to); it no longer decides what the colour IS.
 *
 * resolve() is the whole derivation and it is tuned so that resolve('#35e6ff')
 * reproduces the six constants it replaced. test/ship.mjs asserts that against
 * the literal old values, so a "harmless" tweak in here that would have
 * quietly restyled the default ship turns the build red instead.
 *
 * That turns both sprite caches from "one entry, forever" into "one entry per
 * colour", which is the one way this refactor could have undone the whole
 * argument of js/celestial.js. So both are bounded LRUs (HULL_CACHE_MAX /
 * FLAME_CACHE_MAX) and cacheStats() reports the ceilings, which test/ship.mjs
 * asserts against after walking far more colours than a player could produce.
 * Repainting a hull sprite costs about a millisecond and happens on a swatch
 * TAP, never in the frame loop.
 *
 * With js/ship.js absent the file falls back to the exact colour it used to
 * hold, so rocket.js remains loadable on its own.
 */
(function (global) {
  'use strict';

  var SK = global.SK;
  var TAU = SK.TAU, clamp = SK.clamp;

  /* Sprite is painted at this half-length and minified at blit time, exactly
     like celestial.js: bodies draw at ~10-23 logical px against a 2x device
     cap, so every blit stays a minification and stays sharp. */
  var SPRITE_L = 46;          // half-length of the sprite canvas, px
  var HULL_F   = 2.45;        // hull half-length = PLAYER_R * HULL_F
  var WIDTH_F  = 0.46;        // hull half-width as a fraction of half-length

  /* Thruster. `burn` is a 0..1 impulse game.js spikes on a tap-release and
     decays on the SIM clock; `base` is the always-on idle plume so the ship
     never looks dead while it is coasting. */
  var FLAME_BASE = 0.30;
  var FLAME_LEN  = 3.1;       // plume length at full burn, in hull half-lengths

  /* The white core of the plume. Always white, whatever the ship is painted:
     it is the part that says "engine lit", and it is the same white the bloom
     sprite is made of. */
  var FLAME_HOT  = [255, 255, 255];

  /* The amber the exhaust flashes on a release. Deliberately NOT derived from
     the ship's colour: it is the game telling the player their tap landed, and
     a signal the player can repaint is a signal they can switch off by
     accident. js/game.js paints the release particles with it too. */
  var FLAME_BURN = [255, 176, 58];

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  /* ------------------------------------------------------------ palette */

  /* THE DERIVATION.
   *
   * One hex in, five painted colours out. The constants below are the mix
   * weights that make resolve('#35e6ff') land on the six values this file
   * used to hardcode:
   *
   *     HULL   [236,246,255]  <- mix(cyan, WHITE, HULL_W)  -> [231,252,255]
   *     HULL_D [104,132,158]  <- shade(hull)                -> [104,132,158]
   *     TRIM   [ 53,230,255]  <- the colour itself          -> exact
   *     GLASS  [140,240,255]  <- mix(cyan, WHITE, GLASS_W)  -> [140,241,255]
   *     F_MID  [120,226,255]  <- mix(cyan, WHITE, FIRE_W)   -> [120,238,255]
   *     F_COOL [ 86,126,255]  <- mix(cyan, NIGHT, COOL_W)   -> [ 31,100,143]
   *
   * The first four are the old ship to within a handful of channel steps and
   * HULL_D is exact, which is what test/ship.mjs measures. F_COOL is the one
   * deliberate departure: it is the tail of an ADDITIVE plume whose alpha
   * reaches 0 at that stop, so its hue is barely visible, and deriving it from
   * the ship rather than pinning it blue is what stops a gold rocket trailing
   * a blue exhaust.
   *
   * WHY THE PLATING IS MOSTLY WHITE AT EVERY SETTING
   * The SKYHOOK rocket has always been a white hull with a neon rim: the
   * colour that identifies it lives in the outline, the fins, the nose cone,
   * the glass and the plume, not in the barrel. Keeping HULL_W high preserves
   * that - a fully saturated fuselage reads as painted plastic at 40 px and
   * loses the axial highlight the shading depends on - while the five rim
   * surfaces carry the player's choice at full strength. */
  var FALLBACK = '#35e6ff';
  var WHITE = [255, 255, 255];
  var HULL_W  = 0.88;           // how far the lit plating is pulled to white
  var GLASS_W = 0.43;
  var FIRE_W  = 0.33;
  var COOL_W  = 0.62;
  var NIGHT = [18, 20, 74];     // deep indigo the plume tail fades into

  /* The shadowed flank. Multiplicative darkening plus a small cool lift,
     rather than a mix towards a fixed dark: a mix lets the dark colour's own
     hue take over at high weights, which turned the shaded side of every
     warm-coloured ship blue-grey. Scaling keeps the hull's hue and only the
     LIFT is cool - that is the sky filling the shadow, and it is small enough
     that a gold ship keeps a gold shadow.

     Tuned so shade(mix(cyan, WHITE, HULL_W)) is exactly the [104,132,158] this
     file used to hardcode. */
  var SHADE_K = 0.45;
  var SHADE_LIFT = [0, 19, 43];

  function shade(c) {
    return [Math.min(255, Math.round(c[0] * SHADE_K + SHADE_LIFT[0])),
            Math.min(255, Math.round(c[1] * SHADE_K + SHADE_LIFT[1])),
            Math.min(255, Math.round(c[2] * SHADE_K + SHADE_LIFT[2]))];
  }

  function hex2rgb(h) {
    var m = /^#([0-9a-f]{6})$/i.exec(String(h === undefined || h === null ? '' : h).trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* Resolves a hex (or `undefined`, meaning "whatever the player is flying
     right now") into painted colours plus the cache key they are stored
     under. Never throws and never returns a bad channel: an unreadable colour
     falls back to the shipped default, which is the same rule
     SK.Ship.normalise enforces one layer up. */
  function resolve(hex) {
    var src = hex || (SK.Ship ? SK.Ship.current() : FALLBACK);
    var base = hex2rgb(src);
    if (!base) { src = FALLBACK; base = hex2rgb(FALLBACK); }
    var hull = mix(base, WHITE, HULL_W);
    return {
      key: String(src).toLowerCase(),
      hull: hull,
      hullD: shade(hull),
      trim: base,
      glass: mix(base, WHITE, GLASS_W),
      fire: mix(base, WHITE, FIRE_W),
      fireCool: mix(base, NIGHT, COOL_W)
    };
  }

  /* ------------------------------------------------------------- sprite */

  /* Bounded LRU, keyed by colour. One is the steady state (two while the
     champion's crown is coming and going); the ceiling leaves room for the
     customiser, which repaints on every swatch tap while the player browses.
     Past the ceiling the coldest entry is dropped - never a flush, for the
     same reason js/celestial.js stopped flushing: dropping everything at the
     moment of pressure is how a cache turns into a repaint loop. */
  var HULL_CACHE_MAX = 4;
  var hullCache = {};
  var hullOrder = [];          // least-recently-used first

  /* The fuselage silhouette: a nose cone running into a straight barrel and a
     flared engine skirt. Kept as its own function because the path is needed
     THREE times - fill, clip, outline - and a canvas `restore()` does not
     restore the current path. Rebuilding it is the only way to be sure the
     neon outline traces the hull and not whatever sub-shape was drawn last.
     (It did not, briefly: the outline was stroking the nose-cone path.) */
  function hullPath(g, cx, cy, L, Wd) {
    g.beginPath();
    g.moveTo(cx, cy - L);                                   // nose tip
    g.bezierCurveTo(cx + Wd * 0.86, cy - L * 0.52,
                    cx + Wd, cy - L * 0.10,
                    cx + Wd, cy + L * 0.52);                // right flank
    g.lineTo(cx + Wd * 0.80, cy + L * 0.86);                // right skirt
    g.lineTo(cx - Wd * 0.80, cy + L * 0.86);                // left skirt
    g.lineTo(cx - Wd, cy + L * 0.52);
    g.bezierCurveTo(cx - Wd, cy - L * 0.10,
                    cx - Wd * 0.86, cy - L * 0.52,
                    cx, cy - L);
    g.closePath();
  }

  /* Painted nose-UP (towards -Y) in sprite space. draw() rotates by
     (heading + PI/2) so the nose ends up along the velocity vector. */
  function paintHull(g, cx, cy, L, col) {
    var Wd = L * WIDTH_F;

    /* --- fins, behind the fuselage so the hull edge stays clean --- */
    g.fillStyle = rgba(col.trim, 0.90);
    var s;
    for (s = -1; s <= 1; s += 2) {
      g.beginPath();
      g.moveTo(cx + s * Wd * 0.86, cy + L * 0.24);
      g.lineTo(cx + s * Wd * 1.95, cy + L * 0.92);
      g.lineTo(cx + s * Wd * 0.90, cy + L * 0.86);
      g.closePath();
      g.fill();
    }

    /* --- fuselage: axial shading, i.e. light across the ship's own beam.
       This rotates WITH the hull, which is what a vehicle's shading is
       supposed to do - a baked world-space light would read as a lamp
       orbiting the ship. --- */
    hullPath(g, cx, cy, L, Wd);
    var lat = g.createLinearGradient(cx - Wd, cy, cx + Wd, cy);
    lat.addColorStop(0.00, rgba(col.hullD, 1));
    lat.addColorStop(0.28, rgba(col.hull, 1));
    lat.addColorStop(0.62, rgba(col.hull, 1));
    lat.addColorStop(1.00, rgba(col.hullD, 1));
    g.fillStyle = lat;
    g.fill();

    /* --- markings, clipped to the hull --- */
    g.save();
    hullPath(g, cx, cy, L, Wd);
    g.clip();

    /* Nose cone in the trim colour - the single strongest "this end is the
       front" cue, and it survives being minified to a handful of pixels.
       It stops well short of the mid-hull on purpose: run it further down and
       the cyan cone meets the cyan fins, the pale barrel between them vanishes
       and the silhouette reads as a double-ended arrow rather than a ship. */
    var noseEnd = cy - L * 0.44;
    g.beginPath();
    g.moveTo(cx, cy - L);
    g.bezierCurveTo(cx + Wd * 0.86, cy - L * 0.52, cx + Wd, noseEnd - L * 0.06, cx + Wd, noseEnd);
    g.lineTo(cx - Wd, noseEnd);
    g.bezierCurveTo(cx - Wd, noseEnd - L * 0.06, cx - Wd * 0.86, cy - L * 0.52, cx, cy - L);
    g.closePath();
    var nose = g.createLinearGradient(cx, cy - L, cx, noseEnd);
    nose.addColorStop(0, rgba([255, 255, 255], 0.98));
    nose.addColorStop(1, rgba(col.trim, 0.92));
    g.fillStyle = nose;
    g.fill();

    /* Engine collar */
    g.fillStyle = rgba(col.hullD, 0.9);
    g.fillRect(cx - Wd, cy + L * 0.58, Wd * 2, L * 0.16);
    g.restore();

    /* Hull outline: neon, symmetric, full silhouette. At the size this is
       actually drawn the outline IS most of the readable shape, so it is
       stroked LAST, on a freshly rebuilt path. */
    hullPath(g, cx, cy, L, Wd);
    g.strokeStyle = rgba(col.trim, 0.95);
    g.lineWidth = L * 0.075;
    g.lineJoin = 'round';
    g.stroke();

    /* Porthole - centred on the pale barrel, below the cone. */
    g.beginPath();
    g.arc(cx, cy - L * 0.14, Wd * 0.42, 0, TAU);
    var win = g.createRadialGradient(cx - Wd * 0.12, cy - L * 0.19, 0, cx, cy - L * 0.14, Wd * 0.42);
    win.addColorStop(0, rgba([255, 255, 255], 0.98));
    win.addColorStop(1, rgba(col.glass, 0.75));
    g.fillStyle = win;
    g.fill();
    g.strokeStyle = rgba([255, 255, 255], 0.9);
    g.lineWidth = L * 0.045;
    g.stroke();
  }

  /* Moves `k` to the hot end of an LRU order list and evicts from the cold
     end while the cache is over its ceiling. One function for both caches, so
     the two cannot drift into two different eviction policies. */
  function touch(cache, order, k, max) {
    var at = order.indexOf(k);
    if (at >= 0) order.splice(at, 1);
    order.push(k);
    while (order.length > max) delete cache[order.shift()];
  }

  function hullSprite(col) {
    var k = col.key;
    if (hullCache[k]) { touch(hullCache, hullOrder, k, HULL_CACHE_MAX); return hullCache[k]; }
    var pad = 1.6;                       // room for fins + outline
    var size = Math.ceil(SPRITE_L * pad * 2);
    var c = global.document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    paintHull(g, size / 2, size / 2, SPRITE_L, col);
    hullCache[k] = c;
    touch(hullCache, hullOrder, k, HULL_CACHE_MAX);
    return c;
  }

  /* ------------------------------------------------------------ heading */

  /* The direction the ship is travelling, in canvas radians (0 = +X).
     Orbit: the tangent, and it must agree EXACTLY with the release guide and
     with the velocity _release() hands out - anything else would draw a lie
     about where a tap sends you. Flight: the velocity itself. */
  function heading(p) {
    if (p.mode === 'orbit' && p.node) {
      return Math.atan2(Math.cos(p.ang) * p.dir, -Math.sin(p.ang) * p.dir);
    }
    if (p.vx || p.vy) return Math.atan2(p.vy, p.vx);
    return -Math.PI / 2;
  }

  /* Shortest-arc step from a to b. A hook can reverse the heading by nearly
     180 degrees in one tick; snapping reads as a glitch, so game.js eases
     `p.aim` towards heading() on the FIXED step (deterministic, and never in
     the draw call). */
  function turn(a, b, k) {
    var d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return a + d * k;
  }

  /* ------------------------------------------------------------- flame */

  /* WHY THE FLAME IS BAKED TOO
     --------------------------
     The first version of this drew live: two createLinearGradient calls, a
     createRadialGradient and three path fills, every frame. That is one ship
     against a dozen bodies, so it should have been free - and it was not. On
     the standing frame-time harness (test/perf.mjs, 4x CPU throttle, 390x844
     @dpr2) it cost:

         live render p95   2.8 ms  ->  6.9 ms
         live frame  p95   7.2 ms  -> 12.6 ms

     Attributed, not guessed: stubbing ONLY drawFlame and re-running put live
     render p95 back to 2.9 ms, i.e. the hull blit and the wider exhaust
     particles were free and the gradients were the entire regression. Still
     inside the 16.67 ms budget, but it burned a third of the headroom on one
     sprite, which is exactly the mistake js/celestial.js was written to undo.

     So the plume is pre-rendered into a small bucketed cache and blitted. The
     shape is fixed in sprite space, so length and width become the destination
     rectangle (free), and only the COLOUR varies - which is what the buckets
     are for. FLAME_BUCKETS + 1 plume sprites and the same number of bloom
     sprites, built on first sight and never rebuilt: a bounded cache, in the
     same spirit as SK.makeGlow and the celestial sprite cache.

     Quantising burn to 6 steps is invisible: burn decays over 0.42 s, so a
     bucket boundary is crossed every ~70 ms, under an additive blend, on a
     shape that is already flickering. */
  var FLAME_BUCKETS = 5;                 // 0..5 inclusive => 6 colour steps
  var FSPR_W = 96, FSPR_H = 192;         // plume sprite, painted once per bucket
  var BLOOM_R = 48;                      // nozzle bloom sprite radius

  /* The plume is now keyed by COLOUR as well as bucket, so the cache is a map
     under an LRU rather than a dense array. Two colours' worth of buckets is
     the ceiling: the steady state is one (six entries), and the second set is
     the head-room that lets the crown arrive, or a player browse the
     customiser, without evicting the ship they are actually flying.

     The bloom is NOT keyed by colour - it is made of FLAME_HOT, which is white
     at every setting - so it stays a dense array of FLAME_BUCKETS + 1 and
     keeps its original "built once, never rebuilt" property. */
  var FLAME_CACHE_MAX = (FLAME_BUCKETS + 1) * 2;
  var flameCache = {};
  var flameOrder = [];
  var bloomCache = [];

  /* The plume, painted nose-at-top: full width along y=0, converging to a
     point at y=FSPR_H. drawFlame stretches this rectangle to the length and
     width the current drive asks for. */
  function flameSprite(b, col) {
    var k = col.key + '|' + b;
    if (flameCache[k]) { touch(flameCache, flameOrder, k, FLAME_CACHE_MAX); return flameCache[k]; }
    var burn = b / FLAME_BUCKETS;
    var hot = mix(col.fire, FLAME_BURN, burn);
    var c = global.document.createElement('canvas');
    c.width = FSPR_W; c.height = FSPR_H;
    var g = c.getContext('2d');
    var cx = FSPR_W / 2, wid = FSPR_W / 2;

    var g1 = g.createLinearGradient(0, 0, 0, FSPR_H);
    g1.addColorStop(0.00, rgba(hot, 0.85));
    g1.addColorStop(0.35, rgba(mix(hot, col.fireCool, 0.5), 0.42));
    g1.addColorStop(1.00, rgba(col.fireCool, 0));
    g.fillStyle = g1;
    g.beginPath();
    g.moveTo(cx - wid, 0);
    g.quadraticCurveTo(cx - wid * 0.55, FSPR_H * 0.62, cx, FSPR_H);
    g.quadraticCurveTo(cx + wid * 0.55, FSPR_H * 0.62, cx + wid, 0);
    g.closePath();
    g.fill();

    /* inner core - shorter, whiter, this is what sells "engine lit" */
    var clen = FSPR_H * 0.46, cwid = wid * 0.46;
    var g2 = g.createLinearGradient(0, 0, 0, clen);
    g2.addColorStop(0.00, rgba(FLAME_HOT, 0.95));
    g2.addColorStop(1.00, rgba(hot, 0));
    g.fillStyle = g2;
    g.beginPath();
    g.moveTo(cx - cwid, 0);
    g.quadraticCurveTo(cx, clen * 0.75, cx, clen);
    g.quadraticCurveTo(cx, clen * 0.75, cx + cwid, 0);
    g.closePath();
    g.fill();

    flameCache[k] = c;
    touch(flameCache, flameOrder, k, FLAME_CACHE_MAX);
    return c;
  }

  function bloomSprite(b) {
    if (bloomCache[b]) return bloomCache[b];
    var burn = b / FLAME_BUCKETS;
    bloomCache[b] = SK.makeGlow(BLOOM_R, FLAME_HOT.join(','), 0.55 + burn * 0.35);
    return bloomCache[b];
  }

  /* Drawn in world space, behind the hull, additively. `burn` is the tap
     impulse, `thrust` the steady component (how fast this body is actually
     throwing you), so a star release produces a visibly longer plume than a
     planet one and the art reports the physics. Two blits, no gradients. */
  function drawFlame(ctx, x, y, ang, L, burn, thrust, t, col) {
    var drive = clamp(FLAME_BASE + thrust * 0.55 + burn * 0.95, 0, 2.0);
    if (drive <= 0.02) return;

    /* Flicker from the sim clock only. Two incommensurable rates so it never
       settles into a visible loop. */
    var flick = 1 + 0.10 * Math.sin(t * 41.3) + 0.06 * Math.sin(t * 17.7 + 1.1);
    var len = L * FLAME_LEN * drive * flick;
    var wid = L * WIDTH_F * (0.86 + burn * 0.42);
    var b = Math.round(clamp(burn, 0, 1) * FLAME_BUCKETS);
    var y0 = L * 0.80;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang + Math.PI / 2);        // sprite space: nose at -Y, plume at +Y
    var prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';

    ctx.drawImage(flameSprite(b, col), -wid, y0, wid * 2, len);

    var br = wid * (1.15 + burn * 0.75);
    ctx.drawImage(bloomSprite(b), -br, y0 - br, br * 2, br * 2);

    ctx.globalCompositeOperation = prevOp;
    ctx.restore();
  }

  /* --------------------------------------------------------------- draw */

  /* One blit for the hull, one live flame. `opts`:
       burn    0..1 tap impulse            (default 0)
       thrust  0..1 how hard this body throws you (default 0.35)
       alpha   overall opacity             (default 1)
       warn    0..1 "about to fall off the bottom" pulse; draws the danger ring
     `R` is the collision radius (PLAYER_R); the hull is drawn at R * HULL_F. */
  function draw(ctx, x, y, ang, R, t, opts) {
    var o = opts || {};
    var burn = clamp(o.burn === undefined ? 0 : o.burn, 0, 1);
    var thrust = clamp(o.thrust === undefined ? 0.35 : o.thrust, 0, 1);
    var alpha = o.alpha === undefined ? 1 : o.alpha;
    var L = R * HULL_F;

    /* Resolved ONCE per draw and threaded through both halves, so the hull and
       its own exhaust can never disagree about what colour the ship is - which
       is exactly what would happen if each looked SK.Ship.current() up for
       itself and the crown changed hands between the two calls.

       `opts.colour` is the customiser's preview hook: a specific hex to paint
       instead of the live one. It is never persisted by drawing it. */
    var col = resolve(o.colour);

    drawFlame(ctx, x, y, ang, L, burn, thrust, t, col);

    var spr = hullSprite(col);
    var half = (spr.width / 2) * (L / SPRITE_L);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(ang + Math.PI / 2);
    ctx.drawImage(spr, -half, -half, half * 2, half * 2);
    /* restore() already puts globalAlpha back to whatever the CALLER had.
       Assigning 1 here instead would silently stomp an outer fade - the ship
       would punch through a transition the rest of the scene respected. */
    ctx.restore();

    /* Danger ring. The old white dot carried a permanent cyan outline that
       doubled as the fall warning; the hull owns its own outline now, so the
       ring is drawn ONLY when it means something. */
    if (o.warn > 0.001) {
      ctx.save();
      ctx.strokeStyle = rgba([255, 90, 110], (0.45 + 0.45 * Math.sin(t * 22)).toFixed(3));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, L * 1.28, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }

  /* Where the exhaust actually leaves the ship, in world space. game.js emits
     the trail from here instead of from the hull centre, so the plume trails
     the nozzle rather than squirting out of the cockpit. */
  function nozzle(x, y, ang, R, out) {
    var L = R * HULL_F;
    var d = L * 0.86;
    out.x = x - Math.cos(ang) * d;
    out.y = y - Math.sin(ang) * d;
    return out;
  }

  SK.Rocket = {
    HULL_F: HULL_F,
    FLAME_BURN: FLAME_BURN,
    /* The painted colours for a given hex, or for the live ship. Exposed for
       the customiser's preview and for test/ship.mjs, which asserts the
       derivation against the constants this file used to hold. */
    resolve: resolve,
    heading: heading,
    turn: turn,
    draw: draw,
    nozzle: nozzle,
    /* For the harness: proves every part of the ship is baked, not repainted,
       and that making the paint configurable did not make the caches
       unbounded. Each count must stay at or under its own ceiling no matter
       how many colours have been walked. */
    cacheStats: function () {
      var b = 0, i;
      for (i = 0; i <= FLAME_BUCKETS; i++) { if (bloomCache[i]) b++; }
      return {
        hull: hullOrder.length,
        flame: flameOrder.length,
        bloom: b,
        hullMax: HULL_CACHE_MAX,
        flameMax: FLAME_CACHE_MAX,
        bloomMax: FLAME_BUCKETS + 1
      };
    }
  };

}(typeof window !== 'undefined' ? window : this));
