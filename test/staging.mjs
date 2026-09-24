/* SKYHOOK - the staging pipeline's gate.
 *
 * What this file is defending, in one sentence: a test run must never end up
 * on Leo's real leaderboard.
 *
 * Staging has its OWN Supabase project as of 2026-09-23. Before that it shared
 * production's and bought safety with a flag - readOnlyScores - which blocked
 * the one write that could reach Leo's board. That flag is no longer what does
 * the isolating; a separate database is. So this file pins the property that
 * actually holds now, stated as an implication rather than as a constant:
 *
 *     staging may write freely  <=>  staging is NOT production's project
 *     staging is production's project  =>  staging must be read-only
 *
 * Written that way on purpose. "readOnlyScores === true" would have been the
 * easier assertion and it would now be a false one, and - worse - it would
 * have had to be deleted to let the separate project land, taking the real
 * guarantee with it. The implication survives both worlds and fails loudly in
 * the only one that is dangerous.
 *
 * The flag's machinery is still tested, hard, against a fixture that forces it
 * on (GUARD below). It is off in production-of-staging, not gone, and the day
 * somebody repoints this file at production the guard has to still work.
 *
 * Every check below can fail. Several are deliberately written to fail if
 * somebody "simplifies" the thing they check:
 *   - point staging back at production's project and let it write -> FAIL
 *   - paste production's anon key under the staging URL           -> FAIL
 *   - make submitRun queue a refused run instead of dropping it   -> FAIL
 *   - gut the readOnlyScores guard in js/online.js                -> FAIL
 *   - copy the staging config over the production one             -> FAIL
 *   - point fly.staging.toml at the production app                -> FAIL
 *   - let a branch reach the prod job, or a push reach staging    -> FAIL
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
/* Deliberately NOT "=== true". Staging has its own project now, so it SHOULD
   write; what must never happen is the flag going missing while the URL is
   production's, and that is the next check's job rather than this one's. This
   one only pins that the flag is still a declared boolean - a config that
   dropped the key entirely would read `undefined`, which is falsey, which
   would sail through an `=== false` test having actually lost the guard. */
check('staging config still declares readOnlyScores as a boolean',
  typeof stag.cfg.readOnlyScores === 'boolean',
  JSON.stringify(stag.cfg.readOnlyScores));

/* THE invariant, stated as an implication rather than as "these two strings
   are equal". Staging having its own project is an improvement and this test
   must not stand in its way - so what is pinned is the thing that is actually
   dangerous: pointing staging at the SAME project as production while letting
   it write. This is the check that was load-bearing before the split and is
   still load-bearing after it; it did not need changing to let the split
   land, which is the whole argument for writing it this way. */
const sameProject =
  String(stag.cfg.supabaseUrl).replace(/\/+$/, '') ===
  String(prod.cfg.supabaseUrl).replace(/\/+$/, '');
check(
  'staging on production’s Supabase project => staging must be read-only',
  !sameProject || stag.cfg.readOnlyScores === true,
  sameProject ? 'same project' : 'separate project - read-only no longer required'
);
/* Where we actually expect to be today. Kept separate from the invariant above
   so the two failures read differently: that one means "you broke the safety
   property", this one means "the split got reverted". */
check('staging points at a DIFFERENT Supabase project from production',
  !sameProject, `${stag.cfg.supabaseUrl} vs ${prod.cfg.supabaseUrl}`);
check('staging writes are ENABLED (it owns its board, so it must exercise it)',
  stag.cfg.readOnlyScores === false, JSON.stringify(stag.cfg.readOnlyScores));

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
function claims(jwt) {
  try {
    const p = String(jwt).split('.')[1];
    return JSON.parse(
      Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
  } catch { return {}; }
}
const role = jwt => claims(jwt).role ?? null;
check('staging anon key role claim is literally "anon"',
  role(stag.cfg.supabaseAnonKey) === 'anon', String(role(stag.cfg.supabaseAnonKey)));

/* Now that the two builds hold two DIFFERENT keys, the URL and the key can
   disagree - and that failure is silent and severe. A staging URL with
   production's key is not a broken staging site; it is a PRODUCTION client
   wearing a staging banner, and every assertion above about "different
   project" would still pass, because they all read the URL. So the key gets
   checked against the URL, and against production's key, directly.

   Supabase mints the project ref into the token as `ref`, and it is also the
   first label of the API hostname, so the two are comparable without a
   network call. */
const refOfUrl = u => (String(u).match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || null;
const stagUrlRef = refOfUrl(stag.cfg.supabaseUrl);
const stagKeyRef = claims(stag.cfg.supabaseAnonKey).ref ?? null;
const prodUrlRef = refOfUrl(prod.cfg.supabaseUrl);

check('staging supabaseUrl is a parseable supabase.co project URL', !!stagUrlRef,
  String(stag.cfg.supabaseUrl));
check('staging anon key carries a project ref claim', !!stagKeyRef, String(stagKeyRef));
check('staging anon key belongs to the project staging points at',
  !!stagUrlRef && stagKeyRef === stagUrlRef, `key ref ${stagKeyRef} vs url ref ${stagUrlRef}`);
/* The one that catches a half-done swap: URL moved, key forgotten. */
check('staging anon key is NOT production’s project key',
  !!stagKeyRef && !!prodUrlRef && stagKeyRef !== prodUrlRef,
  `staging key ref ${stagKeyRef}, production ref ${prodUrlRef}`);
check('the two builds do not literally share an anon key',
  String(stag.cfg.supabaseAnonKey) !== String(prod.cfg.supabaseAnonKey));

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
 * 2. js/online.js actually honours the flag, AND staging really writes.
 *
 * Two different things are proved here and they must not be conflated:
 *
 *   a) The GUARD still works. Exercised against a fixture that forces
 *      readOnlyScores on, NOT against the live staging config - because the
 *      live config has it off now, and a guard that is only ever tested in the
 *      configuration where it is disabled is a guard nobody is testing. If
 *      staging is ever repointed at production, the invariant in section 1
 *      demands this flag, and these checks are what make demanding it mean
 *      something.
 *
 *   b) The live staging config actually SUBMITS, and submits to STAGING. The
 *      second half is the interesting one: "it wrote a score" is not reassuring
 *      on its own, because the question is which database it wrote it to.
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

/* (a) The guard, forced on. Everything about this fixture is the real staging
   config except the one flag, so what is being tested is js/online.js's
   handling of it and nothing else. */
const GUARD = { ...stag.cfg, readOnlyScores: true };

const live = sandbox();
live.Online.configure({ ...stag.cfg });
check('staging build is still "configured" (the backend is NOT disabled)',
  live.Online.isConfigured() === true);
check('state() reports readOnlyScores: false, so the UI stops saying scores are dropped',
  live.Online.state().readOnlyScores === false,
  JSON.stringify(live.Online.state().readOnlyScores));

const s = sandbox();
s.Online.configure({ ...GUARD });
check('state() reports readOnlyScores so the UI can say why (guard fixture)',
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
s2.Online.configure({ ...GUARD });
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
s3.Online.configure({ ...GUARD });
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

/* (b) The half that is new. Staging owns its board, so it must actually write
   to it - and the assertion that carries the weight is not "it wrote" but
   "it wrote HERE". A staging build that submits to production's host is the
   exact accident the whole project split exists to prevent, and it would pass
   every check above this one that only reads the config. */
const w = sandbox();
w.storage.set('skyhook.session', SESSION);
w.Online.configure({ ...stag.cfg });
const nw = w.calls.length;
const wres = await w.Online.submitRun(RUN);
check('staging SUBMITS the run (its own board is there to be written to)',
  wres.submitted === true, JSON.stringify(wres));
const wposts = w.calls.slice(nw).filter(c => c.method === 'POST' && /\/rest\/v1\/scores/.test(c.url));
check('staging POSTed it to /rest/v1/scores', wposts.length > 0,
  w.calls.slice(nw).map(c => c.method + ' ' + c.url).join(', '));
check('every staging call went to STAGING’s host',
  w.calls.slice(nw).every(c => String(c.url).startsWith(stag.cfg.supabaseUrl)),
  w.calls.slice(nw).map(c => c.url).join(', '));
/* Stated against production's URL directly, so it keeps working if either
   project is ever renumbered. */
check('NOT ONE staging call touched production’s host',
  !w.calls.slice(nw).some(c => String(c.url).startsWith(prod.cfg.supabaseUrl)),
  w.calls.slice(nw).map(c => c.url).join(', '));

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
const sw = stripComments(read('.github/workflows/staging.yml'));
const jobIn = (src, name) => {
  const m = src.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`));
  return m ? m[1] : '';
};
const onBlock = src => {
  const m = src.match(/\non:\n([\s\S]*?)\n(?=[a-z])/);
  return m ? m[1] : '';
};
const prodJob = jobIn(wf, 'deploy');
const upJob   = jobIn(sw, 'up');
const downJob = jobIn(sw, 'down');

check('the production deploy job still exists', prodJob.length > 0);
check('production deploys ONLY from main',
  /github\.ref == 'refs\/heads\/main'/.test(prodJob));
check('production never deploys on a pull_request event',
  /github\.event_name != 'pull_request'/.test(prodJob));
check('production uses the production token and not the staging one',
  /secrets\.FLY_API_TOKEN/.test(prodJob) && !/FLY_STAGING_API_TOKEN/.test(prodJob));
check('deploy.yml is pushed only from main (no branch fan-out)',
  /push:\s*\n\s*branches:\s*\[main\]/.test(onBlock(wf)) && !/branches-ignore/.test(onBlock(wf)));

/* ON DEMAND (Leo, 2026-09-24): staging is down by default and comes up only
   when somebody asks. Both halves are pinned - deploy.yml must not deploy
   staging any more, and staging.yml must have no trigger except a manual one.
   Putting `push:` back in either file is a one-line change that would quietly
   turn staging back into an always-on box. */
check('deploy.yml no longer deploys staging (no fly.staging.toml, no staging token)',
  !/fly\.staging\.toml/.test(wf) && !/FLY_STAGING_API_TOKEN/.test(wf));
check('staging.yml has an up job and a down job', upJob.length > 0 && downJob.length > 0);
check('staging.yml runs ONLY on workflow_dispatch',
  /^\s*workflow_dispatch:/m.test(onBlock(sw)) &&
  !/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch):/m.test(onBlock(sw)));
check('staging.yml takes an up/down action and a branch',
  /options:\s*\[up, down\]/.test(onBlock(sw)) && /^\s+branch:/m.test(onBlock(sw)));
check('up runs only for action=up, down only for action=down',
  /if:\s*inputs\.action == 'up'/.test(upJob) && /if:\s*inputs\.action == 'down'/.test(downJob));
check('staging uses fly.staging.toml, never the bare fly.toml',
  /--config fly\.staging\.toml/.test(upJob) && !/--config fly\.toml/.test(sw));
/* `fly` and `flyctl` are the same binary, so both spellings are scanned. */
const flyCmds = sw.match(/\bfly(ctl)? (deploy|scale|machines?|apps|secrets|status|releases)\b[^\n]*/g) || [];
check('every fly command in staging.yml names skyhook-staging explicitly',
  flyCmds.length >= 4 && flyCmds.every(l => /-a skyhook-staging\b/.test(l)), flyCmds.join(' | '));
check('nothing in staging.yml names the production app', !/skyhook-game/.test(sw));
check('staging uses its own, separately scoped token and never the production one',
  /secrets\.FLY_STAGING_API_TOKEN/.test(upJob) && /secrets\.FLY_STAGING_API_TOKEN/.test(downJob) &&
  !/secrets\.FLY_API_TOKEN/.test(sw));
/* A branch name is attacker-shaped text (anyone who can push can name one).
   It may reach the job through env and checkout's `ref:` only - never pasted
   into a run: script, where ${{ }} is expanded before the shell parses it. */
check('the branch input never reaches a script as pasted text',
  sw.split('\n').filter(l => /\$\{\{[^}]*inputs\.branch/.test(l))
    .every(l => /^\s*(ref|BRANCH):/.test(l)));
check('staging operations are serialised on the app and never cancelled',
  /group:\s*fly-skyhook-staging/.test(sw) && /cancel-in-progress:\s*false/.test(sw));
check('down scales staging to ZERO machines (not merely stopped)',
  /flyctl scale count 0 -a skyhook-staging/.test(downJob));
check('down proves it: no machines left, and the URL no longer serves the game',
  /machines list -a skyhook-staging/.test(downJob) && /skyhook-staging\.fly\.dev/.test(downJob));
check('nothing in staging.yml can destroy the app itself',
  !/apps (destroy|delete)|flyctl destroy/.test(sw));
/* A branch cut before this pipeline builds the PRODUCTION image under the
   staging name. Refused before the build, not caught a minute after it. */
check('up refuses a branch that cannot build an isolated staging image',
  /branch\/staging\/config\.staging\.js/.test(upJob) && /branch\/Dockerfile/.test(upJob) &&
  /"\$stag_ref" != "\$prod_ref"/.test(upJob) && /"\$key_ref" = "\$stag_ref"/.test(upJob));
/* ...and it has to run BEFORE the deploy, or it is a post-mortem. */
check('the pre-build guard runs before the deploy step',
  upJob.indexOf('build an isolated staging image') > 0 &&
  upJob.indexOf('build an isolated staging image') < upJob.indexOf('flyctl deploy'));
/* The post-deploy verification must check the LIVE site's project, not just
   the image that was meant to be built. */
check('the pipeline verifies the LIVE staging site’s Supabase project',
  /refof \/tmp\/live\.js/.test(upJob) && /live_ref/.test(upJob));
check('the pipeline reads production’s ref from js/config.js, not a hardcoded copy',
  /refof js\/config\.js/.test(upJob));
/* No shared-project fallback on the live check: staging has its own project,
   so staging on production's is a failure whatever readOnlyScores says. */
check('live staging on production’s project fails, with no read-only fallback',
  /"\$live_ref" = "\$prod_ref" \]; then\s*\n\s*echo "FAIL/.test(upJob) && !/readOnlyScores/.test(upJob));
/* The anon key's project sits in a base64 JWT payload that no grep can see. */
check('the live anon key is DECODED and must name staging’s own project',
  /live_key_ref=\$\(keyref "\$live_key"\)/.test(upJob) &&
  /"\$live_key_ref" = "\$live_ref"/.test(upJob) && /base64 -d/.test(upJob));
check('anything deployed but not verified is taken straight back down',
  /if:\s*always\(\) && steps\.deploy\.outcome != 'skipped' && steps\.verify\.outcome != 'success'\s*\n\s*run: flyctl scale count 0/.test(upJob));
/* No workflow may contain a literal project ref - that is the copy that goes
   stale and turns a real check into a passing one. */
check('the workflows hardcode NO supabase project ref',
  !new RegExp(String(prodUrlRef)).test(wf + sw), String(prodUrlRef));

console.log(fails ? `\n${fails} FAILED` : '\nAll staging pipeline checks passed');
process.exit(fails ? 1 : 0);
