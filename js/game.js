/* SKYHOOK - core game.
   One input. You orbit a celestial body on a tether. Tap to let go; you fly in
   a straight line and automatically latch onto the next body you pass near.

   Bodies have MASS. A star pulls harder than a planet, so it spins you faster
   and throws you further; a planet is gentle and forgiving but pays less.
   The run is endless while the rocket stays on screen: there is no rift and no
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

  /* Rocket presentation. RENDER-ONLY - nothing in the simulation, the scoring
     or the collision path reads either of these. PLAYER_R below is unchanged
     and is still the whole of the player's collision geometry; the hull is
     merely DRAWN larger than it (see js/rocket.js, HULL_F). */
  var BURN_FADE    = 0.42;  // seconds for a tap's thruster flare to die down
  var AIM_HALF     = 0.035; // heading ease half-life, seconds
  var THRUST_REF   = 900;   // speed that reads as "engine wide open", px/s

  var SETTLE_RATE  = 240;   // px/s the tether eases out to its resting length
  var PREDICT_T    = 1.15;  // seconds of flight the release guide looks ahead
  var PLAYER_R     = 8;
  var METEOR_R     = 11;   // collision radius of a meteoroid (unchanged)
  var SHARD_PICK   = 22;
  var MARGIN_X     = 96;    // node placement bounds
  var DEATH_PAD    = 64;    // how far off-column before you are gone
  var DECAY_TIME   = 1.55;  // amber nodes burn out this fast
  var CAM_OFFSET   = 0.62;  // player sits this far down the screen

  /* ---- simulation --------------------------------------------------- */
  var STEP         = 1 / 120;  // TRUE fixed step. Never subdivided.
  var MAX_TICKS    = 12;       // ...per rendered frame, then drop the backlog
  var STALL_MAX    = 0.25;     // a longer gap is a stall, not slow rendering
  /* Only job: swallow a SYNTHESISED duplicate event (the mousedown the browser
     fires after a touchstart, a doubled pointerdown). Those arrive within a
     couple of milliseconds. 120 ms was wide enough to delete deliberate human
     taps instead - silently, with zero feedback, which reads as "the game
     ignored me" rather than as lag. 40 ms kills every ghost and is shorter
     than any human double tap. Measured on the SIM clock, not the wall clock:
     a wall-clock debounce would swallow almost every input in the headless
     balance harness, which plays 240 simulated seconds in a fraction of a
     second. */
  var ACT_DEBOUNCE = 0.04;     // seconds; measured on the SIM clock, not wall
  var GUIDE_LEN    = 220;      // release guide length (was 132)
  /* How long the target marker spends SNAPPING IN after a lock is acquired.
     Short on purpose: this is a confirmation, not an animation. Past it the
     marker sits perfectly still, because "locked" should look settled. */
  var LOCK_SNAP    = 0.12;     // seconds, on the SIM clock
  var LABEL_LIFE   = 0.65;
  var DEATH_ANIM   = 0.40;     // was 0.7
  var RETRY_LOCK   = 0.20;     // was 0.5

  /* Tutorial: three scripted hooks, no hazards, 1.0-mass planets. Offsets are
     relative to the starting node so they survive any change to H. */
  var TUTOR_NODES  = [ { x: 144, dy: -156 }, { x: 300, dy: -312 }, { x: 180, dy: -468 } ];
  var TUTOR_HOOKS  = TUTOR_NODES.length;
  var TUTOR_AIM    = 52;    // prompt "TAP NOW" once the guide is this close
  var TUTOR_RESET  = 0.25;  // an assisted miss rewinds this fast

  /* Only the entries something actually reads. `star` and `meteor` used to
     live here and had no call sites left once js/celestial.js took over body
     and hazard art - a dead colour table is a trap, because the next person
     to want a meteoroid colour finds one here and edits a constant that
     paints nothing. METEOR.danger in celestial.js is the live one. */
  var COL = {
    node:   [53, 230, 255],    // planet
    decay:  [255, 176, 58],
    player: [255, 255, 255],
    shard:  [255, 215, 94],
    danger: [255, 46, 99]
  };

  /* The one place that answers "what colour are this body's GAMEPLAY signals?"
     - its latch ring, its tether and its hook burst. That is no longer the
     same question as "what colour is this body painted", which js/celestial.js
     now owns: a body can be an iron-grey rock or a sulfur-yellow cloud world
     and still show the cyan latch ring that has meant "safe anchor" since the
     first build. Stars are the deliberate exception - their spectral colour is
     set by mass, and mass is exactly what decides how far they sling you, so
     letting it through into the signals tells the player something true. */
  function bodyCol(n) {
    return SK.Celestial.signalCol(n);
  }

  /* What a body's BURSTS are made of - the launch ejecta on release and the
     spray when the tether bites. This is the art accent, not the signal
     colour: a lava planet throws orange sparks and a blue giant throws
     blue-white ones, which is what js/celestial.js has documented since the
     art pass landed and what this call finally makes true. Until now
     accentCol was exported with zero call sites while the comment beside it
     described behaviour the game did not have.

     Splitting it from bodyCol is the whole point. The burst is a few hundred
     milliseconds of debris and is free to say "what this world is made of".
     The latch ring and the tether are PERSISTENT and must keep saying "safe
     anchor" (cyan) or "this one burns out" (amber) - those stay on bodyCol,
     so no formation class can ever repaint a gameplay signal. */
  function burstCol(n) {
    return SK.Celestial.accentCol(n);
  }

  /* The rift and the flight timer are gone, so 'rift' and 'drift' would now be
     lying to the player. There are exactly two ways to lose, and both of them
     are "the rocket left the screen". */
  var CAUSE = {
    fell: 'YOU FELL OUT OF THE SKY',
    meteor: 'A METEOROID TOOK YOU OUT',
    edge: 'YOU LEFT THE COLUMN'
  };

  /* A postmortem that only names the consequence teaches nothing. Every
     death ships the one correction that would have prevented it. */
  var FIX = {
    fell:  'Release on the way UP - a downward launch has nothing to catch',
    meteor: 'Meteoroids drift OFF the direct line - a clean release clears them',
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

    /* pre-rendered glows (cheap substitute for ctx.shadowBlur).
       Body halos used to be three fixed sprites right here; there are now
       fourteen formation classes and six spectral classes, each throwing light
       of its own colour, so js/celestial.js owns those and builds them on
       first sight into its bounded cache. The player and the shard are not
       art classes, so they stay. */
    this.glowPlayer = SK.makeGlow(52, COL.player.join(','), 0.9);
    this.glowShard  = SK.makeGlow(34, COL.shard.join(','), 0.9);
    /* Scratch vector for the rocket's nozzle position. Reused so the trail
       emitter allocates nothing during play, matching the particle pool. */
    this._nz = { x: 0, y: 0 };
    /* ---- title-screen cast -------------------------------------------
       The title used to draw a flat cyan ring with a white dot on it: the
       art of a build that shipped before formation classes, spectral stars
       and meteoroids existed, advertising a game that is no longer the one
       behind the tap.
       These are NOT simulated nodes - they are never pushed into this.nodes,
       never stepped and never collided. They are plain data shaped like a
       body so js/celestial.js can paint them with the SAME routines the real
       world uses, which is what keeps the first screen honest: when the art
       changes, the title changes with it for free.
       Fixed `art` values (not this.rand()) so the title is identical on every
       launch and cannot consume from the seeded chain. */
    /* art = 0.05 at mass 1.0 resolves to the RINGED formation class - chosen
       because it is the most obviously procedural body in the roster, so the
       first screen advertises the art system rather than a plain sphere. The
       value is a class SELECTOR, not a magic number: js/celestial.js maps
       (mass, art) -> class, and test/rocket_shots.mjs style seed-search is how
       any other class would be requested. */
    this.titleHero = {                 // the body the demo rocket orbits
      x: 0, y: 0, art: 0.05, mass: 1.0, kind: 'planet', type: 'normal',
      idx: 0, phase: 0.7, spent: false, hooked: true, pop: 0, decay: 0,
      radius: bodyRadius(1.0)
    };
    this.titleCast = [                 // the legend row: what is out there
      /* art = 0.40 at mass 0.92 -> the OCEAN class: the icon under the word
         "PLANET" should look like the thing the word means. */
      { x: 0, y: 0, art: 0.40, mass: 0.92, kind: 'planet', type: 'normal',
        idx: 1, phase: 1.9, spent: false, hooked: false, pop: 0, decay: 0,
        radius: bodyRadius(0.92) },
      { x: 0, y: 0, art: 0.18, mass: 3.10, kind: 'star', type: 'normal',
        idx: 2, phase: 0.2, spent: false, hooked: false, pop: 0, decay: 0,
        radius: bodyRadius(3.10) }
    ];
    this.titleRock = { x: 0, y: 0, homeX: 0, amp: 16, phase: 2.1, art: 0.47 };

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

    /* ---- customise ----------------------------------------------------
       Unlike the leaderboard buttons below, this one does NOT depend on a
       backend: painting your ship is a local, offline feature, so the button
       is on the title screen of every build. It sits directly under the TAP
       TO START copy rather than in the crowded bottom band, because the one
       thing it has to be is FOUND - the feature existed for a day in a build
       where the only way to reach it was to know it was there, which is the
       same as it not existing. Sized to the LEADERBOARD button below rather
       than to a number of its own - 232x44 logical is 188x36 CSS px on a
       390-wide phone. That is under the 44 CSS px tap-target guidance, and it
       is the size every panel button in this game has always been; making
       this one bigger than its neighbour would buy 8 px and cost the row its
       alignment. If the guidance is to be met it has to be met by all three,
       which is its own change. */
    this.shipRect = { x: W / 2 - 116, y: 572, w: 232, h: 44 };

    /* ---- online (accounts + global leaderboard) -----------------------
       The game does not know what Supabase is and never will. It owns two
       things: a flag saying whether an account layer exists at all, and two
       hit rects that ask for it. js/ui_online.js sets `online` and installs
       `onUi`; with no js/config.js filled in, `ready` stays false, the two
       buttons are never drawn, nothing is hit-testable, and every screen is
       pixel-identical to the build that shipped before this feature.
       That is the contract: playing NEVER requires an account, and a dead
       backend costs nobody a run. */
    this.online = {
      ready: false,       // is there a configured backend at all?
      signedIn: false,
      username: '',
      rank: 0,            // global rank of the run just finished, 0 = unknown
      status: ''          // one short line for the game-over screen
    };
    this.onUi = null;     // function (event, payload, game) - installed by the UI layer
    this.boardRect     = { x: W / 2 - 116, y: 794, w: 232, h: 44 }; // title screen
    this.boardRectOver = { x: W / 2 - 110, y: 720, w: 220, h: 46 }; // game over

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

    /* TARGET LOCK. `predict.node` already knew which body a release would
       catch, but nothing on screen said so at a single unambiguous INSTANT -
       the capture rings faded in over a 200 px distance gradient and the
       target marker pulsed on a global sine, so "locked, shoot now" looked
       like "getting warmer". These two fields make the lock a discrete EVENT
       on the sim clock that the renderer can SNAP on: lockNode is the body,
       lockT is seconds since it was acquired (0 on the exact acquisition
       tick). Render-only - no physics, scoring or collision path reads them,
       and they are absent from snapshot() - but advanced on the FIXED step so
       the snap-in takes the same wall time on every device. */
    this.lockNode = null;
    this.lockT = 0;

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
    this.meteors = [];
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
      trailT: 0,
      /* --- render-only, never read by the simulation ---------------------
         `aim` is the drawn heading of the rocket, eased towards the true
         velocity direction on the FIXED step so a hook cannot snap the hull
         through 180 degrees in one frame. `burn` is the thruster impulse a
         tap-release lights, decaying on the sim clock.
         Both are advanced in _step() rather than in the draw call: draw runs
         a variable number of times per tick, so animating there would make
         the ship's look depend on frame scheduling - the exact bug node.pop
         already had. Neither value is read by any physics or scoring path,
         and neither appears in snapshot(), so the harnesses are untouched. */
      aim: -Math.PI / 2,
      burn: 0
    };
    this.player.speed = this._vTan(this.player);
    this.player.aim = SK.Rocket.heading(this.player);
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
         A first-timer must not meet an amber node or a meteor before they have
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

      /* Meteoroids. These are deliberately parked OFF the direct line between
         two nodes, at a perpendicular offset. An earlier version had them
         drifting across the whole column; a 600-run balance sweep showed
         99% of all deaths were hazard hits and the expert-vs-beginner score
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
        // Never let a meteoroid sit inside a node's latch ring - that would make
        // the node itself un-hookable.
        var okA = Math.hypot(hx - top.x, hy - top.y) > top.captureR + 22;
        var okB = Math.hypot(hx - node.x, hy - node.y) > node.captureR + 22;
        if (okA && okB) {
          this.meteors.push({ homeX: hx, x: hx, y: hy, amp: 8 + this.rand() * 12, phase: this.rand() * TAU });
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
    for (i = this.meteors.length - 1; i >= 0; i--) if (this.meteors[i].y > floor) this.meteors.splice(i, 1);
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

    /* The sim clock drives meteoroid drift, so it must restart with the world.
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
    this.lockNode = null;
    this.lockT = 0;
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

    /* The local best above is the score that always counts. This is the
       OPTIONAL second copy: handed to the UI layer, which may submit it, may
       park it for later, or - with no backend configured - may not exist at
       all. Duration comes off the SIM clock, not the wall clock, so a run is
       measured in the same units the server validates it in.
       Emitted last, so nothing an outside listener does can interfere with
       the death sequence itself. */
    this._ui('runEnded', {
      score: this.score,
      hooks: this.hooks,
      altitude: this.altitude,
      durationMs: Math.round(this.time * 1000)
    });
  };

  /* The one door out of the game loop. Wrapped so a throwing listener can
     never take the game down with it: a leaderboard that errors is a
     leaderboard that errors, not a lost run. */
  Game.prototype._ui = function (event, payload) {
    if (typeof this.onUi !== 'function') return;
    try { this.onUi(event, payload, this); } catch (e) { /* never fatal */ }
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

    /* Customise. Title screen only - during a run the screen belongs to the
       run, and on the results screen RETRY must not have a neighbour. Gated on
       `onUi` rather than on `online.ready`: the customiser is offline-capable,
       so the only thing it needs is a UI layer listening. Without one the
       button is not drawn either, so this branch cannot swallow a tap. */
    if (onCanvas && this.state === 'title' && typeof this.onUi === 'function' &&
        inRect(this.shipRect, lx, ly)) {
      this._ui('openShip', null);
      return;
    }

    /* The leaderboard buttons exist only when a backend does. Hit-tested
       before the generic tap-anywhere action, so opening the board can never
       double as "start a run" - and, when online.ready is false, these two
       branches are dead code that cannot swallow a tap. */
    if (this.online.ready && onCanvas) {
      if (this.state === 'title' && inRect(this.boardRect, lx, ly)) {
        this._ui('openBoard', null);
        return;
      }
      if (this.state === 'over' && this.overT > RETRY_LOCK && inRect(this.boardRectOver, lx, ly)) {
        this._ui('openBoard', null);
        return;
      }
    }

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
    /* The tap lit the engine. Render-only: this is the one place the player's
       input becomes visible ON the ship instead of only in the trajectory. */
    p.burn = 1;
    /* ...and the hull COMMITS, on this exact frame. Render-only, no physics
       reads it. `aim` is normally eased onto the true heading with a 35 ms
       half-life, which while orbiting leaves it a steady ~14 deg behind the
       launch vector (omega * tau, measured in test/latency.mjs). Let that ease
       run through a release and the ship keeps swinging into the shot for
       ~92 ms after the click: the physics was instant, the thing the player
       actually looks at was not. Snapping here - next to the burn flare and
       the exhaust burst, so it reads as commitment rather than as a glitch -
       is the single largest cut in PERCEIVED latency in this change. */
    p.aim = SK.Rocket.heading(p);
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
        0.25 + Math.random() * 0.25, 2.2, burstCol(n), 2.4, true);
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
       and, occasionally, into a meteoroid. Start at the distance actually achieved
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
    /* Render-only: a short retro burn as the tether bites. It is smaller than
       a release burn on purpose - catching is not a launch, and the two have
       to stay distinguishable at a glance. */
    p.burn = Math.max(p.burn, tight ? 0.55 : 0.35);
    this.shake = Math.min(this.shake + (tight ? 7 : 3.5), 14);

    var col = burstCol(node);
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
     never step a player straight THROUGH a meteoroid or a shard. */
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
       Both are the same sentence: the rocket left the screen. Horizontal was
       already here; vertical is new, and it is what replaces the rift.
       The camera only ever climbs, so the bottom edge is a RATCHET: every
       hook you land permanently raises the floor beneath you. Stand still and
       you are safe but score nothing; misjudge a release and you fall out of
       your own progress. */
    if (p.x < -DEATH_PAD || p.x > W + DEATH_PAD) { this.die('edge'); return; }
    if (p.y > this.camY + H + DEATH_PAD) { this.die('fell'); return; }

    /* Meteoroids and shards are tested against the SEGMENT the player swept this
       tick, not just the endpoint - so settling out of a tight catch can
       neither skip a pickup nor tunnel through a hazard. */
    for (i = 0; i < this.meteors.length; i++) {
      var m = this.meteors[i];
      m.x = m.homeX + Math.sin(this.time * 0.9 + m.phase) * m.amp;
      var mr = METEOR_R + PLAYER_R;
      if (segDist2(ox, oy, p.x, p.y, m.x, m.y) < mr * mr) { this.die('meteor'); return; }
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
     outcome of a run lives in here: the sim clock, meteoroid drift, the camera,
     spawning, culling and hitstop. */
  Game.prototype._tick = function () {
    var dt = STEP;

    /* Queued input is consumed at the head of a tick, so identical taps at
       identical timestamps replay identically at any refresh rate.

       It is read BEFORE the hitstop freeze below, and that ordering is the
       whole point. A tight catch freezes the sim for 35 ms of juice - five
       ticks, 41.7 ms - and a tight catch is exactly the moment a good player
       taps again. With the freeze checked first, that tap sat in the queue for
       the entire freeze and the game read as laggy; worse, the frozen sim also
       froze p.ang, so the player saw an unchanged screen, tapped again, and
       ACT_DEBOUNCE deleted the retry. Measured at +41.7 ms worst case and 205
       deleted retries per 480 s of play (test/latency.mjs).

       A release therefore PUNCHES THROUGH a freeze: it fires on this tick and
       cancels whatever is left of it, so the shot starts moving immediately
       instead of after the flourish. Determinism is untouched - consumption is
       still a function of the tick index alone, never of wall time or of how
       many frames the display delivered. */
    if (this.queuedAction) {
      this.queuedAction = false;
      if (this.player.mode === 'orbit') {
        this._release(false);
        this.hitstop = 0;
      }
    }

    if (this.hitstop > 0) {
      this.hitstop -= dt;
      this.particles.update(dt * 0.2);
      return;
    }

    this.time += dt;
    if (this.tutResetT > 0) this.tutResetT = Math.max(0, this.tutResetT - dt);

    this._step(dt);
    this.particles.update(dt);
    if (this.state !== 'playing') return;

    var p = this.player;

    /* Latch the target lock. _predictRelease() runs inside _step() and only
       while orbiting, so `predict` goes stale the moment the player lets go -
       hence the explicit orbit test rather than trusting predict.node. The
       lock is acquired on ONE tick (lockT === 0) and held with a sim-clock
       age; the renderer snaps on the acquisition instead of cross-fading, so
       there is a single frame the player can point at and call "locked". */
    var lockTarget = (p.mode === 'orbit') ? this.predict.node : null;
    if (lockTarget !== this.lockNode) {
      this.lockNode = lockTarget;
      this.lockT = 0;
    } else if (lockTarget) {
      this.lockT += dt;
    }

    /* Node pop was decaying inside the draw call (-0.045 per painted frame),
       which made a purely cosmetic value depend on render scheduling. */
    for (var i = 0; i < this.nodes.length; i++) {
      var nd = this.nodes[i];
      if (nd.pop > 0) nd.pop = Math.max(0, nd.pop - 2.7 * dt);
    }
    for (i = 0; i < this.labels.length; i++) {
      if (this.labels[i].t > 0) this.labels[i].t = Math.max(0, this.labels[i].t - dt);
    }

    /* ---- rocket render state (no physics reads this back) --------------
       Advanced here rather than in the draw call for the same reason node.pop
       was moved here: draw runs a variable number of times per tick, so a
       cosmetic value animated there depends on render scheduling. */
    if (p.burn > 0) p.burn = Math.max(0, p.burn - dt / BURN_FADE);
    /* Ease the drawn heading onto the true one. Frame-rate independent, and
       fed the FIXED dt, so the turn takes the same wall time on any device.
       ORBIT ONLY. The ease exists for one event: a hook, which can reverse the
       heading by nearly 180 degrees in a single tick, and snapping that reads
       as a glitch. A flight is a straight line - the heading never changes
       once _release() has set it - so easing there could only ever mean the
       hull is lying about a direction it is already travelling in. */
    if (p.mode === 'orbit') {
      p.aim = SK.Rocket.turn(p.aim, SK.Rocket.heading(p),
        1 - Math.pow(2, -dt / AIM_HALF));
    } else {
      p.aim = SK.Rocket.heading(p);
    }

    /* Exhaust trail. It leaves the NOZZLE, not the hull centre, and it is
       thrown backwards along the heading instead of in a symmetric puff - a
       cloud centred on the ship read as damage, a directed plume reads as
       drive. Colour flashes amber for the length of a burn so a release is
       legible from the trail alone.
       Math.random() here is deliberate and safe: it is a separate stream from
       the seeded this.rand() chain that generates the world, particles never
       feed back into the sim, and the existing trail already used it. */
    p.trailT -= dt;
    if (p.trailT <= 0) {
      p.trailT = 0.018;
      var nz = SK.Rocket.nozzle(p.x, p.y, p.aim, PLAYER_R, this._nz);
      var back = p.aim + Math.PI;
      var ex = 46 + p.burn * 150;                        // exhaust speed
      var spread = (p.mode === 'fly' ? 26 : 16) * (0.5 + p.burn);
      this.particles.spawn(nz.x, nz.y,
        Math.cos(back) * ex + (Math.random() * 2 - 1) * spread,
        Math.sin(back) * ex + (Math.random() * 2 - 1) * spread,
        (p.mode === 'fly' ? 0.26 : 0.20) + p.burn * 0.14,
        (p.mode === 'fly' ? 2.2 : 1.8) + p.burn * 1.5,
        p.burn > 0.35 ? SK.Rocket.FLAME_BURN : COL.node, 1.6, true);
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

  /* _drawStar and _drawPlanet used to live here - ~100 lines of gradients,
     bands and limb strokes rebuilt per body per frame. They are now one
     sprite blit each in js/celestial.js, which is also where the fourteen
     formation classes and six spectral classes were added. Nothing else
     called them. */

  Game.prototype._drawNode = function (ctx, n) {
    var pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4 + n.phase);
    var decayed = n.type === 'decay';
    var isStar = n.kind === 'star';
    var col = bodyCol(n);
    /* Halo colour now comes from the body's formation/spectral class, built
       on first sight and cached in js/celestial.js. */
    var glow = SK.Celestial.glowFor(n);

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

    /* The body itself. Everything about how it LOOKS - formation class,
       spectral colour, craters, bands, rings, corona - lives in
       js/celestial.js and is blitted from a bounded sprite cache. This call
       is side-effect free: no RNG, no writes to `n`. */
    SK.Celestial.drawBody(ctx, n, R, alive, pulse, this.time);

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

    /* Hazards. Drawn at exactly METEOR_R - the collision radius the sim
       uses - so the art can never grow past the hitbox and lie about where
       the danger actually is. The rock, its tumble, its trail and its hot
       leading edge all live in js/celestial.js. */
    for (i = 0; i < this.meteors.length; i++) {
      SK.Celestial.drawMeteor(ctx, this.meteors[i], METEOR_R, this.time);
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

      /* Mark the node this release would actually capture.
         This marker used to breathe on a GLOBAL sine - 0.5 + 0.3 * sin(time)
         - so it looked exactly the same one millisecond after the lock was
           acquired as it did five seconds later. There was no frame the
         player could point at and call "locked"; combined with the capture
         rings fading in over a distance gradient, the whole thing read as
         "getting warmer" rather than "shoot NOW". That is the half of the
         "delay quando o planeta fica com highlighted" report that no amount
         of input latency would have fixed, because nothing on screen was
         ever an EVENT.
         `lockT` (latched in _tick, sim clock, 0 on the acquisition tick) is
         that event. The marker now punches in bright and wide and collapses
         onto the body over LOCK_SNAP, then holds perfectly steady. All of it
         is driven by the FIXED step, so the snap takes the same wall time on
         a 60 Hz phone and a 144 Hz monitor. */
      if (pr.node) {
        var tgt = pr.node;
        /* Guard the draw against a paint that beats the first tick: without
           a latched lock for THIS body there is no acquisition to animate. */
        var snap = (this.lockNode === tgt)
          ? clamp(1 - this.lockT / LOCK_SNAP, 0, 1)
          : 0;
        var snapE = snap * snap;   // bite hard on the first frames, settle fast
        ctx.save();
        ctx.strokeStyle = 'rgba(' + gCol + ',' + (0.55 + 0.45 * snap).toFixed(2) + ')';
        ctx.lineWidth = 2.4 + 3.2 * snapE;
        ctx.beginPath();
        ctx.arc(tgt.x, tgt.y, tgt.radius + 9 + 30 * snapE, 0, TAU);
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

    /* player - the rocket.
       It used to be a white dot with a cyan outline. A dot has no front, so
       the only thing on screen that said which way a tap would fire you was
       the dashed guide. The hull points along the SAME vector the guide draws
       and the same one _release() hands the physics, so heading is now
       readable off the ship itself.
       All of the art lives in js/rocket.js; PLAYER_R (collision) is unchanged
       and the hull is simply drawn larger than it. */
    if (this.state === 'playing') {
      /* The ring used to be a charge meter counting down FLIGHT_MAX. There is
         no flight timer any more, so it reports the thing that CAN kill you:
         how close the rocket is to dropping out of the bottom of the view. */
      var fallGap = (this.camY + H) - p.y;
      SK.drawGlow(ctx, this.glowPlayer, p.x, p.y,
        0.42 + 0.08 * Math.sin(this.time * 7) + p.burn * 0.22, 0.55 + p.burn * 0.25);
      SK.Rocket.draw(ctx, p.x, p.y, p.aim, PLAYER_R, this.time, {
        burn: p.burn,
        /* Steady plume tracks the speed this body actually gives you, so a
           star hook visibly runs the engine harder than a planet hook. */
        thrust: clamp(this._vTan(p) / THRUST_REF, 0, 1),
        warn: fallGap < 150 ? 1 : 0
      });
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

  /* A quiet, hit-tested secondary button: same neon-outline language as Retry
     but never pulsing, because it must not compete with the primary action on
     either screen. Retry is deliberately NOT refactored onto this - it is
     proven code on the hottest screen in the game, and a shared helper would
     put a new bug one edit away from it. */
  Game.prototype._drawPanelButton = function (ctx, r, label, alpha, swatch) {
    var a = clamp(alpha === undefined ? 1 : alpha, 0, 1);
    ctx.save();
    ctx.fillStyle = 'rgba(53,230,255,' + (0.07 * a).toFixed(3) + ')';
    ctx.strokeStyle = 'rgba(53,230,255,' + (0.38 * a).toFixed(3) + ')';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 10);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* A filled dot in the ship's current body colour (the rim and fins - the
       part that reads as "the ship's colour" at a glance), inset at the left. It is the
       button's second job: a label alone says a customiser EXISTS, a live
       swatch says what it is currently set to and that tapping it will change
       something visible. It is also the cheapest possible confirmation that a
       tap in the panel landed - close the panel and the dot has moved on. */
    var pad = 0;
    if (swatch) {
      var cx = r.x + 22, cy = r.y + r.h / 2;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = swatch;
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
      pad = 12;          // keep the label optically centred in what is left
    }
    txt(ctx, label, r.x + pad + (r.w - pad) / 2, r.y + r.h / 2 + 6, 16,
      'rgba(200,235,255,' + (0.92 * a).toFixed(2) + ')', 'center', 700);
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

  /* The first screen. It is the game's only advertisement, so everything on
     it has to be currently true:
       - the hero is the ROCKET the player actually flies, on a tether, lit,
         pointing where a tap would fire it;
       - the body it orbits is painted by js/celestial.js with the same
         routines the live world uses, so the title inherits every future art
         change instead of drifting away from the build again;
       - the legend names the three things that are in the game NOW - planets,
         stars and meteoroids - because the previous copy predated all three
         and the meteoroid hazard was advertised nowhere at all;
       - the controls line names every input that works, not just the touch
         one, since the game is played on desktop too. */
  Game.prototype._drawTitle = function (ctx) {
    var cx = W / 2, cy = 352, r = 88;
    /* The demo used to orbit at a fixed 1.5 rad/s - a 4.19 s lap, against a
       real opening lap of well under 1.5 s. It was advertising a different,
       much calmer game than the one behind the tap. Drive it with the SAME
       gravity relation the player is about to be handed: a 1.0-mass body. */
    var a = this.titleT * Math.sqrt(G / (r * r * r));
    var hero = this.titleHero;
    hero.x = cx; hero.y = cy;

    ctx.strokeStyle = 'rgba(53,230,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();

    /* The hero body, painted by the real art module. */
    var heroPulse = 0.5 + 0.5 * Math.sin(this.titleT * 2.4 + hero.phase);
    SK.drawGlow(ctx, SK.Celestial.glowFor(hero), cx, cy, 3.0 + heroPulse * 0.2, 0.5);
    SK.Celestial.drawBody(ctx, hero, hero.radius * 2.1, true, heroPulse, this.titleT);

    /* Tether + rocket. `a + PI/2` is the tangent at angle `a` for a
       counter-clockwise orbit: the same relation js/rocket.js derives in
       flight, so the demo ship is banked exactly like the live one. */
    var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    ctx.strokeStyle = 'rgba(53,230,255,0.35)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke();
    SK.drawGlow(ctx, this.glowPlayer, px, py, 0.55, 0.7);
    SK.Rocket.draw(ctx, px, py, a + Math.PI / 2, PLAYER_R * 1.35, this.titleT,
      { burn: 0.30 + 0.30 * Math.sin(this.titleT * 2.2), thrust: 0.5 });

    txt(ctx, 'SKYHOOK', W / 2, 182, 62, '#ffffff', 'center', 800, 'rgba(53,230,255,0.9)', 30);
    txt(ctx, 'O R B I T   -   R E L E A S E   -   C L I M B', W / 2, 216, 13, 'rgba(150,210,240,0.75)', 'center', 600);

    /* The old CTA said "TAP / SPACE - to let go of the tether", but the first
       tap does not release anything: it starts the run. Say what the button
       actually does, then say what the NEXT one does - and name the keys,
       which the touch-only copy never did. */
    var blink = 0.65 + 0.35 * Math.sin(this.titleT * 4);
    txt(ctx, 'TAP TO START', W / 2, 512, 26, 'rgba(255,255,255,' + blink.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.6)', 16);
    txt(ctx, 'Tap, click or SPACE fires the thruster and lets go.', W / 2, 540, 13, 'rgba(150,190,220,0.72)', 'center', 500);
    txt(ctx, 'The next hook connects itself.   M mutes.', W / 2, 560, 13, 'rgba(150,190,220,0.55)', 'center', 500);

    /* Drawn before the legend so the legend's glows are never occluded by a
       flat panel, and outside the online/offline branch below: the customiser
       is the same button on both layouts. */
    if (typeof this.onUi === 'function') {
      this._drawPanelButton(ctx, this.shipRect, 'CUSTOMISE SHIP', 1,
        SK.Ship ? SK.Ship.current().body : null);
    }

    /* 638 before the customise button existed. Moved down so the button has
       air under the TAP TO START copy without crowding PLANET / STAR /
       METEOROID; everything from BEST downwards is untouched, which is what
       keeps the leaderboard button where test/leaderboard_ui.mjs clicks it. */
    this._drawLegend(ctx, 650);

    /* Two layouts for the bottom band. Without a backend it is exactly the
       one that shipped before accounts existed - same y values, same copy,
       byte-for-byte the same screen. With a backend the BEST block moves up
       14 px to make room for the leaderboard button and the account line,
       which replaces the tagline: who you are signed in as is information the
       player can act on, and "stay on screen" is a restatement of the rule the
       legend above already teaches. */
    if (this.online.ready) {
      txt(ctx, 'BEST', W / 2, 738, 13, 'rgba(150,190,220,0.55)', 'center', 700);
      txt(ctx, String(this.best), W / 2, 776, 34, 'rgba(255,215,94,0.95)', 'center', 800, 'rgba(255,215,94,0.5)', 18);
      this._drawPanelButton(ctx, this.boardRect, 'LEADERBOARD', 1);
      txt(ctx,
        this.online.signedIn
          ? ('signed in as ' + this.online.username)
          : 'sign in to save your score globally',
        W / 2, 862, 11, 'rgba(140,175,205,0.55)', 'center', 500);
    } else {
      txt(ctx, 'BEST', W / 2, 752, 13, 'rgba(150,190,220,0.55)', 'center', 700);
      txt(ctx, String(this.best), W / 2, 792, 36, 'rgba(255,215,94,0.95)', 'center', 800, 'rgba(255,215,94,0.5)', 18);

      txt(ctx, 'stay on screen and the climb never ends', W / 2, 832, 12, 'rgba(140,175,205,0.5)', 'center', 500);
    }

    this._drawMute(ctx);
  };

  /* Three columns: what you hook, what slings you, what kills you. Drawn with
     the live art routines - these icons cannot go stale, because they ARE the
     in-game bodies at a smaller radius. */
  Game.prototype._drawLegend = function (ctx, y) {
    var cols = [W * 0.5 - 148, W * 0.5, W * 0.5 + 148];
    var i, b, pulse;

    for (i = 0; i < 2; i++) {
      b = this.titleCast[i];
      b.x = cols[i]; b.y = y;
      pulse = 0.5 + 0.5 * Math.sin(this.titleT * 2.4 + b.phase);
      SK.drawGlow(ctx, SK.Celestial.glowFor(b), b.x, b.y, 1.5 + pulse * 0.15, 0.42);
      SK.Celestial.drawBody(ctx, b, 17, true, pulse, this.titleT);
    }

    var rock = this.titleRock;
    rock.x = cols[2]; rock.y = y; rock.homeX = cols[2];
    SK.Celestial.drawMeteor(ctx, rock, 13, this.titleT);

    txt(ctx, 'PLANET', cols[0], y + 40, 11, 'rgba(53,230,255,0.85)', 'center', 800);
    txt(ctx, 'gentle, forgiving', cols[0], y + 57, 10, 'rgba(140,175,205,0.6)', 'center', 500);
    txt(ctx, 'STAR', cols[1], y + 40, 11, 'rgba(255,224,140,0.9)', 'center', 800);
    txt(ctx, 'pulls harder, slings far', cols[1], y + 57, 10, 'rgba(140,175,205,0.6)', 'center', 500);
    txt(ctx, 'METEOROID', cols[2], y + 40, 11, 'rgba(255,110,130,0.9)', 'center', 800);
    txt(ctx, 'one touch and you are out', cols[2], y + 57, 10, 'rgba(140,175,205,0.6)', 'center', 500);
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

      if (this.online.ready) this._drawPanelButton(ctx, this.boardRectOver, 'LEADERBOARD', t);
    }

    /* One line about where this run landed globally. Drawn in the gap between
       the BEST block and Retry, and only when there is a backend to be
       ranked by. The text is written by js/ui_online.js - the game does not
       know whether it is a rank, a "saving...", or a reason it could not be
       saved, and does not need to. */
    if (this.online.ready && this.online.status) {
      txt(ctx, this.online.status, W / 2, 596, 14,
        'rgba(150,210,240,' + (0.8 * t).toFixed(2) + ')', 'center', 600);
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
      persistent: SK.Store.persistent,
      online: {
        ready: this.online.ready,
        signedIn: this.online.signedIn,
        username: this.online.username,
        rank: this.online.rank,
        status: this.online.status
      }
    };
  };

  Game.W = W;
  Game.H = H;
  SK.Game = Game;

}(window));
