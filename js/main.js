/* SKYHOOK - bootstrap: canvas fitting, input, main loop. */
(function (global) {
  'use strict';

  var SK = global.SK;
  var canvas = document.getElementById('game');
  var stage = document.getElementById('stage');
  var ctx = canvas.getContext('2d', { alpha: false });

  var W = SK.Game.W, H = SK.Game.H;

  /* ?seed=123 makes a run reproducible (handy for debugging a bad layout). */
  var seedParam = null;
  try {
    var m = /[?&]seed=(-?\d+)/.exec(global.location.search || '');
    if (m) seedParam = parseInt(m[1], 10);
  } catch (e) { /* ignore */ }

  var game = new SK.Game(seedParam);

  /* ---------------- fit the logical canvas into the stage ------------ */
  var scaleX = 1, scaleY = 1;

  function fit() {
    var rect = stage.getBoundingClientRect();
    var availW = Math.max(1, rect.width);
    var availH = Math.max(1, rect.height);
    var f = Math.min(availW / W, availH / H);
    var cssW = Math.round(W * f);
    var cssH = Math.round(H * f);

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));

    scaleX = canvas.width / W;
    scaleY = canvas.height / H;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  fit();
  global.addEventListener('resize', fit, { passive: true });
  global.addEventListener('orientationchange', function () { setTimeout(fit, 120); }, { passive: true });
  if (global.ResizeObserver) {
    try { new global.ResizeObserver(fit).observe(stage); } catch (e) { /* ignore */ }
  }

  /* ---------------- input ------------------------------------------- */

  function toLogical(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / Math.max(1, r.width) * W,
      y: (clientY - r.top) / Math.max(1, r.height) * H
    };
  }

  var audioArmed = false;
  function armAudio() {
    if (audioArmed) return;
    audioArmed = true;
    SK.Audio.init();
    SK.Audio.setMuted(game.muted);
    SK.Audio.resume();
  }

  /* In the touch fallback the browser synthesises a mousedown after every
     touchstart, so one thumb tap arrived as two releases. */
  var lastTouchAt = 0;
  var TOUCH_GHOST_MS = 750;

  function onDown(e) {
    if (e.cancelable) e.preventDefault();
    armAudio();
    var cx, cy;
    if (e.touches && e.touches.length) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
    else { cx = e.clientX; cy = e.clientY; }
    var p = toLogical(cx, cy);
    /* Whether a real person's input device produced this event. Recorded by
       the game for the leaderboard's bot review, never used to refuse input:
       an untrusted tap still plays exactly like a trusted one. */
    game.inputTrusted = e.isTrusted === true;
    /* A tap anywhere in the letterboxed stage counts; taps land on the
       mute button only when they are actually inside the canvas. */
    game.pointerDown(p.x, p.y);
  }

  function onPointerDown(e) {
    /* Secondary touches in a multi-touch gesture, and every mouse button
       except the primary one, are not gameplay input. */
    if (e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    onDown(e);
  }

  if (global.PointerEvent) {
    stage.addEventListener('pointerdown', onPointerDown, { passive: false });
  } else {
    stage.addEventListener('touchstart', function (e) {
      lastTouchAt = Date.now();
      onDown(e);
    }, { passive: false });
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (Date.now() - lastTouchAt < TOUCH_GHOST_MS) return;   // ghost click
      onDown(e);
    }, { passive: false });
  }

  /* Stop iOS double-tap zoom / long-press callout over the play area. */
  stage.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  global.addEventListener('keydown', function (e) {
    if (e.repeat) return;

    /* SPACE is "fire the thruster" AND the key that types a space into a
       password field. Before accounts existed there was no field to type
       into; now there is, and an unguarded listener would start a run under
       the player mid-password - or worse, swallow the space so the password
       they typed is not the one they think they typed. Two guards: any open
       overlay owns the keyboard, and so does any focused form control. */
    if (SK.UI && SK.UI.isOpen && SK.UI.isOpen()) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;

    var k = e.code || e.key;
    if (k === 'Space' || k === 'Enter' || k === 'ArrowUp' || k === 'KeyW' || k === ' ') {
      e.preventDefault();
      armAudio();
      game.inputTrusted = e.isTrusted === true;
      game.action();
    } else if (k === 'KeyM' || k === 'm') {
      armAudio();
      game.toggleMute();
    }
  });

  /* ---------------- main loop ---------------------------------------- */

  var last = 0;
  var running = true;

  /* The loop hands raw elapsed time to the game, which owns the fixed-step
     accumulator. It no longer invents a dt of 1/60 after a stall - pretending
     a 3-second gap was 16 ms is how a backgrounded tab comes back already
     dead, or silently in slow motion. */
  function frame(ts) {
    global.requestAnimationFrame(frame);
    if (!last) { last = ts; return; }
    var dt = (ts - last) / 1000;
    last = ts;
    if (!running) { game.render(ctx); return; }
    game.update(dt);
    game.render(ctx);
  }

  /* Backgrounding is an explicit interruption: pause, and make the player ask
     for the game back. Coming straight out of a phone call (or, on Android, a
     fullscreen ad) into a live orbit is a stolen run. */
  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    last = 0;
    if (document.hidden) {
      game.pause();
      if (SK.Audio.ctx) { try { SK.Audio.ctx.suspend(); } catch (e) {} }
    } else if (audioArmed) {
      SK.Audio.resume();
    }
  });

  global.addEventListener('blur', function () { last = 0; }, { passive: true });

  global.requestAnimationFrame(frame);

  /* Exposed for the automated smoke test (and for debugging in devtools). */
  global.__SKYHOOK = {
    game: game,
    canvas: canvas,
    stage: stage,
    fit: fit,
    snapshot: function () { return game.snapshot(); },
    tap: function () { game.action(); },
    /* Test/debug hook: reach normal gameplay without playing the tutorial. */
    skipTutorial: function (persist) { game.skipTutorial(persist !== false); },
    version: '1.0.0'
  };

}(window));
