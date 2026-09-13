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

  /* Error text that is safe to put in front of a player: one line, no stack,
     no call log, no internal identifiers. Anything unrecognised collapses to a
     generic sentence rather than leaking a backend message verbatim. */
  function friendly(err, fallback) {
    var raw = '';
    if (!err) raw = '';
    else if (typeof err === 'string') raw = err;
    else raw = err.message || err.error_description || err.msg || err.error || '';
    raw = String(raw).split('\n')[0].slice(0, 180);

    var low = raw.toLowerCase();
    if (!raw) return fallback || 'Something went wrong. Try again.';
    if (low.indexOf('rate limit') >= 0 || low.indexOf('too many') >= 0) {
      return 'Too many attempts. Wait a minute and try again.';
    }
    if (low.indexOf('invalid login') >= 0 || low.indexOf('invalid credentials') >= 0) {
      return 'That email and password do not match an account.';
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
      return 'Cannot reach the leaderboard. Your score is saved on this device.';
    }
    return fallback || 'Something went wrong. Try again.';
  }

  function now() { return Date.now(); }

  /* ------------------------------------------------------------ the module */

  var cfg = null;              // normalised config, or null when disabled
  var session = null;          // { access_token, refresh_token, expires_at, user }
  var listeners = { auth: [], error: [], pending: [] };
  var refreshing = null;       // in-flight refresh promise, shared

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
      boardLimit: (isFinite(limit) && limit > 0) ? Math.min(limit, 200) : 50
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
      hasPending: !!readJSON(K_PENDING)
    };
  }

  var Online = {
    /* Wired by ui_online.js at boot, and by the test harness with a stub
       config. Safe to call more than once. */
    configure: function (raw) {
      cfg = normalise(raw);
      session = null;
      refreshing = null;
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
      return request('/auth/v1/signup', {
        method: 'POST',
        body: { email: email, password: password, data: { username: username } }
      }).then(function (data) {
        var s = sessionFrom(data);
        if (s) {
          s.user.username = username;
          setSession(s);
          Online.flushPending();
          /* The database has the last word on the name. handle_new_user
             de-duplicates it, so a player who asked for an already-taken
             "leo" is "leo1" on the board - and showing them "leo" while the
             leaderboard shows "leo1" is a bug report waiting to happen. Ask
             what was actually assigned. loadUsername never rejects, and the
             account exists either way. */
          return loadUsername().then(function () {
            return { signedIn: true, needsConfirmation: false };
          });
        }
        /* No tokens means the project requires email confirmation. That is a
           legitimate outcome, not an error. */
        return { signedIn: false, needsConfirmation: true };
      }, function (err) {
        throw new Error(friendly(err, 'Could not create that account.'));
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
        throw new Error(friendly(err, 'Could not sign in.'));
      });
    },

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
        emit('error', 'Sign-in was cancelled or refused.');
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
          if (s) setSession(s);
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
        setSession(implicit);
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
      /* `local` separates "this client refused to send it" from "the server
         turned it away". They are the same outcome to this module and very
         different things to say to a player: a sub-second death was never at
         risk of being lost, so reporting it as a failure invents one. */
      if (bad) return Promise.resolve({ submitted: false, queued: false, local: true, reason: bad });
      if (!cfg) return Promise.resolve({ submitted: false, queued: false, local: true, reason: 'offline' });
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

  Online.USERNAME_RE = USERNAME_RE;
  Online.PASSWORD_MIN = PASSWORD_MIN;
  Online.friendly = friendly;
  Online.httpOrigin = httpOrigin;

  SK.Online = Online;

}(typeof window !== 'undefined' ? window : this));
