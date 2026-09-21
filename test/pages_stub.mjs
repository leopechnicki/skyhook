/* SKYHOOK - the canonical-origin gate.
 *
 * Two halves of one fact, checked together because they only make sense
 * together:
 *
 *   1. The repo DECLARES its home. index.html names https://skyhookplay.com as
 *      canonical/og:url/og:image/twitter:image. It used to name the GitHub
 *      Pages URL and rely on an nginx sub_filter to correct it at serve time,
 *      which meant the checked-in file was wrong and only Fly made it right -
 *      so a crawler, a link preview, a `file://` open or anything serving the
 *      folder without that rewrite advertised a URL Leo is retiring.
 *
 *   2. GitHub Pages REDIRECTS to it. pages/ is published instead of a second
 *      copy of the game, so every link already shared as
 *      https://leopechnicki.github.io/skyhook/ still lands on the real home
 *      - and lands there with its query string and hash intact, because
 *      ?seed=123 picks a world and a Supabase auth callback arrives as
 *      ?code=... or #access_token=.... A redirect that drops either is a
 *      redirect that breaks sign-in while looking like it works.
 *
 * The interesting assertions are the ones that EXECUTE the stub's inline
 * script in a vm against fake locations, rather than grepping the HTML for
 * strings that look about right. A regex cannot tell the difference between a
 * redirect that carries the hash and one that discards it.
 *
 * Run: node test/pages_stub.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const HOME = 'https://skyhookplay.com/';
const RETIRED = 'leopechnicki.github.io';

let fails = 0;
/* Detail is printed on FAILURE only. Several checks below compare a computed
   URL against an expected one, and echoing "a != a" next to a green PASS reads
   as a failure at a glance - which is how a real failure gets skimmed past. */
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
};

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ==========================================================================
 * 1. The game declares the real home, with no rewrite involved.
 * ======================================================================== */
{
  const game = read('index.html');

  const tags = [
    ['<link rel=canonical>', /<link rel="canonical" href="([^"]+)">/],
    ['og:url', /<meta property="og:url" content="([^"]+)">/],
    ['og:image', /<meta property="og:image" content="([^"]+)">/],
    ['twitter:image', /<meta name="twitter:image" content="([^"]+)">/]
  ];
  for (const [what, re] of tags) {
    const m = re.exec(game);
    check(`index.html ${what} is on ${HOME}`,
      !!m && m[1].startsWith(HOME), m ? m[1] : 'tag missing');
  }

  check('index.html names the retired Pages origin nowhere at all',
    !game.includes(RETIRED));

  /* conf/site.conf.template searches for the literal that index.html contains.
     The two are one fact written twice and there is no language-level link
     between them, so this is the check that keeps them honest. deploy.yml
     asserts the same thing again against a RUNNING container; this one fails
     in under a second, on a PR, without Docker. */
  const conf = read('conf/site.conf.template');
  const sub = /sub_filter\s+'([^']+)'\s+'\$\{SITE_ORIGIN\}'/.exec(conf);
  check('conf/site.conf.template rewrites the origin index.html actually uses',
    !!sub && game.includes(sub[1]), sub ? sub[1] : 'no sub_filter found');

  /* An identity default is what makes `docker run` with no -e produce a page
     byte-identical to the repo instead of a mangled one. */
  const docker = read('Dockerfile');
  const env = /ENV SITE_ORIGIN="([^"]+)"/.exec(docker);
  check('Dockerfile SITE_ORIGIN defaults to an identity rewrite',
    !!env && !!sub && env[1] === sub[1], env ? env[1] : 'no ENV found');

  const fly = read('fly.toml');
  const flyOrigin = /SITE_ORIGIN\s*=\s*'([^']+)'/.exec(fly);
  check('fly.toml ships the same origin the repo declares',
    !!flyOrigin && HOME.startsWith(flyOrigin[1]), flyOrigin ? flyOrigin[1] : 'not set');

  check('package.json homepage is the real home',
    JSON.parse(read('package.json')).homepage === HOME);
}

/* ==========================================================================
 * 2. The Pages stub. Structure first, then behaviour.
 * ======================================================================== */
const STUBS = ['pages/index.html', 'pages/404.html'];
const scripts = {};

for (const rel of STUBS) {
  const html = read(rel);

  check(`${rel} is NOT a copy of the game`, !html.includes('<canvas id="game"'));
  check(`${rel} pulls in nothing external`,
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html) &&
    !/<img\b/i.test(html),
    'a stub that needs a second request can fail to redirect at all');

  const canon = /<link rel="canonical" href="([^"]+)">/.exec(html);
  check(`${rel} hands its ranking to ${HOME}`,
    !!canon && canon[1] === HOME, canon ? canon[1] : 'no canonical');

  const refresh = /<meta http-equiv="refresh" content="0; url=([^"]+)">/.exec(html);
  check(`${rel} has a 0-second meta refresh (the no-JS path)`,
    !!refresh && refresh[1] === HOME, refresh ? refresh[1] : 'no meta refresh');

  /* Order is load-bearing, not cosmetic. A synchronous inline script runs while
     the parser is still ahead of the meta tag, so script-before-meta is what
     makes the query-preserving redirect win the race. Swap them and ?seed=
     starts disappearing for everyone, silently, with the page still "working".
     Comments are stripped first: both stubs EXPLAIN the meta refresh in a
     comment above the script, and matching that prose instead of the real tag
     is how this check would report the wrong answer with total confidence. */
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  check(`${rel} runs its script BEFORE the meta refresh, so the query survives`,
    markup.indexOf('<script>') < markup.indexOf('http-equiv="refresh"'),
    `script at ${markup.indexOf('<script>')}, meta at ${markup.indexOf('http-equiv="refresh"')}`);

  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  check(`${rel} has exactly one inline script`,
    !!m && html.split('<script>').length === 2);
  scripts[rel] = m ? m[1] : '';

  check(`${rel} offers a visible link for a client that does neither`,
    html.includes(`<a href="${HOME}">`));
}

/* The stub only helps if it is actually published. The `pages-stub` job copies
   named files rather than the whole folder, which keeps developer notes off the
   retired URL but also means a new stub file can be added and silently never
   shipped. */
{
  const wf = read('.github/workflows/deploy.yml');
  const copy = /^\s*cp (pages\/.*?) "\$work"\/$/m.exec(wf);
  check('deploy.yml has a publish step that names its files', !!copy,
    'the pages-stub job no longer copies pages/ file by file - if it now copies '
    + 'the whole folder, delete this check and the one below');
  const named = copy ? copy[1] : '';
  for (const rel of STUBS) {
    check(`${rel} is in the list of files published to gh-pages`,
      named.includes(rel), named);
  }
  check('.nojekyll is published too', named.includes('pages/.nojekyll'), named);

  /* Every stub in the folder, not just the two this file knows about. */
  const onDisk = fs.readdirSync(path.join(ROOT, 'pages'))
    .filter(f => f.endsWith('.html')).map(f => 'pages/' + f);
  const missed = onDisk.filter(f => !named.includes(f));
  check('no stub file exists that gh-pages would never receive',
    missed.length === 0, missed.join(', '));
}

check('both stubs carry the SAME redirect logic',
  scripts[STUBS[0]] === scripts[STUBS[1]],
  'they are copies on purpose; a fix applied to one only is a stub that behaves two ways');

/* ==========================================================================
 * 3. Behaviour: run the stub's own script against a fake location.
 * ======================================================================== */
function redirectFor(rel, loc) {
  const pathname = loc.pathname;
  const search = loc.search || '';
  const hash = loc.hash || '';
  let replaced = null;
  let assigned = null;
  const location = {
    pathname, search, hash,
    replace: url => { replaced = url; },
    set href(url) { assigned = url; },
    get href() { return pathname + search + hash; }
  };
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.location = location;
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.window.location = location;
  vm.runInContext(scripts[rel], sandbox, { timeout: 1000 });
  return { replaced, assigned };
}

const BASE = '/skyhook/';
const cases = [
  ['the bare shared link',
    { pathname: BASE }, HOME],
  ['a shared seed - the world must still be that world',
    { pathname: BASE, search: '?seed=123' }, HOME + '?seed=123'],
  ['a Supabase implicit-flow callback - the token is in the HASH',
    { pathname: BASE, hash: '#access_token=abc&refresh_token=def&type=recovery' },
    HOME + '#access_token=abc&refresh_token=def&type=recovery'],
  ['a Supabase PKCE callback - the code is in the QUERY',
    { pathname: BASE, search: '?code=auth-code-123' }, HOME + '?code=auth-code-123'],
  ['query and hash together',
    { pathname: BASE, search: '?seed=7', hash: '#access_token=xyz' },
    HOME + '?seed=7#access_token=xyz'],
  ['an old deep link keeps its path',
    { pathname: BASE + 'screenshot.png' }, HOME + 'screenshot.png'],
  ['no trailing slash on the base is not the base',
    { pathname: '/skyhook' }, HOME],
  ['served from somewhere unexpected, it still goes home',
    { pathname: '/', search: '?seed=9' }, HOME + '?seed=9']
];

for (const rel of STUBS) {
  for (const [name, loc, expected] of cases) {
    const out = redirectFor(rel, loc);
    check(`${rel}: ${name}`, out.replaced === expected,
      `${out.replaced} != ${expected}`);
  }

  /* location.replace, never location.href: an old link must not leave an entry
     in history that the back button bounces straight off. */
  const out = redirectFor(rel, { pathname: BASE });
  check(`${rel} uses location.replace, not href (no back-button trap)`,
    out.replaced !== null && out.assigned === null);

  check(`${rel} sends nobody back to the retired origin`,
    !read(rel).replace(/<!--[\s\S]*?-->/g, '').includes(RETIRED),
    'outside comments, the old host must not appear as a destination');
}

console.log(fails ? `\n${fails} FAILED` : '\nall pages/canonical checks passed');
process.exit(fails ? 1 : 0);
