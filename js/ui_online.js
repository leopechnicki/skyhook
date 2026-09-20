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
    'ol-username-hint', 'ol-forgot', 'ol-email-field', 'ol-password-field',
    'ol-password-label'];

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
    },
    /* Asking for the link. The email is the ONLY field, so the hint has to do
       the work the missing password box used to: say which of the two names
       this is, because the player who needs this screen is by definition the
       one who has already got them confused. */
    reset: {
      emailLabel: 'Email you signed up with',
      emailHint: 'Not your leaderboard name. We will send a link to it.'
    },
    /* Back from the link, choosing a new password. No email field: the link
       already proved which account this is, and showing an editable address
       would invite someone to think they can retarget it. */
    recover: {
      emailLabel: 'Email you signed up with',
      emailHint: 'Not your leaderboard name.'
    }
  };

  /* Everything that differs per mode, in one table instead of scattered
     ternaries. Four modes made the old `mode === 'signup' ? a : b` pattern
     wrong by construction - a two-way ternary cannot answer a four-way
     question, and the failure mode is silent: RESET PASSWORD would have
     quietly rendered the sign-in wording. */
  var MODES = {
    signin: {
      title: 'SIGN IN', submit: 'SIGN IN', busy: 'Signing in...',
      fields: { username: false, email: true, password: true },
      passwordAutocomplete: 'current-password',
      toggle: 'Create an account', showForgot: true,
      fallback: 'Could not sign in.'
    },
    signup: {
      title: 'CREATE ACCOUNT', submit: 'CREATE ACCOUNT', busy: 'Creating account...',
      fields: { username: true, email: true, password: true },
      passwordAutocomplete: 'new-password',
      toggle: 'I already have an account', showForgot: false,
      fallback: 'Could not create that account.'
    },
    reset: {
      title: 'RESET PASSWORD', submit: 'SEND RESET LINK', busy: 'Sending...',
      fields: { username: false, email: true, password: false },
      passwordAutocomplete: 'current-password',
      toggle: 'Back to sign in', showForgot: false,
      fallback: 'Could not send a reset link.'
    },
    recover: {
      title: 'SET A NEW PASSWORD', submit: 'SET PASSWORD', busy: 'Saving...',
      fields: { username: false, email: false, password: true },
      passwordAutocomplete: 'new-password',
      toggle: 'Cancel', showForgot: false,
      fallback: 'Could not set that password.'
    }
  };

  function setCopy(node, s) {
    if (node) node.textContent = s;
  }

  /* ---------------------------------------------------------------- state */
  var game = null;
  var open = false;
  var mode = 'signin';        // a key of MODES
  var busy = false;
  var lastFocus = null;
  var loadedOnce = false;
  /* A one-shot line to leave on the board view once it has finished loading.
     It exists because showBoard() -> loadBoard() is ASYNCHRONOUS: anything
     written into #ol-board-msg by the caller is overwritten a few hundred
     milliseconds later when the fetch resolves. That is the same shape as the
     "Account created" bug in onSubmit below - a true sentence painted into an
     element that is about to be cleared - and the one message that must not
     vanish that way is "your password was changed", because a player who does
     not see it has no way to tell whether the thing they came back to do
     actually happened. */
  var boardNotice = '';
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
    /* Taken and cleared up front, so a later reload() cannot resurrect a
       confirmation for something that happened minutes ago. */
    var notice = boardNotice;
    boardNotice = '';
    text(el['ol-board-msg'], notice || 'Loading...');
    return Online.topScores().then(function (rows) {
      loadedOnce = true;
      renderRows(rows);
      text(el['ol-board-msg'], notice || (rows.length ? '' : 'No scores yet. Be the first.'));
      return Online.myRank();
    }).then(function (mine) {
      el['ol-myrank'].textContent = mine
        ? ('Your best: #' + mine.rank + ' with ' + mine.score)
        : '';
    }).catch(function (err) {
      renderRows([]);
      /* The load failure wins this line: it is the actionable one, and the
         notice it displaces is not the only evidence - a password change
         leaves the player signed in, which #ol-account states by name. */
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

  function showBoard(notice) {
    boardNotice = notice || '';
    el['ol-board'].hidden = false;
    el['ol-auth'].hidden = true;
    el['ol-title'].textContent = 'GLOBAL LEADERBOARD';
    refreshAccountLine();
    loadBoard();
  }

  /* Hiding a field means hiding its whole .ol-field wrapper - label, input and
     hint together. Hiding the input alone would leave an orphan label
     captioning nothing, which reads as a rendering bug. The wrapper ids are
     SOFT, so an index.html that predates them degrades to showing a field
     rather than to no account layer at all. */
  function setField(wrapperId, inputId, show) {
    var wrap = el[wrapperId];
    if (wrap) wrap.hidden = !show;
    var input = el[inputId];
    /* A hidden required-looking input must also leave the tab order, or the
       focus trap will park the keyboard on a box nobody can see. */
    if (input) input.disabled = !show;
  }

  function showAuth(next) {
    var spec = MODES[next] || MODES.signin;
    mode = MODES[next] ? next : 'signin';

    el['ol-board'].hidden = true;
    el['ol-auth'].hidden = false;
    el['ol-title'].textContent = spec.title;
    el['ol-submit'].textContent = spec.submit;

    el['ol-username-field'].hidden = !spec.fields.username;
    el['ol-username'].disabled = !spec.fields.username;
    setField('ol-email-field', 'ol-email', spec.fields.email);
    setField('ol-password-field', 'ol-password', spec.fields.password);

    var copy = COPY[mode] || COPY.signin;
    setCopy(el['ol-email-label'], copy.emailLabel);
    setCopy(el['ol-email-hint'], copy.emailHint);
    if (spec.fields.username) {
      setCopy(el['ol-username-label'], COPY.signup.usernameLabel);
      setCopy(el['ol-username-hint'], COPY.signup.usernameHint);
    }
    setCopy(el['ol-password-label'], mode === 'recover' ? 'New password' : 'Password');

    el['ol-toggle'].textContent = spec.toggle;
    /* Only on SIGN IN. On CREATE ACCOUNT there is no password to have
       forgotten; on the two reset views the player is already inside the
       flow the link would start. */
    if (el['ol-forgot']) el['ol-forgot'].hidden = !spec.showForgot;

    /* The browser must be told which password this is, or it will offer to
       overwrite a saved password with a new one and vice versa. On the
       recovery view getting this wrong is the difference between the browser
       offering to save the password the player just chose and it quietly
       filling in the old one they cannot remember. */
    el['ol-password'].setAttribute('autocomplete', spec.passwordAutocomplete);

    text(el['ol-auth-msg'], '');
    focusFirst();
  }

  function focusFirst() {
    var spec = MODES[mode] || MODES.signin;
    var first = spec.fields.username ? el['ol-username']
      : (spec.fields.email ? el['ol-email'] : el['ol-password']);
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

  /* EVERY way out of SET A NEW PASSWORD that is not "I set one".
   *
   * A recovery link hands over a real, persisted session before the player
   * has chosen a password - that is how they get to the form at all. So any
   * exit that just closes the view leaves them signed in to an account whose
   * password they still do not know, which is precisely the state Klaudia was
   * in when she gave up and made a second account. The Cancel link used to be
   * the only door that cleaned up; the X, the Escape key, a click on the
   * backdrop and "Back to leaderboard" were three more doors out of the same
   * room, all of them leaving the trap armed - and worse than the original,
   * because `recovering` lives in memory only, so one reload turns the
   * half-finished recovery into an ordinary-looking signed-in session with no
   * evidence anything was skipped.
   *
   * Hence one funnel rather than a guard bolted onto each exit: a fifth door
   * added later gets the behaviour for free, which a fourth copy of the same
   * three lines would not. */
  function abandonRecovery(after) {
    var done = after || function () { /* nothing to do afterwards */ };
    if (!Online.isRecovering || !Online.isRecovering()) { done(); return; }
    Online.signOut().then(function () { syncGame(); done(); }, function () { done(); });
  }

  function closeOverlay() {
    if (!wired || !open) return;
    open = false;
    el.ol.hidden = true;
    el.ol.setAttribute('aria-hidden', 'true');
    el['ol-password'].value = '';
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* ignore */ }
    lastFocus = null;
    /* After the panel is visually gone: closing must feel instant, and the
       sign-out is a network round trip. Online.signOut() drops the local
       session first and unconditionally, so the trap is disarmed even if the
       request never lands. */
    abandonRecovery();
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
    var spec = MODES[mode] || MODES.signin;

    setBusy(true);
    text(el['ol-auth-msg'], spec.busy);

    /* ---- ask for a reset link ----
       Answers the SAME way whether or not that address has an account, and
       the wording is chosen to be true in both cases: "if there is an account"
       is not a hedge, it is the only honest thing that can be said from the
       client, which is never told which it was. Anything more definite would
       turn this box into a way to ask the server who plays this game. */
    if (mode === 'reset') {
      Online.requestPasswordReset(email).then(function () {
        setBusy(false);
        text(el['ol-auth-msg'],
          'If there is an account for that address, a reset link is on its way. ' +
          'Check your inbox and your spam folder, then open the link in this browser.');
        revealAuthMsg();
      }, function (err) {
        setBusy(false);
        text(el['ol-auth-msg'], safeMessage(err, spec.fallback), true);
        revealAuthMsg();
      });
      return;
    }

    /* ---- set the new password, back from the link ---- */
    if (mode === 'recover') {
      Online.setNewPassword(password).then(function () {
        setBusy(false);
        el['ol-password'].value = '';
        syncGame();
        showBoard('Password updated. You are signed in.');
      }, function (err) {
        setBusy(false);
        text(el['ol-auth-msg'], safeMessage(err, spec.fallback), true);
        revealAuthMsg();
      });
      return;
    }

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

      /* THE DEAD END, and the reported bug.
         "That email already has an account. Sign in instead." is true and it
         is where the conversation used to stop. The player it is shown to has
         just demonstrated they think they do not have an account, so the odds
         that they remember its password are poor - and "sign in instead" sends
         them to a form they cannot complete, with nothing on it that leads
         anywhere else. Leo walked exactly this path: "it says my account is
         created but i don't have password".
         So carry them to SIGN IN with the address they typed already in the
         box, and name the door out in the same breath. */
      if (mode === 'signup' && Online.isEmailTaken && Online.isEmailTaken(err)) {
        var typed = el['ol-email'].value;
        showAuth('signin');            // resets the view, and clears the message
        el['ol-email'].value = typed;  // ...so re-fill and re-write after it
        el['ol-password'].value = '';
        text(el['ol-auth-msg'],
          'That email already has an account. Sign in below - or if you do not ' +
          'know the password, use "Forgot password?" to set a new one.', true);
        revealAuthMsg();
        return;
      }

      /* The fallback has to follow the mode. "Could not sign in." on a failed
         CREATE ACCOUNT describes an action the player did not take, which is
         a small lie in the one place they are already confused. */
      text(el['ol-auth-msg'], safeMessage(err, (MODES[mode] || MODES.signin).fallback), true);
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
    /* "Back to leaderboard" is shown on the recovery view too, so it is one of
       the doors out of it - and going back to the board is exactly the move
       that hides the unfinished step from the player. */
    el['ol-back'].addEventListener('click', function () {
      abandonRecovery(function () { showBoard(); });
    });
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
      /* Four modes, so the toggle is a small map rather than a flip. From the
         two reset views it means "take me back", not "show me the other
         form". */
      if (mode === 'signup') { showAuth('signin'); return; }
      if (mode === 'reset') { showAuth('signin'); return; }
      if (mode === 'recover') { abandonRecovery(function () { showBoard(); }); return; }
      showAuth('signup');
    });

    if (el['ol-forgot']) {
      el['ol-forgot'].addEventListener('click', function () {
        var typed = el['ol-email'].value;
        showAuth('reset');
        /* Carry the address across. Somebody who just failed to sign in has
           already typed it, and making them type it again is the kind of
           small friction that ends the attempt. */
        el['ol-email'].value = typed;
        try { el['ol-email'].focus(); } catch (e) { /* ignore */ }
      });
    }

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

    /* The player has just arrived back from a recovery link. This is the one
       case where the game opens the overlay by itself: they clicked a link
       expecting to fix their password, and dropping them on the title screen
       with a silent session would leave the thing they came to do undone and
       invisible. */
    Online.on('recovery', function () {
      openOverlay('auth');
      showAuth('recover');
      text(el['ol-auth-msg'],
        'Link confirmed. Choose a new password to finish.');
      revealAuthMsg();
    });

    /* A dead link reports through the error channel instead, and has to say
       so somewhere the player is looking. */
    Online.on('error', function (msg) {
      if (!msg) return;
      openOverlay('auth');
      showAuth('signin');
      text(el['ol-auth-msg'], safeMessage(msg, 'Something went wrong. Try again.'), true);
      revealAuthMsg();
    });

    /* Consumes an OAuth return if the page was just redirected back here,
       restores a saved session, and uploads anything left queued. */
    Online.init().then(function () {
      syncGame();
      /* `!Online.isRecovering()` is not defensive tidiness - without it the
         recovery flow is silently undone. The 'recovery' listener above fires
         from INSIDE init(), opens the panel and shows the new-password form;
         this line then runs when init() resolves a moment later and would
         switch the very same panel to the leaderboard. The player would watch
         the form they came back for appear and vanish, and be left signed in
         with the password they could not remember - the original bug, rebuilt
         out of two correct-looking pieces. Caught by section D2 of
         test/leaderboard_ui.mjs, which is why that test asserts on the title. */
      if (open && !Online.isRecovering()) showBoard();
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
