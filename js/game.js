/* SKYHOOK - core game.
   One input. You orbit a celestial body on a tether. Tap to let go; you fly in
   a straight line and automatically latch onto the next body you pass near.

   Bodies have MASS. A star pulls harder than a planet, so it spins you faster
   and throws you further; a planet is gentle and forgiving but pays less.
   The run is endless while the ball stays on screen: there is no rift and no
   flight timer. You lose by leaving the column or falling out of the bottom. */
(function (global) {
  'use strict';

  var SK = global.SK;
  var clamp = SK.clamp, lerp = SK.lerp, TAU = SK.TAU;

  /* ---- logical resolution (everything is drawn in these units) ---- */
  var W = 480, H = 880;

  /* ---- tuning ------------------------------------------------------ */
  /* Linear speed is no longer one constant. A brand new player used to be
     dropped straight into 468 px/s, and - worse - a *tight* catch pinned the
     tether at MIN_R, which halved the next timing window (0.62 s orbit at
     r=46 vs 1.24 s at r=92). The game's most celebrated action was silently
     its harshest punishment. Speed now ramps with demonstrated skill and
     MIN_R is wide enough that a bullseye no longer costs you the next hook. */
  /* ---- gravity -----------------------------------------------------
     Bodies used to be identical dots orbited at one global linear SPEED.
     They now have a MASS and a RADIUS, and the orbit is DERIVED from them:

         mu    = G * mass * scale^2        standard gravitational parameter
         omega = sqrt(mu / r^3)            Kepler's circular-orbit rate
         v     = sqrt(mu / r)  ( = omega*r )   tangential speed at release

     Those are the real relations; only the constants are tuned rather than SI.
     What that buys, as gameplay and not decoration:
       - a heavy body spins you faster AND slings you harder,
       - the same body spins you faster the tighter you catch it,
       - a star covers far more ground per release than a planet, so it is
         both the greedy line and the one that throws you off the screen.

     `scale` is the onboarding ramp. It is SQUARED into mu on purpose, so one
     knob moves omega and v together and v = omega*r keeps holding. */
  var G            = 1.55e7; // px^3 / (mass * s^2)
  var SCALE_START  = 0.78;   // gravity scale through the first few hooks
  var SCALE_RAMP_A = 3;      // ...held until this many hooks
  var SCALE_RAMP_B = 20;     // ...reaching full strength at this many hooks
  var TUTOR_SCALE  = 0.64;   // deliberately gentle while the tutorial teaches

  /* One mass-radius law for every body: R = R_REF * M^R_EXP. Stars are drawn
     bigger because they ARE heavier, not because of a lookup table. */
  var R_REF        = 12.5;   // radius of a 1.0-mass body, px
  var R_EXP        = 0.36;

  /* Tether geometry derives from the body's own radius, so a bigger body gets
     a bigger circle, a bigger latch ring and a wider orbit - all at once. */
  var MINR_BASE = 33, MINR_K = 2.16;  // minR = MINR_BASE + MINR_K * radius
  var MAXR_BASE = 55, MAXR_K = 2.96;  // maxR = captureR = MAXR_BASE + MAXR_K*r

  var PLANET_M_LO = 0.55, PLANET_M_HI = 1.15;
  var STAR_M_LO   = 2.20, STAR_M_HI   = 3.20;

  /* Difficulty escalation, and the ONLY one left now that the rift is gone.
     It is not a clock: the sky simply gets heavier the higher you climb, so
     stars appear more often and weigh more. Heavier body -> faster orbit and
     a longer sling -> a tighter release window and less room to stay on
     screen. Deep-run pressure comes out of the physics, not out of a timer. */
  var STAR_FROM     = 6;    // no stars at all before this many bodies
  var STAR_CHANCE_LO = 0.20; // share of bodies that are stars, at STAR_FROM
  var STAR_CHANCE_HI = 0.44; // ...once fully escalated
  var STAR_M_DEEP    = 4.20; // lower bound of the star mass band when deep
  var DEEP_OVER      = 70;   // bodies over which the escalation completes

  /* Catch quality is judged as a FRACTION of the body you caught. Absolute
     pixels would score every star as a sloppy hook purely for being large. */
  var TIGHT_F      = 0.57;
  var LOOSE_F      = 0.85;

  /* REFERENCE constants: the values a 1.0-mass body works out to. Nothing in
     the sim reads them as a tuning knob any more - they are the fallback for
     the balance harness, the title art, and the copy on the title screen. */
  var SPEED        = 468;   // v of a 1.0-mass body at r = 71
  var MIN_R        = 60;    // MINR_BASE + MINR_K * R_REF
  var MAX_R        = 92;    // MAXR_BASE + MAXR_K * R_REF
  var CAPTURE_R    = 92;
  var NODE_R       = 12;
  var TIGHT_D      = 52;    // 0.57 * 92
  var LOOSE_D      = 78;    // 0.85 * 92

  var SETTLE_RATE  = 240;   // px/s the tether eases out to its resting length
  var PREDICT_T    = 1.15;  // seconds of flight the release guide looks ahead
  var PLAYER_R     = 8;
  var MINE_R       = 11;
  var SHARD_PICK   = 22;
  var MARGIN_X     = 96;    // node placement bounds
  var DEATH_PAD    = 64;    // how far off-column before you are gone
  var DECAY_TIME   = 1.55;  // amber nodes burn out this fast
  var CAM_OFFSET   = 0.62;  // player sits this far down the screen

  /* ---- simulation --------------------------------------------------- */
  var STEP         = 1 / 120;  // TRUE fixed step. Never subdivided.
  var MAX_TICKS    = 12;       // ...per rendered frame, then drop the backlog
  var STALL_MAX    = 0.25;     // a longer gap is a stall, not slow rendering
  var ACT_DEBOUNCE = 0.12;     // seconds; measured on the SIM clock, not wall
  var GUIDE_LEN    = 220;      // release guide length (was 132)
  var LABEL_LIFE   = 0.65;
  var DEATH_ANIM   = 0.40;     // was 0.7
  var RETRY_LOCK   = 0.20;     // was 0.5

  /* Tutorial: three scripted hooks, no hazards, 1.0-mass planets. Offsets are
     relative to the starting node so they survive any change to H. */
  var TUTOR_NODES  = [ { x: 144, dy: -156 }, { x: 300, dy: -312 }, { x: 180, dy: -468 } ];
  var TUTOR_HOOKS  = TUTOR_NODES.length;
  var TUTOR_AIM    = 52;    // prompt "TAP NOW" once the guide is this close
  var TUTOR_RESET  = 0.25;  // an assisted miss rewinds this fast

  var COL = {
    node:   [53, 230, 255],    // planet
    star:   [255, 224, 140],   // star
    decay:  [255, 176, 58],
    player: [255, 255, 255],
    shard:  [255, 215, 94],
    mine:   [255, 77, 109],
    danger: [255, 46, 99]
  };

  /* The one place that answers "what colour is this body?". */
  function bodyCol(n) {
    if (!n) return COL.node;
    if (n.type === 'decay') return COL.decay;
    return n.kind === 'star' ? COL.star : COL.node;
  }

  /* The rift and the flight timer are gone, so 'rift' and 'drift' would now be
     lying to the player. There are exactly two ways to lose, and both of them
     are "the ball left the screen". */
  var CAUSE = {
    fell: 'YOU FELL OUT OF THE SKY',
    mine: 'YOU HIT A MINE',
    edge: 'YOU LEFT THE COLUMN'
  };

  /* A postmortem that only names the consequence teaches nothing. Every
     death ships the one correction that would have prevented it. */
  var FIX = {
    fell:  'Release on the way UP - a downward launch has nothing to catch',
    mine:  'Mines sit off the direct line - a clean release clears them',
    edge:  'Stars sling you far - let go of one earlier than you would a planet',
    decay: 'Amber anchors release you when their timer expires'
  };

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  /* ================================================================== */

  function Game(seed) {
    this.W = W; this.H = H;
    /* fixedSeed: an explicitly requested seed (?seed=N) that must survive
       every restart. start() used to throw it away and reseed at random, so
       "reproducible run" reproduced exactly one run - the one nobody plays. */
    this.fixedSeed = (seed === undefined || seed === null) ? null : (seed >>> 0);
    this.runSeed = this.fixedSeed === null ? ((Math.random() * 1e9) | 0) >>> 0 : this.fixedSeed;
    this.seed = this.runSeed;
    this.rand = SK.rng(this.runSeed);

    this.particles = new SK.Particles(420);

    this.best = Math.max(0, Math.floor(SK.Store.getNum('skyhook.best', 0)));
    this.muted = SK.Store.get('skyhook.muted', '0') === '1';
    SK.Audio.muted = this.muted;

    /* pre-rendered glows (cheap substitute for ctx.shadowBlur) */
    this.glowNode   = SK.makeGlow(64, COL.node.join(','), 0.85);
    this.glowStar   = SK.makeGlow(96, COL.star.join(','), 0.9);
    this.glowDecay  = SK.makeGlow(64, COL.decay.join(','), 0.85);
    this.glowPlayer = SK.makeGlow(52, COL.player.join(','), 0.9);
    this.glowShard  = SK.makeGlow(34, COL.shard.join(','), 0.9);
    this.glowMine   = SK.makeGlow(40, COL.mine.join(','), 0.8);

    this.stars = this._makeStars();
    this.nebula = this._makeNebula();

    this.state = 'title';
    this.time = 0;      // SIM clock: advances only on fixed ticks while playing
    this.acc = 0;       // fixed-step accumulator
    this.titleT = 0;
    this.overT = 0;
    this.dyingT = 0;
    this.shake = 0;
    this.flash = 0;
    this.hitstop = 0;
    this.camY = 0;
    this.newBest = false;
    this.cause = 'fell';
    this.lastForced = false;   // was the previous release forced by a decay node?
    this.shardPulse = 0;
    this.queuedAction = false; // input is consumed on the next sim tick
    this.lastActionT = -99;
    this.wasPlaying = false;

    /* Tap targets. Hit-tested BEFORE the generic "tap anywhere" action, so a
       results screen that later grows a purchase button cannot be triggered
       by a stray retry tap. Sized in logical units but chosen so they clear
       48 CSS px on the smallest sane phone (390x844 => scale 0.81). */
    this.muteRect  = { x: W - 56, y: 16, w: 40, h: 40 };          // drawn size
    this.muteHit   = { x: W - 66, y: 6,  w: 60, h: 60 };          // 48.7 CSS px @390w
    this.retryRect = { x: W / 2 - 130, y: 640, w: 260, h: 64 };   // 211x52 CSS px

    this.tutorialDone = SK.Store.get('skyhook.tutorialComplete', '0') === '1';
    this.tutorial = false;
    this.tutStep = 0;
    this.tutHold = false;      // orbit frozen, waiting for the taught tap
    this.tutResetT = 0;
    this.tutMisses = 0;

    /* Pooled floating labels - no allocation during play. */
    this.labels = [];
    for (var li = 0; li < 8; li++) this.labels.push({ t: 0, x: 0, y: 0, s: '', c: '255,255,255' });

    this.predict = { node: null, d: 0, t: 0 };

    this._resetWorld();
  }

  /* ---------------- gravity ----------------------------------------- */

  /* Mass -> radius, the single relation every body obeys. */
  function bodyRadius(mass) { return R_REF * Math.pow(mass, R_EXP); }

  /* Global strength of gravity right now. This is the onboarding ramp and
     nothing else - applied identically on every run, never a hidden
     per-player difficulty knob. */
  Game.prototype._gScale = function () {
    if (this.tutorial) return TUTOR_SCALE;
    var k = clamp((this.hooks - SCALE_RAMP_A) / (SCALE_RAMP_B - SCALE_RAMP_A), 0, 1);
    return lerp(SCALE_START, 1, k);
  };

  /* Standard gravitational parameter of one body, mu = G*M, with the
     onboarding scale squared in so that v = omega*r survives the ramp. */
  Game.prototype._mu = function (n) {
    var sc = this._gScale();
    return G * (n && n.mass ? n.mass : 1) * sc * sc;
  };

  /* The radius the orbit maths actually uses. Floored at the body's OWN
     resting minimum (the per-body successor to the MIN_R guard), so settling
     out of a dead-centre catch is a short wind-out and never a singularity. */
  function orbR(p) {
    var mn = (p.node && p.node.minR) ? p.node.minR : MIN_R;
    return Math.max(p.r, mn);
  }

  /* Signed angular rate in rad/s: omega = sqrt(mu / r^3), Kepler.
     Exposed publicly because the balance harness has to model the integrator
     exactly rather than guess at it (see test/balance.mjs, F3). */
  Game.prototype.angRate = function (p) {
    p = p || this.player;
    if (!p.node) return 0;
    var r = orbR(p);
    return p.dir * Math.sqrt(this._mu(p.node) / (r * r * r));
  };

  /* Tangential speed in px/s: v = sqrt(mu / r). This is the speed you leave
     with, so a heavy body throws you harder for free. */
  Game.prototype._vTan = function (p) {
    p = p || this.player;
    if (!p.node) return p.speed || SPEED;
    return Math.sqrt(this._mu(p.node) / orbR(p));
  };

  Game.prototype._label = function (x, y, s, col) {
    var best = this.labels[0];
    for (var i = 1; i < this.labels.length; i++) {
      if (this.labels[i].t < best.t) best = this.labels[i];
    }
    best.t = LABEL_LIFE; best.x = x; best.y = y; best.s = s;
    best.c = col || '255,255,255';
  };

  /* ---------------- background ------------------------------------- */

  Game.prototype._makeStars = function () {
    var r = SK.rng(1337), out = [], layers = [
      { n: 70, p: 0.12, s: 1.0, a: 0.30 },
      { n: 46, p: 0.30, s: 1.6, a: 0.48 },
      { n: 26, p: 0.55, s: 2.3, a: 0.70 }
    ];
    for (var l = 0; l < layers.length; l++) {
      var L = layers[l];
      for (var i = 0; i < L.n; i++) {
        out.push({
          x: r() * W, y: r() * H, p: L.p,
          s: L.s * (0.6 + r() * 0.8),
          a: L.a * (0.5 + r() * 0.5),
          tw: r() * TAU
        });
      }
    }
    return out;
  };

  Game.prototype._makeNebula = function () {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    var r = SK.rng(99);
    var tints = ['53,230,255', '255,77,210', '120,90,255'];
    for (var i = 0; i < 7; i++) {
      var x = r() * W, y = r() * H, rad = 130 + r() * 240;
      var grad = g.createRadialGradient(x, y, 0, x, y, rad);
      var t = tints[(r() * tints.length) | 0];
      grad.addColorStop(0, 'rgba(' + t + ',' + (0.05 + r() * 0.05).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(' + t + ',0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }
    return c;
  };

  /* ---------------- world ------------------------------------------ */

  Game.prototype._resetWorld = function () {
    this.nodes = [];
    this.mines = [];
    this.shards = [];
    this.nodeCount = 0;
    this.hooks = 0;
    this.score = 0;
    this.combo = 1;
    this.altitude = 0;
    this.particles.clear();

    this.tutStep = 0;
    this.tutHold = false;
    this.tutResetT = 0;
    this.tutMisses = 0;
    this.lastForced = false;
    this.shardPulse = 0;
    for (var li = 0; li < this.labels.length; li++) this.labels[li].t = 0;

    /* The opening body is a fixed 1.0-mass planet on every run: the first
       thing a player ever touches must not be a random star. */
    var first = this._pushNode(W * 0.5, H * 0.66, 'normal', 'planet', 1.0);
    this.startY = first.y;
    this.safeNode = first;   // last anchor, used to rewind an assisted miss

    /* The tutorial's three hooks are scripted, not generated: a first-run
       player must not be able to draw a layout that teaches the wrong thing. */
    if (this.tutorial) {
      for (var ti = 0; ti < TUTOR_NODES.length; ti++) {
        this._pushNode(TUTOR_NODES[ti].x, first.y + TUTOR_NODES[ti].dy, 'normal', 'planet', 1.0);
      }
    }

    /* Start one notch outside the opening body's own resting minimum rather
       than at a hardcoded 70 - the number now means something. */
    var startR = first.minR + 10;
    this.player = {
      x: first.x, y: first.y - startR,
      vx: 0, vy: 0,
      mode: 'orbit',
      node: first,
      ang: -Math.PI / 2,
      r: startR,
      targetR: startR,
      speed: 0,
      dir: 1,
      flyT: 0,
      trailT: 0
    };
    this.player.speed = this._vTan(this.player);
    first.hooked = true;

    this.pendNode = null;
    this.pendD = 0;
    this.pendX = 0;
    this.pendY = 0;

    this.camY = this.player.y - H * CAM_OFFSET;
    this.warnT = 0;
    this.tetherPulse = 0;

    this._ensureAhead();
  };

  /* Every body carries its own physics AND its own geometry. `minR`, `maxR`
     and `captureR` used to be three globals; they are now derived from this
     body's radius, which is derived from its mass. That is what makes "bigger
     circle for a bigger body" a rule of the simulation instead of a paint job.
     NOTE: the balance harness reads `minR` / `captureR` off these objects. */
  Game.prototype._pushNode = function (x, y, type, kind, mass) {
    kind = kind || 'planet';
    if (mass === undefined || mass === null) {
      mass = kind === 'star'
        ? STAR_M_LO + this.rand() * (STAR_M_HI - STAR_M_LO)
        : PLANET_M_LO + this.rand() * (PLANET_M_HI - PLANET_M_LO);
    }
    var radius = bodyRadius(mass);
    var reach = MAXR_BASE + MAXR_K * radius;
    var n = {
      x: x, y: y, type: type,
      kind: kind, mass: mass, radius: radius,
      minR: MINR_BASE + MINR_K * radius,
      maxR: reach,
      captureR: reach,
      spent: false, hooked: false,
      decay: type === 'decay' ? DECAY_TIME : 0,
      pop: 0,
      phase: this.rand() * TAU,
      art: this.rand(),        // stable per-body surface variation
      idx: this.nodeCount++
    };
    this.nodes.push(n);
    return n;
  };

  /* Generate the chain upward until it is comfortably past the top of view. */
  Game.prototype._ensureAhead = function () {
    var guard = 0;
    while (guard++ < 60) {
      var top = this.nodes[this.nodes.length - 1];
      if (top.y < this.camY - 320) break;

      var n = this.nodeCount;
      var gap = clamp(168 + n * 3.0, 168, 298) + (this.rand() * 34 - 12);
      var dxMax = clamp(140 + n * 5.0, 140, 282);

      // Bias each node to the opposite half so the player is always swinging.
      var side = top.x < W * 0.5 ? 1 : -1;
      if (this.rand() < 0.22) side = -side;
      var dx = side * (0.32 + this.rand() * 0.68) * dxMax;
      var x = clamp(top.x + dx, MARGIN_X, W - MARGIN_X);
      var y = top.y - gap;

      /* While the tutorial is still teaching, the chain ahead stays clean.
         A first-timer must not meet an amber node or a mine before they have
         proved they can release, aim and latch at all. */
      var safe = this.tutorial;

      /* Stars are the minority and they arrive only once the player has hooked
         a few times. They are easier to CATCH (bigger latch ring) and harder
         to SURVIVE (they sling you roughly 1.6x further), which is the whole
         risk/reward axis now that the rift is gone. */
      var deep = clamp((n - STAR_FROM) / DEEP_OVER, 0, 1);
      var starP = lerp(STAR_CHANCE_LO, STAR_CHANCE_HI, deep);
      var kind = (!safe && n >= STAR_FROM && this.rand() < starP) ? 'star' : 'planet';

      /* Burn-out is a planet property. Stacking it on a star would combine the
         two harshest mechanics in the game on one body. */
      var type = 'normal';
      if (!safe && kind === 'planet' && n >= 9 && this.rand() < Math.min(0.34, (n - 8) * 0.030)) type = 'decay';
      /* Mass band slides upward with depth; the band's WIDTH is constant so a
         deep sky is uniformly heavier rather than merely more variable. */
      var mass = null;
      if (kind === 'star') {
        mass = lerp(STAR_M_LO, STAR_M_DEEP, deep) + this.rand() * (STAR_M_HI - STAR_M_LO);
      }
      var node = this._pushNode(x, y, type, kind, mass);

      // A shard tempts you off the safest line.
      if (!safe && this.rand() < 0.45) {
        var mt = 0.35 + this.rand() * 0.3;
        var sx = lerp(top.x, node.x, mt), sy = lerp(top.y, node.y, mt);
        var off = (this.rand() * 2 - 1) * 46;
        this.shards.push({ x: clamp(sx + off, 26, W - 26), y: sy, phase: this.rand() * TAU, got: false });
      }

      /* Mines. These are deliberately parked OFF the direct line between
         two nodes, at a perpendicular offset. An earlier version had them
         drifting across the whole column; a 600-run balance sweep showed
         99% of all deaths were mine hits and the expert-vs-beginner score
         gradient collapsed to 1.5x - the hazard was occupying the only
         viable corridor, so outcomes were random instead of earned. Now a
         clean release is always safe and only a sloppy, wide arc (or a
         greedy detour for a shard) can clip one. */
      if (!safe && n >= 12 && this.rand() < Math.min(0.50, (n - 11) * 0.040)) {
        var mx = (top.x + node.x) * 0.5, my = (top.y + node.y) * 0.5;
        var sdx = node.x - top.x, sdy = node.y - top.y;
        var slen = Math.sqrt(sdx * sdx + sdy * sdy) || 1;
        var pnx = -sdy / slen, pny = sdx / slen;
        var sgn = this.rand() < 0.5 ? -1 : 1;
        var offd = 82 + this.rand() * 46;
        var hx = clamp(mx + pnx * sgn * offd, 44, W - 44);
        var hy = my + pny * sgn * offd;
        // Never let a mine sit inside a node's latch ring - that would make
        // the node itself un-hookable.
        var okA = Math.hypot(hx - top.x, hy - top.y) > top.captureR + 22;
        var okB = Math.hypot(hx - node.x, hy - node.y) > node.captureR + 22;
        if (okA && okB) {
          this.mines.push({ homeX: hx, x: hx, y: hy, amp: 8 + this.rand() * 12, phase: this.rand() * TAU });
        }
      }
    }
  };

  Game.prototype._cull = function () {
    var floor = this.camY + H + 460;
    var i;
    for (i = this.nodes.length - 1; i >= 0; i--) {
      if (this.nodes[i].y > floor && this.nodes[i] !== this.player.node &&
          this.nodes[i] !== this.safeNode && this.nodes.length > 3) {
        this.nodes.splice(i, 1);
      }
    }
    for (i = this.mines.length - 1; i >= 0; i--) if (this.mines[i].y > floor) this.mines.splice(i, 1);
    for (i = this.shards.length - 1; i >= 0; i--) if (this.shards[i].y > floor) this.shards.splice(i, 1);
  };

  /* ---------------- flow ------------------------------------------- */

  /* `seed` is optional. Precedence: explicit argument > ?seed=N > random.
     Whichever wins is RECORDED, so snapshot() can always hand back the seed
     that actually produced the run you are looking at. */
  Game.prototype.start = function (seed) {
    var s;
    if (seed !== undefined && seed !== null) s = seed >>> 0;
    else if (this.fixedSeed !== null) s = this.fixedSeed;
    else s = ((Math.random() * 1e9) | 0) >>> 0;

    this.runSeed = s;
    this.seed = s;
    this.rand = SK.rng(s);

    /* The sim clock drives mine drift, so it must restart with the world.
       Leaving it running meant the same seed produced a different layout on
       every run - the seed was decorative. */
    this.time = 0;
    this.acc = 0;

    this.tutorial = !this.tutorialDone;
    this._resetWorld();
    this.state = 'playing';
    this.newBest = false;
    this.shake = 0;
    this.flash = 0;
    this.overT = 0;
    this.dyingT = 0;
    this.hitstop = 0;
    this.queuedAction = false;
    this.lastActionT = -99;
    SK.Audio.resume();
    SK.Audio.start();
  };

  /* Used by the balance harness (and anyone debugging) to reach normal
     gameplay without playing the tutorial first. */
  Game.prototype.skipTutorial = function (persist) {
    this.tutorialDone = true;
    this.tutorial = false;
    if (persist) SK.Store.set('skyhook.tutorialComplete', '1');
  };

  Game.prototype._finishTutorial = function () {
    this.tutorial = false;
    this.tutorialDone = true;
    this.tutHold = false;
    SK.Store.set('skyhook.tutorialComplete', '1');
    this._label(W / 2, this.player.y - 96, 'YOU HAVE IT - GO', '53,230,255');
  };

  /* An assisted miss during the tutorial is not a death. Rewind to the last
     anchor and let them try again - and keep it out of scores, records and
     any future ad counter. */
  Game.prototype._tutorialReset = function () {
    var n = this.safeNode || this.nodes[0];
    if (!n) return;
    var p = this.player;
    this.tutMisses++;
    p.node = n;
    p.mode = 'orbit';
    var rr = n.minR + 10;
    p.ang = -Math.PI / 2;
    p.r = rr;
    p.targetR = rr;
    p.dir = 1;
    p.flyT = 0;
    p.vx = 0; p.vy = 0;
    p.x = n.x; p.y = n.y - rr;
    n.spent = false;
    n.hooked = true;
    p.speed = this._vTan(p);
    this.pendNode = null;
    this.tutResetT = TUTOR_RESET;
    this.tutHold = false;
    this._label(n.x, n.y - 110, 'TRY AGAIN', '255,176,58');
    SK.Audio.snap();
  };

  Game.prototype.die = function (cause) {
    if (this.state !== 'playing') return;
    /* Failure is not available until the tutorial has taught one success. */
    if (this.tutorial) { this._tutorialReset(); return; }
    this.cause = cause;
    this.state = 'dying';
    this.dyingT = 0;
    this.shake = 26;
    this.flash = 1;
    this.hitstop = 0.09;

    var p = this.player;
    for (var i = 0; i < 46; i++) {
      var a = Math.random() * TAU, s = 60 + Math.random() * 340;
      this.particles.spawn(p.x, p.y, Math.cos(a) * s, Math.sin(a) * s,
        0.5 + Math.random() * 0.7, 2 + Math.random() * 3,
        Math.random() < 0.4 ? COL.danger : COL.player, 1.5, true);
    }
    SK.Audio.death();
    if (global.navigator && navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }

    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      SK.Store.set('skyhook.best', this.best);
    }
  };

  Game.prototype.action = function () {
    if (this.state === 'title') { this.start(); return; }
    if (this.state === 'paused') { this.resume(); return; }
    if (this.state === 'over') { if (this.overT > RETRY_LOCK) this.start(); return; }
    if (this.state !== 'playing') return;

    /* Gameplay debounce. Deliberately measured on the SIM clock: a wall-clock
       debounce would swallow almost every input in the headless balance
       harness, which plays 240 simulated seconds in a fraction of a second. */
    if (this.time - this.lastActionT < ACT_DEBOUNCE) return;
    this.lastActionT = this.time;

    /* Input is queued and consumed by the next fixed tick, so the same taps
       at the same timestamps produce the same run at any refresh rate. */
    this.queuedAction = true;
  };

  Game.prototype.pause = function () {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.queuedAction = false;
    this.acc = 0;
    if (SK.Audio.ctx) { try { SK.Audio.ctx.suspend(); } catch (e) {} }
  };

  Game.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.acc = 0;
    this.queuedAction = false;
    this.lastActionT = this.time;
    SK.Audio.resume();
  };

  function inRect(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /* Explicit hitboxes are dispatched BEFORE the generic tap-anywhere action.
     Today that only protects Retry; it is the mechanism that makes it safe to
     put a revive or purchase button on this screen later. */
  Game.prototype.pointerDown = function (lx, ly) {
    /* Taps in the letterbox around the canvas still count as gameplay, but
       they must never reach a button: clamp button hit-testing to the canvas. */
    var onCanvas = lx >= 0 && lx <= W && ly >= 0 && ly <= H;

    if (onCanvas && inRect(this.muteHit, lx, ly)) { this.toggleMute(); return; }

    if (this.state === 'over' && this.overT > RETRY_LOCK) {
      if (onCanvas && inRect(this.retryRect, lx, ly)) { this.start(); return; }
    }
    this.action();
  };

  Game.prototype.toggleMute = function () {
    this.muted = !this.muted;
    SK.Audio.resume();
    SK.Audio.setMuted(this.muted);
    SK.Store.set('skyhook.muted', this.muted ? '1' : '0');
    if (!this.muted) SK.Audio.ui();
  };

  Game.prototype._release = function (forced) {
    var p = this.player;
    var n = p.node;
    if (!n) return;
    /* Speed is sampled once, at release, and held for the whole flight - so a
       hook landing mid-flight can never change the shot already taken. It is
       the body's own orbital velocity, v = sqrt(mu/r): let go of a star and
       you leave far faster than you ever would off a planet. */
    p.speed = this._vTan(p);
    var sn = Math.sin(p.ang), cs = Math.cos(p.ang);
    p.x = n.x + cs * p.r;
    p.y = n.y + sn * p.r;
    p.vx = -sn * p.dir * p.speed;
    p.vy = cs * p.dir * p.speed;
    p.mode = 'fly';
    p.flyT = 0;
    this.pendNode = null;
    this.lastForced = !!forced;
    this.tutHold = false;
    n.spent = true;
    n.hooked = false;
    p.node = null;

    for (var i = 0; i < 8; i++) {
      var j = (Math.random() * 2 - 1) * 0.5;
      this.particles.spawn(p.x, p.y,
        p.vx * (0.25 + Math.random() * 0.35) + j * 90,
        p.vy * (0.25 + Math.random() * 0.35) + j * 90,
        0.25 + Math.random() * 0.25, 2.2, bodyCol(n), 2.4, true);
    }
    if (forced) SK.Audio.snap();
  };

  Game.prototype._hook = function (node, d) {
    var p = this.player;
    var dx = p.x - node.x, dy = p.y - node.y;
    var cross = dx * p.vy - dy * p.vx;

    p.node = node;

    /* Radius continuity. The old code snapped r to MIN_R on catch while
       leaving the player at closest approach, so a bullseye teleported them
       up to ~46 px outward on the very next step - straight through pickups
       and, occasionally, into a mine. Start at the distance actually achieved
       and ease out to the resting length instead. */
    p.r = d;
    p.targetR = clamp(d, node.minR, node.maxR);

    if (d < 0.5) {
      /* Dead-centre catch: atan2 and the cross product are both numerically
         meaningless here. Derive the radial direction from the incoming
         velocity and keep the orbit direction we already had. */
      var vl = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      var ux = p.vx / vl, uy = p.vy / vl;
      p.ang = p.dir > 0 ? Math.atan2(-ux, uy) : Math.atan2(ux, -uy);
      p.r = Math.max(d, 0.001);
    } else {
      p.ang = Math.atan2(dy, dx);
      p.dir = cross >= 0 ? 1 : -1;
    }

    p.mode = 'orbit';
    p.flyT = 0;
    p.speed = this._vTan(p);
    this.pendNode = null;
    this.safeNode = node;
    node.hooked = true;
    node.decay = node.type === 'decay' ? DECAY_TIME : 0;

    /* Catch quality is a FRACTION of the body you caught. Judging a 128 px
       star by a 52 px absolute threshold would have scored every single star
       hook as sloppy - the player would be punished for the body's size. */
    var tight = d <= node.captureR * TIGHT_F;
    if (tight) this.combo = Math.min(this.combo + 1, 9);
    /* A sloppy catch used to wipe the combo to 1 outright. Losing six steps
       of a ladder for one wide latch reads as a bug, not a rule. */
    else if (d >= node.captureR * LOOSE_F) this.combo = Math.max(1, this.combo - 2);

    /* Heavier body, bigger payout. The extra risk of a star has to be bought
       back somewhere or nobody would ever take one on purpose. */
    var gain = Math.round((tight ? 15 : 8) * this.combo * (1 + (node.mass - 1) * 0.22));
    this.score += gain;
    this.hooks++;

    this._label(node.x, node.y - 34,
      (tight ? 'TIGHT +' : 'HOOK +') + gain + (this.combo > 1 ? '  x' + this.combo : ''),
      tight ? '255,215,94' : '53,230,255');

    if (this.tutorial) {
      this.tutStep++;
      if (this.tutStep >= TUTOR_HOOKS) this._finishTutorial();
    }

    node.pop = 1;
    this.tetherPulse = 1;
    this.shake = Math.min(this.shake + (tight ? 7 : 3.5), 14);

    var col = bodyCol(node);
    var count = tight ? 20 : 12;
    for (var i = 0; i < count; i++) {
      var a = Math.random() * TAU, s = 70 + Math.random() * (tight ? 260 : 150);
      this.particles.spawn(node.x + Math.cos(a) * p.r * 0.4, node.y + Math.sin(a) * p.r * 0.4,
        Math.cos(a) * s, Math.sin(a) * s, 0.3 + Math.random() * 0.45,
        1.8 + Math.random() * 2.2, col, 2.2, true);
    }
    SK.Audio.hook(this.combo - 1, tight);
    if (tight) this.hitstop = 0.035;
    if (global.navigator && navigator.vibrate) { try { navigator.vibrate(tight ? 18 : 9); } catch (e) {} }
  };

  /* ---------------- simulation ------------------------------------- */

  /* Squared distance from point c to segment a->b. Used so a fast tick can
     never step a player straight THROUGH a mine or a shard. */
  function segDist2(ax, ay, bx, by, cx, cy) {
    var vx = bx - ax, vy = by - ay;
    var wx = cx - ax, wy = cy - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? clamp((wx * vx + wy * vy) / len2, 0, 1) : 0;
    var dx = ax + vx * t - cx, dy = ay + vy * t - cy;
    return dx * dx + dy * dy;
  }

  /* Where would releasing RIGHT NOW take us? Uses the launch ray and closest
     approach, with the same candidate rules the flight itself uses: the first
     node whose latch ring the ray enters wins. */
  Game.prototype._predictRelease = function () {
    var out = this.predict;
    out.node = null; out.d = 0; out.t = 0;
    var p = this.player;
    if (p.mode !== 'orbit' || !p.node) return out;

    var sn = Math.sin(p.ang), cs = Math.cos(p.ang);
    var rx = p.node.x + cs * p.r, ry = p.node.y + sn * p.r;
    var ux = -sn * p.dir, uy = cs * p.dir;
    /* The flight timer is gone, so "reach" is no longer a rule of the sim -
       it is purely how far ahead the guide is willing to look. */
    var reach = this._vTan(p) * PREDICT_T;

    var bestT = Infinity;
    for (var i = 0; i < this.nodes.length; i++) {
      var nd = this.nodes[i];
      if (nd.spent || nd === p.node) continue;
      var ax = nd.x - rx, ay = nd.y - ry;
      var t = ax * ux + ay * uy;
      if (t <= 0 || t >= reach) continue;
      var px = ax - ux * t, py = ay - uy * t;
      var d = Math.sqrt(px * px + py * py);
      if (d < nd.captureR && t < bestT) { bestT = t; out.node = nd; out.d = d; out.t = t; }
    }
    return out;
  };

  Game.prototype._step = function (dt) {
    var p = this.player, i;
    var ox = p.x, oy = p.y;   // swept-collision origin for this tick

    if (p.mode === 'orbit') {
      var n = p.node;
      p.speed = this._vTan(p);

      /* tutHold freezes the orbit on the taught tap so a first-run player can
         see the release that works before they are asked to time it. */
      if (!this.tutHold) {
        /* omega = sqrt(mu / r^3). The divisor keeps the same floor guard it
           always had, now the BODY's own resting minimum: settling out of a
           dead-centre catch is a short wind-out, never a singular spin. */
        p.ang += this.angRate(p) * dt;
        if (p.r !== p.targetR) {
          var rdiff = p.targetR - p.r;
          var rmove = SETTLE_RATE * dt;
          p.r += clamp(rdiff, -rmove, rmove);
        }
      }
      p.x = n.x + Math.cos(p.ang) * p.r;
      p.y = n.y + Math.sin(p.ang) * p.r;

      this._predictRelease();
      if (this.tutorial && this.tutStep === 0 && !this.tutHold &&
          this.predict.node && this.predict.d <= TUTOR_AIM) {
        this.tutHold = true;   // "TAP NOW"
      }

      if (n.type === 'decay') {
        n.decay -= dt;
        if (n.decay <= 0) {
          for (i = 0; i < 18; i++) {
            var a2 = Math.random() * TAU, s2 = 80 + Math.random() * 220;
            this.particles.spawn(n.x, n.y, Math.cos(a2) * s2, Math.sin(a2) * s2,
              0.35 + Math.random() * 0.4, 2.4, COL.decay, 2.0, true);
          }
          this.shake = Math.min(this.shake + 8, 16);
          this._release(true);
        }
      }
    } else {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.flyT += dt;

      /* Latching happens at CLOSEST APPROACH, not on first entry into range.
         Entering range would always report d ~= CAPTURE_R, so every hook
         would score as sloppy and combos could never build. Once inside a
         node's ring we commit to it and track the minimum distance; the
         tether snaps the instant the distance starts growing again. */
      if (this.pendNode) {
        var pdx = p.x - this.pendNode.x, pdy = p.y - this.pendNode.y;
        var pd = Math.sqrt(pdx * pdx + pdy * pdy);
        if (pd > this.pendD || pd > this.pendNode.captureR) {
          var node = this.pendNode;
          var snapD = this.pendD;
          p.x = this.pendX; p.y = this.pendY;   // rewind to the closest point
          this.pendNode = null;
          this._hook(node, snapD);
        } else {
          this.pendD = pd; this.pendX = p.x; this.pendY = p.y;
        }
      } else {
        var bestNode = null, bestD = 1e9;
        for (i = 0; i < this.nodes.length; i++) {
          var nd = this.nodes[i];
          if (nd.spent) continue;
          var ddx = p.x - nd.x, ddy = p.y - nd.y;
          var d = Math.sqrt(ddx * ddx + ddy * ddy);
          /* Compared against the TARGET's own ring, so a big star really is
             easier to catch than a small planet. */
          if (d < nd.captureR && d < bestD) { bestD = d; bestNode = nd; }
        }
        if (bestNode) {
          this.pendNode = bestNode;
          this.pendD = bestD;
          this.pendX = p.x;
          this.pendY = p.y;
        }
        /* There is deliberately no `else` here any more. A flight that finds
           nothing is not punished by a timer - it simply keeps going until it
           leaves the screen, which is the only fail condition left. */
      }
    }

    /* ---- the two ways to lose --------------------------------------
       Both are the same sentence: the ball left the screen. Horizontal was
       already here; vertical is new, and it is what replaces the rift.
       The camera only ever climbs, so the bottom edge is a RATCHET: every
       hook you land permanently raises the floor beneath you. Stand still and
       you are safe but score nothing; misjudge a release and you fall out of
       your own progress. */
    if (p.x < -DEATH_PAD || p.x > W + DEATH_PAD) { this.die('edge'); return; }
    if (p.y > this.camY + H + DEATH_PAD) { this.die('fell'); return; }

    /* Mines and shards are tested against the SEGMENT the player swept this
       tick, not just the endpoint - so settling out of a tight catch can
       neither skip a pickup nor tunnel through a hazard. */
    for (i = 0; i < this.mines.length; i++) {
      var m = this.mines[i];
      m.x = m.homeX + Math.sin(this.time * 0.9 + m.phase) * m.amp;
      var mr = MINE_R + PLAYER_R;
      if (segDist2(ox, oy, p.x, p.y, m.x, m.y) < mr * mr) { this.die('mine'); return; }
    }

    /* shards */
    var collected = false;
    for (i = 0; i < this.shards.length; i++) {
      var sh = this.shards[i];
      if (sh.got) continue;
      if (segDist2(ox, oy, p.x, p.y, sh.x, sh.y) < SHARD_PICK * SHARD_PICK) {
        sh.got = true;
        collected = true;
        /* A shard used to buy rift pushback. With no rift, the reward it pays
           is the thing that is actually scarce now: combo, which multiplies
           every hook that follows. */
        this.score += 25 * Math.max(1, Math.floor(this.combo * 0.5));
        this.combo = Math.min(this.combo + 1, 9);
        this.shardPulse = 1;
        this._label(sh.x, sh.y - 26, 'SHARD  x' + this.combo, '255,215,94');
        this.shake = Math.min(this.shake + 3, 12);
        for (var k = 0; k < 14; k++) {
          var a3 = Math.random() * TAU, s3 = 60 + Math.random() * 200;
          this.particles.spawn(sh.x, sh.y, Math.cos(a3) * s3, Math.sin(a3) * s3,
            0.3 + Math.random() * 0.4, 2.2, COL.shard, 2.2, true);
        }
        SK.Audio.shard();
      }
    }
    if (collected) {
      for (i = this.shards.length - 1; i >= 0; i--) if (this.shards[i].got) this.shards.splice(i, 1);
    }
  };

  /* ONE simulation tick. Always exactly STEP seconds - never a subdivision of
     whatever the display happened to deliver. Everything that can change the
     outcome of a run lives in here: the sim clock, mine drift, the camera,
     spawning, culling and hitstop. */
  Game.prototype._tick = function () {
    var dt = STEP;

    if (this.hitstop > 0) {
      this.hitstop -= dt;
      this.particles.update(dt * 0.2);
      return;
    }

    /* Queued input is consumed at the head of a tick, so identical taps at
       identical timestamps replay identically at any refresh rate. */
    if (this.queuedAction) {
      this.queuedAction = false;
      if (this.player.mode === 'orbit') this._release(false);
    }

    this.time += dt;
    if (this.tutResetT > 0) this.tutResetT = Math.max(0, this.tutResetT - dt);

    this._step(dt);
    this.particles.update(dt);
    if (this.state !== 'playing') return;

    var p = this.player;

    /* Node pop was decaying inside the draw call (-0.045 per painted frame),
       which made a purely cosmetic value depend on render scheduling. */
    for (var i = 0; i < this.nodes.length; i++) {
      var nd = this.nodes[i];
      if (nd.pop > 0) nd.pop = Math.max(0, nd.pop - 2.7 * dt);
    }
    for (i = 0; i < this.labels.length; i++) {
      if (this.labels[i].t > 0) this.labels[i].t = Math.max(0, this.labels[i].t - dt);
    }

    /* motion trail */
    p.trailT -= dt;
    if (p.trailT <= 0) {
      p.trailT = 0.018;
      var spread = p.mode === 'fly' ? 18 : 10;
      this.particles.spawn(p.x, p.y,
        (Math.random() * 2 - 1) * spread, (Math.random() * 2 - 1) * spread,
        p.mode === 'fly' ? 0.26 : 0.18, p.mode === 'fly' ? 2.2 : 1.7,
        COL.node, 1.6, true);
    }

    /* camera only ever climbs */
    var target = p.y - H * CAM_OFFSET;
    if (target < this.camY) this.camY = SK.damp(this.camY, target, 0.055, dt);

    this.altitude = Math.max(this.altitude, Math.round((this.startY - p.y) / 10));

    /* Proximity warning, now measured against the bottom of the view. */
    var gapToFall = (this.camY + H) - p.y;
    if (gapToFall < 190 && !this.tutorial) {
      this.warnT -= dt;
      if (this.warnT <= 0) { this.warnT = clamp(gapToFall / 460, 0.14, 0.42); SK.Audio.warn(); }
    } else this.warnT = 0;

    this._ensureAhead();
    this._cull();
  };

  Game.prototype.update = function (dtRaw) {
    var dt = (typeof dtRaw === 'number' && dtRaw > 0) ? dtRaw : 0;

    /* A long gap is a STALL (tab throttled, ad overlay, GC pause), not a slow
       frame. The old code clamped dt to 0.05, which silently ran the whole
       game in slow motion below 20 FPS. Drop the backlog instead: never
       simulate a catch-up the player could not react to, never slow down. */
    var stalled = dt > STALL_MAX;
    if (stalled) dt = STALL_MAX;

    /* Presentation-only timers keep using real time so menus stay smooth. */
    this.shake = Math.max(0, this.shake - this.shake * 6 * dt - 6 * dt);
    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.tetherPulse = Math.max(0, this.tetherPulse - dt * 3.5);
    this.shardPulse = Math.max(0, this.shardPulse - dt * 1.8);

    if (this.state === 'title') {
      this.time += dt;              // cosmetic only outside a run
      this.titleT += dt;
      this.camY -= 20 * dt;
      this.particles.update(dt);
      return;
    }

    if (this.state === 'paused') return;

    if (this.state === 'over') {
      this.time += dt;
      this.overT += dt;
      this.camY -= 8 * dt;
      this.particles.update(dt);
      return;
    }

    if (this.state === 'dying') {
      this.time += dt;
      this.dyingT += dt;
      this.particles.update(dt);
      if (this.dyingT > DEATH_ANIM) {
        this.state = 'over';
        this.overT = 0;
        if (this.newBest) SK.Audio.best();
      }
      return;
    }

    /* playing: true fixed-step accumulator */
    if (stalled) { this.acc = 0; return; }

    this.acc += dt;
    var ticks = 0;
    while (this.acc >= STEP && ticks < MAX_TICKS) {
      this.acc -= STEP;
      ticks++;
      this._tick();
      if (this.state !== 'playing') { this.acc = 0; break; }
    }
    if (ticks >= MAX_TICKS) this.acc = 0;   // never death-spiral on a slow device
  };

  /* ---------------- rendering -------------------------------------- */

  function txt(ctx, s, x, y, size, color, align, weight, glow, glowSize) {
    ctx.font = (weight || 700) + ' ' + size + 'px "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'alphabetic';
    if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = glowSize || 18; }
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.shadowBlur = 0;
  }

  Game.prototype._drawBackdrop = function (ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a0f28');
    g.addColorStop(0.55, '#070917');
    g.addColorStop(1, '#04050e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var ny = ((-this.camY * 0.05) % H + H) % H;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.nebula, 0, ny - H);
    ctx.drawImage(this.nebula, 0, ny);
    ctx.globalAlpha = 1;

    for (var i = 0; i < this.stars.length; i++) {
      var st = this.stars[i];
      var y = ((st.y - this.camY * st.p) % H + H) % H;
      var tw = 0.65 + 0.35 * Math.sin(this.time * 2.2 + st.tw);
      ctx.fillStyle = 'rgba(190,225,255,' + (st.a * tw).toFixed(3) + ')';
      ctx.fillRect(st.x, y, st.s, st.s);
    }

    /* side rails: cheap, strong sense of vertical speed */
    var railG = ctx.createLinearGradient(0, 0, 26, 0);
    railG.addColorStop(0, 'rgba(53,230,255,0.10)');
    railG.addColorStop(1, 'rgba(53,230,255,0)');
    ctx.fillStyle = railG;
    ctx.fillRect(0, 0, 26, H);
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.fillStyle = railG;
    ctx.fillRect(0, 0, 26, H);
    ctx.restore();

    var tick = 110;
    var off = ((-this.camY * 0.5) % tick + tick) % tick;
    ctx.fillStyle = 'rgba(53,230,255,0.20)';
    for (var t = off - tick; t < H; t += tick) {
      ctx.fillRect(0, t, 12, 2);
      ctx.fillRect(W - 12, t, 12, 2);
    }
  };

  /* Star surface: an emissive core plus a corona whose extent scales with the
     body's radius, so mass is readable from across the screen without a label.
     Everything is procedural (gradients + arcs), which is deliberate - it costs
     no download, no atlas and no extra fill on a low-end Android GPU, and it
     tracks the size model for free the moment the mass ranges are retuned. */
  Game.prototype._drawStar = function (ctx, n, R, alive, pulse) {
    var a = alive ? 1 : 0.34;

    /* corona: two soft falloffs, the outer one slowly breathing */
    var cr = R * (2.9 + pulse * 0.30);
    var g = ctx.createRadialGradient(n.x, n.y, R * 0.55, n.x, n.y, cr);
    g.addColorStop(0, 'rgba(255,238,196,' + (0.34 * a).toFixed(3) + ')');
    g.addColorStop(0.42, 'rgba(255,196,96,' + (0.13 * a).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(n.x, n.y, cr, 0, TAU); ctx.fill();

    /* photosphere: hot white centre easing to the limb */
    var pg = ctx.createRadialGradient(n.x - R * 0.18, n.y - R * 0.18, R * 0.1, n.x, n.y, R);
    pg.addColorStop(0, 'rgba(255,255,248,' + a.toFixed(2) + ')');
    pg.addColorStop(0.55, 'rgba(255,232,152,' + (0.96 * a).toFixed(2) + ')');
    pg.addColorStop(1, 'rgba(255,158,52,' + (0.92 * a).toFixed(2) + ')');
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.fill();

    /* granulation: a few darker cells, seeded per body so they never crawl */
    if (alive) {
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.clip();
      ctx.fillStyle = 'rgba(214,120,26,0.30)';
      for (var i = 0; i < 4; i++) {
        var ga = (n.art + i * 0.27) * TAU, gd = R * (0.22 + ((n.art * (i + 3)) % 1) * 0.5);
        ctx.beginPath();
        ctx.arc(n.x + Math.cos(ga) * gd, n.y + Math.sin(ga) * gd, R * 0.20, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    /* flare spikes - the classic "this one is a STAR" read */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,236,180,' + (0.5 * a).toFixed(2) + ')';
    ctx.lineWidth = 1.4;
    for (var k = 0; k < 4; k++) {
      var fa = n.phase * 0.4 + k * (Math.PI / 2) + this.time * 0.12;
      var f0 = R * 1.15, f1 = R * (1.75 + pulse * 0.35);
      ctx.beginPath();
      ctx.moveTo(n.x + Math.cos(fa) * f0, n.y + Math.sin(fa) * f0);
      ctx.lineTo(n.x + Math.cos(fa) * f1, n.y + Math.sin(fa) * f1);
      ctx.stroke();
    }
    ctx.restore();
  };

  /* Planet surface: albedo shading with a terminator (the lit side faces the
     top of the column, so the whole field is lit consistently) and latitude
     banding whose count scales with the body's radius. */
  Game.prototype._drawPlanet = function (ctx, n, R, alive, col) {
    var a = alive ? 1 : 0.34;
    var lx = -0.42, ly = -0.52;   // light direction, normalised-ish

    var pg = ctx.createRadialGradient(n.x + lx * R, n.y + ly * R, R * 0.08, n.x, n.y, R * 1.12);
    pg.addColorStop(0, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (0.85 * a).toFixed(2) + ')');
    pg.addColorStop(0.5, 'rgba(' + Math.round(col[0] * 0.45) + ',' + Math.round(col[1] * 0.55) + ',' + Math.round(col[2] * 0.65) + ',' + (0.72 * a).toFixed(2) + ')');
    pg.addColorStop(1, 'rgba(6,10,26,' + (0.85 * a).toFixed(2) + ')');
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.fill();

    /* banding: 2 bands on a small planet, up to 4 on a large one */
    if (alive) {
      var bands = 2 + Math.min(2, Math.floor((R - 9) / 2.6));
      ctx.save();
      ctx.beginPath(); ctx.arc(n.x, n.y, R, 0, TAU); ctx.clip();
      ctx.strokeStyle = rgba(col, 0.20);
      ctx.lineWidth = Math.max(1, R * 0.13);
      for (var b = 0; b < bands; b++) {
        var by = n.y - R + ((b + 0.6 + n.art * 0.5) / bands) * R * 2;
        ctx.beginPath();
        ctx.moveTo(n.x - R, by);
        ctx.lineTo(n.x + R, by);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* limb light: a bright crescent on the lit edge sells the sphere */
    ctx.save();
    ctx.strokeStyle = rgba(col, (0.9 * a).toFixed(2));
    ctx.lineWidth = 1.8;
    var la = Math.atan2(ly, lx);
    ctx.beginPath();
    ctx.arc(n.x, n.y, R - 0.6, la - 1.15, la + 1.15);
    ctx.stroke();
    ctx.strokeStyle = rgba(col, (0.28 * a).toFixed(2));
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(n.x, n.y, R - 0.6, 0, TAU); ctx.stroke();
    ctx.restore();
  };

  Game.prototype._drawNode = function (ctx, n) {
    var pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4 + n.phase);
    var decayed = n.type === 'decay';
    var isStar = n.kind === 'star';
    var col = bodyCol(n);
    var glow = decayed ? this.glowDecay : (isStar ? this.glowStar : this.glowNode);

    /* n.pop decays in _tick(), not here - drawing must never mutate state. */
    var alive = !n.spent;
    var baseA = alive ? 0.55 : 0.14;
    var R = n.radius * (alive ? 1 : 0.7) + n.pop * 6;

    /* Glow sprite scales with the body: a star's halo is genuinely bigger,
       it is not the same 64 px sprite drawn on everything. */
    SK.drawGlow(ctx, glow, n.x, n.y,
      (n.radius / NODE_R) * (alive ? (0.62 + pulse * 0.14 + n.pop * 0.7) : 0.34), baseA);

    /* Latch-range ring, per body. Only drawn for bodies the player could
       plausibly reach right now - drawing it on every one turned the screen
       into a wall of overlapping circles. */
    if (alive) {
      var pdx = this.player.x - n.x, pdy = this.player.y - n.y;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 330 + n.captureR) {
        var ringA = clamp((330 + n.captureR - pd) / 200, 0, 1) * (0.16 + pulse * 0.05);
        ctx.save();
        ctx.setLineDash([5, 9]);
        ctx.lineDashOffset = -this.time * 14;
        ctx.strokeStyle = rgba(col, ringA.toFixed(3));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.captureR, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (isStar) this._drawStar(ctx, n, R, alive, pulse);
    else this._drawPlanet(ctx, n, R, alive, col);

    /* burn-down ring on the body you are currently riding */
    if (decayed && n.hooked && n.decay > 0) {
      var f = n.decay / DECAY_TIME;
      ctx.beginPath();
      ctx.arc(n.x, n.y, R + 8, -Math.PI / 2, -Math.PI / 2 + TAU * f);
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = f < 0.35
        ? 'rgba(255,90,90,' + (0.6 + 0.4 * Math.sin(this.time * 26)).toFixed(3) + ')'
        : rgba(COL.decay, 0.9);
      ctx.stroke();
    }
  };

  Game.prototype._drawWorld = function (ctx) {
    var i, p = this.player;

    for (i = 0; i < this.shards.length; i++) {
      var sh = this.shards[i];
      var bob = Math.sin(this.time * 3 + sh.phase) * 4;
      var sc = 0.8 + 0.2 * Math.sin(this.time * 5 + sh.phase);
      SK.drawGlow(ctx, this.glowShard, sh.x, sh.y + bob, 0.7 * sc, 0.75);
      ctx.save();
      ctx.translate(sh.x, sh.y + bob);
      ctx.rotate(this.time * 1.6 + sh.phase);
      ctx.beginPath();
      ctx.moveTo(0, -8); ctx.lineTo(6, 0); ctx.lineTo(0, 8); ctx.lineTo(-6, 0);
      ctx.closePath();
      ctx.fillStyle = '#fff3c4';
      ctx.fill();
      ctx.strokeStyle = rgba(COL.shard, 0.9);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.restore();
    }

    for (i = 0; i < this.mines.length; i++) {
      var m = this.mines[i];
      SK.drawGlow(ctx, this.glowMine, m.x, m.y, 0.75, 0.6);
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(this.time * 1.1 + m.phase);
      ctx.strokeStyle = rgba(COL.mine, 0.95);
      ctx.lineWidth = 2.2;
      for (var s = 0; s < 6; s++) {
        var a = (s / 6) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
        ctx.lineTo(Math.cos(a) * (MINE_R + 4), Math.sin(a) * (MINE_R + 4));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 6.5, 0, TAU);
      ctx.fillStyle = '#2a0713';
      ctx.fill();
      ctx.strokeStyle = rgba(COL.mine, 1);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    for (i = 0; i < this.nodes.length; i++) this._drawNode(ctx, this.nodes[i]);

    /* tether */
    if (p.mode === 'orbit' && p.node) {
      var n = p.node;
      var tcol = bodyCol(n);
      ctx.strokeStyle = rgba(tcol, (0.28 + this.tetherPulse * 0.5).toFixed(3));
      ctx.lineWidth = 1.6 + this.tetherPulse * 2.2;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      var dx = p.x - n.x, dy = p.y - n.y;
      for (var k = 0; k < 3; k++) {
        var t = ((this.time * 0.9 + k / 3) % 1);
        ctx.fillStyle = rgba(tcol, (0.55 * (1 - t) + 0.2).toFixed(3));
        ctx.beginPath();
        ctx.arc(n.x + dx * t, n.y + dy * t, 2.1, 0, TAU);
        ctx.fill();
      }

      /* Release guide. In a game that is 100% aiming, hiding the launch vector
         is not difficulty, it is guesswork. The guide now also answers the
         question that actually matters: WOULD THIS RELEASE WORK? It runs the
         same closest-approach maths the flight itself uses and recolours -
         cyan when the shot lands inside a latch ring, gold when it lands
         inside the tight-hook threshold. */
      var gvx = -Math.sin(p.ang) * p.dir, gvy = Math.cos(p.ang) * p.dir;
      var pr = this.predict;
      var gCol = '255,255,255', gA = 0.30, gTip = 0.42;
      if (pr.node) {
        if (pr.d <= TIGHT_D) { gCol = '255,215,94'; gA = 0.85; gTip = 0.95; }
        else { gCol = '53,230,255'; gA = 0.62; gTip = 0.8; }
      }
      var tail = GUIDE_LEN - 14;
      ctx.save();
      ctx.setLineDash([7, 8]);
      ctx.lineDashOffset = -this.time * 90;
      ctx.strokeStyle = 'rgba(' + gCol + ',' + gA.toFixed(2) + ')';
      ctx.lineWidth = pr.node ? 2.2 : 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x + gvx * 15, p.y + gvy * 15);
      ctx.lineTo(p.x + gvx * tail, p.y + gvy * tail);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(' + gCol + ',' + gTip.toFixed(2) + ')';
      ctx.beginPath();
      ctx.moveTo(p.x + gvx * GUIDE_LEN, p.y + gvy * GUIDE_LEN);
      ctx.lineTo(p.x + gvx * tail - gvy * 5.5, p.y + gvy * tail + gvx * 5.5);
      ctx.lineTo(p.x + gvx * tail + gvy * 5.5, p.y + gvy * tail - gvx * 5.5);
      ctx.closePath();
      ctx.fill();

      /* Mark the node this release would actually capture. */
      if (pr.node) {
        var tgt = pr.node;
        ctx.save();
        ctx.strokeStyle = 'rgba(' + gCol + ',' + (0.5 + 0.3 * Math.sin(this.time * 8)).toFixed(2) + ')';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(tgt.x, tgt.y, tgt.radius + 9, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }

    this.particles.draw(ctx);

    /* Outcome labels: what did that hook actually pay? Pooled, so no
       allocation and no string churn during play. */
    for (i = 0; i < this.labels.length; i++) {
      var L = this.labels[i];
      if (L.t <= 0) continue;
      var lt = L.t / LABEL_LIFE;
      var rise = (1 - lt) * 26;
      txt(ctx, L.s, L.x, L.y - rise, 17,
        'rgba(' + L.c + ',' + (lt < 0.3 ? (lt / 0.3) : 1).toFixed(2) + ')',
        'center', 800, 'rgba(' + L.c + ',0.7)', 12);
    }

    /* Tutorial coaching, anchored to the player so it cannot be missed. */
    if (this.tutorial && this.state === 'playing') {
      if (this.tutHold) {
        var bp = 0.7 + 0.3 * Math.sin(this.time * 9);
        txt(ctx, 'TAP NOW', p.x, p.y - 58, 26, 'rgba(255,215,94,' + bp.toFixed(2) + ')',
          'center', 800, 'rgba(255,215,94,0.9)', 20);
      } else if (p.mode === 'orbit' && this.tutStep > 0 &&
                 this.predict.node && this.predict.d <= TIGHT_D) {
        txt(ctx, 'RELEASE', p.x, p.y - 52, 20, 'rgba(255,215,94,0.9)',
          'center', 800, 'rgba(255,215,94,0.7)', 14);
      }
    }

    /* player */
    if (this.state === 'playing') {
      /* The ring used to be a charge meter counting down FLIGHT_MAX. There is
         no flight timer any more, so it reports the thing that CAN kill you:
         how close the ball is to dropping out of the bottom of the view. */
      var fallGap = (this.camY + H) - p.y;
      SK.drawGlow(ctx, this.glowPlayer, p.x, p.y, 0.55 + 0.10 * Math.sin(this.time * 7), 0.7);
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = (fallGap < 150)
        ? 'rgba(255,90,110,' + (0.5 + 0.5 * Math.sin(this.time * 22)).toFixed(3) + ')'
        : rgba(COL.node, 0.9);
      ctx.stroke();
    }
  };

  Game.prototype._drawMute = function (ctx) {
    var m = this.muteRect, cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = 'rgba(150,200,235,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 17, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = 'rgba(200,235,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 3); ctx.lineTo(cx - 4, cy - 3); ctx.lineTo(cx + 1, cy - 8);
    ctx.lineTo(cx + 1, cy + 8); ctx.lineTo(cx - 4, cy + 3); ctx.lineTo(cx - 8, cy + 3);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(200,235,255,0.9)';
    ctx.lineWidth = 1.8;
    if (this.muted) {
      ctx.beginPath();
      ctx.moveTo(cx + 4, cy - 5); ctx.lineTo(cx + 11, cy + 5);
      ctx.moveTo(cx + 11, cy - 5); ctx.lineTo(cx + 4, cy + 5);
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(cx + 3, cy, 5, -0.8, 0.8); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + 3, cy, 9, -0.8, 0.8); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  Game.prototype._drawHud = function (ctx) {
    /* Scrim: guarantees the score stays legible when a bright node scrolls
       up behind it. */
    var sg = ctx.createLinearGradient(0, 0, 0, 132);
    sg.addColorStop(0, 'rgba(4,6,18,0.86)');
    sg.addColorStop(0.6, 'rgba(4,6,18,0.42)');
    sg.addColorStop(1, 'rgba(4,6,18,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, 132);

    txt(ctx, String(this.score), W / 2, 74, 54, '#ffffff', 'center', 800, 'rgba(53,230,255,0.85)', 22);

    if (this.combo > 1) {
      var c = clamp((this.combo - 1) / 8, 0, 1);
      var col = 'rgb(' + Math.round(lerp(53, 255, c)) + ',' + Math.round(lerp(230, 200, c)) + ',' + Math.round(lerp(255, 80, c)) + ')';
      var s = 1 + 0.12 * Math.sin(this.time * 9);
      ctx.save();
      ctx.translate(W / 2, 104);
      ctx.scale(s, s);
      txt(ctx, 'x' + this.combo, 0, 0, 22, col, 'center', 800, col, 14);
      ctx.restore();
    }

    txt(ctx, 'BEST ' + this.best, 20, 38, 15, 'rgba(160,200,230,0.7)', 'left', 600);
    txt(ctx, this.altitude + ' m', 20, 60, 15, 'rgba(160,200,230,0.45)', 'left', 600);
    this._drawMute(ctx);
  };

  Game.prototype._drawTitle = function (ctx) {
    var cx = W / 2, cy = 366, r = 88;
    /* The demo used to orbit at a fixed 1.5 rad/s - a 4.19 s lap, against a
       real opening lap of well under 1.5 s. It was advertising a different,
       much calmer game than the one behind the tap. Drive it with the SAME
       gravity relation the player is about to be handed: a 1.0-mass body. */
    var a = this.titleT * Math.sqrt(G / (r * r * r));

    ctx.strokeStyle = 'rgba(53,230,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();

    SK.drawGlow(ctx, this.glowNode, cx, cy, 0.8, 0.6);
    ctx.beginPath(); ctx.arc(cx, cy, NODE_R, 0, TAU);
    ctx.fillStyle = 'rgba(53,230,255,0.22)'; ctx.fill();
    ctx.strokeStyle = 'rgba(53,230,255,0.95)'; ctx.lineWidth = 2.4; ctx.stroke();

    var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    ctx.strokeStyle = 'rgba(53,230,255,0.35)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
    SK.drawGlow(ctx, this.glowPlayer, px, py, 0.9, 0.85);
    ctx.beginPath(); ctx.arc(px, py, PLAYER_R, 0, TAU);
    ctx.fillStyle = '#fff'; ctx.fill();

    txt(ctx, 'SKYHOOK', W / 2, 196, 62, '#ffffff', 'center', 800, 'rgba(53,230,255,0.9)', 30);
    txt(ctx, 'O R B I T   -   R E L E A S E   -   C L I M B', W / 2, 230, 13, 'rgba(150,210,240,0.75)', 'center', 600);

    /* The old CTA said "TAP / SPACE - to let go of the tether", but the first
       tap does not release anything: it starts the run. Say what the button
       actually does, then say what the NEXT one does. */
    var blink = 0.65 + 0.35 * Math.sin(this.titleT * 4);
    txt(ctx, 'TAP TO START', W / 2, 560, 26, 'rgba(255,255,255,' + blink.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.6)', 16);
    txt(ctx, 'Tap again to release. Hooks connect automatically.', W / 2, 588, 13, 'rgba(150,190,220,0.7)', 'center', 500);

    txt(ctx, 'BEST', W / 2, 660, 13, 'rgba(150,190,220,0.55)', 'center', 700);
    txt(ctx, String(this.best), W / 2, 702, 38, 'rgba(255,215,94,0.95)', 'center', 800, 'rgba(255,215,94,0.5)', 18);

    txt(ctx, 'stars pull harder and throw you further than planets', W / 2, 792, 12, 'rgba(140,175,205,0.5)', 'center', 500);
    txt(ctx, 'stay on screen and the climb never ends', W / 2, 812, 12, 'rgba(140,175,205,0.5)', 'center', 500);

    this._drawMute(ctx);
  };

  Game.prototype._drawOver = function (ctx) {
    var t = clamp(this.overT / 0.35, 0, 1);
    ctx.fillStyle = 'rgba(4,5,14,' + (0.74 * t).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);

    var slide = (1 - t) * 26;
    txt(ctx, 'SIGNAL LOST', W / 2, 268 - slide, 44, 'rgba(255,255,255,' + t.toFixed(2) + ')', 'center', 800, 'rgba(255,46,99,0.8)', 26);
    txt(ctx, CAUSE[this.cause] || '', W / 2, 300 - slide, 14, 'rgba(255,140,165,' + (0.8 * t).toFixed(2) + ')', 'center', 600);

    /* One actionable correction, not a restatement of the consequence. If the
       run ended adrift right after an amber node dumped us, name that. */
    var fixKey = (this.cause === 'fell' && this.lastForced) ? 'decay' : this.cause;
    txt(ctx, FIX[fixKey] || '', W / 2, 328 - slide, 14,
      'rgba(150,210,240,' + (0.85 * t).toFixed(2) + ')', 'center', 500);

    txt(ctx, 'SCORE', W / 2, 396, 13, 'rgba(150,190,220,' + (0.6 * t).toFixed(2) + ')', 'center', 700);
    txt(ctx, String(this.score), W / 2, 456, 62, 'rgba(255,255,255,' + t.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.8)', 24);
    txt(ctx, this.hooks + ' hooks   -   ' + this.altitude + ' m', W / 2, 488, 14, 'rgba(150,190,220,' + (0.6 * t).toFixed(2) + ')', 'center', 600);

    if (this.newBest) {
      var pop = 1 + 0.08 * Math.sin(this.overT * 7);
      ctx.save();
      ctx.translate(W / 2, 548);
      ctx.scale(pop, pop);
      txt(ctx, 'NEW BEST!', 0, 0, 28, 'rgba(255,215,94,' + t.toFixed(2) + ')', 'center', 800, 'rgba(255,215,94,0.8)', 22);
      ctx.restore();
    } else {
      txt(ctx, 'BEST  ' + this.best, W / 2, 548, 20, 'rgba(255,215,94,' + (0.85 * t).toFixed(2) + ')', 'center', 700);
    }

    if (this.overT > RETRY_LOCK) {
      /* A real, hit-tested button - not just a word to tap near. Sized so it
         clears 48 CSS px on the smallest sane phone, and pulsing between 0.65
         and 1.0 rather than blinking all the way to invisible. */
      var rr = this.retryRect;
      var pulse = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin((this.overT - RETRY_LOCK) * 4.5));
      ctx.save();
      ctx.fillStyle = 'rgba(53,230,255,' + (0.10 * t).toFixed(2) + ')';
      ctx.strokeStyle = 'rgba(53,230,255,' + (0.55 * pulse).toFixed(2) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(rr.x, rr.y, rr.w, rr.h, 12);
      else ctx.rect(rr.x, rr.y, rr.w, rr.h);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      txt(ctx, 'TAP TO RETRY', W / 2, rr.y + 41, 24,
        'rgba(255,255,255,' + pulse.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.6)', 16);
    }
  };

  Game.prototype.render = function (ctx) {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    this._drawBackdrop(ctx);

    var sx = 0, sy = 0;
    if (this.shake > 0.05) {
      sx = (Math.random() * 2 - 1) * this.shake;
      sy = (Math.random() * 2 - 1) * this.shake;
    }

    if (this.state !== 'title') {
      ctx.save();
      ctx.translate(sx, sy - this.camY);
      this._drawWorld(ctx);
      ctx.restore();
    }

    /* Bottom-edge vignette. The rift is gone; the danger it used to draw is
       now the literal bottom of the screen, so the warning is drawn there. */
    if (this.state === 'playing' || this.state === 'paused') {
      var gap = (this.camY + H) - this.player.y;
      if (gap < 240 || this.shardPulse > 0) {
        var a = clamp(1 - gap / 240, 0, 1) * (0.35 + 0.25 * Math.sin(this.time * 10));
        var vg = ctx.createLinearGradient(0, H, 0, H * 0.42);
        vg.addColorStop(0, 'rgba(255,46,99,' + (a * 0.75).toFixed(3) + ')');
        vg.addColorStop(1, 'rgba(255,46,99,0)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);
      }
      if (this.shardPulse > 0) {
        var sg2 = ctx.createLinearGradient(0, H, 0, H * 0.55);
        sg2.addColorStop(0, 'rgba(255,215,94,' + (this.shardPulse * 0.22).toFixed(3) + ')');
        sg2.addColorStop(1, 'rgba(255,215,94,0)');
        ctx.fillStyle = sg2;
        ctx.fillRect(0, 0, W, H);
      }
    }

    if (this.flash > 0.001) {
      ctx.fillStyle = 'rgba(255,60,100,' + (this.flash * 0.45).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    /* soft edge vignette - frames the column */
    var eg = ctx.createRadialGradient(W / 2, H / 2, H * 0.30, W / 2, H / 2, H * 0.72);
    eg.addColorStop(0, 'rgba(0,0,0,0)');
    eg.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = eg;
    ctx.fillRect(0, 0, W, H);

    if (this.state === 'title') this._drawTitle(ctx);
    else if (this.state === 'over') { this._drawOver(ctx); this._drawMute(ctx); }
    else this._drawHud(ctx);

    /* Coming back from a background/ad interruption never resumes an orbit
       under the player's thumb - they ask for it. */
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(4,5,14,0.72)';
      ctx.fillRect(0, 0, W, H);
      txt(ctx, 'PAUSED', W / 2, 400, 40, '#ffffff', 'center', 800, 'rgba(53,230,255,0.7)', 22);
      txt(ctx, 'TAP TO RESUME', W / 2, 452, 20, 'rgba(255,255,255,0.85)', 'center', 700);
    }

    ctx.restore();
  };

  /* ---------------- automation surface ------------------------------ */
  /* Read-only snapshot, used by test/smoke.mjs to drive a bot through the
     real input path so the automated test actually proves the loop works. */
  Game.prototype.snapshot = function () {
    var p = this.player;
    var next = null, bestD = 1e9;
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      if (n.spent || n === p.node) continue;
      var dx = p.x - n.x, dy = p.y - n.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) { bestD = d; next = n; }
    }
    return {
      state: this.state,
      seed: this.runSeed,          // the seed that ACTUALLY produced this run
      simTime: this.time,
      score: this.score,
      best: this.best,
      hooks: this.hooks,
      combo: this.combo,
      altitude: this.altitude,
      mode: p.mode,
      px: p.x, py: p.y,
      ang: p.ang, r: p.r, targetR: p.targetR, dir: p.dir,
      speed: this._vTan(p),
      tutorial: this.tutorial,
      tutStep: this.tutStep,
      tutHold: this.tutHold,
      tutMisses: this.tutMisses,
      anchor: p.node ? {
        x: p.node.x, y: p.node.y, type: p.node.type,
        kind: p.node.kind, mass: p.node.mass, radius: p.node.radius,
        captureR: p.node.captureR
      } : null,
      next: next ? { x: next.x, y: next.y, d: bestD, kind: next.kind } : null,
      predict: this.predict.node ? { d: this.predict.d, t: this.predict.t } : null,
      gScale: this._gScale(),
      angRate: p.node ? this.angRate(p) : 0,
      fallGap: (this.camY + H) - p.y,
      cause: this.cause,
      persistent: SK.Store.persistent
    };
  };

  Game.W = W;
  Game.H = H;
  SK.Game = Game;

}(window));
