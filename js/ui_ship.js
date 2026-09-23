/* SKYHOOK - the ship customiser.
 *
 * The form half of js/ship.js: a swatch grid, a live preview of the real
 * rocket, and the crown. Real DOM rather than canvas for the same reason the
 * account panel is - a canvas-drawn control has no focus ring, no screen
 * reader, no keyboard and no tap target the platform understands.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DECIDE
 * ---------------------------------------
 *   - which colours exist          -> SK.Ship.SWATCHES
 *   - whether a colour is legal    -> SK.Ship.set() returns false and does
 *                                     nothing if it is not on the menu
 *   - who is wearing the crown     -> SK.Ship.isChampion()
 *
 * That split is what makes the gold hull un-pickable rather than merely
 * un-offered: the gold chip below is rendered as a LOCKED cell, and the click
 * handler routes it through the same SK.Ship.set() as every other swatch,
 * which refuses it because GOLD is not in SWATCHES. Deleting the `disabled`
 * attribute in devtools therefore changes nothing.
 *
 * THE RESIDUAL GAP, STATED PLAINLY
 * --------------------------------
 * "Am I #1?" is answered from the PUBLIC leaderboard read, in the client. A
 * player with devtools can call SK.Ship.forceChampion(true) - or just load
 * ?gold=1 - and paint their own rocket gold. Nothing stops that and nothing
 * here pretends otherwise. It is cosmetic, local, and not persisted: SKYHOOK
 * renders one ship, the player's own, and no other player ever sees it. There
 * is no server-side claim to forge because the crown is never transmitted.
 * If ships ever become visible to other players, the crown must move to a
 * signed claim from the server and this note is the place that says so.
 *
 * ?gold=1 is deliberate, not an oversight: it is how the gold hull can be
 * LOOKED at - in review, in a screenshot, on staging - without first climbing
 * to the top of a live board. It says "Preview" on screen so it can never be
 * mistaken for the real thing.
 */
(function (global) {
  'use strict';

  var SK = global.SK;
  if (!SK) return;
  var doc = global.document;
  if (!doc) return;

  var el = {};
  var IDS = ['sh', 'sh-close', 'sh-title', 'sh-canvas', 'sh-crown',
             'sh-swatches', 'sh-msg', 'sh-done', 'sh-reset'];

  var game = null;
  var open = false;
  var wired = false;
  var lastFocus = null;
  var cells = [];            // one per swatch, plus the locked gold cell

  function collect() {
    for (var i = 0; i < IDS.length; i++) {
      var node = doc.getElementById(IDS[i]);
      if (!node) return false;         // markup absent: no customiser at all
      el[IDS[i]] = node;
    }
    return true;
  }

  /* ------------------------------------------------------------ preview */

  /* A still, not an animation. A requestAnimationFrame loop in here would run
     alongside the game's own, on a screen where nothing is moving, to flicker
     a flame nobody is looking at - and it would have to be torn down on every
     exit path or it would outlive the panel. One repaint per change is enough
     to answer the only question the preview is asked: what will my ship look
     like. `t` is fixed, so the plume flicker is the same every time and a
     screenshot of this panel is reproducible. */
  var PREVIEW_T = 0.0;
  var PREVIEW_BURN = 0.55;
  var PREVIEW_THRUST = 0.62;

  function drawPreview() {
    var c = el['sh-canvas'];
    var ctx;
    try { ctx = c.getContext('2d'); } catch (e) { return; }
    if (!ctx || !SK.Rocket) return;

    ctx.clearRect(0, 0, c.width, c.height);

    /* The starfield the ship is actually seen against. Without it the panel
       judges a colour on a flat dark rectangle, and the whole point of the
       luminance floor in js/ship.js is how these read against THIS. */
    var bg = ctx.createLinearGradient(0, 0, 0, c.height);
    bg.addColorStop(0, '#0a0d22');
    bg.addColorStop(1, '#05060f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);

    /* Nose up. draw() rotates by (ang + PI/2), so -PI/2 points the ship at
       the top of the panel and puts the plume underneath it. */
    SK.Rocket.draw(ctx, c.width / 2, c.height * 0.42, -Math.PI / 2, 15,
      PREVIEW_T, { burn: PREVIEW_BURN, thrust: PREVIEW_THRUST });
  }

  /* -------------------------------------------------------------- swatches */

  function makeCell(hex, name, locked) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'sh-swatch' + (locked ? ' is-locked' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('data-hex', hex);
    /* The accessible name is the colour's name, not its hex. "Magenta" is the
       thing a screen-reader user can act on; "#ff7edb" is not. */
    b.setAttribute('aria-label', locked ? (name + ' - number one only') : name);
    b.title = locked ? (name + ' - top the leaderboard') : name;

    var dot = doc.createElement('span');
    dot.className = 'sh-dot';
    dot.style.background = hex;
    b.appendChild(dot);

    var cap = doc.createElement('span');
    cap.className = 'sh-cap';
    cap.textContent = locked ? '#1' : name;
    b.appendChild(cap);

    b.addEventListener('click', function () { pick(hex, locked, name); });
    return { node: b, hex: hex, locked: !!locked };
  }

  function buildSwatches() {
    var grid = el['sh-swatches'];
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    cells = [];

    var list = SK.Ship.SWATCHES, i, cell;
    for (i = 0; i < list.length; i++) {
      cell = makeCell(list[i].hex, list[i].name, false);
      cells.push(cell);
      grid.appendChild(cell.node);
    }

    /* The crown, shown to everybody and takeable by nobody.
     *
     * Hiding it from players who have not earned it was the first version and
     * it was worse: a reward nobody knows exists motivates nobody, and the
     * first time it appeared it would read as a rendering bug. Shown-but-
     * locked states the rule in one cell - this colour exists, it is the #1
     * spot's, here is what it looks like. */
    cell = makeCell(SK.Ship.GOLD, 'Champion Gold', true);
    cells.push(cell);
    grid.appendChild(cell.node);
  }

  function syncSwatches() {
    var mine = SK.Ship.saved();
    var crowned = SK.Ship.isChampion();
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var on = c.locked ? crowned : (c.hex === mine);
      c.node.setAttribute('aria-checked', on ? 'true' : 'false');
      /* Only one cell is in the tab order, the way a radio group works: Tab
         reaches the group, arrows move within it. */
      c.node.tabIndex = (c.hex === mine && !c.locked) ? 0 : -1;
      if (on) c.node.classList.add('is-on'); else c.node.classList.remove('is-on');
    }
  }

  /* ---------------------------------------------------------------- state */

  function message(s) { el['sh-msg'].textContent = s || ''; }

  function syncCrown() {
    var note = el['sh-crown'];
    if (!SK.Ship.isChampion()) { note.hidden = true; note.textContent = ''; return; }
    note.hidden = false;
    /* Two different true sentences. A player who really is #1 is told what
       they hold and what happens when they lose it; a player previewing the
       hull via ?gold=1 is told it is a preview, because the alternative is a
       panel that congratulates them on a rank they do not have. */
    note.textContent = SK.Ship.isCrowned()
      ? 'You are #1. Your hull is gold while you hold the top spot - the colour below is what you fly when you lose it.'
      : 'Preview: this is the #1 hull. It is not yours until you top the leaderboard.';
  }

  function nameOfPlayer() {
    var s = SK.Online && SK.Online.state ? SK.Online.state() : null;
    return (s && s.username) || '';
  }

  function refresh() {
    syncSwatches();
    syncCrown();
    drawPreview();
  }

  function pick(hex, locked, name) {
    if (locked) {
      message('Gold belongs to whoever is #1. Top the leaderboard and it is yours.');
      return;
    }
    if (!SK.Ship.set(hex)) { message(''); return; }
    message(SK.Ship.isChampion()
      ? (name + ' saved. You will fly it as soon as you are not #1.')
      : (name + ' it is.'));
    /* Persisting to the account is best-effort and deliberately not awaited:
       the colour is already saved locally and already on screen. A slow or
       dead backend must not make a swatch tap feel slow. */
    pushToAccount(hex);
    refresh();
  }

  /* -------------------------------------------------------- account sync */

  /* The colour follows the ACCOUNT when there is one, so signing in on a
     phone gets you the ship you painted on a laptop. Every call here is
     optional in the strongest sense: SK.Online may not exist, may not be
     configured, may be signed out, and the `ship_colour` column may not have
     been added to a given Supabase project at all. Each of those is a silent
     no-op, never an error on screen, because the local copy is the one that
     actually drives the renderer. */
  function pushToAccount(hex) {
    if (!SK.Online || typeof SK.Online.saveShipColour !== 'function') return;
    try { SK.Online.saveShipColour(hex); } catch (e) { /* ignore */ }
  }

  function pullFromAccount() {
    if (!SK.Online || typeof SK.Online.loadShipColour !== 'function') return;
    var p;
    try { p = SK.Online.loadShipColour(); } catch (e) { return; }
    if (!p || typeof p.then !== 'function') return;
    p.then(function (hex) {
      if (!hex || !SK.Ship.isSwatch(hex)) return;
      /* WHO WINS WHEN THE TWO DISAGREE.
         The account does - it is the more deliberate of the two - but only if
         this browser has never been painted. A local choice is something the
         player did on THIS device, and silently overwriting it with an older
         one from the server is the sync bug that makes people stop trusting
         a setting. So: adopt the account colour only over the untouched
         default, and otherwise push the local one up. */
      if (SK.Ship.isDefault()) { SK.Ship.set(hex); }
      else if (SK.Ship.saved() !== hex) { pushToAccount(SK.Ship.saved()); }
    }, function () { /* ignore */ });
  }

  /* ------------------------------------------------------------ the crown */

  /* WHO IS #1, AND WHAT IT COSTS TO ASK.
   *
   * One public read of the board's top row - the same view the leaderboard
   * panel renders, limit 1 - taken once at boot and again after each run
   * ends, which are the only two moments the answer can have changed in a way
   * the player would notice. No polling: a rank that updates while the title
   * screen sits idle is worth less than the battery it costs.
   *
   * Every failure path ends in setChampionName(''), i.e. "nobody known", i.e.
   * the player flies their own colour. Offline, unconfigured, 500, rate
   * limited and empty board are all the same state on purpose - there is one
   * degraded behaviour to reason about instead of five. */
  function refreshChampion() {
    if (!SK.Online || !SK.Online.isConfigured || !SK.Online.isConfigured()) {
      SK.Ship.setChampionName('');
      return;
    }
    SK.Online.topScores(1).then(function (rows) {
      var top = rows && rows[0];
      SK.Ship.setChampionName(top && top.rank === 1 ? top.username : '');
    }, function () {
      SK.Ship.setChampionName('');
    });
  }

  function syncPlayerName() {
    SK.Ship.setPlayerName(nameOfPlayer());
  }

  /* --------------------------------------------------------------- panel */

  function openPanel() {
    if (!wired || open) return;
    open = true;
    lastFocus = doc.activeElement;
    el.sh.hidden = false;
    el.sh.setAttribute('aria-hidden', 'false');
    message('');
    refresh();
    /* Asking again on open, not only at boot: the player may have just
       finished a run that put them on top. */
    refreshChampion();
    try { el['sh-close'].focus(); } catch (e) { /* ignore */ }
  }

  function closePanel() {
    if (!wired || !open) return;
    open = false;
    el.sh.hidden = true;
    el.sh.setAttribute('aria-hidden', 'true');
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* ignore */ }
    lastFocus = null;
  }

  /* aria-modal only describes intent. Without this, Tab walks straight out of
     the dialog and into the page behind it. Same implementation as the
     account panel's, deliberately not shared: two overlays that can never be
     open at once are not worth a module. */
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var focusable = el.sh.querySelectorAll('button:not([disabled])');
    var live = [];
    for (var i = 0; i < focusable.length; i++) {
      if (focusable[i].offsetParent !== null && focusable[i].tabIndex !== -1) {
        live.push(focusable[i]);
      }
    }
    if (!live.length) return;
    var first = live[0], last = live[live.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* Left/right (and up/down) move through the grid, which is what a
     role=radiogroup promises and what a keyboard user will try. */
  function arrows(e) {
    var d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1;
    if (!d) return;
    var at = -1, i;
    for (i = 0; i < cells.length; i++) {
      if (cells[i].node === doc.activeElement) { at = i; break; }
    }
    if (at < 0) return;
    e.preventDefault();
    /* Skips the locked cell in both directions: arrowing onto a colour that
       cannot be chosen is a dead end the keyboard has to back out of. */
    var n = cells.length, next = at;
    for (i = 0; i < n; i++) {
      next = (next + d + n) % n;
      if (!cells[next].locked) break;
    }
    cells[next].node.tabIndex = 0;
    cells[next].node.focus();
    pick(cells[next].hex, false, labelFor(cells[next].hex));
  }

  function labelFor(hex) {
    var list = SK.Ship.SWATCHES;
    for (var i = 0; i < list.length; i++) {
      if (list[i].hex === hex) return list[i].name;
    }
    return 'That colour';
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    if (!SK.Ship || !collect()) return;

    game = (global.__SKYHOOK && global.__SKYHOOK.game) || null;
    if (!game) return;

    buildSwatches();

    /* The game funnels every UI request through one callback. ui_online.js
       installs its own, and it boots FIRST (script order in index.html), so
       chaining rather than overwriting is the difference between adding a
       button and silently deleting the LEADERBOARD one. */
    var prev = typeof game.onUi === 'function' ? game.onUi : null;
    game.onUi = function (event, payload, g) {
      if (event === 'openShip') { openPanel(); return; }
      if (event === 'runEnded') refreshChampion();
      if (prev) prev(event, payload, g);
    };

    el['sh-close'].addEventListener('click', closePanel);
    el['sh-done'].addEventListener('click', closePanel);
    el['sh-reset'].addEventListener('click', function () {
      if (SK.Ship.reset()) { pushToAccount(SK.Ship.saved()); message('Back to Signal Cyan.'); }
      else message('Already the default.');
      refresh();
    });

    /* Backdrop click closes, panel click does not. */
    el.sh.addEventListener('click', function (e) {
      if (e.target === el.sh) closePanel();
    });

    el['sh-swatches'].addEventListener('keydown', arrows);

    doc.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
      trapTab(e);
    });

    /* Repaint on every appearance change, whoever caused it: a swatch tap
       here, a colour arriving from the account, or the crown changing hands
       mid-session while the panel sits open. */
    SK.Ship.onChange(function () {
      if (open) { syncSwatches(); syncCrown(); drawPreview(); }
    });

    if (SK.Online && typeof SK.Online.on === 'function') {
      SK.Online.on('auth', function () {
        syncPlayerName();
        pullFromAccount();
        refreshChampion();
      });
    }

    wired = true;

    /* The local-only escape hatch that lets the gold hull be seen without
       first being earned. Cosmetic, per-load, never written anywhere. */
    try {
      if (String(global.location && global.location.search || '').indexOf('gold=1') >= 0) {
        SK.Ship.forceChampion(true);
      }
    } catch (e) { /* ignore */ }

    syncPlayerName();
    refreshChampion();
    pullFromAccount();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* A handle for the harness and for anything that wants to open the panel
     without a synthetic tap on a canvas. */
  SK.UIShip = {
    open: openPanel,
    close: closePanel,
    isOpen: function () { return open; },
    refreshChampion: refreshChampion
  };

}(typeof window !== 'undefined' ? window : this));
