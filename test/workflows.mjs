/* SKYHOOK - the CI supply-chain gate.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * test.yml's own header says it: "a threat model nothing checks is a comment".
 * deploy.yml now carries a long comment explaining why the flyctl action is
 * pinned to a commit instead of `@master`. Without this file, that comment is
 * the ONLY thing defending the deploy token, and comments do not fail builds.
 * One "cleanup" that shortens `@ed8efb3...` back to `@master` would restore
 * the exact hole it describes, and every check in the repo would stay green.
 *
 * WHAT IS ACTUALLY AT STAKE
 * -------------------------
 * `deploy` (with `preflight`) is the only job that can read FLY_API_TOKEN, and
 * that token can deploy, scale, read secrets from and destroy every app in the
 * Fly org; staging.yml's `up`/`down` hold FLY_STAGING_API_TOKEN likewise. A
 * third-party action referenced by a MUTABLE ref (a branch, or a tag - tags
 * can be force-pushed to a different commit) is arbitrary code that the
 * upstream owner may change at any time, running in the same job as that
 * token. A 40-hex commit SHA is the only ref GitHub will not let anyone move.
 *
 * WHAT IS DELIBERATELY NOT CHECKED
 * --------------------------------
 * actions/* is first-party GitHub, published from the same trust boundary as
 * the runner executing it: if `actions/checkout@v4` were hostile, pinning it
 * would change nothing because GitHub already owns the machine. Those stay on
 * readable major tags so they keep receiving Node-runtime and security
 * updates without a human re-resolving a hash. The distinction this file
 * enforces is first-party-vs-third-party, not tag-vs-SHA everywhere - a rule
 * that churned actions/* on every release would be abandoned within a month,
 * and an abandoned rule protects nothing.
 *
 * Pure Node, no browser, no dependencies, sub-second. Parsing is deliberately
 * regex-over-text rather than a YAML library: the repo has zero runtime
 * dependencies and adding one to `logic` to read four `uses:` lines would be a
 * worse trade than the parsing being simple.
 *
 * Run: node test/workflows.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = path.join(ROOT, '.github', 'workflows');

let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  -> ' + detail : ''}`);
};

const files = fs.readdirSync(DIR).filter(f => /\.ya?ml$/.test(f)).sort();

/* A directory that has stopped matching reality must not read as "all checks
   passed". If someone moves the workflows, this test should shout. */
check('workflows exist to check', files.length > 0, `${DIR} has no yaml`);

/* Comments are stripped before scanning. deploy.yml's pin is explained in a
   comment block that itself contains the words `@master` and `pull_request`;
   scanning raw text would fail the build on its own documentation. */
const strip = src => src
  .split('\n')
  .map(l => l.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');

/* Owners whose code already runs the runner. Pinning these buys nothing and
   costs a manual hash bump per release - see the header. */
const FIRST_PARTY = new Set(['actions', 'github']);

for (const file of files) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const src = strip(raw);

  /* ---------------------------------------------------------------- 1. refs
   * Every `uses:` that leaves this repo must name a commit if it is not
   * first-party. Local refs (./.github/workflows/test.yml) are this repo at
   * this commit and cannot be moved by anyone else. */
  const uses = [...src.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(m => m[1]);
  check(`${file}: has at least one step`, uses.length > 0);

  for (const ref of uses) {
    if (ref.startsWith('./')) continue;                 // this repo, this commit
    const owner = ref.split('/')[0];
    const pinned = /@[0-9a-f]{40}$/.test(ref);

    if (FIRST_PARTY.has(owner)) {
      /* Not "must be a tag" - just "we chose not to require a SHA here".
         Recorded as a PASS so the exemption is visible in the log rather
         than silently skipped. */
      check(`${file}: ${ref} is first-party (tag allowed)`, true);
      continue;
    }
    check(`${file}: ${ref} is pinned to a full commit SHA`, pinned,
      'third-party action on a mutable ref - a branch or tag can be moved ' +
      'under us, and this repo runs third-party code beside FLY_API_TOKEN');
  }

  /* ----------------------------------------------------- 2. pull_request_target
   * It runs with the BASE repo's secrets and a write-capable token, against a
   * PR head that anyone may author. There is no use for it here. */
  check(`${file}: does not use pull_request_target`,
    !/pull_request_target/.test(src),
    'runs fork-authored refs with this repo\'s secrets');

  /* ------------------------------------------------- 3. least privilege
   * A workflow with no `permissions:` inherits the repository default, which
   * is a setting - so the token a job holds would be decided outside the
   * file, and could widen without a diff. Every workflow states it. The
   * top-level block is the one that matters: a job may widen its own scope
   * deliberately (deploy.yml's pages-stub does, to push gh-pages), but the
   * floor must be written down. */
  const block  = src.match(/^permissions:\s*\n((?:[ \t]+\S.*\n)+)/m);  // permissions:\n  contents: read
  const inline = src.match(/^permissions:[ \t]+(\S.*)$/m);             // permissions: write-all

  check(`${file}: declares a top-level permissions block`, !!(block || inline),
    'without it the token scope comes from a repo setting, not this file');

  /* BOTH SPELLINGS, and that is not pedantry. An earlier draft of this file
     understood only the block form, so `permissions: write-all` - the single
     most permissive value GitHub accepts, a token that can push to main and
     rewrite releases - passed as "declares a permissions block" with nothing
     ever looking at the value. A gate that green-lights the worst possible
     configuration is worse than no gate, because it is believed. Caught by
     review; the mutation for it is M7 in the PR. */
  const scope = block ? block[1] : inline ? inline[1] : null;
  if (scope !== null) {
    const readOnly = !/write-all\b/.test(scope) && !/:\s*write\b/.test(scope);
    check(`${file}: top-level permissions are read-only`, readOnly,
      `write at workflow level: ${scope.trim().replace(/\s+/g, ' ')}`);
  }
}

/* ------------------------------------------------------------- 4. the tokens
 * The specific thing this whole file is defending. Each Fly token may be read
 * only by the jobs listed here, in the workflow listed here. If one ever
 * appears anywhere else, the blast radius of every action in that job just
 * became a Fly org. Every workflow is scanned, not just the ones named, so a
 * NEW workflow that reaches for a Fly secret fails until it is added here on
 * purpose.
 *
 *   deploy.yml  - `preflight` only tests FLY_API_TOKEN for emptiness to decide
 *                 whether to deploy at all; `deploy` hands it to flyctl.
 *   staging.yml - `up` and `down` both drive flyctl against skyhook-staging,
 *                 with a separate FLY_STAGING_API_TOKEN (never production's).
 */
const TOKEN_READERS = {
  FLY_API_TOKEN:         { 'deploy.yml':  ['preflight', 'deploy'] },
  FLY_STAGING_API_TOKEN: { 'staging.yml': ['up', 'down'] },
};

/* Jobs are the 2-space keys under `jobs:`; returns [{name, text}]. */
const jobsOf = src => {
  const at = src.search(/^jobs:\s*$/m);
  if (at < 0) return [];
  const body = src.slice(at);
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return heads.map((m, i) => ({
    name: m[1],
    text: body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : body.length),
  }));
};

for (const [secret, allowed] of Object.entries(TOKEN_READERS)) {
  const re = new RegExp(`secrets\\.${secret}\\b`);
  const holders = [];
  for (const file of files) {
    const src = strip(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const job of jobsOf(src)) if (re.test(job.text)) holders.push(`${file}:${job.name}`);
    /* A secret read at workflow level (top-level env:) would hand it to
       every job at once - outside any job, so jobsOf never sees it. */
    const head = src.slice(0, Math.max(0, src.search(/^jobs:\s*$/m)));
    if (re.test(head)) holders.push(`${file}:(workflow-level)`);
  }
  const ok = holders.length > 0 &&
    holders.every(h => { const [f, j] = h.split(':'); return (allowed[f] || []).includes(j); });
  const want = Object.entries(allowed).map(([f, js]) => js.map(j => `${f}:${j}`).join(', ')).join(', ');
  check(`${secret} is read only by ${want}`, ok,
    `jobs reading it: ${holders.join(', ') || '(none - did the secret name change?)'}`);
}

/* ------------------------------------------------------ 5. one pin, not two
 * The same third-party action is used in more than one workflow (setup-flyctl
 * is in deploy.yml AND staging.yml). A deliberate bump that re-resolves one
 * and forgets the other leaves two different commits of the same code
 * holding two different Fly tokens - still "pinned", so check 1 stays green.
 * Every use of a given third-party action must name the same SHA. */
{
  const byAction = new Map();
  for (const file of files) {
    const src = strip(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const m of src.matchAll(/^\s*(?:-\s+)?uses:\s*([^@\s]+)@(\S+)/gm)) {
      const [action, ref] = [m[1], m[2]];
      if (action.startsWith('./') || FIRST_PARTY.has(action.split('/')[0])) continue;
      if (!byAction.has(action)) byAction.set(action, new Set());
      byAction.get(action).add(ref);
    }
  }
  for (const [action, refs] of byAction)
    check(`${action}: every workflow pins the same commit`, refs.size === 1,
      `refs in use: ${[...refs].join(', ')}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall workflow supply-chain checks passed');
process.exit(fails ? 1 : 0);
