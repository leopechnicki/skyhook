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

  var HULL   = [236, 246, 255];   // plating
  var HULL_D = [104, 132, 158];   // shadowed flank
  var TRIM   = [53, 230, 255];    // neon cyan - same signal colour as a latch ring
  var GLASS  = [140, 240, 255];
  var FLAME_HOT  = [255, 255, 255];
  var FLAME_MID  = [120, 226, 255];
  var FLAME_COOL = [86, 126, 255];
  var FLAME_BURN = [255, 176, 58];   // the amber the exhaust flashes on a release

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  /* ------------------------------------------------------------- sprite */

  var hullSpr = null;

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
  function paintHull(g, cx, cy, L) {
    var Wd = L * WIDTH_F;

    /* --- fins, behind the fuselage so the hull edge stays clean --- */
    g.fillStyle = rgba(TRIM, 0.90);
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
    lat.addColorStop(0.00, rgba(HULL_D, 1));
    lat.addColorStop(0.28, rgba(HULL, 1));
    lat.addColorStop(0.62, rgba(HULL, 1));
    lat.addColorStop(1.00, rgba(HULL_D, 1));
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
    nose.addColorStop(1, rgba(TRIM, 0.92));
    g.fillStyle = nose;
    g.fill();

    /* Engine collar */
    g.fillStyle = rgba(HULL_D, 0.9);
    g.fillRect(cx - Wd, cy + L * 0.58, Wd * 2, L * 0.16);
    g.restore();

    /* Hull outline: neon, symmetric, full silhouette. At the size this is
       actually drawn the outline IS most of the readable shape, so it is
       stroked LAST, on a freshly rebuilt path. */
    hullPath(g, cx, cy, L, Wd);
    g.strokeStyle = rgba(TRIM, 0.95);
    g.lineWidth = L * 0.075;
    g.lineJoin = 'round';
    g.stroke();

    /* Porthole - centred on the pale barrel, below the cone. */
    g.beginPath();
    g.arc(cx, cy - L * 0.14, Wd * 0.42, 0, TAU);
    var win = g.createRadialGradient(cx - Wd * 0.12, cy - L * 0.19, 0, cx, cy - L * 0.14, Wd * 0.42);
    win.addColorStop(0, rgba([255, 255, 255], 0.98));
    win.addColorStop(1, rgba(GLASS, 0.75));
    g.fillStyle = win;
    g.fill();
    g.strokeStyle = rgba([255, 255, 255], 0.9);
    g.lineWidth = L * 0.045;
    g.stroke();
  }

  function hullSprite() {
    if (hullSpr) return hullSpr;
    var pad = 1.6;                       // room for fins + outline
    var size = Math.ceil(SPRITE_L * pad * 2);
    var c = global.document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    paintHull(g, size / 2, size / 2, SPRITE_L);
    hullSpr = c;
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
  var flameCache = [], bloomCache = [];

  /* The plume, painted nose-at-top: full width along y=0, converging to a
     point at y=FSPR_H. drawFlame stretches this rectangle to the length and
     width the current drive asks for. */
  function flameSprite(b) {
    if (flameCache[b]) return flameCache[b];
    var burn = b / FLAME_BUCKETS;
    var hot = mix(FLAME_MID, FLAME_BURN, burn);
    var c = global.document.createElement('canvas');
    c.width = FSPR_W; c.height = FSPR_H;
    var g = c.getContext('2d');
    var cx = FSPR_W / 2, wid = FSPR_W / 2;

    var g1 = g.createLinearGradient(0, 0, 0, FSPR_H);
    g1.addColorStop(0.00, rgba(hot, 0.85));
    g1.addColorStop(0.35, rgba(mix(hot, FLAME_COOL, 0.5), 0.42));
    g1.addColorStop(1.00, rgba(FLAME_COOL, 0));
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

    flameCache[b] = c;
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
  function drawFlame(ctx, x, y, ang, L, burn, thrust, t) {
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

    ctx.drawImage(flameSprite(b), -wid, y0, wid * 2, len);

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

    drawFlame(ctx, x, y, ang, L, burn, thrust, t);

    var spr = hullSprite();
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
    TRIM: TRIM,
    FLAME_BURN: FLAME_BURN,
    heading: heading,
    turn: turn,
    draw: draw,
    nozzle: nozzle,
    /* For the harness: proves every part of the ship is baked, not repainted.
       `hull` must be 1 and `flame`/`bloom` must never exceed FLAME_BUCKETS+1,
       which is what makes the cache bounded rather than merely small today. */
    cacheStats: function () {
      var f = 0, b = 0, i;
      for (i = 0; i <= FLAME_BUCKETS; i++) {
        if (flameCache[i]) f++;
        if (bloomCache[i]) b++;
      }
      return { hull: hullSpr ? 1 : 0, flame: f, bloom: b, ceiling: FLAME_BUCKETS + 1 };
    }
  };

}(typeof window !== 'undefined' ? window : this));
