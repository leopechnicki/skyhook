/* SKYHOOK - the account / leaderboard overlay.
 *
 * The bridge between three things that must not know about each other:
 *   js/game.js     draws on a canvas and owns the run
 *   js/online.js   speaks HTTP to Supabase and owns the session
 *   index.html     holds a form the player types into
 *
 * The whole module is a no-op unless BOTH of these are true:
 *   1. js/config.js has a real project URL and anon key, and
 *   2. the page is served over http(s).
 * The second condition is not fussiness. Opened from file:// the page has a
 * null origin: every cross-origin fetch is refused by CORS and an OAuth
 * redirect has nowhere to come back to. Rather than let the player find that
 * out by tapping a button that throws, the account layer simply does not
 * appear, and SKYHOOK from a double-clicked index.html stays exactly the
 * offline game it has always been.
 */
(function (global) {
  'use strict';

  var SK = global.SK;
  if (!SK || !SK.Online) return;

  var doc = global.document;
  if (!doc) return;

  var Online = SK.Online;

  /* ------------------------------------------------------------- elements */
  var el = {};
  var IDS = ['ol', 'ol-close', 'ol-title', 'ol-board', 'ol-account', 'ol-list',
    'ol-board-msg', 'ol-myrank', 'ol-signin', 'ol-signout', 'ol-auth',
    'ol-google', 'ol-form', 'ol-username-field', 'ol-username', 'ol-email',
    'ol-password', 'ol-submit', 'ol-auth-msg', 'ol-toggle', 'ol-back'];

  /* Labels and hint lines. These are SOFT: unlike IDS above, a missing one
     must not switch the whole account layer off. GitHub Pages can serve a
     cached index.html against a fresh js/ui_online.js for a while after a
     deploy, and losing the leaderboard entirely because a hint paragraph has
     not landed yet would be a far worse bug than the wording being stale for
     one page load. Every read of these is null-guarded. */
  var SOFT_IDS = ['ol-email-label', 'ol-email-hint', 'ol-username-label',
    'ol-username-hint'];

  function collect() {
    for (var i = 0; i < IDS.length; i++) {
      var node = doc.getElementById(IDS[i]);
      if (!node) return false;          // markup missing: stay switched off
      el[IDS[i]] = node;
    }
    for (var j = 0; j < SOFT_IDS.length; j++) {
      el[SOFT_IDS[j]] = doc.getElementById(SOFT_IDS[j]) || null;
    }
    return true;
  }

  /* The whole point of this change: which field is the public name and which
     one is the credential. Split by mode because the useful sentence differs -
     on SIGN IN the player has already chosen both and needs to know which one
     the box wants; on CREATE ACCOUNT they are choosing them and need to know
     which one strangers will see. */
  var COPY = {
    signin: {
      emailLabel: 'Email you signed up with',
      emailHint: 'Not your leaderboard name.'
    },
    signup: {
      emailLabel: 'Email',
      /* No promise about a confirmation link here: the live project has
         Confirm email switched OFF (2026-09-17) precisely because the
         built-in SMTP only sends a few mails an hour and every sign-up
         was burning one. The client cannot know the server's setting
         until it answers, so this line says only what is true in BOTH
         configurations - the auth message after submit already tells
         the confirmation story on projects that require it. */
      emailHint: 'Your login. Never shown on the board.',
      usernameLabel: 'Username',
      usernameHint: 'Your public name on the leaderboard.'
    }
  };

  function setCopy(node, s) {
    if (node) node.textContent = s;
  }

  /* ---------------------------------------------------------------- state */
  var game = null;
  var open = false;
  var mode = 'signin';        // 'signin' | 'signup'
  var busy = false;
  var lastFocus = null;
  var loadedOnce = false;
  /* False until boot() has found the markup AND a configured backend. Every
     entry point below checks it, so on the shipped (config-less) build the
     SK.UI handles exist but are inert - calling one is a no-op, never a throw
     into js/main.js or into a devtools console. */
  var wired = false;

  function text(node, s, isError) {
    node.textContent = s || '';
    if (node.classList) {
      if (isError) node.classList.add('is-error');
      else node.classList.remove('is-error');
    }
  }

  /* The auth message line is the LAST element in #ol-auth - it renders below
     the submit button, inside a panel that is `max-height: 100%;
     overflow-y: auto`. On a short viewport (a phone in landscape, a laptop
     with a short window) the button the player just pressed is the last thing
     in view and the answer to it is painted off the bottom of the scroll
     area. A truthful message nobody can see is the same bug as no message, so
     the answer is scrolled to whenever one is written. */
  function revealAuthMsg() {
    var node = el['ol-auth-msg'];
    if (!node || !node.scrollIntoView) return;
    /* `block: 'nearest'` scrolls the panel only if the line is genuinely out
       of view, so a message that was already visible does not make the dialog
       jump under the player's hands. Older engines take a boolean here and
       ignore an object; the catch covers the ones that object to it. */
    try { node.scrollIntoView({ block: 'nearest' }); }
    catch (e) { try { node.scrollIntoView(false); } catch (e2) { /* ignore */ } }
  }

  /* Anything that reaches a player goes through here: one line, bounded
     length, never a stack trace or a backend message verbatim. */
  function safeMessage(err, fallback) {
    var m = '';
    if (typeof err === 'string') m = err;
    else if (err && err.message) m = err.message;
    m = String(m).split('\n')[0].trim().slice(0, 180);
    return m || fallback || 'Something went wrong. Try again.';
  }

  /* --------------------------------------------------------- game binding */

  function syncGame() {
    if (!game) return;
    var s = Online.state();
    game.online.signedIn = s.signedIn;
    game.online.username = s.username;
  }

  function setStatus(s) {
    if (game) game.online.status = s || '';
  }

  /* ------------------------------------------------------------ the board */

  function renderRows(rows) {
    var me = (Online.state().username || '').toLowerCase();
    var list = el['ol-list'];
    while (list.firstChild) list.removeChild(list.firstChild);

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = doc.createElement('li');
      li.className = 'ol-row' + (r.rank <= 3 ? ' is-top' : '') +
        (me && r.username.toLowerCase() === me ? ' is-me' : '');

      var rank = doc.createElement('span');
      rank.className = 'ol-rank';
      rank.textContent = '#' + r.rank;

      /* textContent, never innerHTML. Usernames are attacker-supplied strings
         from a public signup form; the schema restricts them to [A-Za-z0-9_]
         but this is the layer that would be exploited if that ever loosened,
         so it does not rely on it. */
      var name = doc.createElement('span');
      name.className = 'ol-name';
      name.textContent = r.username;

      var score = doc.createElement('span');
      score.className = 'ol-score';
      score.textContent = String(r.score);

      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(score);
      list.appendChild(li);
    }
  }

  function loadBoard() {
    text(el['ol-board-msg'], 'Loading...');
    return Online.topScores().then(function (rows) {
      loadedOnce = true;
      renderRows(rows);
      text(el['ol-board-msg'], rows.length ? '' : 'No scores yet. Be the first.');
      return Online.myRank();
    }).then(function (mine) {
      el['ol-myrank'].textContent = mine
        ? ('Your best: #' + mine.rank + ' with ' + mine.score)
        : '';
    }).catch(function (err) {
      renderRows([]);
      text(el['ol-board-msg'], safeMessage(err, 'Could not load the leaderboard.'), true);
      el['ol-myrank'].textContent = '';
    });
  }

  function refreshAccountLine() {
    var s = Online.state();
    el['ol-account'].textContent = s.signedIn
      ? ('Signed in as ' + (s.username || 'pilot'))
      : 'Playing as a guest - sign in to appear on the board.';
    el['ol-signin'].hidden = s.signedIn;
    el['ol-signout'].hidden = !s.signedIn;
  }

  /* ------------------------------------------------------------ the views */

  function showBoard() {
    el['ol-board'].hidden = false;
    el['ol-auth'].hidden = true;
    el['ol-title'].textContent = 'GLOBAL LEADERBOARD';
    refreshAccountLine();
    loadBoard();
  }

  function showAuth(next) {
    mode = next || 'signin';
    el['ol-board'].hidden = true;
    el['ol-auth'].hidden = false;
    el['ol-title'].textContent = mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN';
    el['ol-username-field'].hidden = mode !== 'signup';
    el['ol-submit'].textContent = mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN';

    var copy = mode === 'signup' ? COPY.signup : COPY.signin;
    setCopy(el['ol-email-label'], copy.emailLabel);
    setCopy(el['ol-email-hint'], copy.emailHint);
    if (mode === 'signup') {
      setCopy(el['ol-username-label'], COPY.signup.usernameLabel);
      setCopy(el['ol-username-hint'], COPY.signup.usernameHint);
    }
    el['ol-toggle'].textContent = mode === 'signup'
      ? 'I already have an account'
      : 'Create an account';
    /* The browser must be told which password this is, or it will offer to
       overwrite a saved password with a new one and vice versa. */
    el['ol-password'].setAttribute('autocomplete',
      mode === 'signup' ? 'new-password' : 'current-password');
    text(el['ol-auth-msg'], '');
    focusFirst();
  }

  function focusFirst() {
    var first = mode === 'signup' ? el['ol-username'] : el['ol-email'];
    try { first.focus(); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- open and close */

  function openOverlay(view) {
    if (!wired || open) return;
    open = true;
    lastFocus = doc.activeElement;
    el.ol.hidden = false;
    el.ol.setAttribute('aria-hidden', 'false');
    if (view === 'auth') showAuth('signin'); else showBoard();
    if (view !== 'auth') { try { el['ol-close'].focus(); } catch (e) {} }
  }

  function closeOverlay() {
    if (!wired || !open) return;
    open = false;
    el.ol.hidden = true;
    el.ol.setAttribute('aria-hidden', 'true');
    el['ol-password'].value = '';
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* ignore */ }
    lastFocus = null;
  }

  /* aria-modal only describes intent; without this it is a false promise and
     Tab walks straight out of the dialog into the page behind it. */
  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var focusable = el.ol.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    var live = [];
    for (var i = 0; i < focusable.length; i++) {
      if (focusable[i].offsetParent !== null) live.push(focusable[i]);
    }
    if (!live.length) return;
    var first = live[0], last = live[live.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* --------------------------------------------------------------- actions */

  function setBusy(on) {
    busy = on;
    el['ol-submit'].disabled = on;
    if (!el['ol-google'].hidden) el['ol-google'].disabled = on;
  }

  function onSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    var email = el['ol-email'].value;
    var password = el['ol-password'].value;
    var username = el['ol-username'].value;

    setBusy(true);
    text(el['ol-auth-msg'], mode === 'signup' ? 'Creating account...' : 'Signing in...');

    var p = mode === 'signup'
      ? Online.signUp(username, email, password)
      : Online.signIn(email, password);

    p.then(function (res) {
      setBusy(false);
      el['ol-password'].value = '';
      if (res && res.needsConfirmation) {
        /* Order matters and is the whole bug this once had: showAuth() resets
           the view, and resetting the view clears ol-auth-msg. Setting the
           message first meant it was wiped in the same tick, so a player who
           had just created an account was flipped back to a blank sign-in
           form with nothing on screen telling them an email was sent - and
           then their sign-in failed, because the address was unconfirmed.
           Switch the view first, then write the message into it. */
        showAuth('signin');
        text(el['ol-auth-msg'],
          'Account created. Confirm it from the email we just sent, then sign in.');
        revealAuthMsg();
        return;
      }
      syncGame();
      showBoard();
    }, function (err) {
      setBusy(false);
      /* The fallback has to follow the mode. "Could not sign in." on a failed
         CREATE ACCOUNT describes an action the player did not take, which is
         a small lie in the one place they are already confused. */
      text(el['ol-auth-msg'], safeMessage(err, mode === 'signup'
        ? 'Could not create that account.'
        : 'Could not sign in.'), true);
      revealAuthMsg();
    });
  }

  function onGoogle() {
    if (busy) return;
    setBusy(true);
    text(el['ol-auth-msg'], 'Opening Google...');
    /* This navigates away; the promise only fails if the URL could not even
       be built, which is why setBusy(false) lives in the failure path only. */
    Online.signInWithGoogle('google').catch(function (err) {
      setBusy(false);
      text(el['ol-auth-msg'], safeMessage(err, 'Could not start Google sign-in.'), true);
      revealAuthMsg();
    });
  }

  function onSignOut() {
    Online.signOut().then(function () {
      syncGame();
      showBoard();
    });
  }

  /* ------------------------------------------------------- run submission */

  function handleRunEnded(run) {
    var s = Online.state();
    if (!s.signedIn) {
      /* Park it. When they sign in, flushPending sends the best one, so
         choosing to make an account later never costs them the run that made
         them want one. */
      Online.submitRun(run);
      setStatus('sign in to put this run on the board');
      return;
    }

    setStatus('saving score...');
    Online.submitRun(run).then(function (res) {
      if (!res.submitted) {
        setStatus(res.queued ? 'saved here - will upload later' : 'score not saved');
        return null;
      }
      return Online.myRank().then(function (mine) {
        if (mine && mine.rank) {
          if (game) game.online.rank = mine.rank;
          setStatus('RANK #' + mine.rank + ' GLOBAL');
        } else {
          setStatus('score saved');
        }
        return null;
      });
    }).catch(function () {
      setStatus('score not saved');
    });
  }

  /* ------------------------------------------------------------- wiring */

  function onUi(event, payload) {
    if (event === 'openBoard') { openOverlay('board'); return; }
    if (event === 'runEnded') { handleRunEnded(payload); return; }
  }

  function boot() {
    if (!collect()) return;

    /* Two gates, both hard. Either one closed means no account layer at all -
       not a disabled button, not an error toast: absent. */
    var config = global.SKYHOOK_CONFIG;
    var configured = Online.configure(config);
    if (!configured || !Online.httpOrigin()) return;

    game = (global.__SKYHOOK && global.__SKYHOOK.game) || null;
    if (!game) return;

    game.online.ready = true;
    game.onUi = onUi;
    wired = true;

    el['ol-close'].addEventListener('click', closeOverlay);
    el['ol-back'].addEventListener('click', function () { showBoard(); });
    el['ol-signin'].addEventListener('click', function () { showAuth('signin'); });
    el['ol-signout'].addEventListener('click', onSignOut);

    /* Google is an extra opt-in in the Supabase dashboard, not something a
       project has by default - docs/LEADERBOARD_SETUP.md step 3 is a whole
       trip through Google Cloud, and skipping it is explicitly allowed. On a
       project that skipped it, pressing this button does NOT fail politely in
       the panel: Online.signInWithGoogle navigates the tab to GoTrue, which
       answers 400 {"msg":"Unsupported provider: provider is not enabled"} and
       renders it as raw JSON. The player is ejected out of the game onto a
       machine error, with the browser Back button as the only way home.
       So the button is opt-in here too: it exists only when the config states
       the provider actually does. Absent beats disabled, for the same reason
       the whole account layer is absent without a config rather than greyed
       out - an affordance that cannot work should not be drawn. */
    if (!config || config.googleSignIn !== true) {
      el['ol-google'].hidden = true;
      var orRule = doc.querySelector('#ol-auth .ol-or');
      if (orRule) orRule.hidden = true;
    } else {
      el['ol-google'].addEventListener('click', onGoogle);
    }
    el['ol-form'].addEventListener('submit', onSubmit);
    el['ol-toggle'].addEventListener('click', function () {
      showAuth(mode === 'signup' ? 'signin' : 'signup');
    });

    /* Clicking the darkened area outside the panel closes, the way every
       other dialog on the web does. */
    el.ol.addEventListener('click', function (e) {
      if (e.target === el.ol) closeOverlay();
    });

    doc.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') { closeOverlay(); return; }
      trapTab(e);
    });

    Online.on('auth', function () {
      syncGame();
      if (open && !el['ol-board'].hidden) refreshAccountLine();
    });

    Online.on('pending', function (res) {
      if (res && res.submitted) setStatus('earlier run uploaded');
    });

    /* Consumes an OAuth return if the page was just redirected back here,
       restores a saved session, and uploads anything left queued. */
    Online.init().then(function () {
      syncGame();
      if (open) showBoard();
    });
  }

  /* Exposed for js/main.js (the keyboard must belong to whoever is on top)
     and for test/leaderboard_ui.mjs. */
  SK.UI = {
    isOpen: function () { return open; },
    open: function (view) { openOverlay(view); },
    close: closeOverlay,
    reload: function () { return wired ? loadBoard() : Promise.resolve(); },
    loaded: function () { return loadedOnce; }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

}(window));
