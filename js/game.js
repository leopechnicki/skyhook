/* SKYHOOK - core game.
   One input. You orbit a node on a tether. Tap to let go; you fly in a
   straight line and automatically latch onto the next node you pass near.
   Miss, and there is nothing under you but the rising rift. */
(function (global) {
  'use strict';

  var SK = global.SK;
  var clamp = SK.clamp, lerp = SK.lerp, TAU = SK.TAU;

  /* ---- logical resolution (everything is drawn in these units) ---- */
  var W = 480, H = 880;

  /* ---- tuning ------------------------------------------------------ */
  var SPEED        = 468;   // constant linear speed, orbiting AND flying
  var MIN_R        = 46;    // tightest tether - below this the player disc
                            // visually merges with the node it is orbiting
  var MAX_R        = 92;    // widest tether == latch range
  var CAPTURE_R    = 92;
  var TIGHT_D      = 52;    // latch closer than this = tight hook (combo up)
  var LOOSE_D      = 78;    // latch further than this = sloppy (combo reset)
  var FLIGHT_MAX   = 1.5;   // seconds adrift before the hook loses charge
  var PLAYER_R     = 8;
  var NODE_R       = 12;
  var MINE_R       = 11;
  var SHARD_PICK   = 22;
  var MARGIN_X     = 96;    // node placement bounds
  var DEATH_PAD    = 64;    // how far off-column before you are gone
  var DECAY_TIME   = 1.55;  // amber nodes burn out this fast
  var CAM_OFFSET   = 0.62;  // player sits this far down the screen
  var STEP         = 1 / 120;

  var COL = {
    node:   [53, 230, 255],
    decay:  [255, 176, 58],
    player: [255, 255, 255],
    shard:  [255, 215, 94],
    mine:   [255, 77, 109],
    rift:   [255, 46, 99]
  };

  var CAUSE = {
    rift:  'THE RIFT TOOK YOU',
    mine:  'YOU HIT A MINE',
    drift: 'HOOK LOST CHARGE',
    edge:  'YOU LEFT THE COLUMN'
  };

  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  /* ================================================================== */

  function Game(seed) {
    this.W = W; this.H = H;
    this.seed = (seed === undefined || seed === null) ? ((Math.random() * 1e9) | 0) : seed;
    this.rand = SK.rng(this.seed);

    this.particles = new SK.Particles(420);

    this.best = Math.max(0, Math.floor(SK.Store.getNum('skyhook.best', 0)));
    this.muted = SK.Store.get('skyhook.muted', '0') === '1';
    SK.Audio.muted = this.muted;

    /* pre-rendered glows (cheap substitute for ctx.shadowBlur) */
    this.glowNode   = SK.makeGlow(64, COL.node.join(','), 0.85);
    this.glowDecay  = SK.makeGlow(64, COL.decay.join(','), 0.85);
    this.glowPlayer = SK.makeGlow(52, COL.player.join(','), 0.9);
    this.glowShard  = SK.makeGlow(34, COL.shard.join(','), 0.9);
    this.glowMine   = SK.makeGlow(40, COL.mine.join(','), 0.8);
    this.glowRift   = SK.makeGlow(120, COL.rift.join(','), 0.5);

    this.stars = this._makeStars();
    this.nebula = this._makeNebula();

    this.state = 'title';
    this.time = 0;
    this.titleT = 0;
    this.overT = 0;
    this.dyingT = 0;
    this.shake = 0;
    this.flash = 0;
    this.hitstop = 0;
    this.camY = 0;
    this.newBest = false;
    this.cause = 'rift';
    this.muteRect = { x: W - 56, y: 16, w: 40, h: 40 };

    this._resetWorld();
  }

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

    var first = this._pushNode(W * 0.5, H * 0.66, 'normal');
    this.startY = first.y;

    this.player = {
      x: first.x, y: first.y - 70,
      vx: 0, vy: 0,
      mode: 'orbit',
      node: first,
      ang: -Math.PI / 2,
      r: 70,
      dir: 1,
      flyT: 0,
      trailT: 0
    };
    first.hooked = true;

    this.pendNode = null;
    this.pendD = 0;
    this.pendX = 0;
    this.pendY = 0;

    this.camY = this.player.y - H * CAM_OFFSET;
    this.riftY = this.camY + H + 240;
    this.warnT = 0;
    this.tetherPulse = 0;

    this._ensureAhead();
  };

  Game.prototype._pushNode = function (x, y, type) {
    var n = {
      x: x, y: y, type: type,
      spent: false, hooked: false,
      decay: type === 'decay' ? DECAY_TIME : 0,
      pop: 0,
      phase: this.rand() * TAU,
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

      var type = 'normal';
      if (n >= 9 && this.rand() < Math.min(0.34, (n - 8) * 0.030)) type = 'decay';
      var node = this._pushNode(x, y, type);

      // A shard tempts you off the safest line.
      if (this.rand() < 0.45) {
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
      if (n >= 12 && this.rand() < Math.min(0.50, (n - 11) * 0.040)) {
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
        var okA = Math.hypot(hx - top.x, hy - top.y) > CAPTURE_R + 22;
        var okB = Math.hypot(hx - node.x, hy - node.y) > CAPTURE_R + 22;
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
      if (this.nodes[i].y > floor && this.nodes[i] !== this.player.node && this.nodes.length > 3) {
        this.nodes.splice(i, 1);
      }
    }
    for (i = this.mines.length - 1; i >= 0; i--) if (this.mines[i].y > floor) this.mines.splice(i, 1);
    for (i = this.shards.length - 1; i >= 0; i--) if (this.shards[i].y > floor) this.shards.splice(i, 1);
  };

  /* ---------------- flow ------------------------------------------- */

  Game.prototype.start = function () {
    this.rand = SK.rng((Math.random() * 1e9) | 0);
    this._resetWorld();
    this.state = 'playing';
    this.newBest = false;
    this.shake = 0;
    this.flash = 0;
    this.overT = 0;
    this.dyingT = 0;
    this.hitstop = 0;
    SK.Audio.resume();
    SK.Audio.start();
  };

  Game.prototype.die = function (cause) {
    if (this.state !== 'playing') return;
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
        Math.random() < 0.4 ? COL.rift : COL.player, 1.5, true);
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
    if (this.state === 'over') { if (this.overT > 0.5) this.start(); return; }
    if (this.state !== 'playing') return;
    if (this.player.mode === 'orbit') this._release(false);
  };

  Game.prototype.pointerDown = function (lx, ly) {
    var m = this.muteRect;
    if (lx >= m.x - 10 && lx <= m.x + m.w + 10 && ly >= m.y - 10 && ly <= m.y + m.h + 10) {
      this.toggleMute();
      return;
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
    var sn = Math.sin(p.ang), cs = Math.cos(p.ang);
    p.x = n.x + cs * p.r;
    p.y = n.y + sn * p.r;
    p.vx = -sn * p.dir * SPEED;
    p.vy = cs * p.dir * SPEED;
    p.mode = 'fly';
    p.flyT = 0;
    this.pendNode = null;
    n.spent = true;
    n.hooked = false;
    p.node = null;

    for (var i = 0; i < 8; i++) {
      var j = (Math.random() * 2 - 1) * 0.5;
      this.particles.spawn(p.x, p.y,
        p.vx * (0.25 + Math.random() * 0.35) + j * 90,
        p.vy * (0.25 + Math.random() * 0.35) + j * 90,
        0.25 + Math.random() * 0.25, 2.2, COL.node, 2.4, true);
    }
    if (forced) SK.Audio.snap();
  };

  Game.prototype._hook = function (node, d) {
    var p = this.player;
    var dx = p.x - node.x, dy = p.y - node.y;
    var cross = dx * p.vy - dy * p.vx;

    p.node = node;
    p.ang = Math.atan2(dy, dx);
    p.r = clamp(d, MIN_R, MAX_R);
    p.dir = cross >= 0 ? 1 : -1;
    p.mode = 'orbit';
    p.flyT = 0;
    this.pendNode = null;
    node.hooked = true;
    node.decay = node.type === 'decay' ? DECAY_TIME : 0;

    var tight = d <= TIGHT_D;
    if (tight) this.combo = Math.min(this.combo + 1, 9);
    else if (d >= LOOSE_D) this.combo = 1;

    this.score += (tight ? 15 : 8) * this.combo;
    this.hooks++;

    node.pop = 1;
    this.tetherPulse = 1;
    this.shake = Math.min(this.shake + (tight ? 7 : 3.5), 14);

    var col = node.type === 'decay' ? COL.decay : COL.node;
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

  Game.prototype._step = function (dt) {
    var p = this.player, i;

    if (p.mode === 'orbit') {
      var n = p.node;
      p.ang += p.dir * (SPEED / p.r) * dt;
      p.x = n.x + Math.cos(p.ang) * p.r;
      p.y = n.y + Math.sin(p.ang) * p.r;

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
        if (pd > this.pendD || pd > CAPTURE_R) {
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
          if (d < CAPTURE_R && d < bestD) { bestD = d; bestNode = nd; }
        }
        if (bestNode) {
          this.pendNode = bestNode;
          this.pendD = bestD;
          this.pendX = p.x;
          this.pendY = p.y;
        } else if (p.flyT > FLIGHT_MAX) { this.die('drift'); return; }
      }
    }

    if (p.x < -DEATH_PAD || p.x > W + DEATH_PAD) { this.die('edge'); return; }

    /* the rift */
    var riftSpeed = 52 + Math.min(132, this.hooks * 1.7);
    this.riftY -= riftSpeed * dt;
    var leash = this.camY + H + 300;
    if (this.riftY > leash) this.riftY = leash;
    if (p.y >= this.riftY) { this.die('rift'); return; }

    /* mines */
    for (i = 0; i < this.mines.length; i++) {
      var m = this.mines[i];
      m.x = m.homeX + Math.sin(this.time * 0.9 + m.phase) * m.amp;
      var mdx = p.x - m.x, mdy = p.y - m.y;
      if (mdx * mdx + mdy * mdy < (MINE_R + PLAYER_R) * (MINE_R + PLAYER_R)) { this.die('mine'); return; }
    }

    /* shards */
    var collected = false;
    for (i = 0; i < this.shards.length; i++) {
      var sh = this.shards[i];
      if (sh.got) continue;
      var sdx = p.x - sh.x, sdy = p.y - sh.y;
      if (sdx * sdx + sdy * sdy < SHARD_PICK * SHARD_PICK) {
        sh.got = true;
        collected = true;
        this.score += 25 * Math.max(1, Math.floor(this.combo * 0.5));
        this.riftY += 72;            // breathing room as a reward
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

  Game.prototype.update = function (dtRaw) {
    var dt = Math.min(dtRaw, 0.05);
    this.time += dt;

    this.shake = Math.max(0, this.shake - this.shake * 6 * dt - 6 * dt);
    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.tetherPulse = Math.max(0, this.tetherPulse - dt * 3.5);

    if (this.state === 'title') {
      this.titleT += dt;
      this.camY -= 20 * dt;
      this.particles.update(dt);
      return;
    }

    if (this.state === 'over') {
      this.overT += dt;
      this.camY -= 8 * dt;
      this.particles.update(dt);
      return;
    }

    if (this.state === 'dying') {
      this.dyingT += dt;
      this.particles.update(dt);
      this.riftY -= 40 * dt;
      if (this.dyingT > 0.7) {
        this.state = 'over';
        this.overT = 0;
        if (this.newBest) SK.Audio.best();
      }
      return;
    }

    /* playing */
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      this.particles.update(dt * 0.2);
      return;
    }

    var steps = Math.min(8, Math.max(1, Math.ceil(dt / STEP)));
    var sdt = dt / steps;
    for (var s = 0; s < steps; s++) {
      this._step(sdt);
      if (this.state !== 'playing') break;
    }

    this.particles.update(dt);
    if (this.state !== 'playing') return;

    var p = this.player;

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

    /* proximity warning beeps */
    var gapToRift = this.riftY - p.y;
    if (gapToRift < 190) {
      this.warnT -= dt;
      if (this.warnT <= 0) { this.warnT = clamp(gapToRift / 460, 0.14, 0.42); SK.Audio.warn(); }
    } else this.warnT = 0;

    /* rift embers */
    if (Math.random() < dt * 40) {
      this.particles.spawn(Math.random() * W, this.riftY + 6,
        (Math.random() * 2 - 1) * 30, -60 - Math.random() * 120,
        0.7 + Math.random() * 0.7, 2 + Math.random() * 2, COL.rift, 0.7, true);
    }

    this._ensureAhead();
    this._cull();
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

  Game.prototype._drawNode = function (ctx, n) {
    var pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4 + n.phase);
    var decayed = n.type === 'decay';
    var col = decayed ? COL.decay : COL.node;
    var glow = decayed ? this.glowDecay : this.glowNode;

    if (n.pop > 0) n.pop = Math.max(0, n.pop - 0.045);

    var alive = !n.spent;
    var baseA = alive ? 0.55 : 0.14;

    SK.drawGlow(ctx, glow, n.x, n.y, alive ? (0.62 + pulse * 0.14 + n.pop * 0.7) : 0.34, baseA);

    /* Latch-range ring. Only drawn for nodes the player could plausibly
       reach right now - drawing it on every node turned the screen into
       a wall of overlapping circles. */
    if (alive) {
      var pdx = this.player.x - n.x, pdy = this.player.y - n.y;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 330) {
        var ringA = clamp((330 - pd) / 200, 0, 1) * (0.16 + pulse * 0.05);
        ctx.save();
        ctx.setLineDash([5, 9]);
        ctx.lineDashOffset = -this.time * 14;
        ctx.strokeStyle = rgba(col, ringA.toFixed(3));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, CAPTURE_R, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.beginPath();
    ctx.arc(n.x, n.y, NODE_R * (alive ? 1 : 0.7) + n.pop * 6, 0, TAU);
    ctx.fillStyle = rgba(col, alive ? 0.22 : 0.10);
    ctx.fill();
    ctx.lineWidth = alive ? 2.4 : 1.2;
    ctx.strokeStyle = rgba(col, alive ? 0.95 : 0.30);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(n.x, n.y, 3.6, 0, TAU);
    ctx.fillStyle = alive ? '#ffffff' : rgba(col, 0.4);
    ctx.fill();

    /* burn-down ring on the node you are currently riding */
    if (decayed && n.hooked && n.decay > 0) {
      var f = n.decay / DECAY_TIME;
      ctx.beginPath();
      ctx.arc(n.x, n.y, NODE_R + 8, -Math.PI / 2, -Math.PI / 2 + TAU * f);
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
      var tcol = n.type === 'decay' ? COL.decay : COL.node;
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

      /* Release-direction guide. In a game that is 100% aiming, hiding the
         launch vector is not difficulty, it is guesswork. */
      var gvx = -Math.sin(p.ang) * p.dir, gvy = Math.cos(p.ang) * p.dir;
      ctx.save();
      ctx.setLineDash([7, 8]);
      ctx.lineDashOffset = -this.time * 90;
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(p.x + gvx * 15, p.y + gvy * 15);
      ctx.lineTo(p.x + gvx * 118, p.y + gvy * 118);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath();
      ctx.moveTo(p.x + gvx * 132, p.y + gvy * 132);
      ctx.lineTo(p.x + gvx * 118 - gvy * 5.5, p.y + gvy * 118 + gvx * 5.5);
      ctx.lineTo(p.x + gvx * 118 + gvy * 5.5, p.y + gvy * 118 - gvx * 5.5);
      ctx.closePath();
      ctx.fill();
    }

    this.particles.draw(ctx);

    /* player */
    if (this.state === 'playing') {
      var charge = p.mode === 'fly' ? 1 - (p.flyT / FLIGHT_MAX) : 1;
      SK.drawGlow(ctx, this.glowPlayer, p.x, p.y, 0.55 + 0.10 * Math.sin(this.time * 7), 0.7);
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_R, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = (p.mode === 'fly' && charge < 0.45)
        ? 'rgba(255,90,110,' + (0.5 + 0.5 * Math.sin(this.time * 22)).toFixed(3) + ')'
        : rgba(COL.node, 0.9);
      ctx.stroke();
    }
  };

  Game.prototype._riftEdgeY = function (x) {
    return this.riftY
      + Math.sin(x * 0.031 + this.time * 3.1) * 7
      + Math.sin(x * 0.017 - this.time * 2.0) * 5;
  };

  Game.prototype._drawRift = function (ctx) {
    var y = this.riftY;
    if (y > this.camY + H + 60) return;

    var x;
    ctx.beginPath();
    ctx.moveTo(-20, this._riftEdgeY(-20));
    for (x = -8; x <= W + 20; x += 12) ctx.lineTo(x, this._riftEdgeY(x));
    ctx.lineTo(W + 20, y + 620);
    ctx.lineTo(-20, y + 620);
    ctx.closePath();

    var g = ctx.createLinearGradient(0, y - 20, 0, y + 320);
    g.addColorStop(0, 'rgba(255,46,99,0.85)');
    g.addColorStop(0.18, 'rgba(150,10,60,0.80)');
    g.addColorStop(1, 'rgba(40,0,20,0.96)');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(-20, this._riftEdgeY(-20));
    for (x = -8; x <= W + 20; x += 12) ctx.lineTo(x, this._riftEdgeY(x));
    ctx.strokeStyle = 'rgba(255,190,210,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();

    SK.drawGlow(ctx, this.glowRift, W * 0.5, y + 10, 3.0, 0.35);
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
    var a = this.titleT * 1.5;

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
    txt(ctx, 'H O O K   -   S W I N G   -   C L I M B', W / 2, 230, 13, 'rgba(150,210,240,0.75)', 'center', 600);

    var blink = 0.55 + 0.45 * Math.sin(this.titleT * 4);
    txt(ctx, 'TAP  /  SPACE', W / 2, 560, 26, 'rgba(255,255,255,' + blink.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.6)', 16);
    txt(ctx, 'to let go of the tether', W / 2, 588, 15, 'rgba(150,190,220,0.65)', 'center', 500);

    txt(ctx, 'BEST', W / 2, 660, 13, 'rgba(150,190,220,0.55)', 'center', 700);
    txt(ctx, String(this.best), W / 2, 702, 38, 'rgba(255,215,94,0.95)', 'center', 800, 'rgba(255,215,94,0.5)', 18);

    txt(ctx, 'gold shards push the rift back', W / 2, 792, 12, 'rgba(140,175,205,0.5)', 'center', 500);
    txt(ctx, 'amber nodes burn out - do not linger', W / 2, 812, 12, 'rgba(140,175,205,0.5)', 'center', 500);

    this._drawMute(ctx);
  };

  Game.prototype._drawOver = function (ctx) {
    var t = clamp(this.overT / 0.35, 0, 1);
    ctx.fillStyle = 'rgba(4,5,14,' + (0.74 * t).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);

    var slide = (1 - t) * 26;
    txt(ctx, 'SIGNAL LOST', W / 2, 268 - slide, 44, 'rgba(255,255,255,' + t.toFixed(2) + ')', 'center', 800, 'rgba(255,46,99,0.8)', 26);
    txt(ctx, CAUSE[this.cause] || '', W / 2, 300 - slide, 14, 'rgba(255,140,165,' + (0.8 * t).toFixed(2) + ')', 'center', 600);

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

    if (this.overT > 0.5) {
      var blink = 0.5 + 0.5 * Math.sin((this.overT - 0.5) * 4.5);
      txt(ctx, 'TAP TO RETRY', W / 2, 668, 24, 'rgba(255,255,255,' + blink.toFixed(2) + ')', 'center', 800, 'rgba(53,230,255,0.6)', 16);
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
      this._drawRift(ctx);
      ctx.restore();
    }

    /* rift proximity vignette */
    if (this.state === 'playing') {
      var gap = this.riftY - this.player.y;
      if (gap < 240) {
        var a = clamp(1 - gap / 240, 0, 1) * (0.35 + 0.25 * Math.sin(this.time * 10));
        var vg = ctx.createLinearGradient(0, H, 0, H * 0.35);
        vg.addColorStop(0, 'rgba(255,46,99,' + (a * 0.75).toFixed(3) + ')');
        vg.addColorStop(1, 'rgba(255,46,99,0)');
        ctx.fillStyle = vg;
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
      score: this.score,
      best: this.best,
      hooks: this.hooks,
      combo: this.combo,
      altitude: this.altitude,
      mode: p.mode,
      px: p.x, py: p.y,
      ang: p.ang, r: p.r, dir: p.dir,
      anchor: p.node ? { x: p.node.x, y: p.node.y, type: p.node.type } : null,
      next: next ? { x: next.x, y: next.y, d: bestD } : null,
      riftY: this.riftY,
      cause: this.cause,
      persistent: SK.Store.persistent
    };
  };

  Game.W = W;
  Game.H = H;
  SK.Game = Game;

}(window));
