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

  function onDown(e) {
    if (e.cancelable) e.preventDefault();
    armAudio();
    var cx, cy;
    if (e.touches && e.touches.length) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
    else { cx = e.clientX; cy = e.clientY; }
    var p = toLogical(cx, cy);
    /* A tap anywhere in the letterboxed stage counts; taps land on the
       mute button only when they are actually inside the canvas. */
    game.pointerDown(p.x, p.y);
  }

  if (global.PointerEvent) {
    stage.addEventListener('pointerdown', onDown, { passive: false });
  } else {
    stage.addEventListener('touchstart', onDown, { passive: false });
    stage.addEventListener('mousedown', onDown, { passive: false });
  }

  /* Stop iOS double-tap zoom / long-press callout over the play area. */
  stage.addEventListener('touchmove', function (e) { if (e.cancelable) e.preventDefault(); }, { passive: false });
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  global.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var k = e.code || e.key;
    if (k === 'Space' || k === 'Enter' || k === 'ArrowUp' || k === 'KeyW' || k === ' ') {
      e.preventDefault();
      armAudio();
      game.action();
    } else if (k === 'KeyM' || k === 'm') {
      armAudio();
      game.toggleMute();
    }
  });

  /* ---------------- main loop ---------------------------------------- */

  var last = 0;
  var running = true;

  function frame(ts) {
    global.requestAnimationFrame(frame);
    if (!last) { last = ts; return; }
    var dt = (ts - last) / 1000;
    last = ts;
    if (!running) return;
    if (dt > 0.25) dt = 1 / 60;          // returning from a background tab
    game.update(dt);
    game.render(ctx);
  }

  document.addEventListener('visibilitychange', function () {
    running = !document.hidden;
    last = 0;
    if (document.hidden && SK.Audio.ctx) { try { SK.Audio.ctx.suspend(); } catch (e) {} }
    else if (audioArmed) SK.Audio.resume();
  });

  global.requestAnimationFrame(frame);

  /* Exposed for the automated smoke test (and for debugging in devtools). */
  global.__SKYHOOK = {
    game: game,
    canvas: canvas,
    stage: stage,
    fit: fit,
    snapshot: function () { return game.snapshot(); },
    tap: function () { game.action(); },
    version: '1.0.0'
  };

}(window));
