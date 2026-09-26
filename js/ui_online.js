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
    'ol-password-label', 'ol-account-links', 'ol-edit-name', 'ol-edit-password',
    'ol-password2-field', 'ol-password2', 'ol-password2-label'];

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
      emailHint: 'Not your leaderboard name.',
      passwordLabel: 'New password'
    },
    /* Renaming. The hint is not the sign-up one: the question a player asks
       before pressing this is "what happens to my scores?", and the answer -
       nothing, they follow the name - is the whole reason renaming is safe to
       offer. It is true because the board is a view over profiles; if that
       ever changes, this sentence becomes a lie and supabase/schema.sql
       section 7 is where it would be broken. */
    username: {
      usernameLabel: 'New username',
      usernameHint: 'Your public name. Your past scores follow it. Five changes a day.'
    },
    /* Two password boxes, and which is which is the thing to get right: the
       top one is the credential being PROVEN, the bottom one the credential
       being SET. Labelling both "Password" would be the same class of mistake
       as the email/username muddle these labels exist to fix. */
    password: {
      passwordLabel: 'Current password',
      password2Label: 'New password'
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
    },
    /* The two account-settings views. They are modes of the same form rather
       than a panel of their own on purpose: the field machinery, the busy
       state, the error line and the focus trap below all already work, and a
       parallel copy of them is a second place for the truthful-message rule
       to be forgotten. */
    username: {
      title: 'CHANGE USERNAME', submit: 'SAVE NAME', busy: 'Saving...',
      fields: { username: true, email: false, password: false },
      passwordAutocomplete: 'current-password',
      toggle: 'Cancel', showForgot: false,
      fallback: 'Could not change that name.'
    },
    password: {
      title: 'CHANGE PASSWORD', submit: 'CHANGE PASSWORD', busy: 'Changing...',
      fields: { username: false, email: false, password: true, password2: true },
      passwordAutocomplete: 'current-password',
      toggle: 'Cancel', showForgot: false,
      fallback: 'Could not change that password.'
    },
    /* An account that signs in with Google has no password to type, so this
       view has no boxes at all - it explains that and offers the one thing
       that does work, the emailed link. A disabled password form with an
       apology under it would be the dead form the brief rules out. */
    setPassword: {
      title: 'ACCOUNT PASSWORD', submit: 'EMAIL ME A LINK', busy: 'Sending...',
      fields: { username: false, email: false, password: false },
      passwordAutocomplete: 'new-password',
      toggle: 'Cancel', showForgot: false,
      fallback: 'Could not send that link.'
    }
  };

  function setCopy(node, s) {
    if (node) node.textContent = s;
  }

  /* ---------------------------------------------------------------- state */
  var game = null;
  var open = false;
  /* Backdrop-dismiss guard, see the pointerdown/click wiring below. Reset
     on every open/close so a pointerdown that never got its click (Escape,
     pointercancel) cannot arm the next open. */
  var downOnBackdrop = false;
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

  /* `admin` is true only when the SERVER said so (Online.isAdmin) and the
     rows came from the admin board. Everyone else gets exactly the rows they
     always had: no extra element, no extra class, nothing to find in the DOM. */
  function renderRows(rows, admin) {
    var me = (Online.state().username || '').toLowerCase();
    var list = el['ol-list'];
    while (list.firstChild) list.removeChild(list.firstChild);
    modOpen = null;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var li = doc.createElement('li');
      li.className = 'ol-row' + (r.rank && r.rank <= 3 ? ' is-top' : '') +
        (me && r.username.toLowerCase() === me ? ' is-me' : '') +
        (admin && r.banned ? ' is-banned' : '');

      var rank = doc.createElement('span');
      rank.className = 'ol-rank';
      /* A banned account has no rank - the public board does not list it at
         all. The admin sees it last, marked, so it can be found and unbanned. */
      rank.textContent = r.rank ? '#' + r.rank : '--';

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
      if (admin && r.banned) {
        var tag = doc.createElement('span');
        tag.className = 'ol-tag';
        tag.textContent = 'BANNED';
        li.appendChild(tag);
      }
      li.appendChild(score);
      /* No control on your own row or another admin's: the server refuses
         both, so drawing a button for them would be drawing a lie. */
      if (admin && r.userId && !r.isAdmin) li.appendChild(modButton(r, li));
      list.appendChild(li);
    }
  }

  /* ----------------------------------------------------- moderation (admin)
   * One small "Manage" button per row opens an action strip directly under
   * that row: Ban (or Unban) / Delete / Cancel. Ban is reversible and runs on
   * the tap. Delete is not, so it asks once more, naming the account and what
   * goes with it, before anything is sent. One strip open at a time. */
  var modOpen = null;          // the strip <li> currently open, if any

  function closeMod() {
    /* If focus is inside the strip, hand it back to the row's Manage button
       before the strip goes - otherwise it falls to <body> and a keyboard or
       screen-reader user is thrown to the top of the panel. */
    try {
      if (modOpen && modOpen.opener && modOpen.contains(doc.activeElement)) modOpen.opener.focus();
    } catch (e) { /* ignore */ }
    if (modOpen && modOpen.parentNode) modOpen.parentNode.removeChild(modOpen);
    if (modOpen && modOpen.opener) modOpen.opener.setAttribute('aria-expanded', 'false');
    modOpen = null;
  }

  function modButton(r, li) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'ol-mod';
    b.textContent = 'Manage';
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', 'Manage ' + r.username);
    b.addEventListener('click', function () {
      var wasMine = modOpen && modOpen.opener === b;
      closeMod();
      if (!wasMine) openMod(r, li, b);
    });
    return b;
  }

  function modAction(label, cls, fn) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'ol-modbtn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function openMod(r, li, opener) {
    var bar = doc.createElement('li');
    bar.className = 'ol-modbar';
    bar.opener = opener;
    opener.setAttribute('aria-expanded', 'true');

    function actions() {
      while (bar.firstChild) bar.removeChild(bar.firstChild);
      /* The name is on the buttons so the one-tap action can never be read
         as belonging to the row above or below the strip. */
      bar.appendChild(r.banned
        ? modAction('Unban ' + r.username, '', function () {
          run(Online.unbanUser(r.userId), r.username + ' is back on the board.');
        })
        : modAction('Ban ' + r.username, 'is-warn', function () {
          run(Online.banUser(r.userId, 'suspected bot'),
            r.username + ' is banned: off the board, and cannot submit. Unban from this list.');
        }));
      bar.appendChild(modAction('Delete ' + r.username, 'is-danger', confirmDelete));
      bar.appendChild(modAction('Cancel', '', closeMod));
    }

    function confirmDelete() {
      while (bar.firstChild) bar.removeChild(bar.firstChild);
      var q = doc.createElement('p');
      q.className = 'ol-modq';
      q.textContent = 'Delete ' + r.username + ' for good? The account and every run go. This cannot be undone.';
      bar.appendChild(q);
      var yes = modAction('Yes, delete', 'is-danger', function () {
        run(Online.deleteUser(r.userId), r.username + ' was deleted.');
      });
      var keep = modAction('Keep', '', function () {
        actions();
        try { bar.querySelector('button').focus(); } catch (e) { /* ignore */ }
      });
      bar.appendChild(yes);
      bar.appendChild(keep);
      /* "Yes, delete" renders where "Delete" was just tapped. So a double tap
         or a held Enter must not be able to answer the question: focus goes
         to the safe choice, and the destructive one wakes up after a beat. */
      yes.disabled = true;
      setTimeout(function () { yes.disabled = false; }, 500);
      try { keep.focus(); } catch (e) { /* ignore */ }
    }

    function run(p, done) {
      var btns = bar.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
      p.then(function () {
        boardNotice = done;
        closeMod();
        /* The reload replaces every row, focus included. Put it back on this
           account's Manage button, or on the list if the account is gone. */
        var label = 'Manage ' + r.username;
        Promise.resolve(loadBoard()).then(function () {
          var mods = el['ol-list'].querySelectorAll('.ol-mod');
          for (var k = 0; k < mods.length; k++) {
            if (mods[k].getAttribute('aria-label') === label) { mods[k].focus(); return; }
          }
          var first = el['ol-list'].querySelector('.ol-mod');
          if (first) first.focus();
        }).catch(function () { /* ignore */ });
      }, function (err) {
        for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
        text(el['ol-board-msg'], safeMessage(err, 'That did not work. Nothing was changed.'), true);
      });
    }

    actions();
    li.parentNode.insertBefore(bar, li.nextSibling);
    modOpen = bar;
    var first = bar.querySelector('button');
    try { if (first) first.focus(); } catch (e) { /* ignore */ }
  }

  function loadBoard() {
    /* Taken and cleared up front, so a later reload() cannot resurrect a
       confirmation for something that happened minutes ago. */
    var notice = boardNotice;
    boardNotice = '';
    text(el['ol-board-msg'], notice || 'Loading...');
    /* isAdmin() never rejects, and answers false with no request at all when
       signed out - so for every non-admin this is the same topScores() read
       as always. If the admin board itself fails, fall back to the public one
       rather than show an admin nothing. */
    var admin = false;
    return Online.isAdmin().then(function (yes) {
      if (!yes) return Online.topScores();
      return Online.adminBoard().then(function (rows) {
        admin = true;
        return rows;
      }, function () { return Online.topScores(); });
    }).then(function (rows) {
      loadedOnce = true;
      renderRows(rows, admin);
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

  /* MAY THE ACCOUNT VIEWS BE OPENED AT ALL.
   *
   * Two conditions, and they fail for different reasons. Signed out there is
   * no account to edit. Mid-run there is - but the panel would be taking the
   * screen away from a run that is still being played, and the form it opens
   * wants the keyboard, which during a run belongs to the thruster. In
   * practice the overlay is only reachable from the title and results screens
   * (js/game.js hit-tests the LEADERBOARD button in those two states only), so
   * this is a second lock on a door that is already shut - which is the point:
   * the first lock is a hit-test in another file that knows nothing about this
   * one, and SK.UI.open() is a public handle anybody can call.
   */
  function canEditAccount() {
    if (!Online.state().signedIn) return false;
    if (!game) return true;
    var st = game.state;
    return st !== 'playing' && st !== 'dying' && st !== 'paused';
  }

  function refreshAccountLine() {
    var s = Online.state();
    el['ol-account'].textContent = s.signedIn
      ? ('Signed in as ' + (s.username || 'pilot'))
      : 'Playing as a guest - sign in to appear on the board.';
    el['ol-signin'].hidden = s.signedIn;
    el['ol-signout'].hidden = !s.signedIn;
    /* Absent rather than disabled, the same rule the Google button follows:
       an affordance that cannot work should not be drawn. */
    var links = el['ol-account-links'];
    if (links) links.hidden = !canEditAccount();
    /* And if the markup for a view is not there - a cached index.html against
       a fresh script, which SOFT_IDS exists for - its entry point goes with
       it rather than opening a form with no boxes in it. */
    if (el['ol-edit-name']) el['ol-edit-name'].hidden = !el['ol-username'];
    if (el['ol-edit-password']) {
      el['ol-edit-password'].hidden = !el['ol-password2'];
    }
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
    setField('ol-password2-field', 'ol-password2', !!spec.fields.password2);

    var copy = COPY[mode] || COPY.signin;
    setCopy(el['ol-email-label'], copy.emailLabel);
    setCopy(el['ol-email-hint'], copy.emailHint);
    if (spec.fields.username) {
      setCopy(el['ol-username-label'], copy.usernameLabel || COPY.signup.usernameLabel);
      setCopy(el['ol-username-hint'], copy.usernameHint || COPY.signup.usernameHint);
    }
    /* Seven modes now, and the password box carries a different meaning in
       four of them: the credential you have (SIGN IN), the one you are
       choosing (CREATE ACCOUNT, SET A NEW PASSWORD) and the one you are
       proving (CHANGE PASSWORD). A ternary that named one mode and lumped the
       rest together was already the wrong shape at four; the label lives in
       the COPY table with every other string that varies by view. */
    setCopy(el['ol-password-label'], copy.passwordLabel || 'Password');
    setCopy(el['ol-password2-label'], copy.password2Label || 'New password');

    /* A typed password must not survive a change of view. The old flows only
       ever had one box and cleared it by hand at each site that needed it;
       with CHANGE PASSWORD there are two, one of them is the player's CURRENT
       credential, and leaving either sitting in the DOM after the view has
       moved on is how a shoulder-surfer gets a free look. Clearing here covers
       every route in and out at once. */
    el['ol-password'].value = '';
    if (el['ol-password2']) el['ol-password2'].value = '';

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
    /* A view with no fields at all (ACCOUNT PASSWORD on a Google account) has
       nothing to type into, and focusing a disabled input silently does
       nothing - which would leave the keyboard on the page behind the dialog.
       Its only action is the button, so that is where the keyboard goes. */
    var first = spec.fields.username ? el['ol-username']
      : (spec.fields.email ? el['ol-email']
        : (spec.fields.password ? el['ol-password'] : el['ol-submit']));
    try { first.focus(); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------- open and close */

  function openOverlay(view) {
    if (!wired || open) return;
    open = true;
    downOnBackdrop = false;
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
    downOnBackdrop = false;
    el.ol.hidden = true;
    el.ol.setAttribute('aria-hidden', 'true');
    el['ol-password'].value = '';
    if (el['ol-password2']) el['ol-password2'].value = '';
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

    /* ---- rename ----
       The board is reloaded rather than patched in place: the player's row
       moves nowhere, but it is the board that has to show the new name, and
       re-reading it is the only version of "it worked" that comes from the
       server rather than from this file believing itself. */
    if (mode === 'username') {
      Online.changeUsername(username).then(function () {
        setBusy(false);
        syncGame();
        showBoard('You are ' + Online.state().username + ' now, on every score you have set.');
      }, function (err) {
        setBusy(false);
        text(el['ol-auth-msg'], safeMessage(err, spec.fallback), true);
        revealAuthMsg();
      });
      return;
    }

    /* ---- change the password, from inside a live session ----
       Online.changePassword checks the current one against the server before
       it sets anything, so a wrong entry here fails at the check and the
       account is untouched. */
    if (mode === 'password') {
      var next = el['ol-password2'] ? el['ol-password2'].value : '';
      Online.changePassword(password, next).then(function () {
        setBusy(false);
        el['ol-password'].value = '';
        if (el['ol-password2']) el['ol-password2'].value = '';
        /* "You are still signed in" is not filler. The player has just changed
           the credential this session was opened with, and the reasonable
           assumption is that they now have to log back in - possibly mid-run.
           They do not: GoTrue keeps the current session and revokes the
           others' refresh tokens. Their access tokens stay valid until they
           expire (an hour at most), so "signed out everywhere else" would be
           a promise the server keeps late - the copy says when. */
        showBoard('Password changed. You are still signed in here. Other devices will have to sign in again within the hour.');
      }, function (err) {
        setBusy(false);
        text(el['ol-auth-msg'], safeMessage(err, spec.fallback), true);
        revealAuthMsg();
      });
      return;
    }

    /* ---- a Google account asking for a password ----
       Same endpoint as "Forgot password?", aimed at the address already on
       the account, so the player never has to type an address to prove they
       own a mailbox we already know. The wording avoids promising which of
       "set" or "reset" it will be, because from here we cannot know whether
       a password was added to this account earlier. */
    if (mode === 'setPassword') {
      Online.sendSetPasswordLink().then(function () {
        setBusy(false);
        text(el['ol-auth-msg'],
          'A link is on its way to the address on this account. Open it in this ' +
          'browser and it will let you choose a password. Check your spam folder too.');
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

  /* The two doors out of the "Signed in as X" line.
   *
   * Both re-check canEditAccount() rather than trusting that the links were
   * hidden when the view was drawn: refreshAccountLine() runs when the board
   * is rendered, and a run can start after that - so the state that hid them
   * is a snapshot, and this is the fact. */
  function onEditName() {
    if (busy) return;
    if (!canEditAccount()) { refuseAccountEdit(); return; }
    showAuth('username');
    /* Start from the name they have. A rename is nearly always an edit of the
       current name rather than a fresh one, and an empty box asks them to
       remember and retype it exactly. */
    el['ol-username'].value = Online.state().username || '';
    try { el['ol-username'].select(); } catch (e) { /* ignore */ }
  }

  /* WHICH PASSWORD VIEW, decided before anything is drawn.
   *
   * An account that signs in with Google has no password, and the two answers
   * ("type your current one" / "there isn't one, here is a link") share no
   * fields. Showing one and swapping it a round trip later is the bug this
   * file already has a comment about on the recovery path - a form the player
   * watches appear and vanish - so nothing opens until the answer is in.
   * Online.accountInfo() resolves from the session when it already knows,
   * which is the common case and costs no request at all. */
  function onEditPassword() {
    if (busy) return;
    if (!canEditAccount()) { refuseAccountEdit(); return; }
    setBusy(true);
    text(el['ol-board-msg'], 'Checking how this account signs in...');
    Online.accountInfo().then(function (info) {
      setBusy(false);
      if (info.hasPassword) { showAuth('password'); return; }
      showAuth('setPassword');
      text(el['ol-auth-msg'],
        'This account signs in with Google, so there is no password on it to ' +
        'change. If you want one as well - to sign in without Google - we can ' +
        'email you a link that lets you choose one.');
      revealAuthMsg();
    }, function (err) {
      setBusy(false);
      /* No form, because we still do not know which form would be true. The
         board stays up and says what failed. */
      text(el['ol-board-msg'],
        safeMessage(err, 'Could not check how this account signs in. Try again.'), true);
    });
  }

  function refuseAccountEdit() {
    text(el['ol-board-msg'],
      Online.state().signedIn
        ? 'Account settings are closed while a run is in progress. Finish it first.'
        : 'Sign in first - there is no account to change yet.',
      true);
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
    /* Staging. Online.submitRun refuses the run on its own - this branch adds
       nothing to the SAFETY of that, it exists so the message is true. The
       signed-out path below says "sign in to put this run on the board", and
       on a read-only build signing in would not put it on the board, so
       printing that line here would be teaching the tester something false
       about the build they are testing. */
    if (s.readOnlyScores) {
      setStatus('staging - score not sent to the leaderboard');
      return;
    }
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
        setStatus(res.queued ? 'saved here - will upload later'
          : res.code === 'SKBAN' ? 'account banned - score not saved' : 'score not saved');
        return null;
      }
      /* Saved, but held for bot review (supabase/schema.sql, section 3b).
         Say so: a RANK line that silently excludes the run would be a lie. */
      if (res.flagged) {
        setStatus('saved - held for review, not on the board yet');
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
    if (el['ol-edit-name']) el['ol-edit-name'].addEventListener('click', onEditName);
    if (el['ol-edit-password']) el['ol-edit-password'].addEventListener('click', onEditPassword);

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
      /* Cancelling an account view goes back to the board, not to a sign-in
         form: the player is already signed in, and offering them a login box
         reads as "that logged you out". */
      if (mode === 'username' || mode === 'password' || mode === 'setPassword') {
        showBoard();
        return;
      }
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
    /* Backdrop tap closes - but only a tap that STARTED on the backdrop.
       On Android (Chromium WebView, real touch) the click synthesised after
       a tap is targeted at whatever is under the finger when it fires, not
       at what was there on pointerdown. The LEADERBOARD button on the
       game-over screen sits below the panel, so the tap that opened the
       overlay (pointerdown on the canvas -> openOverlay) was followed ~20 ms
       later by a click on the now-visible backdrop, which closed it again:
       the board could not be opened by touch at all. Playwright's mouse
       click keeps the target the pointer went down on, so no browser test
       saw it; the emulator did (android-app/PLAYSTORE_READY_REPORT.md). */
    /* Without Pointer Events (WebView < Chromium 55, old Safari) nothing
       would ever arm the guard, so fall back to the plain click there. */
    var hasPointerEvents = (typeof PointerEvent === 'function');
    el.ol.addEventListener('pointerdown', function (e) { downOnBackdrop = (e.target === el.ol); });
    el.ol.addEventListener('pointercancel', function () { downOnBackdrop = false; });
    el.ol.addEventListener('click', function (e) {
      var armed = downOnBackdrop || !hasPointerEvents;
      downOnBackdrop = false;
      if (e.target === el.ol && armed) closeOverlay();
    });

    doc.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'Escape') {
        /* An open moderation strip is the innermost thing - close that. */
        if (modOpen) { closeMod(); return; }
        closeOverlay();
        return;
      }
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
