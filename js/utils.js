/* SKYHOOK - shared helpers.
   Plain script (no ES modules) on purpose: ES modules are blocked by CORS
   when the page is opened directly from disk (file://). This way the game
   runs by double-clicking index.html, with zero build step and zero server. */
(function (global) {
  'use strict';

  var SK = global.SK || (global.SK = {});

  SK.TAU = Math.PI * 2;

  SK.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  SK.lerp = function (a, b, t) { return a + (b - a) * t; };

  /* Frame-rate independent exponential smoothing.
     `half` = seconds for the value to close half the gap. */
  SK.damp = function (a, b, half, dt) {
    return b + (a - b) * Math.pow(2, -dt / half);
  };

  SK.hypot = function (x, y) { return Math.sqrt(x * x + y * y); };

  /* Deterministic PRNG (mulberry32) so runs can be reproduced with ?seed=N. */
  SK.rng = function (seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* localStorage is unavailable (throws) on file:// in Chromium and in
     private modes. Never let that break the game - fall back to memory. */
  SK.Store = (function () {
    var mem = {};
    var ok = false;
    try {
      var k = '__sk_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      ok = true;
    } catch (e) { ok = false; }

    return {
      persistent: ok,
      get: function (key, def) {
        try {
          var v = ok ? global.localStorage.getItem(key) : (key in mem ? mem[key] : null);
          return v === null || v === undefined ? def : v;
        } catch (e) { return def; }
      },
      set: function (key, val) {
        try {
          if (ok) global.localStorage.setItem(key, String(val));
          else mem[key] = String(val);
        } catch (e) { /* quota / disabled - ignore */ }
      },
      getNum: function (key, def) {
        var n = parseFloat(this.get(key, ''));
        return isFinite(n) ? n : def;
      }
    };
  }());

  /* Pre-rendered radial glow sprite. Much cheaper than ctx.shadowBlur,
     which tanks frame rate on mobile GPUs. */
  SK.makeGlow = function (radius, rgb, innerAlpha) {
    var size = radius * 2;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0.0, 'rgba(' + rgb + ',' + (innerAlpha === undefined ? 0.95 : innerAlpha) + ')');
    grad.addColorStop(0.35, 'rgba(' + rgb + ',' + (innerAlpha === undefined ? 0.32 : innerAlpha * 0.34) + ')');
    grad.addColorStop(1.0, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  };

  SK.drawGlow = function (ctx, sprite, x, y, scale, alpha) {
    var r = sprite.width * 0.5 * scale;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  };

  /* Fixed-capacity particle system. No allocation during play. */
  function Particles(max) {
    this.max = max;
    this.n = 0;
    this.p = new Array(max);
    for (var i = 0; i < max; i++) {
      this.p[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, drag: 0.9, r: 255, g: 255, b: 255, glow: false };
    }
  }
  Particles.prototype.spawn = function (x, y, vx, vy, life, size, rgb, drag, glow) {
    var q;
    if (this.n < this.max) { q = this.p[this.n++]; }
    else { q = this.p[(Math.random() * this.max) | 0]; } // recycle oldest-ish under load
    q.x = x; q.y = y; q.vx = vx; q.vy = vy;
    q.life = life; q.max = life; q.size = size;
    q.r = rgb[0]; q.g = rgb[1]; q.b = rgb[2];
    q.drag = drag === undefined ? 1.6 : drag;
    q.glow = !!glow;
    return q;
  };
  Particles.prototype.update = function (dt) {
    for (var i = 0; i < this.n; i++) {
      var q = this.p[i];
      q.life -= dt;
      if (q.life <= 0) {
        var last = this.p[--this.n];
        this.p[this.n] = q;
        this.p[i] = last;
        i--;
        continue;
      }
      var d = Math.exp(-q.drag * dt);
      q.vx *= d; q.vy *= d;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  };
  Particles.prototype.draw = function (ctx) {
    var prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.n; i++) {
      var q = this.p[i];
      var t = q.life / q.max;
      var a = t * t;
      var s = q.size * (0.35 + t * 0.65);
      ctx.fillStyle = 'rgba(' + q.r + ',' + q.g + ',' + q.b + ',' + a.toFixed(3) + ')';
      ctx.fillRect(q.x - s * 0.5, q.y - s * 0.5, s, s);
    }
    ctx.globalCompositeOperation = prevOp;
  };
  Particles.prototype.clear = function () { this.n = 0; };

  SK.Particles = Particles;

}(window));
