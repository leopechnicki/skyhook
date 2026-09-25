/* SKYHOOK - the ship customiser.
 *
 * The form half of js/ship.js: four part tabs (nose / window / body / fire),
 * one swatch grid for whichever part is selected, a live preview of the real
 * rocket, and the crown. Real DOM rather than canvas for the same reason the
 * account panel is - a canvas-drawn control has no focus ring, no screen
 * reader, no keyboard and no tap target the platform understands.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DECIDE
 * ---------------------------------------
 *   - which colours exist          -> SK.Ship.SWATCHES
 *   - which parts exist            -> SK.Ship.PARTS
 *   - whether a pick is legal      -> SK.Ship.why(part, hex): '' or the reason
 *   - who is wearing the crown     -> SK.Ship.isChampion()
 *
 * A swatch that would make the ship unreadable - a pale window on a pale
 * hull, say - is shown GREYED with the reason as its label, and tapping it
 * says why instead of painting it. The grey is only the explanation: the
 * click routes through SK.Ship.set(), which asks the same why() and refuses,
 * so deleting the aria-disabled attribute in devtools changes nothing. The
 * gold chip is the same machine - rendered LOCKED, refused by set() because
 * GOLD is not in SWATCHES.
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
 * ONE PANEL, THREE DOORS
 * ----------------------
 * js/game.js emits 'openShip' from the title, the PAUSED screen and game
 * over; this file answers all three with the same panel. Nothing here knows
 * or cares which screen asked, and that is the point: opening it never
 * touches the game's state, so a paused run is still paused, to the tick,
 * when the panel closes, and the new paint is on the frozen rocket already
 * (js/rocket.js asks SK.Ship.current() on every draw). While it is open,
 * js/main.js keeps the keyboard away from the game - on PAUSED, space
 * would otherwise mean "resume" - and Esc closes the panel without
 * resuming anything.
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
  var IDS = ['sh', 'sh-close', 'sh-title', 'sh-canvas', 'sh-crown', 'sh-parts',
             'sh-swatches', 'sh-msg', 'sh-done', 'sh-reset'];

  var game = null;
  var open = false;
  var wired = false;
  var lastFocus = null;
  var part = 'body';         // the part the swatch grid is currently painting
  var tabs = [];             // one per part
  var cells = [];            // one per swatch, plus the locked gold cell

  function collect() {
    for (var i = 0; i < IDS.length; i++) {
      var node = doc.getElementById(IDS[i]);
      if (!node) return false;         // markup absent: no customiser at all
      el[IDS[i]] = node;
    }
    return true;
  }

  function label(p) { return SK.Ship.PART_INFO[p].label; }

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
       readability rule in js/ship.js is how these read against THIS. */
    var bg = ctx.createLinearGradient(0, 0, 0, c.height);
    bg.addColorStop(0, '#0a0d22');
    bg.addColorStop(1, '#05060f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);

    /* The preview always shows the player's OWN paint - it is what they are
       editing, and a preview that stayed gold while they tapped swatches
       would look exactly like a customiser that does nothing. While they
       wear the crown the gold ship is drawn beside it, smaller and labelled,
       because that is what they actually fly until somebody beats them.

       Nose up: draw() rotates by (ang + PI/2), so -PI/2 points the ship at
       the top of the panel and puts the plume underneath it. */
    var opts = { burn: PREVIEW_BURN, thrust: PREVIEW_THRUST, paint: SK.Ship.saved() };
    if (!SK.Ship.isChampion()) {
      SK.Rocket.draw(ctx, c.width / 2, c.height * 0.42, -Math.PI / 2, 15, PREVIEW_T, opts);
      return;
    }
    SK.Rocket.draw(ctx, c.width * 0.36, c.height * 0.42, -Math.PI / 2, 14, PREVIEW_T, opts);
    SK.Rocket.draw(ctx, c.width * 0.78, c.height * 0.36, -Math.PI / 2, 9, PREVIEW_T,
      { burn: PREVIEW_BURN, thrust: PREVIEW_THRUST, paint: SK.Ship.GOLD });
    ctx.save();
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,194,26,0.9)';
    ctx.fillText('#1 GOLD', c.width * 0.78, c.height * 0.92);
    ctx.fillStyle = 'rgba(200,225,245,0.8)';
    ctx.fillText('YOURS', c.width * 0.36, c.height * 0.92);
    ctx.restore();
  }

  /* ------------------------------------------------------------ part tabs */

  function buildTabs() {
    var bar = el['sh-parts'];
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    tabs = [];
    var parts = SK.Ship.PARTS;
    for (var i = 0; i < parts.length; i++) {
      (function (p) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'sh-part';
        b.setAttribute('role', 'tab');
        b.setAttribute('data-part', p);
        b.setAttribute('aria-controls', 'sh-swatches');
        var dot = doc.createElement('span');
        dot.className = 'sh-dot';
        b.appendChild(dot);
        var cap = doc.createElement('span');
        cap.className = 'sh-cap';
        cap.textContent = label(p);
        b.appendChild(cap);
        b.addEventListener('click', function () { choosePart(p); });
        tabs.push({ node: b, part: p, dot: dot });
        bar.appendChild(b);
      }(parts[i]));
    }
  }

  function syncTabs() {
    var mine = SK.Ship.saved();
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i], on = t.part === part;
      t.node.setAttribute('aria-selected', on ? 'true' : 'false');
      t.node.tabIndex = on ? 0 : -1;
      /* Each tab carries its part's current colour, so the four choices can
         be read at a glance without opening each one. */
      t.dot.style.background = mine[t.part];
      t.node.setAttribute('aria-label', label(t.part) + ': ' + SK.Ship.nameOf(mine[t.part]));
      if (on) t.node.classList.add('is-on'); else t.node.classList.remove('is-on');
    }
    el['sh-swatches'].setAttribute('aria-label', label(part) + ' colour');
  }

  function choosePart(p) {
    if (!SK.Ship.PART_INFO[p] || p === part) return;
    part = p;
    message('');
    refresh();
  }

  /* -------------------------------------------------------------- swatches */

  function makeCell(hex, name, locked) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'sh-swatch' + (locked ? ' is-locked' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('data-hex', hex);
    b.title = locked ? (name + ' - top the leaderboard') : name;

    var dot = doc.createElement('span');
    dot.className = 'sh-dot';
    dot.style.background = hex;
    b.appendChild(dot);

    var cap = doc.createElement('span');
    cap.className = 'sh-cap';
    cap.textContent = locked ? '#1' : name;
    b.appendChild(cap);

    var cell = { node: b, hex: hex, name: name, locked: !!locked, blocked: '' };
    b.addEventListener('click', function () { pick(cell); });
    return cell;
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
    var mine = SK.Ship.saved()[part];
    var crowned = SK.Ship.isChampion();
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var on = c.locked ? crowned : (c.hex === mine);
      /* Re-asked on every sync, not cached: whether Ice is a legal WINDOW
         depends on what the BODY is right now. */
      c.blocked = (c.locked || on) ? '' : SK.Ship.why(part, c.hex);
      c.node.setAttribute('aria-checked', on ? 'true' : 'false');
      /* The accessible name is the colour's name, not its hex. "Magenta" is
         the thing a screen-reader user can act on; "#ff7edb" is not. A
         refused colour says why in the same breath. */
      c.node.setAttribute('aria-label', c.locked ? (c.name + ' - number one only')
        : (c.blocked ? (c.name + ' - unavailable: ' + c.blocked) : c.name));
      if (c.blocked) {
        c.node.setAttribute('aria-disabled', 'true');
        c.node.classList.add('is-blocked');
        c.node.title = c.name + ' - ' + c.blocked;
      } else {
        c.node.removeAttribute('aria-disabled');
        c.node.classList.remove('is-blocked');
        c.node.title = c.locked ? (c.name + ' - top the leaderboard') : c.name;
      }
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
      ? 'You are #1. Your whole ship is gold while you hold the top spot - the paint you choose here is what you fly when you lose it.'
      : 'Preview: this is the #1 hull. It is not yours until you top the leaderboard.';
  }

  function nameOfPlayer() {
    var s = SK.Online && SK.Online.state ? SK.Online.state() : null;
    return (s && s.username) || '';
  }

  function refresh() {
    syncTabs();
    syncSwatches();
    syncCrown();
    drawPreview();
  }

  function pick(cell) {
    if (cell.locked) {
      message('Gold belongs to whoever is #1. Top the leaderboard and it is yours.');
      return;
    }
    if (!SK.Ship.set(part, cell.hex)) {
      /* Refused or already set. why() tells the two apart. */
      message(SK.Ship.why(part, cell.hex));
      return;
    }
    message(SK.Ship.isChampion()
      ? (label(part) + ': ' + cell.name + ' saved. You will fly it as soon as you are not #1.')
      : (label(part) + ': ' + cell.name + '.'));
    /* Persisting to the account is best-effort and deliberately not awaited:
       the paint is already saved locally and already on screen. A slow or
       dead backend must not make a swatch tap feel slow. */
    pushToAccount();
    refresh();
  }

  /* -------------------------------------------------------- account sync */

  /* The paint follows the ACCOUNT when there is one, so signing in on a
     phone gets you the ship you painted on a laptop. Every call here is
     optional in the strongest sense: SK.Online may not exist, may not be
     configured, may be signed out, and the ship_* columns may not have been
     added to a given Supabase project at all. Each of those is a silent
     no-op, never an error on screen, because the local copy is the one that
     actually drives the renderer. */
  function pushToAccount() {
    if (!SK.Online || typeof SK.Online.saveShipPaint !== 'function') return;
    try { SK.Online.saveShipPaint(SK.Ship.toStored()); } catch (e) { /* ignore */ }
  }

  function pullFromAccount() {
    if (!SK.Online || typeof SK.Online.loadShipPaint !== 'function') return;
    var p;
    try { p = SK.Online.loadShipPaint(); } catch (e) { return; }
    if (!p || typeof p.then !== 'function') return;
    p.then(function (row) {
      if (!row) return;
      /* A row that has never been painted is all empty strings. It says
         nothing, so it must not be read as "the account wants the default"
         and flatten a ship this browser has already painted. */
      var any = false;
      for (var i = 0; i < SK.Ship.PARTS.length; i++) { if (row[SK.Ship.PARTS[i]]) any = true; }
      /* WHO WINS WHEN THE TWO DISAGREE.
         The account does - it is the more deliberate of the two - but only if
         this browser has never been painted. A local choice is something the
         player did on THIS device, and silently overwriting it with an older
         one from the server is the sync bug that makes people stop trusting
         a setting. So: adopt the account paint only over the untouched
         default, and otherwise push the local one up. setPaint() runs the
         row through the same gate a tap goes through, so a stored
         combination that would not read is corrected before it is drawn. */
      if (any && SK.Ship.isDefault()) { SK.Ship.setPaint(row); return; }
      if (!SK.Ship.isDefault()) {
        var mine = SK.Ship.saved(), differs = false;
        for (var j = 0; j < SK.Ship.PARTS.length; j++) {
          var k = SK.Ship.PARTS[j];
          if (String(row[k] || SK.Ship.DEFAULT) !== mine[k]) differs = true;
        }
        if (differs) pushToAccount();
      }
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
   * the player flies their own paint. Offline, unconfigured, 500, rate
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

  function step(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return -1;
    return 0;
  }

  /* Left/right (and up/down) move through the grid, which is what a
     role=radiogroup promises and what a keyboard user will try. */
  function arrows(e) {
    var d = step(e);
    if (!d) return;
    var at = -1, i;
    for (i = 0; i < cells.length; i++) {
      if (cells[i].node === doc.activeElement) { at = i; break; }
    }
    if (at < 0) return;
    e.preventDefault();
    /* Skips the locked cell and every refused one, in both directions:
       arrowing onto a colour that cannot be chosen is a dead end the
       keyboard has to back out of. The current colour is never refused, so
       there is always somewhere to land. */
    var n = cells.length, next = at;
    for (i = 0; i < n; i++) {
      next = (next + d + n) % n;
      if (!cells[next].locked && !cells[next].blocked) break;
    }
    cells[next].node.tabIndex = 0;
    cells[next].node.focus();
    pick(cells[next]);
  }

  /* The part tabs are a tablist: arrows move between them and select. */
  function tabArrows(e) {
    var d = step(e);
    if (!d) return;
    var at = -1, i;
    for (i = 0; i < tabs.length; i++) { if (tabs[i].part === part) { at = i; break; } }
    if (at < 0) return;
    e.preventDefault();
    var next = tabs[(at + d + tabs.length) % tabs.length];
    choosePart(next.part);
    next.node.focus();
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    if (!SK.Ship || !collect()) return;

    game = (global.__SKYHOOK && global.__SKYHOOK.game) || null;
    if (!game) return;

    buildTabs();
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
      if (SK.Ship.reset()) { pushToAccount(); message('Back to Signal Cyan on every part.'); }
      else message('Already the default.');
      refresh();
    });

    /* Backdrop click closes, panel click does not - and only a click whose
       pointerdown was ALSO on the backdrop. Same Android WebView behaviour
       as js/ui_online.js: the click synthesised after the tap that opened the
       panel is targeted at whatever is under the finger by then. Today the
       panel covers every CUSTOMISE button, so that click lands on the panel
       and is ignored; the guard keeps it that way when the layout moves. */
    var downOnBackdrop = false;
    el.sh.addEventListener('pointerdown', function (e) { downOnBackdrop = (e.target === el.sh); });
    el.sh.addEventListener('click', function (e) {
      var armed = downOnBackdrop;
      downOnBackdrop = false;
      if (e.target === el.sh && armed) closePanel();
    });

    el['sh-swatches'].addEventListener('keydown', arrows);
    el['sh-parts'].addEventListener('keydown', tabArrows);

    doc.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { e.preventDefault(); closePanel(); return; }
      trapTab(e);
    });

    /* Repaint on every appearance change, whoever caused it: a swatch tap
       here, a paint arriving from the account, or the crown changing hands
       mid-session while the panel sits open. */
    SK.Ship.onChange(function () {
      if (open) refresh();
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
    part: function () { return part; },
    choosePart: choosePart,
    refreshChampion: refreshChampion
  };

}(typeof window !== 'undefined' ? window : this));
