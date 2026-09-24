/* SKYHOOK - accounts and the global leaderboard.
 *
 * Talks to Supabase (GoTrue for auth, PostgREST for data) over plain fetch.
 *
 * Why no supabase-js
 * ------------------
 * The obvious move is the @supabase/supabase-js ESM bundle off a CDN. It was
 * rejected, and the reason is the first line of README: this game is one page,
 * zero dependencies, zero build step, and it runs by double-clicking
 * index.html. An ESM CDN import breaks three of those four:
 *   1. ES modules are blocked by CORS on file://, so the shipped page would
 *      start throwing the moment it is opened from disk - the exact thing
 *      js/utils.js already documents as the reason nothing here is a module.
 *   2. A <script> from a third-party CDN runs with full access to the page. A
 *      compromised or hijacked CDN version owns every player's session. We
 *      would be adding a remote-code-execution surface to a game.
 *   3. ~120 KB of SDK to send two POSTs and a GET, on a page whose entire
 *      payload is smaller than that.
 * The endpoints used below are the documented, versioned GoTrue/PostgREST HTTP
 * API (verified against supabase/auth openapi.yaml) - the same wire protocol
 * the SDK speaks. We are not reverse-engineering anything; we are skipping a
 * wrapper.
 *
 * Everything here is OPTIONAL. With no config the module sets itself to
 * disabled, makes zero network calls, and the game is untouched. Playing never
 * requires an account, and a dead backend must never cost anybody a run.
 */
(function (global) {
  'use strict';

  var SK = global.SK || (global.SK = {});

  /* ---------------------------------------------------------------- keys */
  var K_SESSION = 'skyhook.session';
  var K_PENDING = 'skyhook.pendingRun';
  var K_VERIFIER = 'skyhook.pkceVerifier';

  var TIMEOUT_MS = 12000;
  /* Refresh a little before the token actually dies, so a submission fired at
     the end of a long run does not lose the race. */
  var REFRESH_PAD_MS = 60000;

  var USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
  /* Deliberately loose. Address validity is decided by the confirmation mail
     arriving, not by a regex nobody can get right. This only catches typos. */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PASSWORD_MIN = 8;

  /* ------------------------------------------------------------- helpers */

  function noop() {}

  function store() {
    return SK.Store || { get: function (k, d) { return d; }, set: noop };
  }

  function readJSON(key) {
    try {
      var raw = store().get(key, '');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function writeJSON(key, val) {
    try { store().set(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  function clearKey(key) {
    try { store().set(key, ''); } catch (e) { /* ignore */ }
  }

  /* GoTrue / PostgREST error codes -> the one line a player should read.
     Keyed on the code rather than the prose for two reasons. The prose is not
     a contract: "email rate limit exceeded" is free to be reworded in any
     Supabase release, and a message that quietly stops matching a substring
     degrades into the generic fallback with nothing going red. And the HTTP
     status is not specific enough - see over_email_send_rate_limit below. */
  var CODE_MESSAGES = {
    /* The wall Leo hit on 2026-09-16, and the reason this table exists.
       Confirmed by probe: POST /auth/v1/signup -> 429
       {"error_code":"over_email_send_rate_limit","msg":"email rate limit
       exceeded"}. This is NOT the player doing anything too often. It is the
       PROJECT's confirmation-email quota - a handful per hour on Supabase's
       built-in SMTP, shared by every person who tries to sign up - and the
       old wording ("Too many attempts. Wait a minute and try again.") was
       wrong on both counts. It blamed the player for a first attempt, and it
       named a timescale an order of magnitude too short, so waiting the
       advised minute and retrying hit the identical wall. Repeat that twice
       and the only available conclusion is that the game is broken, which is
       the report we got. Say whose limit it is, give the real scale, and
       leave the player somewhere to go. */
    over_email_send_rate_limit:
      'Sign-ups are rate-limited right now - this server only sends a few confirmation emails an hour. Try again later; you can keep playing without an account.',

    /* The other 429, and the one the old wording was actually right about:
       per-IP request throttling, which does clear in about a minute. Same
       status code, opposite advice - which is why the code is read and not
       just the status. */
    over_request_rate_limit:
      'Too many attempts from this device. Wait a minute and try again.',

    /* GoTrue refuses whole domains, including example.com and the disposable
       providers. The address can be perfectly well-formed and still be
       rejected, so "Could not create that account." leaves the player with a
       form they cannot fix by looking at it. */
    email_address_invalid:
      'That email address was refused. Try a different one.',

    user_already_exists: 'That email already has an account. Sign in instead.',
    email_exists: 'That email already has an account. Sign in instead.',
    /* PostgREST unique_violation - the username unique index in schema.sql. */
    '23505': 'That name is already taken.',

    email_not_confirmed:
      'This account is not confirmed yet. Check your inbox and your spam folder for the link.',
    /* The commonest way to land here is not a typo in the password: it is
       having typed the LEADERBOARD NAME into a box that authenticates by
       email. Restating "that email and password are wrong" to someone who
       believes they typed their username correctly is true and useless, so
       the line names the mistake instead of describing the symptom. */
    invalid_credentials:
      'No account matches that email and password. Sign in with your email address, not your leaderboard name.',
    weak_password: 'Password must be at least ' + PASSWORD_MIN + ' characters.',
    validation_failed: 'Check the form and try again.',

    signup_disabled: 'Account creation is switched off on this server.',
    email_provider_disabled: 'Email sign-up is switched off on this server.',

    /* The recovery link is a one-time token with a lifetime. Clicking an old
       one, or the same one twice, lands back here with this. It is not an
       error the player caused and it has an obvious next step, so say it. */
    otp_expired: 'That reset link has expired or was already used. Ask for a new one.',
    /* A password GoTrue refuses because it is the one already on the account.
       Silently accepting it would be worse: the player would think they had
       changed something. */
    same_password: 'That is already your password. Choose a different one.'
  };

  /* Some codes mean different things depending on what the player just asked
     for, and the generic sentence is wrong - sometimes badly wrong - in the
     other context. over_email_send_rate_limit is the example that forced this
     table to exist: on sign-up it is the project's confirmation-email quota
     and the honest advice is "come back later"; on a password reset it is the
     55-second per-address cooldown that a probe measured against the live
     project on 2026-09-18, and telling someone locked out of their account to
     wait an hour when the real wait is under a minute sends them away for
     nothing. Same code, same status, opposite advice.

     Keyed context -> code -> line. A context that does not override a code
     falls through to CODE_MESSAGES, so this table only ever holds the
     differences. */
  var CONTEXT_MESSAGES = {
    reset: {
      over_email_send_rate_limit:
        'A reset link was just sent to that address. Wait a minute before asking for another one.',
      over_request_rate_limit:
        'Too many attempts from this device. Wait a minute and try again.',
      /* On sign-up this means "pick another address". On a reset it means the
         address cannot receive our mail at all, which is a dead end worth
         naming rather than dressing up as a retry. */
      email_address_invalid:
        'That email address was refused by the server, so no link can be sent to it.',
      validation_failed: 'Check the address and try again.',
      /* `network` is the one key here that is not a GoTrue error code - a
         connection that never landed carries no code at all. It is in this
         table anyway because it is the same kind of fact: the right sentence
         depends on what the player was trying to do. The default line is
         "Cannot reach the leaderboard. Your score is saved on this device.",
         which is exactly right after a run and is nonsense here - nobody
         asking for a reset link has a score in play, and telling them one is
         safe answers a question they did not ask instead of the one they
         did. */
      network: 'Cannot reach the server. Check your connection and try again.'
    },
    newPassword: {
      /* There is no email in this step at all - only the PUT that sets the
         password - so an email-quota message here would be nonsense. */
      over_email_send_rate_limit:
        'The server is rate-limiting this right now. Wait a minute and try again.',
      invalid_credentials:
        'That reset link has expired or was already used. Ask for a new one.',
      /* Worse here than on the reset request: the player has a live recovery
         session that expires, so "try again" has to mean NOW, not later. */
      network: 'Cannot reach the server. Check your connection and try again.'
    }
  };

  /* Error text that is safe to put in front of a player: one line, no stack,
     no call log, no internal identifiers. Anything unrecognised collapses to a
     generic sentence rather than leaking a backend message verbatim. */
  /* Re-wrap a backend error as a player-facing one WITHOUT losing the machine
     -readable code. The UI needs both: the sentence to show, and something
     stable to branch on. Matching the sentence instead would mean any future
     reword silently changes behaviour - the exact failure mode CODE_MESSAGES
     exists to avoid, reintroduced one layer up. */
  function playerError(err, fallback, context) {
    var e = new Error(friendly(err, fallback, context));
    var code = (err && err.code) ? String(err.code) : '';
    if (code) e.code = code;
    if (err && err.status) e.status = err.status;
    return e;
  }

  /* GoTrue sometimes states the wait itself, and when it does, the number it
     gives beats every fixed sentence in the tables above. Verified against the
     live project on 2026-09-18:

       POST /auth/v1/recover twice in a row -> 429
       {"error_code":"over_email_send_rate_limit",
        "msg":"For security purposes, you can only request this after 55 seconds."}

     That is a PER-ADDRESS cooldown measured in SECONDS, and it shares its
     error_code with the project's hourly SMTP quota, whose message carries no
     number at all. Telling somebody who is locked out of their account to come
     back "later" when the true wait is under a minute is the same species of
     bug as the one the table above was written to fix, pointing the other way:
     an honest-sounding line that sends them away for an hour they did not owe.
     So: when the server names a wait, repeat the wait. */
  function waitSeconds(raw) {
    var m = /after (\d+) seconds?/i.exec(String(raw || ''));
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    /* An hour is the ceiling a plausible cooldown can have. Anything larger is
       a number that means something else, and echoing it would be worse than
       the generic sentence. */
    return (isFinite(n) && n > 0 && n <= 3600) ? n : 0;
  }

  function friendly(err, fallback, context) {
    /* The code first, when there is one. Substring matching stays below as the
       fallback: network failures never carry a code, and an unrecognised code
       should still get whatever the prose can be read for. */
    var code = (err && err.code) ? String(err.code) : '';
    var over = (context && CONTEXT_MESSAGES[context]) || null;

    /* A stated cooldown outranks both tables - it is the most specific true
       thing available, and it is the only one that answers "how long?". */
    if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
      var secs = waitSeconds(err && (err.message || err.msg));
      if (secs) return 'Too soon - wait ' + secs + ' seconds and try again.';
    }

    if (code && over && Object.prototype.hasOwnProperty.call(over, code)) {
      return over[code];
    }
    if (code && Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) {
      return CODE_MESSAGES[code];
    }

    var raw = '';
    if (!err) raw = '';
    else if (typeof err === 'string') raw = err;
    else raw = err.message || err.error_description || err.msg || err.error || '';
    raw = String(raw).split('\n')[0].slice(0, 180);

    var low = raw.toLowerCase();
    if (!raw) return fallback || 'Something went wrong. Try again.';
    /* An uncoded rate limit of unknown kind. Name both possibilities rather
       than pick one and be wrong half the time. */
    if (low.indexOf('email rate limit') >= 0 || low.indexOf('email send rate') >= 0) {
      if (over && over.over_email_send_rate_limit) return over.over_email_send_rate_limit;
      return CODE_MESSAGES.over_email_send_rate_limit;
    }
    if (low.indexOf('rate limit') >= 0 || low.indexOf('too many') >= 0) {
      return 'Too many attempts right now. Wait a few minutes and try again.';
    }
    if (low.indexOf('invalid login') >= 0 || low.indexOf('invalid credentials') >= 0) {
      /* Read from the table rather than repeated, so the coded path and this
         substring fallback cannot drift into telling a player two different
         stories about the same refusal. */
      return CODE_MESSAGES.invalid_credentials;
    }
    if (low.indexOf('already registered') >= 0 || low.indexOf('already exists') >= 0 ||
        low.indexOf('duplicate key') >= 0) {
      return 'That name or email is already taken.';
    }
    if (low.indexOf('email not confirmed') >= 0) {
      return 'Confirm your email first - check your inbox.';
    }
    if (low.indexOf('password') >= 0 && low.indexOf('short') >= 0) {
      return 'Password must be at least ' + PASSWORD_MIN + ' characters.';
    }
    if (low.indexOf('failed to fetch') >= 0 || low.indexOf('networkerror') >= 0 ||
        low.indexOf('aborted') >= 0 || low.indexOf('timeout') >= 0) {
      if (over && over.network) return over.network;
      return 'Cannot reach the leaderboard. Your score is saved on this device.';
    }
    return fallback || 'Something went wrong. Try again.';
  }

  function now() { return Date.now(); }

  /* ------------------------------------------------------------ the module */

  var cfg = null;              // normalised config, or null when disabled
  var session = null;          // { access_token, refresh_token, expires_at, user }
  var listeners = { auth: [], error: [], pending: [], recovery: [] };
  var refreshing = null;       // in-flight refresh promise, shared
  /* True between "the player came back through a recovery link" and "they set
     a new password". The session is real and usable in that window - GoTrue
     hands one over, and proving you can read the mailbox IS the proof of
     ownership - but the player still does not know a password, so the UI has
     to insist on the one step that fixes that. Deliberately in memory only:
     it must not survive a reload, or a stale flag would trap somebody in a
     password form they have already been through. */
  var recovering = false;

  function emit(evt, payload) {
    var list = listeners[evt] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { /* a listener must not break auth */ }
    }
  }

  /* A config counts as present only if BOTH values are non-empty and the URL
     actually looks like a URL. Half-filled config is treated as no config -
     it is a setup mistake, and the right response to a setup mistake is the
     game people already had, not a broken login box. */
  function normalise(raw) {
    if (!raw) return null;
    var url = String(raw.supabaseUrl || '').trim().replace(/\/+$/, '');
    var key = String(raw.supabaseAnonKey || '').trim();
    if (!url || !key) return null;
    if (!/^https?:\/\/[^\s/]+\./.test(url)) return null;
    if (url.indexOf('abcdefghijklmnopqrst') >= 0 || key.indexOf('PLACEHOLDER') >= 0) return null;
    var limit = parseInt(raw.boardLimit, 10);
    return {
      url: url,
      key: key,
      boardLimit: (isFinite(limit) && limit > 0) ? Math.min(limit, 200) : 50,
      /* Read-only mode. The staging build sets this true and shares the
         production Supabase project, so it must be able to READ the board -
         that is the whole point of having a staging copy of a leaderboard
         feature - while being structurally unable to WRITE a score into it.
         Strictly `=== true`: a truthy typo like the string "false" must not
         silently arm it in production, and the default for every config that
         has never heard of this flag is false. */
      readOnlyScores: raw.readOnlyScores === true
    };
  }

  function httpOrigin() {
    try {
      var p = global.location && global.location.protocol;
      return p === 'http:' || p === 'https:';
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------- fetching */

  function request(path, opts) {
    opts = opts || {};
    if (!cfg) return Promise.reject(new Error('offline'));
    var f = global.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('offline'));

    var headers = {
      apikey: cfg.key,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    /* PostgREST and GoTrue both read the bearer token to decide who you are.
       Signed out, the anon key is the identity - which under RLS can read the
       public board and nothing else. */
    headers.Authorization = 'Bearer ' + (opts.token || cfg.key);
    if (opts.headers) {
      for (var h in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, h)) headers[h] = opts.headers[h];
      }
    }

    var init = { method: opts.method || 'GET', headers: headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    /* A hung request must not hang the UI forever. AbortController is absent
       in very old engines, so its absence is tolerated rather than required. */
    var timer = null;
    if (typeof global.AbortController === 'function') {
      var ac = new global.AbortController();
      init.signal = ac.signal;
      timer = setTimeout(function () { try { ac.abort(); } catch (e) {} }, TIMEOUT_MS);
    }

    return f(cfg.url + path, init).then(function (res) {
      if (timer) clearTimeout(timer);
      var ct = '';
      try { ct = (res.headers && res.headers.get && res.headers.get('content-type')) || ''; } catch (e) {}
      var body = (res.status === 204 || ct.indexOf('json') < 0)
        ? Promise.resolve(null)
        : res.json().catch(function () { return null; });
      return body.then(function (data) {
        if (!res.ok) {
          var e = new Error(
            (data && (data.message || data.error_description || data.msg || data.error)) ||
            ('HTTP ' + res.status)
          );
          e.status = res.status;
          /* The machine-readable code, carried alongside the prose because the
             prose is not a contract and the status alone is ambiguous: GoTrue
             answers 429 for BOTH "this device is hammering us" and "the
             project's confirmation-email quota is spent", and those two need
             opposite advice.

             It has to come out of the BODY. Supabase also puts it in an
             `x-sb-error-code` response header, which would be the tidier
             source, but the project sends no Access-Control-Expose-Headers -
             verified against the live project on 2026-09-16 - so a
             cross-origin fetch() cannot read that header at all. The body is
             the only channel a browser has.

             GoTrue: { code: 429 (number), error_code: "over_email_send_rate_limit" }
             PostgREST: { code: "23505" (string SQLSTATE), message: ... }
             so `code` is only trusted when it is a string, which is exactly
             the case where it is a SQLSTATE and not a repeat of the status. */
          var code = (data && data.error_code) || '';
          if (!code && data && typeof data.code === 'string') code = data.code;
          e.code = String(code);
          throw e;
        }
        return data;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  /* --------------------------------------------------------------- session */

  function sessionFrom(data) {
    if (!data || !data.access_token) return null;
    var expiresIn = parseInt(data.expires_in, 10);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: now() + (isFinite(expiresIn) ? expiresIn : 3600) * 1000,
      user: {
        id: (data.user && data.user.id) || '',
        username: '',
        email: (data.user && data.user.email) || ''
      }
    };
  }

  function persist() {
    if (session) {
      /* The email is held in memory for the "signed in as" line only. It is
         never written to disk and never sent to the scores table. */
      writeJSON(K_SESSION, {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: { id: session.user.id, username: session.user.username }
      });
    } else {
      clearKey(K_SESSION);
    }
  }

  function setSession(next) {
    session = next;
    persist();
    emit('auth', publicState());
  }

  function expired() {
    return !session || !session.expires_at || session.expires_at - REFRESH_PAD_MS <= now();
  }

  function refresh() {
    if (!session || !session.refresh_token) return Promise.reject(new Error('no session'));
    if (refreshing) return refreshing;
    refreshing = request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: session.refresh_token }
    }).then(function (data) {
      var next = sessionFrom(data);
      if (!next) throw new Error('no session');
      next.user.username = session.user.username;
      setSession(next);
      refreshing = null;
      return next;
    }, function (err) {
      refreshing = null;
      /* A refresh token the server rejects is a dead session, not a blip:
         drop it rather than retrying forever with a credential that will
         never work again. */
      if (err && err.status && err.status >= 400 && err.status < 500) setSession(null);
      throw err;
    });
    return refreshing;
  }

  /* Every authenticated call goes through here, so token freshness is handled
     in exactly one place. */
  function withToken(fn) {
    if (!session) return Promise.reject(new Error('not signed in'));
    if (!expired()) return fn(session.access_token);
    return refresh().then(function (s) { return fn(s.access_token); });
  }

  /* --------------------------------------------------------------- profile */

  function loadUsername() {
    if (!session) return Promise.resolve('');
    return withToken(function (token) {
      return request('/rest/v1/profiles?select=username&id=eq.' +
        encodeURIComponent(session.user.id) + '&limit=1', { token: token });
    }).then(function (rows) {
      var name = (rows && rows[0] && rows[0].username) || '';
      if (name) {
        session.user.username = name;
        persist();
        emit('auth', publicState());
      }
      return name;
    }, function () { return ''; });
  }

  /* --------------------------------------------------------------- PKCE */

  function randomVerifier() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    var out = '';
    var c = global.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      var arr = new Uint8Array(56);
      c.getRandomValues(arr);
      for (var i = 0; i < arr.length; i++) out += chars.charAt(arr[i] % chars.length);
      return out;
    }
    for (var j = 0; j < 56; j++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function challengeFor(verifier) {
    var c = global.crypto;
    /* crypto.subtle only exists in a secure context. On plain http (a LAN test
       server) there is no SHA-256, and GoTrue's documented fallback is the
       `plain` method - the same one supabase-js falls back to. */
    if (!c || !c.subtle || typeof global.TextEncoder !== 'function' || typeof global.btoa !== 'function') {
      return Promise.resolve({ challenge: verifier, method: 'plain' });
    }
    return c.subtle.digest('SHA-256', new global.TextEncoder().encode(verifier)).then(function (buf) {
      var bytes = new Uint8Array(buf), s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return {
        challenge: global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
        method: 's256'
      };
    }, function () {
      return { challenge: verifier, method: 'plain' };
    });
  }

  function redirectTarget() {
    try {
      var l = global.location;
      return l.origin + l.pathname;
    } catch (e) { return ''; }
  }

  /* ----------------------------------------------------------- validation */

  /* The same shape the CHECK constraints in supabase/schema.sql enforce. The
     server is the authority - this copy exists so an obviously bad run is
     rejected without a round trip, and so the harness can assert the rule
     without a database. Keep the two in step. */
  function validateRun(run) {
    if (!run || typeof run !== 'object') return 'no run';
    var score = Math.floor(run.score), hooks = Math.floor(run.hooks);
    var alt = Math.floor(run.altitude || 0), ms = Math.floor(run.durationMs);
    if (!isFinite(score) || score < 0 || score > 5000000) return 'score out of range';
    if (!isFinite(hooks) || hooks < 0 || hooks > 200000) return 'hooks out of range';
    if (!isFinite(alt) || alt < 0 || alt > 50000000) return 'altitude out of range';
    if (!isFinite(ms) || ms < 500 || ms > 86400000) return 'duration out of range';
    if (score > 500 + hooks * 450) return 'score not reachable with that many hooks';
    if (hooks > 12 + (ms / 1000) * 9) return 'too many hooks for that duration';
    return null;
  }

  function payloadFor(run) {
    return {
      score: Math.floor(run.score),
      hooks: Math.floor(run.hooks),
      altitude: Math.floor(run.altitude || 0),
      duration_ms: Math.floor(run.durationMs)
    };
  }

  /* ------------------------------------------------------------ public API */

  function publicState() {
    return {
      configured: !!cfg,
      signedIn: !!session,
      username: (session && session.user.username) || '',
      email: (session && session.user.email) || '',
      hasPending: !!readJSON(K_PENDING),
      recovering: recovering,
      /* Surfaced so the UI can tell the player why their score did not go up,
         instead of leaving them to conclude the leaderboard is broken. */
      readOnlyScores: !!(cfg && cfg.readOnlyScores)
    };
  }

  var Online = {
    /* Wired by ui_online.js at boot, and by the test harness with a stub
       config. Safe to call more than once. */
    configure: function (raw) {
      cfg = normalise(raw);
      session = null;
      refreshing = null;
      recovering = false;
      if (!cfg) return false;
      var saved = readJSON(K_SESSION);
      if (saved && saved.access_token && saved.refresh_token) {
        session = {
          access_token: saved.access_token,
          refresh_token: saved.refresh_token,
          expires_at: saved.expires_at || 0,
          user: {
            id: (saved.user && saved.user.id) || '',
            username: (saved.user && saved.user.username) || '',
            email: ''
          }
        };
      }
      return true;
    },

    isConfigured: function () { return !!cfg; },
    isSignedIn: function () { return !!session; },
    state: publicState,
    validateRun: validateRun,
    payloadFor: payloadFor,

    on: function (evt, fn) {
      if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn);
      return this;
    },

    /* Boot. Consumes an OAuth return if there is one, then makes sure the
       username is known. Never rejects: a failure here must leave a playable
       game, so it resolves with the state it managed to reach. */
    init: function () {
      if (!cfg) return Promise.resolve(publicState());
      var self = this;
      return this.consumeRedirect()
        .then(function () { return session ? loadUsername() : null; })
        .then(function () {
          if (session) self.flushPending();
          return publicState();
        })
        .catch(function () { return publicState(); });
    },

    /* --------------------------------------------------------- sign up */
    signUp: function (username, email, password) {
      if (!cfg) return Promise.reject(new Error('offline'));
      username = String(username || '').trim();
      email = String(email || '').trim();
      password = String(password || '');

      if (!USERNAME_RE.test(username)) {
        return Promise.reject(new Error('Username: 3-16 letters, numbers or _'));
      }
      if (!EMAIL_RE.test(email)) return Promise.reject(new Error('That email does not look right.'));
      if (password.length < PASSWORD_MIN) {
        return Promise.reject(new Error('Password must be at least ' + PASSWORD_MIN + ' characters.'));
      }

      /* username rides in `data`, which GoTrue stores as raw_user_meta_data;
         the handle_new_user trigger turns it into the profiles row. Nothing
         else is collected - no display name, no avatar, no country. */
      /* redirect_to is where the "Confirm your email address" link sends the
         player once they click it. Without it GoTrue falls back to the
         project's Site URL, which is an origin-shaped setting - so on a site
         served from a subpath (GitHub Pages: /skyhook/) the confirmation link
         lands the player on the domain ROOT and the game is nowhere in sight.
         Observed doing exactly that against the live project. Sending the
         page's own origin+pathname puts them back where they started.
         GoTrue only honours a redirect_to that is allow-listed under
         Authentication -> URL Configuration -> Redirect URLs; if it is not,
         it ignores it and uses the Site URL, which is today's behaviour. So
         this can improve the outcome and cannot make it worse. */
      var signupPath = '/auth/v1/signup';
      var back = httpOrigin() ? redirectTarget() : '';
      if (back) signupPath += '?redirect_to=' + encodeURIComponent(back);

      return request(signupPath, {
        method: 'POST',
        body: { email: email, password: password, data: { username: username } }
      }).then(function (data) {
        var s = sessionFrom(data);
        if (s) {
          s.user.username = username;
          setSession(s);
          Online.flushPending();
          return { signedIn: true, needsConfirmation: false };
        }
        /* No tokens means the project requires email confirmation. That is a
           legitimate outcome, not an error. */
        return { signedIn: false, needsConfirmation: true };
      }, function (err) {
        throw playerError(err, 'Could not create that account.');
      });
    },

    /* --------------------------------------------------------- sign in */
    signIn: function (email, password) {
      if (!cfg) return Promise.reject(new Error('offline'));
      email = String(email || '').trim();
      password = String(password || '');
      if (!email || !password) return Promise.reject(new Error('Email and password, please.'));

      return request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email: email, password: password }
      }).then(function (data) {
        var s = sessionFrom(data);
        if (!s) throw new Error('no session');
        setSession(s);
        return loadUsername().then(function () {
          Online.flushPending();
          return publicState();
        });
      }, function (err) {
        throw playerError(err, 'Could not sign in.');
      });
    },

    /* -------------------------------------------------- forgotten password */

    /* Ask GoTrue to mail a one-time recovery link.
     *
     * PROVEN, not assumed. Before this existed the honest question was whether
     * the project can send mail at all - Confirm email was switched OFF on
     * 2026-09-17 precisely because the built-in SMTP could not keep up with
     * sign-ups, and a reset button on a server that cannot send is a decoration
     * that strands people more thoroughly than no button at all. So it was
     * measured against the live project on 2026-09-18, end to end, into a real
     * throwaway inbox: POST /auth/v1/recover -> 200, and "Reset your password"
     * from noreply@mail.app.supabase.io arrived in 3.2 seconds carrying a
     * working ?type=recovery link. Volume is the difference: sign-up burned a
     * mail per new player, a reset burns one per person who forgets, and the
     * only limit in the way is a 55-second per-address cooldown.
     *
     * ALWAYS RESOLVES THE SAME WAY for a deliverable request, whether or not
     * the address has an account. That is not politeness, it is the reason the
     * endpoint is safe to put on a public page: a form that answers "no such
     * account" is a free tool for testing whether somebody plays this game.
     * GoTrue already behaves this way - 200 with an empty body for both,
     * verified in the same probe - and this must not add a check in front of
     * it that puts the leak back.
     */
    requestPasswordReset: function (email) {
      if (!cfg) return Promise.reject(new Error('offline'));
      email = String(email || '').trim();
      if (!EMAIL_RE.test(email)) {
        return Promise.reject(new Error('That email does not look right.'));
      }

      /* Same reasoning as sign-up: without redirect_to the link lands on the
         project's Site URL, which on GitHub Pages is the domain ROOT and not
         /skyhook/. The player would click a valid link and arrive nowhere
         near the game. GoTrue only honours an allow-listed value, so this can
         improve the outcome and cannot make it worse. */
      var path = '/auth/v1/recover';
      var back = httpOrigin() ? redirectTarget() : '';
      if (back) path += '?redirect_to=' + encodeURIComponent(back);

      return request(path, { method: 'POST', body: { email: email } })
        .then(function () {
          return { sent: true };
        }, function (err) {
          throw playerError(err, 'Could not send a reset link.', 'reset');
        });
    },

    /* Set a new password on the session the recovery link established.
     *
     * PUT /auth/v1/user is the same endpoint a signed-in player would use to
     * change their password; the recovery token is simply how they got a
     * session without knowing the old one. Which is also why this is allowed
     * outside recovery: someone already signed in changing their password is
     * the same operation, and refusing it here would be an arbitrary rule. */
    setNewPassword: function (password) {
      if (!cfg) return Promise.reject(new Error('offline'));
      password = String(password || '');
      if (password.length < PASSWORD_MIN) {
        return Promise.reject(new Error('Password must be at least ' + PASSWORD_MIN + ' characters.'));
      }
      if (!session) {
        return Promise.reject(new Error('That reset link has expired or was already used. Ask for a new one.'));
      }
      return withToken(function (token) {
        return request('/auth/v1/user', {
          method: 'PUT', token: token, body: { password: password }
        });
      }).then(function () {
        /* Out of recovery the moment it succeeds, so the UI stops insisting
           and the player is simply signed in - with a password they chose and
           therefore know. */
        recovering = false;
        emit('auth', publicState());
        return loadUsername().then(function () {
          Online.flushPending();
          return publicState();
        });
      }, function (err) {
        throw playerError(err, 'Could not set that password.', 'newPassword');
      });
    },

    isRecovering: function () { return recovering; },

    /* ------------------------------------------------- sign in with Google */
    /* Returns the URL it is sending the browser to (handy for the harness),
       and performs the navigation itself when there is a browser to navigate. */
    signInWithGoogle: function (provider) {
      if (!cfg) return Promise.reject(new Error('offline'));
      var name = provider || 'google';
      var verifier = randomVerifier();
      return challengeFor(verifier).then(function (pk) {
        store().set(K_VERIFIER, verifier);
        var url = cfg.url + '/auth/v1/authorize?provider=' + encodeURIComponent(name) +
          '&redirect_to=' + encodeURIComponent(redirectTarget()) +
          '&code_challenge=' + encodeURIComponent(pk.challenge) +
          '&code_challenge_method=' + encodeURIComponent(pk.method);
        try {
          if (global.location && typeof global.location.assign === 'function') {
            global.location.assign(url);
          }
        } catch (e) { /* no browser to redirect - the harness just reads the url */ }
        return url;
      });
    },

    /* Handles the return leg of an OAuth round trip, in both shapes GoTrue can
       use: `?code=` (PKCE, the one we ask for) and `#access_token=` (implicit,
       what a project configured the old way sends back). The URL is scrubbed
       afterwards either way, so a session never sits in the address bar, in
       history, or in a screenshot. */
    consumeRedirect: function () {
      if (!cfg) return Promise.resolve(null);
      var loc = global.location;
      if (!loc) return Promise.resolve(null);

      var search = String(loc.search || '');
      var hash = String(loc.hash || '');

      var codeMatch = /[?&]code=([^&]+)/.exec(search);
      var tokenMatch = /[#&]access_token=([^&]+)/.exec(hash);
      var errMatch = /[?&#]error_description=([^&]+)/.exec(search + hash) ||
                     /[?&#]error=([^&]+)/.exec(search + hash);
      /* GoTrue labels the return leg. `type=recovery` is the whole difference
         between "this person signed in" and "this person is holding a link
         that proves they own the mailbox and still does not know a password",
         and the two need opposite handling. Read from search AND hash: the
         PKCE leg puts it in the query string, the implicit leg in the
         fragment, and which one a project uses is a dashboard setting. */
      var isRecovery = /[?&#]type=recovery(&|$)/.test(search + hash);
      /* The failure shape of a recovery link specifically: GoTrue sends
         #error=access_denied&error_code=otp_expired for a link that has
         expired OR has already been spent. */
      var errCode = /[?&#]error_code=([^&]+)/.exec(search + hash);

      function scrub() {
        try {
          if (global.history && global.history.replaceState) {
            global.history.replaceState(null, '', loc.pathname);
          }
        } catch (e) { /* ignore */ }
      }

      if (errMatch) {
        scrub();
        clearKey(K_VERIFIER);
        var code = errCode ? decodeURIComponent(errCode[1]) : '';
        /* A dead recovery link is the one failure here with an obvious next
           step, and "Sign-in was cancelled or refused" describes an action the
           player did not take - they clicked a link we sent them. Name what
           happened and where to go. */
        if (code === 'otp_expired' || isRecovery) {
          emit('error', CODE_MESSAGES.otp_expired);
        } else {
          emit('error', 'Sign-in was cancelled or refused.');
        }
        return Promise.resolve(null);
      }

      if (codeMatch) {
        var verifier = store().get(K_VERIFIER, '');
        clearKey(K_VERIFIER);
        scrub();
        if (!verifier) {
          emit('error', 'Sign-in could not be completed. Try again.');
          return Promise.resolve(null);
        }
        return request('/auth/v1/token?grant_type=pkce', {
          method: 'POST',
          body: { auth_code: decodeURIComponent(codeMatch[1]), code_verifier: verifier }
        }).then(function (data) {
          var s = sessionFrom(data);
          /* The same guard as the implicit leg below. Which of the two shapes
             a recovery link comes back in is a project setting, not something
             this client chooses, so both have to be able to recognise one. */
          if (s && isRecovery) recovering = true;
          if (s) setSession(s);
          if (s && isRecovery) emit('recovery', publicState());
          return s;
        }, function (err) {
          emit('error', friendly(err, 'Sign-in could not be completed. Try again.'));
          return null;
        });
      }

      if (tokenMatch) {
        var params = {};
        hash.replace(/^#/, '').split('&').forEach(function (pair) {
          var i = pair.indexOf('=');
          if (i > 0) params[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
        });
        scrub();
        var implicit = sessionFrom({
          access_token: params.access_token,
          refresh_token: params.refresh_token,
          expires_in: params.expires_in,
          user: null
        });
        if (!implicit) return Promise.resolve(null);
        /* THE RECOVERY CASE, and the reason this branch is not just a
           sign-in. A recovery link comes back in exactly this implicit shape,
           so before this existed clicking one signed the player in silently
           and dropped them on the board - session restored, password still
           unknown, and nothing on screen suggesting there was a step they had
           not done. They would close the tab and be locked out again the next
           time. Set the flag BEFORE setSession, so the 'auth' listeners the
           UI has already attached see a state that says recovering:true on
           the very first notification rather than a frame of "signed in,
           nothing to do". */
        if (isRecovery) recovering = true;
        setSession(implicit);
        if (isRecovery) emit('recovery', publicState());
        /* The implicit response carries no user object, so ask who this is. */
        return request('/auth/v1/user', { token: implicit.access_token })
          .then(function (user) {
            if (user && user.id && session) {
              session.user.id = user.id;
              session.user.email = user.email || '';
              persist();
            }
            return session;
          }, function () { return session; });
      }

      return Promise.resolve(null);
    },

    signOut: function () {
      /* Leaving mid-recovery is allowed and is a real choice - the player may
         simply have changed their mind. What must not happen is the flag
         outliving the session and trapping the next view in a password form
         for an account nobody is signed into. */
      recovering = false;
      if (!session) { setSession(null); return Promise.resolve(publicState()); }
      var token = session.access_token;
      /* The local session is dropped first and unconditionally. If the network
         call fails, the player is still signed out on this device - which is
         what they asked for and the only part we control. */
      setSession(null);
      return request('/auth/v1/logout?scope=local', { method: 'POST', token: token })
        .catch(function () { return null; })
        .then(function () { return publicState(); });
    },

    /* ------------------------------------------------------ scores */

    /* Never rejects. A score that cannot be sent is parked in localStorage and
       retried on the next sign-in or the next successful submission, because
       losing somebody's best run to a flaky tunnel is not an acceptable
       failure mode for a leaderboard. */
    submitRun: function (run) {
      var bad = validateRun(run);
      if (bad) return Promise.resolve({ submitted: false, queued: false, reason: bad });
      if (!cfg) return Promise.resolve({ submitted: false, queued: false, reason: 'offline' });
      /* The staging gate, and the reason it is HERE rather than in the UI.
         Every score that has ever reached the production board went through
         this one function; a check anywhere higher up is a check a future
         call site can forget to make.

         `queued: false` is the load-bearing half. The obvious implementation
         parks the run in localStorage like every other failure does, and that
         would be exactly wrong: a queued run is a run waiting for a session
         that CAN write, and the entire purpose of this branch is that no such
         moment must ever arrive for a score rolled on staging. It is dropped,
         deliberately and visibly, and the player is told. */
      if (cfg.readOnlyScores) {
        return Promise.resolve({
          submitted: false,
          queued: false,
          reason: 'Staging build - scores are not saved to the leaderboard.'
        });
      }
      if (!session) {
        queuePending(run);
        return Promise.resolve({ submitted: false, queued: true, reason: 'not signed in' });
      }
      return withToken(function (token) {
        return request('/rest/v1/scores', {
          method: 'POST',
          token: token,
          headers: { Prefer: 'return=minimal' },
          body: payloadFor(run)
        });
      }).then(function () {
        return { submitted: true, queued: false, reason: '' };
      }, function (err) {
        var status = err && err.status;
        /* 4xx other than auth means the server judged the run itself - a
           plausibility constraint or the rate limit. Queueing it would just
           replay a rejection forever. */
        if (status && status >= 400 && status < 500 && status !== 401 && status !== 403) {
          return { submitted: false, queued: false, reason: friendly(err, 'Score refused.') };
        }
        queuePending(run);
        return { submitted: false, queued: true, reason: friendly(err, 'Saved on this device for now.') };
      });
    },

    flushPending: function () {
      var pending = readJSON(K_PENDING);
      if (!pending || !cfg || !session) return Promise.resolve(false);
      /* Returning early WITHOUT clearing the key. submitRun would refuse the
         run anyway, but this function wipes the pending slot before it asks -
         so falling through would silently destroy a run the player is still
         owed, for no gain. Read-only means "change nothing", including the
         contents of localStorage. */
      if (cfg.readOnlyScores) return Promise.resolve(false);
      clearKey(K_PENDING);
      return this.submitRun(pending).then(function (res) {
        emit('pending', res);
        return !!res.submitted;
      });
    },

    pendingRun: function () { return readJSON(K_PENDING); },

    topScores: function (limit) {
      if (!cfg) return Promise.reject(new Error('offline'));
      var n = Math.min(parseInt(limit, 10) || cfg.boardLimit, 200);
      /* Column list is explicit and short on purpose: the view exposes only
         these, and asking for them by name means a future column cannot
         silently start shipping to the client. */
      /* Read with the anon key even when signed in. The board is public data,
         so the user's JWT buys nothing here - and using it would turn an
         expired token into a 401 on a request that never needed one. */
      return request('/rest/v1/leaderboard?select=rank,username,score,hooks,altitude,created_at' +
        '&order=rank.asc&limit=' + n).then(function (rows) {
        return (rows || []).map(function (r) {
          return {
            rank: parseInt(r.rank, 10) || 0,
            username: String(r.username || ''),
            score: parseInt(r.score, 10) || 0,
            hooks: parseInt(r.hooks, 10) || 0,
            altitude: parseInt(r.altitude, 10) || 0,
            createdAt: r.created_at || ''
          };
        });
      }, function (err) {
        throw new Error(friendly(err, 'Could not load the leaderboard.'));
      });
    },

    /* ------------------------------------------------- the ship's paint ---
     * The paint follows the ACCOUNT, so a player who paints their ship on a
     * laptop finds it painted on their phone. Both halves are OPTIONAL in the
     * strongest sense - js/ui_ship.js treats a rejection, a missing column and
     * a signed-out player as the same non-event - because the paint is
     * already saved in localStorage and already on screen before either of
     * these is called. The network is a convenience here, never a dependency.
     *
     * A project whose SQL predates supabase/schema.sql section 8 has no
     * ship_* columns at all. PostgREST answers that with a 400, which arrives
     * here as a rejected promise and is swallowed exactly like a dead
     * connection. That is deliberate: the feature must not appear broken on a
     * backend that simply has not been migrated yet.
     *
     * What comes back is RAW - one string per part, '' for "never chosen".
     * It is not trusted here: SK.Ship.setPaint() puts it through the same gate
     * a tap goes through before a pixel of it is painted.
     */
    loadShipPaint: function () {
      if (!cfg || !session) return Promise.resolve(null);
      return withToken(function (token) {
        return request('/rest/v1/profiles?select=ship_nose,ship_window,ship_body,ship_fire' +
          '&id=eq.' + encodeURIComponent(session.user.id) + '&limit=1', { token: token });
      }).then(function (rows) {
        var r = rows && rows[0];
        if (!r) return null;
        return {
          nose: String(r.ship_nose || ''),
          window: String(r.ship_window || ''),
          body: String(r.ship_body || ''),
          fire: String(r.ship_fire || '')
        };
      }, function () { return null; });
    },

    /* Through an RPC rather than a PATCH on profiles, and that is the whole
       security argument: whatever UPDATE a player holds on their own profile
       row is column-scoped to their username, so the ship columns cannot be
       written directly at all. The function is the one narrow door, it
       writes only auth.uid()'s own row, all four parts in one statement (so
       a half-saved ship cannot exist), and each column's CHECK constraint
       holds the SAME allow-list the client shows - so the server rejects an
       off-menu colour (champion gold included) even when the request did not
       come from this file. */
    saveShipPaint: function (paint) {
      if (!cfg || !session) return Promise.resolve(false);
      var p = paint || {};
      return withToken(function (token) {
        return request('/rest/v1/rpc/set_ship_paint', {
          method: 'POST', token: token,
          body: {
            p_nose: String(p.nose || ''),
            p_window: String(p.window || ''),
            p_body: String(p.body || ''),
            p_fire: String(p.fire || '')
          }
        });
      }).then(function () { return true; }, function () { return false; });
    },

    myRank: function () {
      if (!cfg || !session) return Promise.resolve(null);
      return withToken(function (token) {
        return request('/rest/v1/rpc/my_rank', { method: 'POST', token: token, body: {} });
      }).then(function (rows) {
        var r = rows && rows[0];
        if (!r) return null;
        return {
          rank: parseInt(r.rank, 10) || 0,
          score: parseInt(r.score, 10) || 0,
          username: String(r.username || '')
        };
      }, function () { return null; });
    }
  };

  /* Keep only the best unsent run. A queue of every failed submission would
     grow without bound in a tunnel and replay a hundred mediocre runs on the
     other side; the player only cares that their best one counted. */
  function queuePending(run) {
    var prev = readJSON(K_PENDING);
    if (prev && prev.score >= run.score) return;
    writeJSON(K_PENDING, {
      score: Math.floor(run.score),
      hooks: Math.floor(run.hooks),
      altitude: Math.floor(run.altitude || 0),
      durationMs: Math.floor(run.durationMs)
    });
  }

  /* "This address already has an account" arrives under more than one code
     depending on GoTrue version, and the UI has to react to ALL of them - that
     is the exact state a player is in when they need the reset flow. Exported
     so there is one list, here, next to the table it mirrors. */
  Online.EMAIL_TAKEN_CODES = ['user_already_exists', 'email_exists'];
  Online.isEmailTaken = function (err) {
    var code = (err && err.code) ? String(err.code) : '';
    if (code) {
      for (var i = 0; i < Online.EMAIL_TAKEN_CODES.length; i++) {
        if (Online.EMAIL_TAKEN_CODES[i] === code) return true;
      }
      return false;
    }
    /* No code: fall back to the sentence, which is ours and therefore stable
       enough for this one purpose. */
    var m = String((err && err.message) || '').toLowerCase();
    return m.indexOf('already has an account') >= 0 ||
           m.indexOf('already taken') >= 0;
  };

  Online.USERNAME_RE = USERNAME_RE;
  Online.PASSWORD_MIN = PASSWORD_MIN;
  Online.friendly = friendly;
  Online.httpOrigin = httpOrigin;

  SK.Online = Online;

}(typeof window !== 'undefined' ? window : this));
