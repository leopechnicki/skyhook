/* SKYHOOK online gate  -  accounts, score submission, and the security rules
 * that are only rules if something checks them.
 *
 * Pure Node, no browser, no network: js/online.js is loaded into a vm sandbox
 * with a scripted fetch, so every assertion here is about the bytes the game
 * would actually put on the wire and what it does with the answer. That makes
 * this the cheap half of the gate - it runs in well under a second and it
 * catches the failures that matter most:
 *
 *   1. The OFFLINE path. With no js/config.js the game must make zero network
 *      calls and behave exactly as it did before accounts existed. This is the
 *      single most important test in the file, because it is the promise made
 *      to every player who never signs in and to anyone who double-clicks
 *      index.html from disk.
 *   2. The submission payload. A leaderboard that posts the wrong shape is a
 *      leaderboard that silently records nothing.
 *   3. Auth transitions: out -> in -> out, including that signing out drops
 *      the session even when the logout call itself fails.
 *   4. That a run which the game cannot physically produce is refused before
 *      it is sent - the client half of the server's CHECK constraints.
 *   5. That supabase/schema.sql still says what the threat model needs it to
 *      say: RLS on, no UPDATE, no DELETE, no email column anywhere near the
 *      public view.
 *
 * Run:  node test/online.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const CONFIG = {
  supabaseUrl: 'https://testproj.supabase.co',
  supabaseAnonKey: 'anon-test-key',
  boardLimit: 50
};

/* --------------------------------------------------------------------------
 * Sandbox: the real js/utils.js and js/online.js, a fake browser around them.
 * ------------------------------------------------------------------------ */
function makeSandbox({ href = 'https://leopechnicki.github.io/skyhook/', search = '', hash = '' } = {}) {
  const storage = new Map();
  const calls = [];
  let router = () => ({ status: 404, body: { message: 'no route' } });
  let assigned = null;

  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }
  };

  function response(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body)
    };
  }

  const fetchStub = (url, init = {}) => {
    const entry = {
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(entry);
    const out = router(entry);
    if (out && out.networkError) return Promise.reject(new Error('Failed to fetch'));
    return Promise.resolve(response(out.status ?? 200, out.body ?? null));
  };

  const sandbox = {
    Math, Date, JSON, console, Promise, Error, Uint8Array, TextEncoder,
    setTimeout, clearTimeout, AbortController,
    crypto: webcrypto,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    localStorage,
    fetch: fetchStub,
    document: { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) }) }) },
    location: {
      protocol: href.startsWith('https') ? 'https:' : 'http:',
      origin: 'https://leopechnicki.github.io',
      pathname: '/skyhook/',
      search,
      hash,
      assign: url => { assigned = url; }
    },
    history: { replaceState: () => {} }
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/utils.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/online.js'), 'utf8'), sandbox);

  return {
    SK: sandbox.SK,
    Online: sandbox.SK.Online,
    calls,
    storage,
    route: fn => { router = fn; },
    assigned: () => assigned,
    location: sandbox.location
  };
}

const TOKEN_OK = {
  access_token: 'jwt-access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  user: { id: 'user-uuid-1', email: 'leo@example.com' }
};

/* ==========================================================================
 * 1. OFFLINE - the default build. Zero config, zero network, zero UI.
 * ======================================================================== */
{
  const s = makeSandbox();

  check('no config at all -> not configured',
    s.Online.configure(undefined) === false && s.Online.isConfigured() === false);
  check('empty config (the committed js/config.js) -> not configured',
    s.Online.configure({ supabaseUrl: '', supabaseAnonKey: '', boardLimit: 50 }) === false);
  check('half-filled config -> not configured (url without key)',
    s.Online.configure({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: '' }) === false);
  check('half-filled config -> not configured (key without url)',
    s.Online.configure({ supabaseUrl: '', supabaseAnonKey: 'k' }) === false);
  check('the config.example.js placeholders are recognised as placeholders',
    s.Online.configure({
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PLACEHOLDER.PLACEHOLDER'
    }) === false);
  check('a non-URL in supabaseUrl -> not configured',
    s.Online.configure({ supabaseUrl: 'not a url', supabaseAnonKey: 'k' }) === false);

  const state = s.Online.state();
  check('offline state reports configured=false, signedIn=false',
    state.configured === false && state.signedIn === false);

  const res = await s.Online.submitRun({ score: 900, hooks: 7, altitude: 400, durationMs: 30000 });
  check('offline submitRun resolves (never throws at the game)',
    res.submitted === false && res.reason === 'offline');

  let boardRejected = false;
  await s.Online.topScores().catch(() => { boardRejected = true; });
  check('offline topScores rejects instead of calling out', boardRejected);

  await s.Online.init();
  await s.Online.myRank();
  await s.Online.flushPending();

  check('OFFLINE MADE NOT ONE NETWORK CALL', s.calls.length === 0,
    s.calls.length ? s.calls.map(c => c.url).join(' | ') : '');
}

/* ==========================================================================
 * 2. Run validation - the client mirror of the SQL CHECK constraints.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  const v = run => s.Online.validateRun(run);

  check('an ordinary run validates',
    v({ score: 1840, hooks: 22, altitude: 900, durationMs: 41000 }) === null);
  check('a very good run still validates (nothing honest is refused)',
    v({ score: 96000, hooks: 900, altitude: 40000, durationMs: 260000 }) === null);
  check('a negative score is refused', v({ score: -5, hooks: 2, altitude: 0, durationMs: 9000 }) !== null);
  check('score impossible for the hook count is refused',
    v({ score: 999999, hooks: 3, altitude: 10, durationMs: 9000 }) !== null);
  check('more hooks than the input debounce allows is refused',
    v({ score: 100, hooks: 400, altitude: 10, durationMs: 5000 }) !== null);
  check('an instant "run" is refused', v({ score: 10, hooks: 1, altitude: 1, durationMs: 20 }) !== null);
  check('a 30-hour run is refused', v({ score: 10, hooks: 1, altitude: 1, durationMs: 108000000 }) !== null);
  check('garbage is refused', v(null) !== null && v({}) !== null);

  /* The client copy has to agree with the server copy, or one of them is
     decoration. Both bounds are read straight out of the SQL. */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  check('client plausibility rule matches the SQL CHECK (500 + hooks * 450)',
    sql.includes('score <= 500 + hooks * 450'));
  check('client rate rule matches the SQL CHECK (12 + seconds * 9)',
    sql.includes('hooks <= 12 + (duration_ms / 1000.0) * 9'));
}

/* ==========================================================================
 * 3. Sign-up and the submission payload.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);

  const seen = [];
  s.route(call => {
    seen.push(call);
    if (call.url.includes('/auth/v1/signup')) return { status: 200, body: TOKEN_OK };
    if (call.url.includes('/rest/v1/scores')) return { status: 201, body: null };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    return { status: 404, body: { message: 'unexpected' } };
  });

  const authEvents = [];
  s.Online.on('auth', st => authEvents.push(st.signedIn));

  await s.Online.signUp('leo', 'leo@example.com', 'hunter2hunter2');
  const signup = seen.find(c => c.url.includes('/signup'));

  check('sign-up POSTs to /auth/v1/signup', !!signup && signup.method === 'POST');
  check('sign-up sends the anon key as apikey',
    signup.headers.apikey === CONFIG.supabaseAnonKey);
  check('sign-up body is exactly email + password + { data: { username } }',
    JSON.stringify(Object.keys(signup.body).sort()) === '["data","email","password"]' &&
    JSON.stringify(Object.keys(signup.body.data)) === '["username"]',
    JSON.stringify(signup.body.data));
  check('sign-up collects NOTHING beyond username, email, password',
    !JSON.stringify(signup.body).match(/country|avatar|age|phone|full_name|birth/i));

  /* Where the "Confirm your email address" link comes back to. Without this
     GoTrue falls back to the project's Site URL, which is origin-shaped - so
     on GitHub Pages, served from /skyhook/, the confirmation link dropped the
     player on the domain root with no game in sight. Verified happening
     against the live project before this was added. */
  check('sign-up tells GoTrue to send the confirmation link back to THIS page',
    signup.url.includes('redirect_to=' + encodeURIComponent('https://leopechnicki.github.io/skyhook/')),
    signup.url);
  check('sign-up left the session signed in', s.Online.isSignedIn() === true);
  check('an auth event fired on sign-up', authEvents.length >= 1 && authEvents[0] === true);

  const run = { score: 1840, hooks: 22, altitude: 913, durationMs: 41250 };
  const out = await s.Online.submitRun(run);
  const post = seen.find(c => c.url.includes('/rest/v1/scores'));

  check('score submission reports success', out.submitted === true);
  check('score POSTs to /rest/v1/scores', !!post && post.method === 'POST');
  check('score payload is exactly {score, hooks, altitude, duration_ms}',
    JSON.stringify(Object.keys(post.body).sort()) === '["altitude","duration_ms","hooks","score"]',
    JSON.stringify(post.body));
  check('score payload carries the run values, floored to integers',
    post.body.score === 1840 && post.body.hooks === 22 &&
    post.body.altitude === 913 && post.body.duration_ms === 41250);
  check('score payload does NOT send user_id (the server decides whose row it is)',
    post.body.user_id === undefined);
  check('score payload contains no email and no token material',
    !JSON.stringify(post.body).match(/@|token|jwt/i));
  check('score submission authenticates with the USER token, not the anon key',
    post.headers.Authorization === 'Bearer jwt-access-1');
}

/* ==========================================================================
 * 4. Auth transitions: signed out -> signed in -> signed out.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(call => {
    if (call.url.includes('grant_type=password')) return { status: 200, body: TOKEN_OK };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    if (call.url.includes('/auth/v1/logout')) return { status: 204, body: null };
    return { status: 404, body: { message: 'unexpected' } };
  });

  const seenStates = [];
  s.Online.on('auth', st => seenStates.push(st.signedIn));

  check('starts signed out', s.Online.state().signedIn === false);

  await s.Online.signIn('leo@example.com', 'hunter2hunter2');
  const afterIn = s.Online.state();
  check('after sign-in: signedIn true and the username is resolved',
    afterIn.signedIn === true && afterIn.username === 'leo', JSON.stringify(afterIn));
  check('the session was persisted to storage', !!s.storage.get('skyhook.session'));
  check('the persisted session does NOT contain the email address',
    !String(s.storage.get('skyhook.session')).includes('@'),
    String(s.storage.get('skyhook.session')));

  await s.Online.signOut();
  const afterOut = s.Online.state();
  check('after sign-out: signedIn false, username cleared',
    afterOut.signedIn === false && afterOut.username === '');
  check('the persisted session was cleared', !s.storage.get('skyhook.session'));
  check('auth events fired for both transitions (in, out)',
    seenStates.includes(true) && seenStates[seenStates.length - 1] === false,
    JSON.stringify(seenStates));

  /* A session restored from storage is a third transition, and the one that
     happens on nearly every page load. */
  const s2 = makeSandbox();
  s2.storage.set('skyhook.session', JSON.stringify({
    access_token: 'jwt-access-1', refresh_token: 'refresh-1',
    expires_at: Date.now() + 3600_000, user: { id: 'user-uuid-1', username: 'leo' }
  }));
  s2.Online.configure(CONFIG);
  check('a saved session is restored on the next load',
    s2.Online.isSignedIn() === true && s2.Online.state().username === 'leo');
}

/* ==========================================================================
 * 5. Sign-out must survive a failing backend.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(call => {
    if (call.url.includes('grant_type=password')) return { status: 200, body: TOKEN_OK };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    return { networkError: true };
  });
  await s.Online.signIn('leo@example.com', 'hunter2hunter2');
  await s.Online.signOut();
  check('sign-out drops the local session even when the logout call fails',
    s.Online.isSignedIn() === false && !s.storage.get('skyhook.session'));
}

/* ==========================================================================
 * 6. Expired token -> refresh, transparently.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.storage.set('skyhook.session', JSON.stringify({
    access_token: 'stale', refresh_token: 'refresh-1',
    expires_at: Date.now() - 1000, user: { id: 'user-uuid-1', username: 'leo' }
  }));
  s.Online.configure(CONFIG);

  s.route(call => {
    if (call.url.includes('grant_type=refresh_token')) {
      return { status: 200, body: { ...TOKEN_OK, access_token: 'jwt-fresh' } };
    }
    if (call.url.includes('/rest/v1/scores')) return { status: 201, body: null };
    return { status: 404, body: { message: 'unexpected' } };
  });

  const out = await s.Online.submitRun({ score: 700, hooks: 9, altitude: 300, durationMs: 20000 });
  const refreshCall = s.calls.find(c => c.url.includes('grant_type=refresh_token'));
  const scoreCall = s.calls.find(c => c.url.includes('/rest/v1/scores'));

  check('an expired token is refreshed before the submission', !!refreshCall);
  check('the refresh body is exactly { refresh_token }',
    JSON.stringify(Object.keys(refreshCall.body)) === '["refresh_token"]');
  check('the submission then goes out with the FRESH token',
    out.submitted === true && scoreCall.headers.Authorization === 'Bearer jwt-fresh');

  /* A refresh token the server rejects means the session is gone for good. */
  const s2 = makeSandbox();
  s2.storage.set('skyhook.session', JSON.stringify({
    access_token: 'stale', refresh_token: 'dead',
    expires_at: Date.now() - 1000, user: { id: 'u', username: 'leo' }
  }));
  s2.Online.configure(CONFIG);
  s2.route(() => ({ status: 401, body: { message: 'Invalid Refresh Token' } }));
  await s2.Online.submitRun({ score: 700, hooks: 9, altitude: 300, durationMs: 20000 });
  check('a rejected refresh token ends the session instead of looping',
    s2.Online.isSignedIn() === false);
}

/* ==========================================================================
 * 7. A score that cannot be sent is never lost.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(() => ({ networkError: true }));

  /* Signed out: nothing to submit to yet, but the run still matters. */
  const queued = await s.Online.submitRun({ score: 1200, hooks: 14, altitude: 500, durationMs: 30000 });
  check('a run finished while signed out is queued, not dropped',
    queued.queued === true && s.Online.pendingRun().score === 1200);

  const worse = await s.Online.submitRun({ score: 300, hooks: 4, altitude: 100, durationMs: 12000 });
  check('a worse later run does not overwrite the queued best',
    worse.queued === true && s.Online.pendingRun().score === 1200);

  const better = await s.Online.submitRun({ score: 2600, hooks: 30, altitude: 1200, durationMs: 55000 });
  check('a better later run replaces the queued one',
    better.queued === true && s.Online.pendingRun().score === 2600);

  /* Now the network comes back and they sign in. */
  s.route(call => {
    if (call.url.includes('grant_type=password')) return { status: 200, body: TOKEN_OK };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    if (call.url.includes('/rest/v1/scores')) return { status: 201, body: null };
    return { status: 404, body: { message: 'unexpected' } };
  });
  await s.Online.signIn('leo@example.com', 'hunter2hunter2');
  await new Promise(r => setTimeout(r, 10));
  const flushed = s.calls.filter(c => c.url.includes('/rest/v1/scores'));
  check('signing in uploads the queued run', flushed.length === 1 && flushed[0].body.score === 2600,
    JSON.stringify(flushed.map(c => c.body)));
  check('the queue is empty afterwards', !s.Online.pendingRun());

  /* A run the SERVER refuses (plausibility / rate limit) must not be queued:
     replaying a rejection forever is a loop, not a retry. */
  const s2 = makeSandbox();
  s2.Online.configure(CONFIG);
  s2.storage.set('skyhook.session', JSON.stringify({
    access_token: 'jwt', refresh_token: 'r', expires_at: Date.now() + 3600_000,
    user: { id: 'u', username: 'leo' }
  }));
  s2.Online.configure(CONFIG);
  s2.route(() => ({ status: 400, body: { message: 'new row violates check constraint "scores_score_plausible"' } }));
  const refused = await s2.Online.submitRun({ score: 2600, hooks: 30, altitude: 1200, durationMs: 55000 });
  check('a server-refused run is reported, not queued for replay',
    refused.submitted === false && refused.queued === false && !s2.Online.pendingRun());
}

/* ==========================================================================
 * 8. Reading the board.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(call => {
    if (call.url.includes('/rest/v1/leaderboard')) {
      return {
        status: 200,
        body: [
          { rank: 1, username: 'leo', score: 9001, hooks: 80, altitude: 4200, created_at: '2026-09-13T10:00:00Z' },
          { rank: 2, username: 'klaudia', score: 7400, hooks: 61, altitude: 3100, created_at: '2026-09-12T10:00:00Z' }
        ]
      };
    }
    return { status: 404, body: { message: 'unexpected' } };
  });

  const rows = await s.Online.topScores(50);
  const req = s.calls[0];

  check('the board is read from the leaderboard VIEW, not the scores table',
    req.url.includes('/rest/v1/leaderboard'));
  check('the board request names its columns explicitly',
    req.url.includes('select=rank,username,score,hooks,altitude,created_at'));
  check('the board request asks for no column that could be an email',
    !/email/i.test(req.url));
  check('the board is read with the ANON key even when a session exists',
    req.headers.Authorization === 'Bearer ' + CONFIG.supabaseAnonKey);
  check('the board request is ordered and bounded',
    req.url.includes('order=rank.asc') && req.url.includes('limit=50'));
  check('rows are normalised to {rank, username, score, hooks, altitude, createdAt}',
    rows.length === 2 && rows[0].rank === 1 && rows[0].username === 'leo' &&
    rows[0].score === 9001 && rows[0].createdAt === '2026-09-13T10:00:00Z');
  check('the board limit is capped so a hostile config cannot ask for everything',
    (await (async () => {
      s.calls.length = 0;
      await s.Online.topScores(100000);
      return s.calls[0].url.includes('limit=200');
    })()));

  const s2 = makeSandbox();
  s2.Online.configure(CONFIG);
  s2.route(() => ({ networkError: true }));
  let msg = '';
  await s2.Online.topScores().catch(e => { msg = e.message; });
  check('a failed board read gives one readable line, not a stack trace',
    msg.length > 0 && msg.length < 120 && !msg.includes('\n') && !/at .*\(/.test(msg), msg);
}

/* ==========================================================================
 * 9. Google OAuth - the URL we send people to, and the code we get back.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  const url = await s.Online.signInWithGoogle('google');

  check('Google sign-in goes to GoTrue /auth/v1/authorize',
    url.startsWith('https://testproj.supabase.co/auth/v1/authorize?'));
  check('...for the google provider', url.includes('provider=google'));
  check('...with a redirect back to this exact page',
    url.includes('redirect_to=' + encodeURIComponent('https://leopechnicki.github.io/skyhook/')));
  check('...using PKCE with SHA-256, so no token is ever put in the address bar',
    url.includes('code_challenge=') && url.includes('code_challenge_method=s256'));
  check('...and the verifier is kept locally, never sent in the redirect',
    !!s.storage.get('skyhook.pkceVerifier') &&
    !url.includes(s.storage.get('skyhook.pkceVerifier')));
  check('the browser was actually redirected', s.assigned() === url);
  check('starting Google sign-in makes no API call of its own', s.calls.length === 0);

  /* The return leg. */
  const back = makeSandbox({ search: '?code=auth-code-123' });
  back.storage.set('skyhook.pkceVerifier', 'verifier-abc');
  back.Online.configure(CONFIG);
  back.route(call => {
    if (call.url.includes('grant_type=pkce')) return { status: 200, body: TOKEN_OK };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    return { status: 404, body: { message: 'unexpected' } };
  });
  await back.Online.init();
  const exchange = back.calls.find(c => c.url.includes('grant_type=pkce'));
  check('coming back with ?code= exchanges it for a session',
    !!exchange && exchange.body.auth_code === 'auth-code-123' &&
    exchange.body.code_verifier === 'verifier-abc');
  check('the OAuth round trip ends signed in', back.Online.isSignedIn() === true);
  check('the one-time verifier is destroyed after use',
    !back.storage.get('skyhook.pkceVerifier'));

  /* The old implicit shape still has to work: a project configured before
     PKCE existed answers with tokens in the fragment. */
  const imp = makeSandbox({ hash: '#access_token=imp-token&refresh_token=imp-refresh&expires_in=3600&token_type=bearer' });
  imp.Online.configure(CONFIG);
  imp.route(call => {
    if (call.url.includes('/auth/v1/user')) return { status: 200, body: { id: 'u2', email: 'leo@example.com' } };
    if (call.url.includes('/rest/v1/profiles')) return { status: 200, body: [{ username: 'leo' }] };
    return { status: 404, body: { message: 'unexpected' } };
  });
  await imp.Online.init();
  check('an implicit-flow return (#access_token) is also accepted',
    imp.Online.isSignedIn() === true);

  /* A refused consent must not look like a crash. */
  const denied = makeSandbox({ search: '?error=access_denied&error_description=The+user+denied' });
  denied.Online.configure(CONFIG);
  const errs = [];
  denied.Online.on('error', m => errs.push(m));
  await denied.Online.init();
  check('a cancelled Google sign-in reports one friendly line and stays signed out',
    denied.Online.isSignedIn() === false && errs.length === 1 && errs[0].length < 120, errs[0] || '');
}

/* ==========================================================================
 * 10. Input validation at the signup form.
 * ======================================================================== */
{
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(() => ({ status: 200, body: TOKEN_OK }));

  const rejects = async (u, e, p) => {
    let failed = false;
    await s.Online.signUp(u, e, p).catch(() => { failed = true; });
    return failed;
  };

  check('a 2-character username is refused', await rejects('ab', 'a@b.co', 'hunter2hunter2'));
  check('a 17-character username is refused', await rejects('a'.repeat(17), 'a@b.co', 'hunter2hunter2'));
  check('a username with a space is refused', await rejects('le o', 'a@b.co', 'hunter2hunter2'));
  check('a username with markup is refused', await rejects('<script>', 'a@b.co', 'hunter2hunter2'));
  check('an address with no @ is refused', await rejects('leo', 'nope', 'hunter2hunter2'));
  check('a 7-character password is refused', await rejects('leo', 'a@b.co', 'short12'));
  check('none of those reached the network', s.calls.length === 0,
    s.calls.map(c => c.url).join(' | '));

  /* Email confirmation ON is a normal project setting, not an error. */
  const s2 = makeSandbox();
  s2.Online.configure(CONFIG);
  s2.route(() => ({ status: 200, body: { id: 'u', email: 'leo@example.com' } }));
  const res = await s2.Online.signUp('leo', 'leo@example.com', 'hunter2hunter2');
  check('a project that requires email confirmation is handled, not treated as failure',
    res.needsConfirmation === true && res.signedIn === false && s2.Online.isSignedIn() === false);

  /* Email confirmation OFF is the other normal setting, and as of the public
     launch it is THIS project's setting: GoTrue answers the signup with a
     full session and no mail is ever sent. Every signup assertion above this
     one exercises the confirmation-required half, so until now the path every
     real new player takes was the one path with nothing asserting on it.

     The contract the UI depends on: signedIn true, needsConfirmation FALSE -
     not merely falsy-by-omission, because ui_online.js branches on that exact
     field to decide between "you are in" and "go read your email", and the
     second of those is now advice about a message that will never arrive. */
  const s3 = makeSandbox();
  s3.Online.configure(CONFIG);
  s3.route(call => {
    if (call.url.includes('/auth/v1/signup')) return { status: 200, body: TOKEN_OK };
    return { status: 404, body: { message: 'unexpected: ' + call.url } };
  });
  const res3 = await s3.Online.signUp('newpilot', 'newpilot@example.com', 'hunter2hunter2');
  check('an auto-confirm project signs the new account straight in',
    res3.signedIn === true && res3.needsConfirmation === false &&
    s3.Online.isSignedIn() === true, JSON.stringify(res3));
  check('the auto-confirmed account carries the username the player just chose',
    s3.Online.state().username === 'newpilot', JSON.stringify(s3.Online.state()));
  check('the auto-confirmed session is persisted, so a reload stays signed in',
    !!s3.storage.get('skyhook.session'));
  check('the auto-confirmed session still keeps the email off the device',
    !String(s3.storage.get('skyhook.session')).includes('@'),
    String(s3.storage.get('skyhook.session')));
  check('an auto-confirm signup does NOT go looking for a profile row it just named',
    s3.calls.filter(c => c.url.includes('/rest/v1/profiles')).length === 0,
    s3.calls.map(c => c.url).join(' | '));
}

/* ==========================================================================
 * 10b. A REFUSED sign-up says something true.
 * ========================================================================
 * The happy paths above all had a cooperative server. Leo's did not: on
 * 2026-09-16 he tried to put his name on the board and
 *   POST /auth/v1/signup -> 429
 *   {"code":429,"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}
 * because this project is on Supabase's built-in SMTP, whose confirmation-mail
 * quota is a handful an hour and had been spent. The player was answered
 * "Too many attempts. Wait a minute and try again." - which blamed him for a
 * first attempt, and named a timescale ten to sixty times too short, so
 * following the advice returned him to the identical wall. That is how a
 * working button becomes "I tried to create a login and it didn't work".
 *
 * Every mock in this repo auto-confirmed, so the whole class was invisible to
 * CI. These are the assertions that make it visible, and the sharpest one is
 * the pair: BOTH rate limits are HTTP 429 and they must not produce the same
 * sentence, which is only possible if error_code is actually being read.
 * ======================================================================== */
{
  const refuses = async (status, body, fn) => {
    const s = makeSandbox();
    s.Online.configure(CONFIG);
    s.route(() => ({ status, body }));
    let msg = '';
    await (fn ? fn(s) : s.Online.signUp('newpilot', 'new@pilot.io', 'hunter2hunter2'))
      .then(() => { msg = '<RESOLVED - no error raised>'; }, e => { msg = e.message; });
    return msg;
  };

  const emailLimit = await refuses(429, {
    code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded'
  });
  check('a rate-limited sign-up is refused, not silently swallowed',
    emailLimit.indexOf('<RESOLVED') !== 0, emailLimit);
  check('a rate-limited sign-up does NOT tell the player to wait "a minute"',
    !/a minute/i.test(emailLimit), JSON.stringify(emailLimit));
  check('a rate-limited sign-up names a timescale the player can act on',
    /later|hour/i.test(emailLimit), JSON.stringify(emailLimit));
  check('a rate-limited sign-up does not blame the player for "too many attempts"',
    !/too many attempts/i.test(emailLimit), JSON.stringify(emailLimit));
  check('a rate-limited sign-up says the game is still playable without an account',
    /keep playing|without an account/i.test(emailLimit), JSON.stringify(emailLimit));
  check('a rate-limited sign-up never shows the backend string verbatim',
    !/email rate limit exceeded/i.test(emailLimit), JSON.stringify(emailLimit));

  /* The other 429. Same status, different cause, opposite advice - this pair
     is what proves error_code is read rather than the status guessed at. */
  const reqLimit = await refuses(429, {
    code: 429, error_code: 'over_request_rate_limit', msg: 'Request rate limit reached'
  }, s => s.Online.signIn('leo@pilot.io', 'hunter2hunter2'));
  check('the per-device 429 and the email-quota 429 do NOT say the same thing',
    reqLimit !== emailLimit, JSON.stringify([reqLimit, emailLimit]));
  check('the per-device 429 is the one that may honestly say "a minute"',
    /minute/i.test(reqLimit), JSON.stringify(reqLimit));

  /* GoTrue rejects whole domains - example.com among them, confirmed against
     the live project. Well-formed and still refused, so the generic fallback
     leaves the player staring at a form with nothing wrong on it. */
  const badEmail = await refuses(400, {
    code: 400, error_code: 'email_address_invalid',
    msg: 'Email address "a@example.com" is invalid'
  });
  check('a domain the server refuses is reported as an email problem',
    /email address was refused|different one/i.test(badEmail), JSON.stringify(badEmail));
  check('a refused domain does not echo the address back from the server',
    badEmail.indexOf('@') < 0, JSON.stringify(badEmail));

  const dup = await refuses(422, {
    code: 422, error_code: 'user_already_exists', msg: 'User already registered'
  });
  check('an address that already has an account is told to sign in instead',
    /sign in/i.test(dup), JSON.stringify(dup));

  const unconfirmed = await refuses(400, {
    code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed'
  }, s => s.Online.signIn('leo@pilot.io', 'hunter2hunter2'));
  check('an unconfirmed account is told where the link is, spam included',
    /not confirmed/i.test(unconfirmed) && /spam/i.test(unconfirmed),
    JSON.stringify(unconfirmed));

  const off = await refuses(422, {
    code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance'
  });
  check('sign-ups being switched off is stated, not disguised as a failure',
    /switched off/i.test(off), JSON.stringify(off));

  /* PostgREST speaks SQLSTATE in `code` as a STRING, where GoTrue puts the
     numeric HTTP status. Only the string form may be trusted as a code, or
     every 429 would be looked up under the key "429". */
  const dupRow = await refuses(409, {
    code: '23505', message: 'duplicate key value violates unique constraint'
  }, s => s.Online.signIn('leo@pilot.io', 'hunter2hunter2'));
  check('a PostgREST unique violation is read as a taken name, not a raw SQL line',
    /already taken/i.test(dupRow), JSON.stringify(dupRow));

  /* An error_code nobody has seen before must still land somewhere sane. */
  const unknown = await refuses(500, {
    code: 500, error_code: 'some_future_code_we_do_not_know', msg: 'internal boom'
  });
  check('an unrecognised error code falls back to a generic line, not a leak',
    unknown.length > 0 && !/internal boom|some_future_code/i.test(unknown),
    JSON.stringify(unknown));

  /* A dead network carries no code at all: the substring path below the table
     still has to work. */
  const s = makeSandbox();
  s.Online.configure(CONFIG);
  s.route(() => ({ networkError: true }));
  let netMsg = '';
  await s.Online.signUp('newpilot', 'new@pilot.io', 'hunter2hunter2')
    .then(() => {}, e => { netMsg = e.message; });
  check('an error with no code at all still gets a human line',
    /cannot reach|saved on this device/i.test(netMsg), JSON.stringify(netMsg));

  /* Every line above is rendered into a 12px centred paragraph, and
     ui_online.js truncates at 180 characters. A message that gets cut mid-word
     is not the message that was reviewed. */
  const allMessages = [emailLimit, reqLimit, badEmail, dup, unconfirmed, off, dupRow, unknown, netMsg];
  check('no player-facing line is long enough to be truncated at 180 chars',
    allMessages.every(m => m.length <= 180),
    JSON.stringify(allMessages.map(m => m.length)));
  check('no player-facing line contains an internal identifier',
    !allMessages.some(m => /_[a-z]+_[a-z]+|http|supabase|gotrue|postgrest|jwt/i.test(m)),
    JSON.stringify(allMessages.filter(m => /_[a-z]+_[a-z]+|http|supabase|gotrue|postgrest|jwt/i.test(m))));
}

/* ==========================================================================
 * 11. The schema still says what the threat model needs it to say.
 * ========================================================================
 * These are text assertions over supabase/schema.sql. They are blunt, and
 * that is the point: the SQL runs in Leo's Supabase project, not in CI, so
 * this file is the only place a reviewer's assumption about it can be made to
 * fail. Deleting a policy or turning RLS off must break the build. */
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const norm = sql.replace(/\s+/g, ' ').toLowerCase();

  check('RLS is enabled on scores',
    norm.includes('alter table public.scores enable row level security'));
  check('RLS is enabled on profiles',
    norm.includes('alter table public.profiles enable row level security'));
  check('insert is restricted to your own rows (with check user_id = auth.uid())',
    norm.includes('with check (user_id = auth.uid())'));
  check('there is NO update policy on scores', !/create policy[^;]*for update[^;]*on public\.scores/.test(norm));
  check('there is NO delete policy on scores', !/create policy[^;]*for delete[^;]*on public\.scores/.test(norm));
  check('update and delete are revoked outright',
    norm.includes('revoke update, delete on public.scores from anon, authenticated'));
  check('the rate limit is a BEFORE INSERT trigger (not bypassable by hitting the table directly)',
    norm.includes('before insert on public.scores') && norm.includes('rate limit'));
  check('the server overrides user_id with auth.uid() regardless of what the client sent',
    norm.includes('new.user_id := auth.uid()'));
  check('plausibility bounds are CHECK constraints on the table',
    norm.includes('constraint scores_score_plausible') && norm.includes('constraint scores_rate_plausible'));
  check('the public view runs as the caller (security_invoker), not as its owner',
    norm.includes('with (security_invoker = on)'));
  check('the public view selects no email column',
    !/create or replace view public\.leaderboard[\s\S]*?;/i.test(sql) ||
    !/create or replace view public\.leaderboard[\s\S]*?;/i.exec(sql)[0].toLowerCase().includes('email'));
  check('no view or function anywhere exposes auth.users columns to the client',
    !norm.includes('from auth.users'));
  check('the username shape is enforced in the database, not only in the form',
    norm.includes("username ~ '^[a-za-z0-9_]{3,16}$'"));
  check('usernames are unique case-insensitively',
    norm.includes('create unique index if not exists profiles_username_lower_key'));
  check('the schema never mentions the service_role key',
    !norm.includes('service_role'));
}

/* ==========================================================================
 * 12. js/config.js as committed must be safe and internally consistent.
 *
 * This used to assert the file shipped EMPTY. That assertion died the day the
 * leaderboard was actually switched on, and keeping it would have meant the
 * only way to ship the feature was to delete its own test - so it is replaced
 * by the checks that were doing the real work anyway:
 *
 *   - all or nothing. A URL with no key (or a key with no URL) is a build that
 *     thinks it is online and cannot be; js/online.js refuses it (section 2),
 *     and it should never reach a commit in the first place.
 *   - if it IS filled in, the key must be an ANON key. anon and service_role
 *     are both JWTs issued by the same project and differ by one claim inside
 *     base64, so a grep for the string "service_role" cannot tell them apart -
 *     it would sail straight past the one paste that hands every browser a key
 *     that bypasses RLS. Decoding the payload is the only check that catches
 *     it, and it is strictly stronger than what was here before.
 *
 * The offline default is still gated, just not by this file's contents: by
 * Online.configure() in section 2, and in a real browser by the explicitly
 * config-less site in test/leaderboard_ui.mjs.
 * ======================================================================== */
{
  const committed = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const field = re => { const m = re.exec(committed); return m ? m[1] : null; };
  const url = field(/supabaseUrl:\s*'([^']*)'/);
  const key = field(/supabaseAnonKey:\s*'([^']*)'/);

  check('js/config.js declares a supabaseUrl string', url !== null);
  check('js/config.js declares a supabaseAnonKey string', key !== null);
  check('js/config.js is all-or-nothing: both filled in, or both empty',
    (!!url) === (!!key), `url=${!!url} key=${!!key}`);

  /* googleSignIn gates whether the "Continue with Google" button is drawn at
     all. Only the literal true draws it, so a typo ('true', True, googleSignin)
     silently means off - which is the SAFE direction, but it should still be a
     declared boolean rather than an accident. */
  const googleLine = /googleSignIn:\s*(true|false)\s*[,}\n]/.exec(committed);
  check('js/config.js declares googleSignIn as a real boolean',
    googleLine !== null, googleLine ? googleLine[1] : 'missing or not a boolean literal');

  if (url && key) {
    check('the configured supabaseUrl is an https project URL with no trailing slash',
      /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url), url);

    /* Decode the JWT payload. Never print it whole: it is public, but a test
       log is not the place to normalise pasting keys around. */
    let claims = null;
    try {
      const seg = key.split('.')[1] || '';
      claims = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    } catch (e) { claims = null; }

    check('the committed key is a decodable JWT', claims !== null);
    check('the committed key is the ANON key, not service_role',
      !!claims && claims.role === 'anon', claims ? String(claims.role) : 'undecodable');
    check('the committed key belongs to the project in supabaseUrl',
      !!claims && url.includes(String(claims.ref)), claims ? String(claims.ref) : '?');
    check('the committed key has not expired',
      !!claims && typeof claims.exp === 'number' && claims.exp * 1000 > Date.now(),
      claims && claims.exp ? new Date(claims.exp * 1000).toISOString() : '?');
  }
  /* The service_role key bypasses RLS: in a browser it is a master key to the
     whole database. Comments are allowed to WARN about it - that is what
     js/config.js does - so comments are stripped before looking. Any surviving
     mention means one is in actual code. */
  const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const offenders = fs.readdirSync(path.join(ROOT, 'js'))
    .filter(f => f.endsWith('.js'))
    .filter(f => stripComments(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).includes('service_role'));
  check('no service_role key is committed in any js/ file (comments warning about it are fine)',
    offenders.length === 0, offenders.join(', '));
}

console.log(`\n${fails === 0
  ? 'online layer holds: offline stays offline, payloads are right, the rules are in the database'
  : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
