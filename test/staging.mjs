/* SKYHOOK - the staging pipeline's gate.
 *
 * What this file is defending, in one sentence: a test run must never end up
 * on Leo's real leaderboard.
 *
 * The staging site shares the production Supabase project - the full argument
 * for that is at the top of staging/config.staging.js, and the short version
 * is that the only credential this repo holds is scoped to that one project,
 * so a second one cannot be created without Leo doing it by hand, and a
 * staging build with no backend at all cannot test a leaderboard feature.
 * Sharing the project means the ONLY thing standing between a staging run and
 * the real board is one flag and the three lines in js/online.js that honour
 * it, so those get a test with teeth rather than a comment.
 *
 * Every check below can fail. Several are deliberately written to fail if
 * somebody "simplifies" the thing they check:
 *   - delete readOnlyScores from the staging config            -> FAIL
 *   - make submitRun queue the run instead of dropping it      -> FAIL
 *   - copy the staging config over the production one          -> FAIL
 *   - point fly.staging.toml at the production app             -> FAIL
 *   - let main reach the staging job, or a branch the prod job -> FAIL
 *
 * Pure Node, no browser, no network, sub-second.
 *
 * Run:  node test/staging.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

/* --------------------------------------------------------------------------
 * 1. The two configs, as the browser would actually see them.
 *
 * Evaluated rather than grepped: a flag that is present in the source and
 * unreachable at runtime - inside a dead branch, after an early return, in a
 * block a syntax error swallowed - is worth nothing, and only running the file
 * can tell the difference.
 * ------------------------------------------------------------------------ */
function evalConfig(file) {
  const created = [];
  const sandbox = {
    console,
    document: {
      readyState: 'complete',
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      body: { appendChild() {} },
      getElementById: () => null,
      createElement: tag => { const el = { tagName: tag, style: {} }; created.push(el); return el; },
      addEventListener: () => {}
    }
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  vm.runInContext(read(file), sandbox);
  return { cfg: sandbox.SKYHOOK_CONFIG, created };
}

const prod = evalConfig('js/config.js');
const stag = evalConfig('staging/config.staging.js');

check('staging config evaluates to a SKYHOOK_CONFIG', !!stag.cfg);
check('staging config sets readOnlyScores === true', stag.cfg.readOnlyScores === true,
  JSON.stringify(stag.cfg.readOnlyScores));

/* THE invariant, stated as an implication rather than as "these two strings
   are equal". If a dedicated staging Supabase project is ever created, that is
   an improvement and this test must not stand in its way - so what is pinned
   is the thing that is actually dangerous: pointing staging at the SAME
   project as production while letting it write. */
const sameProject =
  String(stag.cfg.supabaseUrl).replace(/\/+$/, '') ===
  String(prod.cfg.supabaseUrl).replace(/\/+$/, '');
check(
  'staging on production’s Supabase project => staging must be read-only',
  !sameProject || stag.cfg.readOnlyScores === true,
  sameProject ? 'same project' : 'separate project - read-only no longer required'
);

/* The overlay must never travel the other way. */
check('production config does NOT carry readOnlyScores',
  prod.cfg.readOnlyScores !== true, JSON.stringify(prod.cfg.readOnlyScores));
check('production config file has no readOnlyScores text at all',
  !/readOnlyScores/.test(read('js/config.js')));

/* The key is public by design, but only the anon one is. A service_role key
   bypasses RLS entirely, and it and an anon key are both JWTs that look
   identical at a glance - so the role claim is decoded rather than trusted.
   test/online.mjs does this for js/config.js; the staging config needs it for
   exactly the same reason and is a different file. */
function role(jwt) {
  try {
    const p = String(jwt).split('.')[1];
    return JSON.parse(
      Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    ).role;
  } catch { return null; }
}
check('staging anon key role claim is literally "anon"',
  role(stag.cfg.supabaseAnonKey) === 'anon', String(role(stag.cfg.supabaseAnonKey)));

/* The two things that keep staging from being mistaken for production, and
   from outranking it. */
const stagSrc = read('staging/config.staging.js');
check('staging config injects a noindex meta', /noindex, nofollow/.test(stagSrc));
const banner = stag.created.find(el => el.tagName === 'div');
check('staging config creates a visible banner element', !!banner);
check('the banner says STAGING', !!banner && /STAGING/.test(banner.textContent || ''),
  banner && banner.textContent);
/* The game is played by tapping anywhere. A banner that could swallow the
   first tap would make staging behave differently from production, which is
   the one thing a staging site must not do. */
check('the banner cannot eat a tap (pointer-events:none)',
  !!banner && /pointer-events:\s*none/.test(banner.style.cssText || ''));

/* --------------------------------------------------------------------------
 * 2. js/online.js actually honours the flag.
 *
 * This is the half that matters. The flag is inert on its own; what protects
 * the leaderboard is submitRun refusing, and refusing WITHOUT queueing.
 * ------------------------------------------------------------------------ */
function sandbox() {
  const storage = new Map();
  const calls = [];
  const ctx = {
    Math, Date, JSON, console, Promise, Error, Uint8Array, TextEncoder,
    setTimeout, clearTimeout, AbortController,
    crypto: webcrypto,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); }
    },
    fetch: (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve([])
      });
    },
    document: {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) })
      })
    },
    location: {
      protocol: 'https:', origin: 'https://skyhook-staging.fly.dev',
      pathname: '/', search: '', hash: '', assign() {}
    },
    history: { replaceState() {} }
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  ctx.self = ctx;
  vm.runInContext(read('js/utils.js'), ctx);
  vm.runInContext(read('js/online.js'), ctx);
  return { Online: ctx.SK.Online, calls, storage };
}

/* A run the production build would happily accept - so a refusal below is the
   staging flag doing its job and not validateRun rejecting a bad fixture. */
const RUN = { score: 4321, hooks: 19, altitude: 8800, durationMs: 61000 };
const SESSION = JSON.stringify({
  access_token: 'a', refresh_token: 'r',
  expires_at: Date.now() + 3600e3, user: { id: 'u', username: 'leo' }
});

const control = sandbox();
control.Online.configure({ ...prod.cfg });
/* validateRun returns null when the run is fine and a reason string when it
   is not - so the assertion is "no reason", not "empty string". */
check('control: the production config accepts the fixture run',
  !control.Online.validateRun(RUN), String(control.Online.validateRun(RUN)));

const s = sandbox();
s.Online.configure({ ...stag.cfg });
check('staging build is still "configured" (the backend is NOT disabled)',
  s.Online.isConfigured() === true);
check('state() reports readOnlyScores so the UI can say why',
  s.Online.state().readOnlyScores === true);

const before = s.calls.length;
const res = await s.Online.submitRun(RUN);
check('submitRun refuses the run', res.submitted === false, JSON.stringify(res));
/* The load-bearing half. A queued run is a run waiting for a session that CAN
   write - precisely the moment that must never come for a staging score. */
check('submitRun does NOT queue the run for later', res.queued === false, JSON.stringify(res));
check('submitRun says why, in words a tester can read',
  /staging/i.test(String(res.reason)), String(res.reason));
check('submitRun made ZERO network calls', s.calls.length === before,
  s.calls.slice(before).map(c => c.method + ' ' + c.url).join(', '));
check('nothing was written to the pending-run slot',
  !s.storage.has('skyhook.pendingRun'), [...s.storage.keys()].join(', '));

/* Signed in changes nothing. The guard sits above the session check on
   purpose: "not signed in" is the path that queues. */
const s2 = sandbox();
s2.storage.set('skyhook.session', SESSION);
s2.Online.configure({ ...stag.cfg });
check('control: the session fixture really does sign the sandbox in',
  s2.Online.isSignedIn() === true);
const n2 = s2.calls.length;
const res2 = await s2.Online.submitRun(RUN);
check('submitRun refuses a SIGNED-IN run too',
  res2.submitted === false && res2.queued === false, JSON.stringify(res2));
check('a signed-in submitRun still makes zero network calls', s2.calls.length === n2,
  s2.calls.slice(n2).map(c => c.method + ' ' + c.url).join(', '));

/* flushPending wipes the pending slot before it submits, so falling through
   would destroy a run the player is still owed for no gain. */
const s3 = sandbox();
s3.storage.set('skyhook.pendingRun', JSON.stringify(RUN));
s3.storage.set('skyhook.session', SESSION);
s3.Online.configure({ ...stag.cfg });
const flushed = await s3.Online.flushPending();
check('flushPending is a no-op on staging', flushed === false);
check('flushPending did not destroy the pending run',
  s3.storage.get('skyhook.pendingRun') === JSON.stringify(RUN));

/* READS must still work, or the staging site cannot test the feature it
   exists to test. This is the check that stops "isolation" being implemented
   by turning the backend off. */
const s4 = sandbox();
s4.Online.configure({ ...stag.cfg });
const n4 = s4.calls.length;
await s4.Online.topScores(10).catch(() => null);
check('reading the leaderboard still hits the network on staging',
  s4.calls.length > n4 && /\/rest\/v1\/leaderboard/.test(s4.calls[n4].url),
  s4.calls.slice(n4).map(c => c.url).join(', '));

/* And production must be unaffected by all of the above. */
const p = sandbox();
p.storage.set('skyhook.session', SESSION);
p.Online.configure({ ...prod.cfg });
const np = p.calls.length;
const pres = await p.Online.submitRun(RUN);
check('production still POSTs the score', pres.submitted === true, JSON.stringify(pres));
check('production POSTed it to /rest/v1/scores',
  p.calls.slice(np).some(c => c.method === 'POST' && /\/rest\/v1\/scores/.test(c.url)),
  p.calls.slice(np).map(c => c.method + ' ' + c.url).join(', '));

/* --------------------------------------------------------------------------
 * 3. The pipeline: two Fly apps, two tokens, two mutually exclusive gates.
 * ------------------------------------------------------------------------ */
const flyProd = read('fly.toml');
const flyStag = read('fly.staging.toml');
const nameOf = t => (t.match(/^app\s*=\s*'([^']+)'/m) || [])[1];

check('fly.staging.toml names a DIFFERENT app from fly.toml',
  !!nameOf(flyStag) && !!nameOf(flyProd) && nameOf(flyStag) !== nameOf(flyProd),
  `${nameOf(flyStag)} vs ${nameOf(flyProd)}`);
check('fly.staging.toml deploys skyhook-staging', nameOf(flyStag) === 'skyhook-staging');
check('fly.toml still deploys skyhook-game (production is untouched)',
  nameOf(flyProd) === 'skyhook-game');
check('staging is in ams, like production', /^primary_region\s*=\s*'ams'/m.test(flyStag));
check('staging passes SKYHOOK_ENV=staging as a build arg',
  /\[build\.args\][\s\S]*?SKYHOOK_ENV\s*=\s*'staging'/.test(flyStag));
check('production passes NO SKYHOOK_ENV', !/SKYHOOK_ENV/.test(flyProd));
check('staging does not claim the production canonical',
  /SITE_ORIGIN\s*=\s*'https:\/\/skyhook-staging\.fly\.dev'/.test(flyStag));
check('staging tells crawlers to stay away',
  /ROBOTS_TAG\s*=\s*'noindex, nofollow'/.test(flyStag));
/* Idle cost. A staging box that never stops is a staging box Leo pays for
   every hour he is not testing. */
check('staging stops itself when idle',
  /auto_stop_machines\s*=\s*'stop'/.test(flyStag) && /min_machines_running\s*=\s*0/.test(flyStag));

const dockerfile = read('Dockerfile');
check('Dockerfile defaults SKYHOOK_ENV to production',
  /^ARG SKYHOOK_ENV=production$/m.test(dockerfile));
check('Dockerfile defaults ROBOTS_TAG to the no-op "all"',
  /^ENV ROBOTS_TAG="all"$/m.test(dockerfile));
/* envsubst leaves an unset ${NAME} in the rendered config verbatim and nginx
   then refuses to start, so every name the template uses MUST have a default
   in the image. This is the check that turns "nginx crash-loops on a fresh
   deploy" into a red build. */
/* Comment lines are stripped first. Both of the files scanned below explain
   themselves at length, and prose that MENTIONS ${NAME} or names a secret is
   not the same as config that USES it - an assertion that cannot tell the
   difference fails on a sentence and passes on a bug. */
const stripComments = src => src.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

const tmpl = stripComments(read('conf/site.conf.template'));
const usedVars = [...new Set([...tmpl.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map(m => m[1]))];
check('the nginx template uses at least one substituted variable', usedVars.length > 0);
for (const name of usedVars) {
  check(`nginx template var \${${name}} has a default in the Dockerfile`,
    new RegExp(`^ENV ${name}=`, 'm').test(dockerfile));
}
check('the crawler header is on the page, not only on the assets',
  /location = \/index\.html[\s\S]*?add_header X-Robots-Tag "\$\{ROBOTS_TAG\}"/.test(tmpl));

check('staging/robots.txt disallows everything', /^Disallow:\s*\/\s*$/m.test(read('staging/robots.txt')));

const wf = stripComments(read('.github/workflows/deploy.yml'));
const jobBody = name => {
  const m = wf.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`));
  return m ? m[1] : '';
};
const prodJob = jobBody('deploy');
const stagJob = jobBody('staging');

check('the production deploy job still exists', prodJob.length > 0);
check('the staging deploy job exists', stagJob.length > 0);
/* Mutually exclusive by construction: main cannot reach staging and a branch
   cannot reach production. Both halves are asserted, because deleting either
   `if` is a one-line change with a very expensive blast radius. */
check('production deploys ONLY from main',
  /github\.ref == 'refs\/heads\/main'/.test(prodJob));
check('production never deploys on a pull_request event',
  /github\.event_name != 'pull_request'/.test(prodJob));
check('staging deploys ONLY from something that is not main',
  /github\.ref != 'refs\/heads\/main'/.test(stagJob));
check('staging uses fly.staging.toml, never the bare fly.toml',
  /--config fly\.staging\.toml/.test(stagJob));
check('staging uses its own, separately scoped token',
  /secrets\.FLY_STAGING_API_TOKEN/.test(stagJob));
check('production uses the production token and not the staging one',
  /secrets\.FLY_API_TOKEN/.test(prodJob) && !/FLY_STAGING_API_TOKEN/.test(prodJob));
check('staging waits for the test suite and the container checks',
  /needs:\s*\[tests, image, preflight\]/.test(stagJob));
/* One app, one deploy at a time. Two branches pushed a minute apart must not
   race for the single machine Leo is about to open. */
check('staging deploys are serialised on the app, not on the branch',
  /group:\s*fly-skyhook-staging/.test(stagJob) && /cancel-in-progress:\s*false/.test(stagJob));
check('the pipeline verifies the LIVE staging site is read-only',
  /readOnlyScores: true/.test(stagJob));

console.log(fails ? `\n${fails} FAILED` : '\nAll staging pipeline checks passed');
process.exit(fails ? 1 : 0);
