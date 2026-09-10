/* SKYHOOK test bot - shared by test/smoke.mjs and test/perf.mjs.
 *
 * An in-page script (not a module) that plays the game for real: it waits for
 * the orbit angle where releasing aims closest at the next body, then
 * dispatches a genuine primary pointerdown on the stage - the same code path a
 * human thumb walks. Injected with page.evaluate(<this file's text>).
 *
 * Extracted from smoke.mjs 2026-09-10 so the frame-time harness measures the
 * game under the SAME player, rather than a second, divergent copy of the bot.
 *
 * `isPrimary/pointerId/pointerType/button/buttons` below are the fields Chrome
 * actually sets on a real primary mouse pointerdown. main.js drops
 * non-primary pointers on purpose (extra fingers in a multi-touch gesture are
 * not gameplay input), so omitting any of them makes the bot invisible to the
 * game - which is exactly the defect this harness once shipped.
 */
window.__bot = { on: true, taps: 0 };
(function botLoop() {
  requestAnimationFrame(botLoop);
  var B = window.__bot;
  if (!B.on) return;
  var g = window.__SKYHOOK && window.__SKYHOOK.game;
  if (!g || g.state !== 'playing') return;
  var p = g.player;
  if (p.mode !== 'orbit' || !p.node) return;

  function tap() {
    var r = window.__SKYHOOK.canvas.getBoundingClientRect();
    window.__SKYHOOK.stage.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    }));
    B.taps++;
  }

  /* The tutorial FREEZES the orbit on tutHold and puts "TAP NOW" on screen.
     A bot that only fires on a changing angle waits there forever - which is
     exactly what it did: 26 s, 0 hooks, altitude stuck at 7 m. When the game
     tells the player to tap, tap. This is the real first-run path a human
     walks, so the suite should walk it too rather than skipping the tutorial. */
  if (g.tutHold) { tap(); return; }

  var target = null, bd = 1e9;
  for (var i = 0; i < g.nodes.length; i++) {
    var n = g.nodes[i];
    if (n.spent || n === p.node) continue;
    var d = Math.hypot(p.x - n.x, p.y - n.y);
    if (d < bd) { bd = d; target = n; }
  }
  if (!target) return;

  function aimAt(ang) {
    var cs = Math.cos(ang), sn = Math.sin(ang);
    var rx = p.node.x + cs * p.r, ry = p.node.y + sn * p.r;
    var vx = -sn * p.dir, vy = cs * p.dir;
    var tx = target.x - rx, ty = target.y - ry;
    return { along: tx * vx + ty * vy, perp: Math.abs(tx * vy - ty * vx) };
  }

  /* Ask the game for its own angular rate instead of restating it. The old
     hardcoded 468/p.r was wrong twice over - speed ramps 360 -> 468 with
     hooks, and the divisor is floored at the body's resting minimum - so the
     one-frame lookahead that decides the release was aiming at a phantom.
     (Same defect balance.mjs logged as F3a/F3b.) */
  var rate = (typeof g.angRate === 'function')
    ? g.angRate(p)
    : p.dir * (p.speed / Math.max(p.r, 60));
  var step = rate * (1 / 60);

  /* Tolerance scales with the TARGET's own latch ring, so "close enough"
     means the same thing on a small planet and on a big star. */
  var tol = 70 * ((target.captureR || 92) / 92);

  var now = aimAt(p.ang);
  var soon = aimAt(p.ang + step);
  if (now.along > 0 && now.perp < tol && soon.perp >= now.perp) tap();
})();
