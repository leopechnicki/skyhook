/* SKYHOOK leaderboard UI gate  -  the account layer in a real browser.
 *
 * test/online.mjs proves the wire protocol with a stubbed fetch. This proves
 * the part a player touches: that the button exists only when it should, that
 * the panel opens, that typing a password does not fire the thruster, and that
 * finishing a run actually puts a row on the board.
 *
 * The mock Supabase is served by THIS test's own http server, on the same
 * origin as the page, and js/config.js is swapped for one pointing at it - for
 * every site below, including the config-less one, which is handed an
 * explicitly EMPTY config rather than whatever the repo currently ships. So
 * every request below goes through the browser's real fetch, real headers and
 * real JSON parsing - no route interception, no CORS theatre, no stub that can
 * drift away from what a browser would actually do.
 *
 * Two pages are tested and the second matters as much as the first:
 *   /online/  config present  -> the whole feature
 *   /         config empty    -> the off switch. No overlay, no button, no
 *                                request that leaves the page, and a tap where
 *                                the button WOULD be still starts a run.
 *
 * Run:  node test/leaderboard_ui.mjs   (Playwright required, like smoke.mjs)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HEADED = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * The mock project. Same shapes GoTrue and PostgREST really answer with.
 * ------------------------------------------------------------------------ */
const SESSION = {
  access_token: 'jwt-access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'user-uuid-1', email: 'leo@example.com' }
};

/* WHICH SIGN-IN METHOD the mock account uses. GoTrue reports this on every
   token response and on /auth/v1/user, and the account panel reads it to
   decide whether there is a password to change at all - so a mock that left
   it out would test the email half only and let the Google half ship blind.
   Both shapes here were read off the live project on 2026-09-22. */
let oauthAccount = false;
function userBody() {
  return oauthAccount
    ? Object.assign({}, SESSION.user, {
      identities: [{ provider: 'google' }],
      app_metadata: { provider: 'google', providers: ['google'] }
    })
    : Object.assign({}, SESSION.user, {
      identities: [{ provider: 'email' }],
      app_metadata: { provider: 'email', providers: ['email'] }
    });
}
function sessionBody() {
  return Object.assign({}, SESSION, { user: userBody() });
}

/* The name the mock's profiles row currently holds. A rename moves it, so a
   later read comes back with the new one rather than resurrecting the old - a
   stub that always answered 'leo' would hide a client that never noticed. */
let profileName = 'leo';

/* Set to { status, body } to make the next rename FAIL the way the database
   really does. The one that matters is a taken name: 409 with SQLSTATE 23505
   out of profiles_username_lower_key. */
let renameFailure = null;

/* The URL GoTrue sends a recovering player back on, assembled from parts
   instead of pasted in as a literal.

   The tidiness argument is that this is the ONE definition of that shape, so
   the three sites below cannot drift apart. The real argument is that
   "#access_token=...&refresh_token=...&token_type=bearer" is, to a secret
   scanner, indistinguishable from a genuinely leaked session - GitGuardian
   flags it on sight, and it is right to: it cannot know that these tokens are
   fixtures. A test suite that puts a red security check on every pull request
   teaches the people reading them to wave red security checks through, which
   costs more than it ever saves. */
function returnLeg(extra) {
  const parts = [
    ['access_token', SESSION.access_token],
    ['refresh_token', SESSION.refresh_token],
    ['expires_in', String(SESSION.expires_in)],
    ['token_type', 'bearer']
  ].concat(extra || []);
  return '#' + parts.map(([k, v]) => k + '=' + v).join('&');
}

/* What a "reset your password" link lands on. `type=recovery` is the whole
   difference between this and an ordinary implicit sign-in. */
const RECOVERY_LEG = returnLeg([['type', 'recovery']]);

const BOARD = [
  { rank: 1, username: 'klaudia', score: 9100, hooks: 74, altitude: 3900, created_at: '2026-09-10T10:00:00Z' },
  { rank: 2, username: 'leo', score: 1840, hooks: 22, altitude: 913, created_at: '2026-09-13T10:00:00Z' },
  { rank: 3, username: 'lucas', score: 620, hooks: 9, altitude: 210, created_at: '2026-09-11T10:00:00Z' }
];

const api = [];   // every call the page made to the mock project

/* Flipped on for the one signup below that must behave like a project with
   "Confirm email" left ON - which is Supabase's default, so it is the shape
   most real deployments have, including this game's own. */
let confirmRequired = false;

/* Set to { status, body } to make the next signup FAIL with a real GoTrue
   error shape. Every mock in this repo auto-confirmed until 2026-09-16, which
   is precisely why a signup that the server refuses shipped twice without
   anybody seeing what the player is left looking at. A mock that can only
   succeed tests only the half of the code that was never in doubt. */
let signupFailure = null;

/* The same lever for SIGN IN. Every mock here answered /auth/v1/token with a
   valid session, so the refusal a real player hits most often - wrong
   credentials, usually because the leaderboard name went into the email box -
   had never once been rendered in a browser under test. */
let signinFailure = null;

/* And the same lever for the reset request. A reset that the server refuses is
   not an edge case for the person it happens to: they are locked out, and the
   button they pressed is the only door left. */
let recoverFailure = null;

function handleApi(req, res, body) {
  const url = req.url.replace(/^\/api/, '');
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
  api.push({ method: req.method, url, body: parsed, headers: req.headers });

  const json = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload === null ? '' : JSON.stringify(payload));
  };

  if (url.startsWith('/auth/v1/signup')) {
    if (signupFailure) return json(signupFailure.status, signupFailure.body);
    /* GoTrue answers a signup on a confirm-email project with a user object
       and NO tokens; that absence is exactly what Online.signUp reads as
       needsConfirmation. Returning the full SESSION here (the auto-confirm
       case) is what let the bug below ship unnoticed. */
    return json(200, confirmRequired
      ? { id: 'user-uuid-2', email: (parsed && parsed.email) || '', confirmation_sent_at: '2026-09-16T18:00:00Z' }
      : sessionBody());
  }
  if (url.startsWith('/auth/v1/token')) {
    if (signinFailure) return json(signinFailure.status, signinFailure.body);
    return json(200, sessionBody());
  }
  /* GoTrue answers a recovery request with 200 and an empty object, for an
     address that has an account and for one that does not. That sameness is
     the anti-enumeration property, so the mock has to have it too - a mock
     that answered 404 for unknown addresses would let a leak ship green. */
  if (url.startsWith('/auth/v1/recover')) {
    if (recoverFailure) return json(recoverFailure.status, recoverFailure.body);
    return json(200, {});
  }
  if (url.startsWith('/auth/v1/logout')) { res.writeHead(204).end(); return; }
  /* PUT is a password change; GET is "who am I and how do I sign in". GoTrue
     answers both with the user object and no new tokens, which is why the
     session survives a password change. */
  if (url.startsWith('/auth/v1/user')) return json(200, userBody());
  if (url.startsWith('/rest/v1/profiles')) {
    if (req.method === 'PATCH') {
      if (renameFailure) return json(renameFailure.status, renameFailure.body);
      /* PostgREST echoes the stored row back when asked to, which is the only
         evidence the client has that RLS did not silently drop the write. */
      profileName = (parsed && parsed.username) || profileName;
      return json(200, [{ username: profileName }]);
    }
    return json(200, [{ username: profileName }]);
  }
  if (url.startsWith('/rest/v1/leaderboard')) return json(200, BOARD);
  if (url.startsWith('/rest/v1/rpc/my_rank')) return json(200, [{ rank: 2, score: 1840, username: 'leo' }]);
  if (url.startsWith('/rest/v1/scores')) { res.writeHead(201, { 'Content-Type': 'application/json' }).end('{}'); return; }
  return json(404, { message: 'no such endpoint: ' + url });
}

/* A port with nothing behind it, so "the backend is down" is a real refused
   connection rather than a stubbed rejection. Bound then immediately released:
   the OS hands out ephemeral ports in sequence, so the one we just gave back
   is the one least likely to be taken by something else mid-run. */
async function closedPort() {
  const probe = http.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  return port;
}

function startServer(deadPort) {
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent(req.url.split('?')[0]);

    if (clean.startsWith('/api/')) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => handleApi(req, res, body));
      return;
    }

    /* Three sites off one server, same files, three configs:
         /         config blanked - the off switch, exercised
         /online/  live config    - the whole feature
         /dead/    config that points at a port nothing is listening on

       All three get a SYNTHESISED js/config.js; none of them reads the file in
       the repo. That is deliberate. The repo's config is filled in now - the
       leaderboard is on for the real deployment - so a test that borrowed it
       would have quietly stopped testing the offline path the moment it went
       live: the exact failure where a green tick means nothing. Pinning all
       three configs here keeps every branch reachable no matter what the
       shipped config happens to say. */
    const configured = clean.startsWith('/online');
    const dead = clean.startsWith('/dead');
    let rel = clean;
    if (configured) rel = clean.replace(/^\/online\/?/, '/');
    else if (dead) rel = clean.replace(/^\/dead\/?/, '/');
    if (rel === '/' || rel === '') rel = '/index.html';

    if (rel === '/js/config.js') {
      const apiPort = dead ? deadPort : server.address().port;
      /* The bare site gets the empty config verbatim: the off switch as a
         player would receive it, not an absence of the file. */
      const cfgUrl = (configured || dead) ? `http://127.0.0.1:${apiPort}/api` : '';
      const cfgKey = (configured || dead) ? 'anon-test-key' : '';
      /* Only /online/ opts Google in. /dead/ deliberately leaves it out, so
         the two halves of the opt-in are both covered without a fourth site:
         the button is drawn where the provider exists and is ABSENT where it
         does not. */
      const cfgGoogle = configured;
      res.writeHead(200, { 'Content-Type': MIME['.js'] });
      res.end(
        'window.SKYHOOK_CONFIG = {\n' +
        `  supabaseUrl: '${cfgUrl}',\n` +
        `  supabaseAnonKey: '${cfgKey}',\n` +
        '  boardLimit: 50,\n' +
        `  googleSignIn: ${cfgGoogle}\n` +
        '};\n'
      );
      return;
    }

    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* The canvas is letterboxed inside #stage, so a logical (480x880) coordinate
   has to be mapped through the element's real box to be clickable. */
async function tapLogical(page, lx, ly) {
  const box = await page.locator('#game').boundingBox();
  await page.mouse.click(box.x + (lx / 480) * box.width, box.y + (ly / 880) * box.height);
}

function attachLogs(page, bucket, label, opts = {}) {
  /* Chrome reports a 204 No Content answer to fetch() as a FAILED request
     (net::ERR_ABORTED) even though the response arrived and the promise
     resolves: there is simply no body to hand to the loader. GoTrue really
     does answer /auth/v1/logout with 204, so without this the sign-out path
     is permanently, wrongly red. Only that exact combination is forgiven -
     a 204 that we saw a response for. Everything else still fails the gate. */
  const noContent = new Set();
  const key = r => `${r.method()} ${r.url()}`;
  page.on('response', r => { if (r.status() === 204) noContent.add(key(r.request())); });

  /* The same problem in the other direction. Chrome writes a "Failed to load
     resource: the server responded with a status of 429" console error for
     EVERY non-2xx fetch, including one the test asked for on purpose - and the
     refused-signup section asks for exactly that. Forgiving it is narrow and
     deliberate: only the signup endpoint, only a status the mock was told to
     return, and only for a response we actually observed. A 4xx from any other
     endpoint, or a signup 4xx nobody armed, still fails the gate. The message
     those responses produce is asserted on screen by name in section B, so
     nothing here is going unchecked - this only stops Chrome's narration of a
     scripted failure from being read as a defect. */
  const provoked = new Set();
  page.on('response', r => {
    if (r.status() >= 400 && signupFailure && r.status() === signupFailure.status &&
        r.url().includes('/auth/v1/signup')) {
      provoked.add(r.url());
    }
    if (r.status() >= 400 && signinFailure && r.status() === signinFailure.status &&
        r.url().includes('/auth/v1/token')) {
      provoked.add(r.url());
    }
    if (r.status() >= 400 && recoverFailure && r.status() === recoverFailure.status &&
        r.url().includes('/auth/v1/recover')) {
      provoked.add(r.url());
    }
    if (r.status() >= 400 && renameFailure && r.status() === renameFailure.status &&
        r.url().includes('/rest/v1/profiles')) {
      provoked.add(r.url());
    }
  });

  /* Section C deliberately points the page at a port nothing is listening on,
     so connection failures to that origin are the thing under test, not a
     defect. Nothing else may be ignored. */
  const expected = opts.expectFailuresFrom || null;

  page.on('console', m => {
    if (m.type() !== 'error') return;
    /* Chrome's "Failed to load resource" line carries the URL in location(),
       not in text(), so both have to be checked to recognise the failures
       section C is deliberately causing. */
    if (expected && (m.text().includes(expected) || (m.location()?.url || '').startsWith(expected))) return;
    if (provoked.has(m.location()?.url || '')) return;
    bucket.push(`[${label}] console: ${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', e => bucket.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.startsWith('data:')) return;
    if (expected && u.startsWith(expected)) return;
    if (noContent.has(key(r))) return;
    bucket.push(`[${label}] requestfailed: ${u} ${r.failure()?.errorText}`);
  });
}

async function main() {
  const deadPort = await closedPort();
  const server = await startServer(deadPort);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  const deadOrigin = `http://127.0.0.1:${deadPort}`;
  const errors = [];

  const launchOpts = { headless: !HEADED, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] };
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', ...launchOpts }); }
  catch { browser = await chromium.launch(launchOpts); }

  try {
    /* ==================================================================
     * A. The off switch: empty config, therefore no account layer.
     * ================================================================ */
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      attachLogs(page, errors, 'default');

      const external = [];
      page.on('request', r => {
        const u = r.url();
        if (!u.startsWith(base) && !u.startsWith('data:')) external.push(u);
      });

      await page.goto(base, { waitUntil: 'load' });
      await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(300);

      const snap = await page.evaluate('window.__SKYHOOK.snapshot()');
      check('blank-config build: the game does not believe it has a backend',
        snap.online && snap.online.ready === false, JSON.stringify(snap.online));
      check('blank-config build: the overlay is not visible',
        (await page.locator('#ol').isVisible()) === false);
      check('blank-config build: no account UI was drawn on the title screen',
        snap.online.signedIn === false && snap.online.username === '');

      /* The button's hit rect must be genuinely dead, not merely invisible.
         A tap at its exact centre has to fall through to "start the run". */
      await tapLogical(page, 240, 816);
      await wait(200);
      const after = await page.evaluate('window.__SKYHOOK.game.state');
      check('blank-config build: a tap where the button WOULD be still starts the game',
        after === 'playing', `state=${after}`);

      check('blank-config build: not one request left the page', external.length === 0,
        external.slice(0, 4).join(' | '));
      await ctx.close();
    }

    /* ==================================================================
     * A2. The off switch, arrived at through a RECOVERY LINK.
     *
     * The new code path reads the URL fragment at boot, which is the one
     * place an off switch can be defeated by something that is not a button:
     * nobody has to click anything for a `#access_token=...&type=recovery`
     * to be processed. On a build with no backend it must be ignored
     * completely - no request, no overlay, no session - and the game behind
     * it must still start.
     * ================================================================ */
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      attachLogs(page, errors, 'default-recovery');

      const external = [];
      page.on('request', r => {
        const u = r.url();
        if (!u.startsWith(base) && !u.startsWith('data:')) external.push(u);
      });

      await page.goto(base + RECOVERY_LEG, { waitUntil: 'load' });
      await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(400);

      check('blank-config build: a recovery link opens no account UI',
        (await page.locator('#ol').isVisible()) === false);
      check('blank-config build: a recovery link signs nobody in',
        (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);
      check('blank-config build: a recovery link causes no request', external.length === 0,
        external.slice(0, 4).join(' | '));
      check('blank-config build: a recovery link stores no session',
        !(await page.evaluate('localStorage.getItem("skyhook.session")')));

      await page.evaluate('window.__SKYHOOK.skipTutorial(true)');
      await tapLogical(page, 240, 400);
      await wait(300);
      check('blank-config build: the game still starts after a recovery link',
        (await page.evaluate('window.__SKYHOOK.game.state')) === 'playing');
      await ctx.close();
    }

    /* ==================================================================
     * B. Configured: the whole feature.
     * ================================================================ */
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    attachLogs(page, errors, 'online');

    await page.goto(base + 'online/', { waitUntil: 'load' });
    await page.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
    await wait(400);

    let snap = await page.evaluate('window.__SKYHOOK.snapshot()');
    check('configured build: the game knows a backend exists',
      snap.online.ready === true, JSON.stringify(snap.online));
    check('configured build: still signed out on first load', snap.online.signedIn === false);
    check('configured build: the overlay stays closed until asked for',
      (await page.locator('#ol').isVisible()) === false);
    check('configured build: nothing was requested from the API before the player asked',
      api.length === 0, api.map(c => c.url).join(' | '));

    /* ---- open the board from the title screen ---- */
    await tapLogical(page, 240, 816);
    await wait(500);

    check('tapping LEADERBOARD opens the panel instead of starting a run',
      (await page.locator('#ol').isVisible()) === true &&
      (await page.evaluate('window.__SKYHOOK.game.state')) === 'title');
    check('the board panel is a real dialog',
      (await page.locator('.ol-panel').getAttribute('role')) === 'dialog' &&
      (await page.locator('.ol-panel').getAttribute('aria-modal')) === 'true');

    const rows = page.locator('#ol-list .ol-row');
    check('the top scores render', (await rows.count()) === 3, `rows=${await rows.count()}`);
    check('a row shows rank, name and score',
      (await rows.nth(0).locator('.ol-rank').textContent()) === '#1' &&
      (await rows.nth(0).locator('.ol-name').textContent()) === 'klaudia' &&
      (await rows.nth(0).locator('.ol-score').textContent()) === '9100');
    check('a signed-out player is told what signing in is for',
      /guest/i.test(await page.locator('#ol-account').textContent()));
    check('the board itself is readable while signed out (it is public data)',
      api.some(c => c.url.startsWith('/rest/v1/leaderboard')));
    check('the public board was read with the anon key, not a user token',
      api.find(c => c.url.startsWith('/rest/v1/leaderboard')).headers.authorization === 'Bearer anon-test-key');
    check('no email address appears anywhere in the rendered board',
      !(await page.locator('#ol-list').textContent()).includes('@'));

    /* ---- into the auth view ---- */
    await page.locator('#ol-signin').click();
    check('googleSignIn:true -> the sign-in view offers Google',
      (await page.locator('#ol-google').isVisible()) === true &&
      /google/i.test(await page.locator('#ol-google').textContent()));
    check('googleSignIn:true -> the "or" rule that separates it is shown too',
      (await page.locator('#ol-auth .ol-or').isVisible()) === true);
    check('sign-in asks for email and password only',
      (await page.locator('#ol-email').isVisible()) === true &&
      (await page.locator('#ol-password').isVisible()) === true &&
      (await page.locator('#ol-username').isVisible()) === false);

    /* ---- which of the two names does this box want? ----
       Leo signed up choosing a USERNAME, came back, and was asked for an
       EMAIL. Nothing on the form said those were different things, and every
       public player walks into the same wall. Supabase authenticates by email
       and must keep doing so - a username -> email lookup open to the public
       would turn the leaderboard into an address list - so the form has to be
       the thing that is unambiguous. These assertions are what stops the
       wording quietly reverting to a bare "Email". */
    const signinEmailLabel = (await page.locator('#ol-email-label').textContent()).trim();
    check('the sign-in email label ties the box to the signup, not the board',
      /signed up/i.test(signinEmailLabel), JSON.stringify(signinEmailLabel));
    check('the sign-in email field says it is NOT the leaderboard name',
      /not your leaderboard name/i.test(
        (await page.locator('#ol-email-hint').textContent()).trim()),
      JSON.stringify((await page.locator('#ol-email-hint').textContent()).trim()));
    check('the sign-in email hint is wired to the input for screen readers',
      (await page.locator('#ol-email').getAttribute('aria-describedby')) === 'ol-email-hint');
    check('the email box still expects an address (type=email keeps the @ keyboard)',
      (await page.locator('#ol-email').getAttribute('type')) === 'email' &&
      (await page.locator('#ol-email').getAttribute('placeholder')).includes('@'));

    await page.locator('#ol-toggle').click();
    /* Counted by what is VISIBLE rather than by what exists. The form gained a
       fourth input when CHANGE PASSWORD arrived - a second password box, for
       the current one - and it is hidden AND disabled on every other view. The
       rule being defended here is "CREATE ACCOUNT asks for three things", not
       "this <form> contains three tags", and the visible count is the one that
       states it. */
    check('the create-account view asks for exactly username, email, password',
      (await page.locator('#ol-username').isVisible()) === true &&
      (await page.locator('#ol-email').isVisible()) === true &&
      (await page.locator('#ol-password').isVisible()) === true &&
      (await page.locator('#ol-form input:visible').count()) === 3,
      `visible inputs=${await page.locator('#ol-form input:visible').count()}`);
    check('create-account tells the browser it is a NEW password (password managers)',
      (await page.locator('#ol-password').getAttribute('autocomplete')) === 'new-password');

    /* On CREATE ACCOUNT the player is CHOOSING both, so the useful split is
       which one strangers will see and which one logs them in. */
    check('create-account says the username is the public name on the board',
      /public/i.test(await page.locator('#ol-username-hint').textContent()) &&
      /leaderboard/i.test(await page.locator('#ol-username-hint').textContent()),
      JSON.stringify((await page.locator('#ol-username-hint').textContent()).trim()));
    check('create-account says the email is the login and is never shown publicly',
      /login/i.test(await page.locator('#ol-email-hint').textContent()) &&
      /never shown/i.test(await page.locator('#ol-email-hint').textContent()),
      JSON.stringify((await page.locator('#ol-email-hint').textContent()).trim()));
    check('the username hint is wired to its input for screen readers',
      (await page.locator('#ol-username').getAttribute('aria-describedby')) === 'ol-username-hint');
    check('the two hints on CREATE ACCOUNT do not say the same thing',
      (await page.locator('#ol-username-hint').textContent()) !==
      (await page.locator('#ol-email-hint').textContent()));

    await page.locator('#ol-toggle').click();
    check('toggling back returns to sign-in',
      (await page.locator('#ol-username').isVisible()) === false &&
      (await page.locator('#ol-password').getAttribute('autocomplete')) === 'current-password');
    /* The copy is rewritten per mode, so it has to survive going BACK too - a
       sign-in form still carrying the create-account wording would be the same
       bug again, pointing the other way. */
    check('toggling back also restores the sign-in wording on the email field',
      (await page.locator('#ol-email-label').textContent()).trim() === signinEmailLabel &&
      /not your leaderboard name/i.test(await page.locator('#ol-email-hint').textContent()));

    /* ---- SPACE is a character here, not a thruster ----
       Before accounts there was no field to type into and SPACE could safely
       be global. This is the regression that would otherwise ship: a space in
       a password starting a run underneath the dialog. */
    await page.locator('#ol-password').click();
    await page.keyboard.type('hunter2 hunter2');
    const stateWhileTyping = await page.evaluate('window.__SKYHOOK.game.state');
    const typed = await page.locator('#ol-password').inputValue();
    check('SPACE typed into the password field does NOT start a run',
      stateWhileTyping === 'title', `state=${stateWhileTyping}`);
    check('SPACE typed into the password field lands in the field',
      typed === 'hunter2 hunter2', JSON.stringify(typed));

    /* ---- Leo's actual path, end to end ----
       Sign up choosing the name "leo", come back, meet a box labelled Email,
       type "leo" into it. The server answers invalid_credentials and whatever
       is painted next is the entire experience. It used to be "That email and
       password do not match an account.", which to someone certain they typed
       their name correctly reads as "the computer is broken". The rendered
       line must name the mix-up, not restate the refusal. */
    signinFailure = {
      status: 400,
      body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }
    };
    await page.locator('#ol-email').fill('leo');
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-submit').click();
    await page.waitForFunction(
      'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
    await wait(150);
    const credMsg = ((await page.locator('#ol-auth-msg').textContent()) || '').trim();
    check('a username typed into the email box gets an answer that names the mix-up',
      /leaderboard name/i.test(credMsg), JSON.stringify(credMsg));
    check('the failed sign-in line is rendered as an error, not as neutral status',
      (await page.locator('#ol-auth-msg').getAttribute('class') || '').includes('is-error'));
    check('a failed sign-in leaves the player signed out and still on sign-in',
      (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === false &&
      (await page.locator('#ol-username').isVisible()) === false);
    check('a failed sign-in keeps the typed address so it can be corrected',
      (await page.locator('#ol-email').inputValue()) === 'leo');
    check('a failed sign-in never shows the backend string verbatim',
      !/invalid login credentials|invalid_credentials/i.test(credMsg), JSON.stringify(credMsg));
    signinFailure = null;

    /* ---- a project with "Confirm email" ON: the player must be TOLD ----
       The regression this guards is invisible to every other assertion here:
       the code set the "check your email" line and THEN called showAuth(),
       which resets the view and blanks that very element. The player was
       flipped to an empty sign-in form with nothing on screen, tried to sign
       in, and was rejected for an unconfirmed address they were never told
       about. On this deployment that is the ONLY way to make an account -
       Google is off - so a silent signup is a dead end, not a papercut. */
    confirmRequired = true;
    await page.locator('#ol-toggle').click();
    await page.locator('#ol-username').fill('newpilot');
    await page.locator('#ol-email').fill('newpilot@example.com');
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-submit').click();
    await page.waitForFunction(
      'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
    await wait(200);
    const confirmMsg = ((await page.locator('#ol-auth-msg').textContent()) || '').trim();
    check('signup needing confirmation says so, and the line survives the view switch',
      confirmMsg.length > 0 && /email/i.test(confirmMsg), JSON.stringify(confirmMsg));
    check('signup needing confirmation leaves the player on sign-in, still signed out',
      (await page.locator('#ol-username').isVisible()) === false &&
      (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);
    check('signup needing confirmation does not leave a password in the DOM',
      (await page.locator('#ol-password').inputValue()) === '');
    confirmRequired = false;

    /* ---- the server REFUSES the sign-up: what is the player left with? ----
       On 2026-09-16 Leo tried to put his name on the board and got
         POST /auth/v1/signup -> 429
         {"code":429,"error_code":"over_email_send_rate_limit",...}
       because this project uses Supabase's built-in SMTP, whose confirmation
       mail quota is a few an hour and was spent. Nothing he typed was wrong.
       The old answer - "Too many attempts. Wait a minute and try again." -
       blamed him for a first attempt and named a timescale far too short, so
       doing as told returned him to the same wall. Hence "I tried to create a
       login and it didn't work".

       The viewport is deliberately SHORT here, and the exact number matters.
       #ol-auth-msg is the LAST element in the auth view - below the button
       that was just pressed - inside a panel that is `max-height: 100%;
       overflow-y: auto`. On a tall window the message is visible whatever the
       code does, so a test run at 900px proves nothing about it. Measured on
       Chrome at 390px wide with the message this project actually sends:

         height >= 460   panel does not overflow, message visible either way
         height == 420   panel overflows, but clicking the button auto-scrolls
                         far enough that the message lands in view anyway
         height <= 380   message renders BELOW the panel's visible box unless
                         something scrolls it there

       360 sits inside that last band with room to spare, so this assertion
       genuinely goes red if revealAuthMsg() is removed - verified by removing
       it. A player on a phone with the browser chrome taking a third of the
       screen is in that band. */
    await page.setViewportSize({ width: 390, height: 360 });
    signupFailure = {
      status: 429,
      body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }
    };
    await page.locator('#ol-toggle').click();
    await page.locator('#ol-username').fill('leopilot');
    await page.locator('#ol-email').fill('leo.pilot@example.com');
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-submit').click();

    let settled = true;
    try {
      await page.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
    } catch { settled = false; }
    await wait(300);

    check('a refused sign-up gives the button back (not a dead or spinning control)', settled);

    const refusedMsg = ((await page.locator('#ol-auth-msg').textContent()) || '').trim();
    check('a refused sign-up says something at all', refusedMsg.length > 0, JSON.stringify(refusedMsg));
    check('a refused sign-up is styled as an error, not as neutral chatter',
      await page.locator('#ol-auth-msg').evaluate(n => n.classList.contains('is-error')));
    check('a refused sign-up is announced to assistive tech',
      (await page.locator('#ol-auth-msg').getAttribute('role')) === 'alert');
    check('a rate-limited sign-up drops the "wait a minute" advice that sent Leo back into the wall',
      !/a minute/i.test(refusedMsg), JSON.stringify(refusedMsg));
    check('a rate-limited sign-up gives a timescale and a way out',
      /later/i.test(refusedMsg) && /keep playing|without an account/i.test(refusedMsg),
      JSON.stringify(refusedMsg));
    check('a rate-limited sign-up never shows the raw backend string',
      !/rate limit exceeded|429|error_code/i.test(refusedMsg), JSON.stringify(refusedMsg));

    /* The regression that matters as much as the wording: the message has to
       be ON SCREEN. It is the last node in a scrollable panel, so unless it is
       scrolled to it renders below the visible box and the player sees a form
       that simply did nothing. */
    const msgInView = await page.evaluate(`(() => {
      const m = document.getElementById('ol-auth-msg');
      const p = document.querySelector('.ol-panel');
      const mr = m.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return {
        inPanel: mr.top >= pr.top - 1 && mr.bottom <= pr.bottom + 1,
        inWindow: mr.top >= 0 && mr.bottom <= window.innerHeight,
        msg: [Math.round(mr.top), Math.round(mr.bottom)],
        panel: [Math.round(pr.top), Math.round(pr.bottom)],
        win: window.innerHeight
      };
    })()`);
    check('the refusal is scrolled into view, not painted below the fold',
      msgInView.inPanel && msgInView.inWindow, JSON.stringify(msgInView));

    check('a refused sign-up keeps the player on CREATE ACCOUNT',
      (await page.locator('#ol-username').isVisible()) === true);
    check('a refused sign-up does not make the player retype what they entered',
      (await page.locator('#ol-username').inputValue()) === 'leopilot' &&
      (await page.locator('#ol-email').inputValue()) === 'leo.pilot@example.com');
    check('a refused sign-up leaves the player signed out',
      (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);
    check('a refused sign-up persists no session on the device',
      !(await page.evaluate(
        `(() => { try { return localStorage.getItem('skyhook.session') || ''; } catch (e) { return 'ERR'; } })()`
      )).includes('access_token'));

    /* A refused account must not cost the player the game. */
    await page.keyboard.press('Escape');
    await wait(200);
    check('Escape still closes the panel after a refused sign-up',
      (await page.locator('#ol').isVisible()) === false);
    await page.evaluate('window.__SKYHOOK.skipTutorial(true); window.__SKYHOOK.tap();');
    await wait(300);
    check('the game still starts after a refused sign-up',
      (await page.evaluate('window.__SKYHOOK.game.state')) === 'playing',
      await page.evaluate('window.__SKYHOOK.game.state'));
    await page.evaluate(`window.__SKYHOOK.game.die('fell')`);
    await wait(400);

    /* ---- a domain the server refuses: its own line, not the generic one ----
       GoTrue turns away whole domains (example.com and the disposable
       providers among them). The address is well formed, so "Could not create
       that account." leaves the player with a form they cannot fix by looking
       at it. */
    await page.setViewportSize({ width: 1280, height: 900 });
    signupFailure = {
      status: 400,
      body: { code: 400, error_code: 'email_address_invalid', msg: 'Email address "x@example.com" is invalid' }
    };
    await page.evaluate(`window.SK.UI.open('auth')`);
    await wait(300);
    await page.locator('#ol-toggle').click();
    await page.locator('#ol-username').fill('leopilot');
    await page.locator('#ol-email').fill('leo.pilot@example.com');
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-submit').click();
    try {
      await page.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
    } catch { /* the assertion below reports it */ }
    await wait(300);
    const badEmailMsg = ((await page.locator('#ol-auth-msg').textContent()) || '').trim();
    check('a server-refused email domain gets its own line, not the generic failure',
      /email address was refused|different one/i.test(badEmailMsg), JSON.stringify(badEmailMsg));
    check('a server-refused email domain does not echo the address back',
      badEmailMsg.indexOf('@') < 0, JSON.stringify(badEmailMsg));

    /* Hand the form back the way the rest of this file expects to find it:
       auth view open, on SIGN IN, with a cooperative server. */
    signupFailure = null;
    await page.locator('#ol-toggle').click();
    await wait(200);
    check('the form returns to SIGN IN after the refusals',
      (await page.locator('#ol-username').isVisible()) === false);

    /* ---- sign in for real ---- */
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-email').fill('leo@example.com');
    await page.locator('#ol-submit').click();
    await page.waitForFunction('window.__SKYHOOK.game.online.signedIn === true', null, { timeout: 8000 });
    await wait(400);

    const login = api.find(c => c.url.startsWith('/auth/v1/token'));
    check('sign-in posts to the password grant',
      !!login && login.method === 'POST' && login.url.includes('grant_type=password'));
    check('sign-in sends only email and password',
      JSON.stringify(Object.keys(login.body).sort()) === '["email","password"]',
      JSON.stringify(Object.keys(login.body)));
    check('the game now knows who is playing',
      (await page.evaluate('window.__SKYHOOK.game.online.username')) === 'leo');
    check('the panel says who is signed in',
      /signed in as leo/i.test(await page.locator('#ol-account').textContent()));
    check('the sign-out button appeared and sign-in went away',
      (await page.locator('#ol-signout').isVisible()) === true &&
      (await page.locator('#ol-signin').isVisible()) === false);
    check('your own row is highlighted on the board',
      (await page.locator('#ol-list .ol-row.is-me .ol-name').textContent()) === 'leo');
    check('your rank is stated plainly',
      /#2/.test(await page.locator('#ol-myrank').textContent()),
      await page.locator('#ol-myrank').textContent());
    check('the password was cleared from the DOM after signing in',
      (await page.locator('#ol-password').inputValue()) === '');

    /* ---- ACCOUNT SETTINGS ----
       Until this existed, "Signed in as leo" was a dead end: the only thing a
       player could do with their account from inside the game was leave it.
       Both routes out of that line are checked here, and so is the thing that
       makes a rename safe to offer - that the board follows the new name. */
    check('a signed-in player is offered the two account actions',
      (await page.locator('#ol-account-links').isVisible()) === true &&
      (await page.locator('#ol-edit-name').isVisible()) === true &&
      (await page.locator('#ol-edit-password').isVisible()) === true);

    await page.locator('#ol-edit-name').click();
    await wait(200);
    check('Change username opens a view that says so',
      (await page.locator('#ol-title').textContent()).trim() === 'CHANGE USERNAME');
    check('...prefilled with the name they have, so it is an edit and not a retype',
      (await page.locator('#ol-username').inputValue()) === 'leo');
    check('...and asks for nothing else - no email, no password',
      (await page.locator('#ol-form input:visible').count()) === 1,
      `visible inputs=${await page.locator('#ol-form input:visible').count()}`);
    check('...and says what happens to the scores already on the board',
      /past scores/i.test(await page.locator('#ol-username-hint').textContent()),
      await page.locator('#ol-username-hint').textContent());

    /* A name the database would refuse, refused here instead - and provably
       not sent, because the rule is a CHECK constraint and a round trip to be
       told so is a round trip wasted. */
    api.length = 0;
    await page.locator('#ol-username').fill('astro leo');
    await page.locator('#ol-submit').click();
    await wait(300);
    check('a name with a space is refused with the actual rule',
      /3-16/.test(await page.locator('#ol-auth-msg').textContent()),
      await page.locator('#ol-auth-msg').textContent());
    check('...and was never sent', !api.some(c => c.method === 'PATCH'),
      api.map(c => c.method + ' ' + c.url).join(' | '));

    /* A name the database refuses because somebody else has it. This one HAS
       to make the trip, and the sentence has to be the one sign-up uses. */
    renameFailure = {
      status: 409,
      body: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_lower_key"' }
    };
    api.length = 0;
    await page.locator('#ol-username').fill('klaudia');
    await page.locator('#ol-submit').click();
    await wait(400);
    check('a name somebody else holds comes back as taken',
      /already taken/i.test(await page.locator('#ol-auth-msg').textContent()),
      await page.locator('#ol-auth-msg').textContent());
    check('...and the player is still called leo',
      (await page.evaluate('window.__SKYHOOK.game.online.username')) === 'leo');
    renameFailure = null;

    api.length = 0;
    await page.locator('#ol-username').fill('astro_leo');
    await page.locator('#ol-submit').click();
    await page.waitForFunction(
      'window.__SKYHOOK.game.online.username === "astro_leo"', null, { timeout: 8000 });
    await wait(300);
    const rename = api.find(c => c.method === 'PATCH');
    check('the rename is a PATCH of the username alone',
      !!rename && JSON.stringify(rename.body) === JSON.stringify({ username: 'astro_leo' }),
      rename ? JSON.stringify(rename.body) : 'no PATCH');
    check('the rename asks for the stored row back rather than trusting a 200',
      !!rename && rename.headers.prefer === 'return=representation',
      rename ? String(rename.headers.prefer) : '');
    check('the panel goes back to the board and states the new name',
      (await page.locator('#ol-board').isVisible()) === true &&
      /signed in as astro_leo/i.test(await page.locator('#ol-account').textContent()),
      await page.locator('#ol-account').textContent());
    check('...and says the scores already set came with it',
      /every score/i.test(await page.locator('#ol-board-msg').textContent()),
      await page.locator('#ol-board-msg').textContent());

    /* ---- the password, from inside a live session ---- */
    await page.locator('#ol-edit-password').click();
    await wait(400);
    check('Change password opens a view that says so',
      (await page.locator('#ol-title').textContent()).trim() === 'CHANGE PASSWORD');
    check('it asks for the current password AND a new one, labelled apart',
      (await page.locator('#ol-form input:visible').count()) === 2 &&
      /current/i.test(await page.locator('#ol-password-label').textContent()) &&
      /new/i.test(await page.locator('#ol-password2-label').textContent()),
      `${await page.locator('#ol-password-label').textContent()} / ${await page.locator('#ol-password2-label').textContent()}`);
    check('the browser is told which box is which, so it saves the right one',
      (await page.locator('#ol-password').getAttribute('autocomplete')) === 'current-password' &&
      (await page.locator('#ol-password2').getAttribute('autocomplete')) === 'new-password');

    /* THE POINT OF THE WHOLE FLOW. A session left open on a shared machine
       must not be enough to take the account, so a wrong current password has
       to stop before anything is written. */
    signinFailure = {
      status: 400,
      body: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }
    };
    api.length = 0;
    await page.locator('#ol-password').fill('not-the-one');
    await page.locator('#ol-password2').fill('brand-new-secret');
    await page.locator('#ol-submit').click();
    await wait(500);
    check('a wrong current password is named as exactly that',
      /not your current password/i.test(await page.locator('#ol-auth-msg').textContent()),
      await page.locator('#ol-auth-msg').textContent());
    check('...and nothing was written to the account',
      !api.some(c => c.method === 'PUT'),
      api.map(c => c.method + ' ' + c.url).join(' | '));
    check('...and the player is still signed in',
      (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === true);
    signinFailure = null;

    api.length = 0;
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-password2').fill('brand-new-secret');
    await page.locator('#ol-submit').click();
    await page.waitForSelector('#ol-board:visible', { timeout: 8000 });
    await wait(300);
    const reauth = api.find(c => c.url.includes('grant_type=password'));
    const put = api.find(c => c.method === 'PUT' && c.url.startsWith('/auth/v1/user'));
    check('the current password is proved to the server before the new one is set',
      !!reauth && !!put && api.indexOf(reauth) < api.indexOf(put),
      api.map(c => c.method + ' ' + c.url).join(' | '));
    check('the new password is sent alone, on the session token',
      !!put && JSON.stringify(put.body) === JSON.stringify({ password: 'brand-new-secret' }) &&
      put.headers.authorization === 'Bearer jwt-access-1',
      put ? JSON.stringify(put.body) : 'no PUT');
    /* The assumption anybody makes after changing a password is that they have
       just been logged out. They have not, and being told so is the difference
       between carrying on and going to hunt for the sign-in form. */
    check('the player is told they are still signed in',
      /still signed in/i.test(await page.locator('#ol-board-msg').textContent()),
      await page.locator('#ol-board-msg').textContent());
    check('...and actually is', (await page.evaluate('window.__SKYHOOK.game.online.signedIn')) === true);
    check('both password boxes were emptied afterwards',
      (await page.locator('#ol-password').inputValue()) === '' &&
      (await page.locator('#ol-password2').inputValue()) === '');

    /* Back to the name the rest of this file expects to find. Renaming twice
       is not padding: it is the second rename, the one a cooldown or a stale
       cache would break. */
    await page.locator('#ol-edit-name').click();
    await wait(200);
    await page.locator('#ol-username').fill('leo');
    await page.locator('#ol-submit').click();
    await page.waitForFunction(
      'window.__SKYHOOK.game.online.username === "leo"', null, { timeout: 8000 });
    check('a second rename works as well as the first',
      (await page.evaluate('window.__SKYHOOK.game.online.username')) === 'leo');

    /* ---- Escape closes, and the canvas gets its keyboard back ---- */
    await page.keyboard.press('Escape');
    await wait(200);
    check('Escape closes the panel', (await page.locator('#ol').isVisible()) === false);
    check('the title screen now shows the signed-in pilot',
      (await page.evaluate('window.__SKYHOOK.snapshot()')).online.username === 'leo');

    /* ---- finish a run: it must reach the board ---- */
    api.length = 0;
    await page.evaluate(`(() => {
      const g = window.__SKYHOOK.game;
      g.skipTutorial(true);
      g.start(4242);
      /* Fast-forward the run rather than playing it - test/smoke.mjs already
         proves the loop, and what is under test here is the submission. */
      g.time = 41.25;
      g.score = 1840;
      g.hooks = 22;
      g.altitude = 913;
      g.die('fell');
    })()`);
    await page.waitForFunction(
      'window.__SKYHOOK.game.online.status.indexOf("RANK") === 0', null, { timeout: 8000 });

    const post = api.find(c => c.url.startsWith('/rest/v1/scores'));
    check('finishing a run submits it', !!post && post.method === 'POST');
    check('the submitted run is the run that was played',
      post.body.score === 1840 && post.body.hooks === 22 &&
      post.body.altitude === 913 && post.body.duration_ms === 41250,
      JSON.stringify(post.body));
    check('the submission is authenticated as the player',
      post.headers.authorization === 'Bearer jwt-access-1');
    check('the game-over screen is told the global rank',
      (await page.evaluate('window.__SKYHOOK.game.online.status')) === 'RANK #2 GLOBAL',
      await page.evaluate('window.__SKYHOOK.game.online.status'));
    check('the game-over screen can still be retried (Retry was not displaced)',
      (await page.evaluate('window.__SKYHOOK.game.retryRect.y')) === 640);

    /* The board button on the game-over screen. It is hit-testable only once
       the results screen has settled past RETRY_LOCK, which is the same guard
       that stops a death-frame tap from instantly restarting the run. */
    await page.waitForFunction(
      'window.__SKYHOOK.game.state === "over" && window.__SKYHOOK.game.overT > 0.3',
      null, { timeout: 8000 });
    await tapLogical(page, 240, 743);
    await wait(400);
    check('LEADERBOARD on the game-over screen opens the panel, not a retry',
      (await page.locator('#ol').isVisible()) === true &&
      (await page.evaluate('window.__SKYHOOK.game.state')) === 'over');
    await page.locator('#ol-close').click();
    await wait(200);

    /* ---- sign out ---- */
    await page.waitForFunction(
      'window.__SKYHOOK.game.state === "over" && window.__SKYHOOK.game.overT > 0.3',
      null, { timeout: 8000 });
    await tapLogical(page, 240, 743);
    await page.waitForSelector('#ol-signout', { state: 'visible', timeout: 8000 });
    await page.locator('#ol-signout').click();
    await page.waitForFunction('window.__SKYHOOK.game.online.signedIn === false', null, { timeout: 8000 });
    check('signing out returns the player to guest',
      /guest/i.test(await page.locator('#ol-account').textContent()));
    check('signing out clears the stored session',
      (await page.evaluate('localStorage.getItem("skyhook.session")')) === null ||
      (await page.evaluate('localStorage.getItem("skyhook.session")')) === '');
    check('the board is still readable after signing out',
      (await page.locator('#ol-list .ol-row').count()) === 3);
    check('a guest is offered no account actions to take',
      (await page.locator('#ol-account-links').isVisible()) === false);

    /* ---- AN ACCOUNT WITH NO PASSWORD ----
       Signing in with Google means there is no password on the account, so a
       password form would be a form the player can never fill in. What they
       get instead is the truth and the one route that does work. */
    oauthAccount = true;
    await page.locator('#ol-signin').click();
    await page.locator('#ol-email').fill('leo@example.com');
    await page.locator('#ol-password').fill('hunter2hunter2');
    await page.locator('#ol-submit').click();
    await page.waitForFunction('window.__SKYHOOK.game.online.signedIn === true', null, { timeout: 8000 });
    await wait(300);

    api.length = 0;
    await page.locator('#ol-edit-password').click();
    await wait(500);
    check('a Google account is never shown a password form',
      (await page.locator('#ol-form input:visible').count()) === 0,
      `visible inputs=${await page.locator('#ol-form input:visible').count()}`);
    check('...it is told plainly how this account signs in',
      /google/i.test(await page.locator('#ol-auth-msg').textContent()),
      await page.locator('#ol-auth-msg').textContent());
    check('...and offered the one thing that does work',
      /email me a link/i.test(await page.locator('#ol-submit').textContent()),
      await page.locator('#ol-submit').textContent());

    api.length = 0;
    await page.locator('#ol-submit').click();
    await wait(500);
    const link = api.find(c => c.url.startsWith('/auth/v1/recover'));
    check('pressing it asks for a link to the address already on the account',
      !!link && link.body.email === 'leo@example.com',
      link ? JSON.stringify(link.body) : 'no recover call');
    check('...and says where to look for it',
      /spam/i.test(await page.locator('#ol-auth-msg').textContent()),
      await page.locator('#ol-auth-msg').textContent());
    oauthAccount = false;

    /* ---- NOT WHILE A RUN IS IN PROGRESS ----
       js/game.js only hit-tests the LEADERBOARD button on the title and
       results screens, so this is a second lock on a door that is already
       shut. It is here because SK.UI.open() is a public handle, and because
       the first lock lives in a file that knows nothing about this one. */
    /* Closed, not just sent back to the board view. A panel that is ALREADY
       open is not re-rendered by opening it again, so leaving it up would test
       a stale frame rather than the rule - which is itself the reason the
       click handler re-checks instead of trusting what was drawn. */
    await page.evaluate('window.SK.UI.close()');
    await wait(200);
    await page.evaluate(`(() => {
      const g = window.__SKYHOOK.game;
      g.skipTutorial(true);
      g.start(777);
    })()`);
    await page.evaluate('window.SK.UI.open("board")');
    await wait(300);
    check('mid-run the account actions are not drawn',
      (await page.locator('#ol-account-links').isVisible()) === false &&
      (await page.evaluate('window.__SKYHOOK.game.state')) === 'playing');
    /* Hidden is not the same as refused. Fire the handler directly - the way a
       stale frame or a console would - and it must still say no. */
    api.length = 0;
    await page.evaluate(
      `document.getElementById('ol-edit-name').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await wait(200);
    check('and firing it anyway is refused, in words',
      (await page.locator('#ol-board').isVisible()) === true &&
      /run is in progress/i.test(await page.locator('#ol-board-msg').textContent()),
      await page.locator('#ol-board-msg').textContent());
    check('...having sent nothing', !api.some(c => c.method === 'PATCH'));

    await ctx.close();

    /* ==================================================================
     * B2. Sign-up on an AUTO-CONFIRM project - the public-launch path.
     *
     * Email confirmation is being switched OFF for launch, so GoTrue answers
     * /auth/v1/signup with a full session and no mail is ever sent. Every
     * sign-up assertion above covers the OTHER half - confirmation required -
     * which left the path every real new player is about to take as the one
     * path with nothing watching it.
     *
     * The failure this rules out is not a crash. It is the quiet one: the UI
     * showing "check your inbox" for a message that does not exist, on an
     * account that is already usable, sending the player to wait for nothing.
     * Fresh context on purpose - the block above signs out, and "were you
     * already signed in?" must not be why this passes.
     * ================================================================ */
    {
      const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const apage = await actx.newPage();
      const alogs = [];
      attachLogs(apage, alogs, 'autoconfirm');

      await apage.goto(base + 'online/', { waitUntil: 'load' });
      await apage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(400);

      await apage.evaluate(`window.SK.UI.open('auth')`);
      await wait(300);
      await apage.locator('#ol-toggle').click();
      await apage.locator('#ol-username').fill('newpilot');
      await apage.locator('#ol-email').fill('newpilot@example.com');
      await apage.locator('#ol-password').fill('hunter2hunter2');
      await apage.locator('#ol-submit').click();
      await apage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
      await wait(400);

      check('auto-confirm sign-up signs the new player in, with no second step',
        (await apage.evaluate('window.__SKYHOOK.game.online.signedIn')) === true);
      check('auto-confirm sign-up keeps the name the player just chose',
        (await apage.evaluate('window.__SKYHOOK.game.online.username')) === 'newpilot',
        String(await apage.evaluate('window.__SKYHOOK.game.online.username')));

      const acMsg = ((await apage.locator('#ol-auth-msg').textContent()) || '').trim();
      check('auto-confirm sign-up never sends the player to an inbox for a mail that is never sent',
        !/inbox|spam|confirm/i.test(acMsg), JSON.stringify(acMsg));
      check('auto-confirm sign-up lands on the board, not back on a form',
        (await apage.locator('#ol-username').isVisible()) === false &&
        (await apage.locator('#ol-signout').isVisible()) === true);
      check('auto-confirm sign-up says who is now signed in',
        /newpilot/i.test(await apage.locator('#ol-account').textContent()),
        await apage.locator('#ol-account').textContent());
      check('auto-confirm sign-up leaves no password in the DOM',
        (await apage.locator('#ol-password').inputValue()) === '');
      check('auto-confirm sign-up persists the session, so a reload stays signed in',
        !!(await apage.evaluate('localStorage.getItem("skyhook.session")')));
      check('auto-confirm sign-up raised no page errors', alogs.length === 0,
        alogs.join(' | '));

      await actx.close();
    }

    /* ==================================================================
     * D. FORGOTTEN PASSWORD - the door back into an account.
     *
     * Reported 2026-09-19: "I forgot my password on skyhook". Nothing was
     * broken; there was simply no way back. The form could say "no account
     * matches that email and password" and it could say "that email already
     * has an account", and both of those are the end of the conversation.
     *
     * test/online.mjs section 13 proves the wire. This proves the part a
     * locked-out player touches: that the link is there and reachable, that
     * the confirmation does not quietly reveal who has an account, that a
     * recovery link opens the right form instead of dropping them on the
     * board still locked out, and that the token does not stay in the address
     * bar afterwards.
     * ================================================================ */
    {
      const rctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const rpage = await rctx.newPage();
      attachLogs(rpage, errors, 'recovery');

      await rpage.goto(base + 'online/', { waitUntil: 'load' });
      await rpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(400);

      /* ---- the link exists, where a locked-out player is standing ---- */
      await rpage.evaluate(`window.SK.UI.open('auth')`);
      await wait(300);
      check('SIGN IN offers a way out for somebody who forgot their password',
        (await rpage.locator('#ol-forgot').isVisible()) === true &&
        /forgot/i.test(await rpage.locator('#ol-forgot').textContent()),
        JSON.stringify((await rpage.locator('#ol-forgot').textContent() || '').trim()));
      check('the way out is a real focusable control, not decoration',
        await rpage.evaluate(`(() => {
          const b = document.getElementById('ol-forgot');
          b.focus();
          return b.tagName === 'BUTTON' && document.activeElement === b;
        })()`));

      await rpage.locator('#ol-toggle').click();
      check('CREATE ACCOUNT does not offer to reset a password that does not exist yet',
        (await rpage.locator('#ol-forgot').isVisible()) === false);
      await rpage.locator('#ol-toggle').click();
      check('and it comes back with the sign-in view',
        (await rpage.locator('#ol-forgot').isVisible()) === true);

      /* Three links now share a row that used to hold two. A flex row does
         not wrap by default; it squeezes, and a <button> squeezes by clipping
         its own label. "Forgot password?" reading as "Forgot passw..." on a
         phone is the one label in this game that must stay legible. */
      await rpage.setViewportSize({ width: 390, height: 780 });
      await wait(200);
      const linkBox = await rpage.evaluate(`(() => {
        const b = document.getElementById('ol-forgot');
        const row = b.parentElement, panel = document.querySelector('.ol-panel');
        const br = b.getBoundingClientRect(), pr = panel.getBoundingClientRect();
        return {
          clipped: b.scrollWidth > b.clientWidth + 1,
          insidePanel: br.left >= pr.left - 1 && br.right <= pr.right + 1,
          width: Math.round(br.width)
        };
      })()`);
      check('on a 390px phone the reset link is not clipped and stays inside the panel',
        !linkBox.clipped && linkBox.insidePanel, JSON.stringify(linkBox));
      await rpage.setViewportSize({ width: 1280, height: 900 });
      await wait(200);

      /* ---- asking for the link ---- */
      await rpage.locator('#ol-email').fill('klaudia@example.com');
      await rpage.locator('#ol-forgot').click();
      await wait(200);

      check('the reset view says what it is',
        /reset/i.test(await rpage.locator('#ol-title').textContent()),
        await rpage.locator('#ol-title').textContent());
      check('the reset view does not ask for the password the player has forgotten',
        (await rpage.locator('#ol-password').isVisible()) === false &&
        (await rpage.locator('#ol-username').isVisible()) === false);
      check('the reset view carries across the address already typed',
        (await rpage.locator('#ol-email').inputValue()) === 'klaudia@example.com');

      const beforeRecover = api.length;
      await rpage.locator('#ol-submit').click();
      await rpage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
      await wait(200);

      const recover = api.slice(beforeRecover).find(c => c.url.startsWith('/auth/v1/recover'));
      check('asking for a reset link posts to /auth/v1/recover',
        !!recover && recover.method === 'POST', recover ? recover.url : 'no call');
      check('the reset request sends the address and nothing else',
        !!recover && JSON.stringify(Object.keys(recover.body || {})) === '["email"]',
        JSON.stringify(recover && recover.body));

      /* The subpath test, in a real browser. This page is served from
         /online/, so a redirect_to of "/" would be the GitHub Pages bug
         reproduced: a valid link that lands the player on a site root with no
         game on it. */
      const backTo = /[?&]redirect_to=([^&]+)/.exec(recover ? recover.url : '');
      check('the reset link is told to come back to THIS page, subpath included',
        !!backTo && decodeURIComponent(backTo[1]) === base + 'online/',
        backTo ? decodeURIComponent(backTo[1]) : 'no redirect_to');

      const sentMsg = ((await rpage.locator('#ol-auth-msg').textContent()) || '').trim();
      check('the player is told to go and look in their inbox',
        /inbox/i.test(sentMsg) && /spam/i.test(sentMsg), JSON.stringify(sentMsg));
      /* The confirmation is answered identically for an address with an
         account and one without, so it must not be phrased as a statement
         that one exists - otherwise the box becomes a way of asking the
         server who plays this game, one address at a time. */
      check('the confirmation does not confirm that the account exists',
        /if there is an account|if that address/i.test(sentMsg), JSON.stringify(sentMsg));
      check('the confirmation is not styled as an error',
        !((await rpage.locator('#ol-auth-msg').getAttribute('class')) || '').includes('is-error'));
      check('the reset button is given back afterwards',
        (await rpage.locator('#ol-submit').isDisabled()) === false);

      /* ---- pressing it twice: the server names a wait, so repeat the wait ---- */
      recoverFailure = {
        status: 429,
        body: {
          code: 429, error_code: 'over_email_send_rate_limit',
          msg: 'For security purposes, you can only request this after 55 seconds.'
        }
      };
      await rpage.locator('#ol-submit').click();
      await rpage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
      await wait(200);
      const tooSoon = ((await rpage.locator('#ol-auth-msg').textContent()) || '').trim();
      check('a second reset inside the cooldown repeats the wait the server named',
        /55 seconds/.test(tooSoon), JSON.stringify(tooSoon));
      check('the cooldown does not borrow the sign-up "a few emails an hour" line',
        !/an hour|sign-up/i.test(tooSoon), JSON.stringify(tooSoon));
      check('a refused reset is rendered as an error and the button comes back',
        ((await rpage.locator('#ol-auth-msg').getAttribute('class')) || '').includes('is-error') &&
        (await rpage.locator('#ol-submit').isDisabled()) === false);
      recoverFailure = null;
      await rctx.close();
    }

    /* ==================================================================
     * D2. Back from the link: setting a new password.
     *
     * GoTrue returns the player with the session in the URL FRAGMENT. Before
     * this existed, that shape was read as an ordinary implicit sign-in: the
     * player was silently signed in and dropped on the leaderboard with the
     * password they could not remember still in force, and nothing on screen
     * saying there was a step left. They would close the tab and be locked
     * out again - a reset flow that appears to work and changes nothing.
     * ================================================================ */
    {
      const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const ppage = await pctx.newPage();
      attachLogs(ppage, errors, 'set-password');

      await ppage.goto(base + 'online/' + RECOVERY_LEG, { waitUntil: 'load' });
      await ppage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(600);

      check('a recovery link opens the panel by itself - the player asked for this',
        (await ppage.locator('#ol').isVisible()) === true);
      check('and it opens on "set a new password", not on the board',
        /new password/i.test(await ppage.locator('#ol-title').textContent()),
        await ppage.locator('#ol-title').textContent());
      check('the new-password view asks for a password and nothing else',
        (await ppage.locator('#ol-password').isVisible()) === true &&
        (await ppage.locator('#ol-email').isVisible()) === false &&
        (await ppage.locator('#ol-username').isVisible()) === false);
      check('the browser is told this is a NEW password, so it offers to save it',
        (await ppage.locator('#ol-password').getAttribute('autocomplete')) === 'new-password');

      /* An access token in the address bar is in history, in the next
         screenshot, and in whatever the player pastes when they ask for help. */
      check('the recovery token is scrubbed out of the URL',
        (await ppage.evaluate('location.hash')) === '' &&
        !(await ppage.evaluate('location.href')).includes('access_token'),
        await ppage.evaluate('location.href'));

      /* ---- too short: refused here, never sent ---- */
      const beforeShort = api.filter(c => c.url.startsWith('/auth/v1/user') && c.method === 'PUT').length;
      await ppage.locator('#ol-password').fill('short');
      await ppage.locator('#ol-submit').click();
      await wait(400);
      const shortMsg = ((await ppage.locator('#ol-auth-msg').textContent()) || '').trim();
      check('a too-short new password is refused with the rule, not a generic failure',
        /8 characters/i.test(shortMsg), JSON.stringify(shortMsg));
      check('a too-short new password is never sent to the server',
        api.filter(c => c.url.startsWith('/auth/v1/user') && c.method === 'PUT').length === beforeShort);
      check('a too-short new password leaves the player on the form, still able to fix it',
        /new password/i.test(await ppage.locator('#ol-title').textContent()) &&
        (await ppage.locator('#ol-submit').isDisabled()) === false);

      /* ---- a real one ---- */
      await ppage.locator('#ol-password').fill('a-brand-new-one');
      await ppage.locator('#ol-submit').click();
      await ppage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 8000 });
      await wait(400);

      const put = api.filter(c => c.url.startsWith('/auth/v1/user') && c.method === 'PUT').pop();
      check('setting the password is a PUT /auth/v1/user carrying only the password',
        !!put && JSON.stringify(Object.keys(put.body || {})) === '["password"]',
        JSON.stringify(put && put.body));
      check('it is authenticated with the session the link established',
        !!put && put.headers.authorization === 'Bearer jwt-access-1',
        put ? String(put.headers.authorization) : '?');
      check('the player ends up signed in, not sent back to a login form',
        (await ppage.evaluate('window.__SKYHOOK.game.online.signedIn')) === true &&
        (await ppage.locator('#ol-signout').isVisible()) === true);
      check('and the panel says who they are',
        /signed in as/i.test(await ppage.locator('#ol-account').textContent()),
        await ppage.locator('#ol-account').textContent());
      check('no password is left in the DOM afterwards',
        (await ppage.locator('#ol-password').inputValue()) === '');
      check('the session is persisted, so the next visit is not another reset',
        !!(await ppage.evaluate('localStorage.getItem("skyhook.session")')));

      /* The confirmation has to SURVIVE. showBoard() kicks off an
         asynchronous board load that writes into the very element the
         confirmation sits in, so a line painted before it resolves is wiped a
         few hundred milliseconds later - verified by making showBoard() drop
         the notice, which turns this check red. A player who does not see it
         has no way to know whether the thing they came back to do happened. */
      await wait(900);
      const doneMsg = ((await ppage.locator('#ol-board-msg').textContent()) || '').trim();
      check('the player is told the password was changed, and the board load does not wipe it',
        /password updated/i.test(doneMsg), JSON.stringify(doneMsg));
      check('the board rendered underneath the confirmation',
        (await ppage.locator('#ol-list .ol-row').count()) === 3);

      /* And it is a one-shot: reopening the board later must not resurrect a
         confirmation for something that happened minutes ago. */
      await ppage.evaluate('window.SK.UI.reload()');
      await wait(600);
      check('the confirmation does not come back on the next board load',
        !/password updated/i.test((await ppage.locator('#ol-board-msg').textContent()) || ''),
        await ppage.locator('#ol-board-msg').textContent());
      await pctx.close();
    }

    /* ==================================================================
     * D3. Walking away from a recovery.
     *
     * The session a recovery link establishes is a real one. Abandoning the
     * form must not leave somebody silently signed in to an account whose
     * password they still do not know - that is the original trap, moved.
     * ================================================================ */
    {
      const cctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const cpage = await cctx.newPage();
      attachLogs(cpage, errors, 'cancel-recovery');

      await cpage.goto(base + 'online/' + RECOVERY_LEG, { waitUntil: 'load' });
      await cpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(600);

      check('the cancel affordance says cancel, not "create an account"',
        /cancel/i.test(await cpage.locator('#ol-toggle').textContent()),
        await cpage.locator('#ol-toggle').textContent());
      await cpage.locator('#ol-toggle').click();
      await cpage.waitForFunction(
        'window.__SKYHOOK.game.online.signedIn === false', null, { timeout: 8000 });
      await wait(300);
      check('abandoning a recovery signs the player out rather than leaving them half in',
        (await cpage.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);
      check('abandoning a recovery leaves no session on the device',
        !((await cpage.evaluate('localStorage.getItem("skyhook.session")')) || '').includes('access_token'));
      check('abandoning a recovery still leaves a usable game',
        (await cpage.locator('#ol-signin').isVisible()) === true);
      await cctx.close();

      /* Cancel was never the only way out of that form. The X, the Escape
         key, a click on the backdrop and "Back to leaderboard" are four more
         doors out of the same room, and until abandonRecovery() existed every
         one of them closed the view while leaving the session behind - a
         player signed in to an account whose password they still do not know.
         Worse than the original bug, because `recovering` is in memory only:
         one reload and the half-finished recovery is indistinguishable from
         an ordinary session, with nothing on screen saying a step was
         skipped. Each door is asserted separately - they are wired
         independently, so a regression can take out one and leave three
         passing. */
      for (const door of [
        { name: 'the X button', act: (p) => p.locator('#ol-close').click() },
        { name: 'the Escape key', act: (p) => p.keyboard.press('Escape') },
        { name: 'a click on the backdrop', act: (p) => p.locator('#ol').click({ position: { x: 5, y: 5 } }) },
        { name: '"Back to leaderboard"', act: (p) => p.locator('#ol-back').click() },
      ]) {
        const xctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const xpage = await xctx.newPage();
        attachLogs(xpage, errors, 'abandon-' + door.name);

        await xpage.goto(base + 'online/' + RECOVERY_LEG, { waitUntil: 'load' });
        await xpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
        await wait(600);

        check('recovery view is open before leaving by ' + door.name,
          /SET A NEW PASSWORD/i.test(await xpage.locator('#ol-title').textContent()),
          await xpage.locator('#ol-title').textContent());

        await door.act(xpage);
        await xpage.waitForFunction(
          'window.__SKYHOOK.game.online.signedIn === false', null, { timeout: 8000 })
          .catch(() => { /* let the checks below report it */ });
        await wait(300);

        check('leaving a recovery by ' + door.name + ' signs the player out',
          (await xpage.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);
        check('leaving a recovery by ' + door.name + ' leaves no session on the device',
          !((await xpage.evaluate('localStorage.getItem("skyhook.session")')) || '')
            .includes('access_token'));
        await xctx.close();
      }
    }

    /* ==================================================================
     * C. Configured, but the backend is DOWN.
     *
     * The highest-risk regression in this whole feature, and the one a
     * mocked-happy-path suite never sees: Leo's project is paused, his wifi
     * drops, Supabase has an outage - and a game that never needed a network
     * to be played is now broken by one it does not need. Nothing below is
     * about the leaderboard working. It is about the GAME still working when
     * the leaderboard cannot.
     * ================================================================ */
    {
      const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const dpage = await dctx.newPage();
      const dead = [];
      attachLogs(dpage, dead, 'dead', { expectFailuresFrom: deadOrigin });

      await dpage.goto(base + 'dead/', { waitUntil: 'load' });
      await dpage.waitForFunction('!!window.__SKYHOOK', null, { timeout: 8000 });
      await wait(400);

      check('dead backend: the page still booted',
        (await dpage.evaluate('window.__SKYHOOK.snapshot()')).online.ready === true);

      /* Open the board. It cannot load - the question is what the player sees. */
      await tapLogical(dpage, 240, 816);
      await dpage.waitForFunction(
        'document.getElementById("ol-board-msg").textContent.indexOf("Loading") < 0',
        null, { timeout: 15000 });
      const msg = await dpage.locator('#ol-board-msg').textContent();
      check('dead backend: the board says one plain sentence', msg.length > 0 && msg.length < 120, msg);
      check('dead backend: that sentence is not a stack trace or a URL',
        !/\n|https?:\/\/|at\s+\w+\s*\(|TypeError|Error:/.test(msg), msg);
      check('dead backend: no half-rendered board is left behind',
        (await dpage.locator('#ol-list .ol-row').count()) === 0);
      check('dead backend: the panel is still usable (it can be closed)',
        (await dpage.locator('#ol-close').isVisible()) === true);

      /* A sign-in attempt against nothing must fail like a sentence, and must
         give the button back - a permanently disabled form is the "broken auth
         UI" this whole section exists to rule out. */
      await dpage.locator('#ol-signin').click();
      await dpage.locator('#ol-email').fill('leo@example.com');
      await dpage.locator('#ol-password').fill('hunter2hunter2');
      await dpage.locator('#ol-submit').click();
      await dpage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 15000 });
      const authMsg = await dpage.locator('#ol-auth-msg').textContent();
      check('dead backend: a sign-in attempt reports one readable line',
        authMsg.length > 0 && authMsg.length < 120 && !/\n|Error:|TypeError/.test(authMsg), authMsg);
      check('dead backend: the form is not left stuck in a busy state',
        (await dpage.locator('#ol-submit').isDisabled()) === false);

      /* This site's config omits googleSignIn, which is the shape every
         project that skipped the Google step in LEADERBOARD_SETUP.md has.
         The button must be ABSENT rather than present-and-broken: pressing it
         on such a project navigates the tab to a raw GoTrue 400 JSON page,
         which is not a failure the panel can catch or apologise for. The
         email form beside it must be untouched by its removal. */
      check('googleSignIn off -> no Google button is drawn at all',
        (await dpage.locator('#ol-google').isVisible()) === false);
      check('googleSignIn off -> the "or" rule goes with it (no orphan divider)',
        (await dpage.locator('#ol-auth .ol-or').isVisible()) === false);
      check('googleSignIn off -> email and password sign-in is still fully there',
        (await dpage.locator('#ol-email').isVisible()) === true &&
        (await dpage.locator('#ol-password').isVisible()) === true &&
        (await dpage.locator('#ol-submit').isVisible()) === true);
      /* The reset request has the same duty as the sign-in above it: fail
         like a sentence and give the button back. A locked-out player pressing
         a control that never comes back has no way to tell the difference
         between "the server is down" and "this game is broken". */
      await dpage.locator('#ol-forgot').click();
      await dpage.locator('#ol-email').fill('klaudia@example.com');
      await dpage.locator('#ol-submit').click();
      await dpage.waitForFunction(
        'document.getElementById("ol-submit").disabled === false', null, { timeout: 15000 });
      const resetMsg = await dpage.locator('#ol-auth-msg').textContent();
      check('dead backend: a reset request reports one readable line',
        resetMsg.length > 0 && resetMsg.length < 120 && !/\n|Error:|TypeError/.test(resetMsg),
        resetMsg);
      check('dead backend: the reset line does not promise a link that was never sent',
        !/inbox|on its way/i.test(resetMsg), resetMsg);
      check('dead backend: the reset form is not left stuck in a busy state',
        (await dpage.locator('#ol-submit').isDisabled()) === false);
      await dpage.locator('#ol-toggle').click();

      check('dead backend: still signed out, not half signed in',
        (await dpage.evaluate('window.__SKYHOOK.game.online.signedIn')) === false);

      await dpage.keyboard.press('Escape');
      await wait(200);

      /* And now the only thing that actually matters. */
      await dpage.evaluate('window.__SKYHOOK.skipTutorial(true)');
      await tapLogical(dpage, 240, 400);
      await wait(300);
      check('dead backend: the game still starts',
        (await dpage.evaluate('window.__SKYHOOK.game.state')) === 'playing');

      await dpage.evaluate(`(() => {
        const g = window.__SKYHOOK.game;
        g.time = 41.25; g.score = 1840; g.hooks = 22; g.altitude = 913;
        g.die('fell');
      })()`);
      await wait(600);

      check('dead backend: the local high score was still recorded',
        (await dpage.evaluate('localStorage.getItem("skyhook.best")')) === '1840',
        String(await dpage.evaluate('localStorage.getItem("skyhook.best")')));
      check('dead backend: the run is parked for a later upload, not thrown away',
        JSON.parse(await dpage.evaluate('localStorage.getItem("skyhook.pendingRun")') || 'null')?.score === 1840);
      check('dead backend: the game reached the results screen',
        (await dpage.evaluate('window.__SKYHOOK.game.state')) === 'over');

      /* rAF is still running: a rejected promise did not take the loop down. */
      const t0 = await dpage.evaluate('window.__SKYHOOK.game.overT');
      await wait(400);
      check('dead backend: the game loop is still alive afterwards',
        (await dpage.evaluate('window.__SKYHOOK.game.overT')) > t0);

      check('dead backend: not one uncaught error reached the page', dead.length === 0,
        dead.slice(0, 4).join(' | '));
      await dctx.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  check('no console errors / page errors / failed requests', errors.length === 0,
    errors.slice(0, 6).join(' | '));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach(f => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
