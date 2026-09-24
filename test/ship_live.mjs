/* SKYHOOK ship paint - the account round trip, against a REAL Supabase project.
 *
 * test/ship.mjs proves the round trip against a stand-in server. This proves
 * it against the real schema, the real RLS, the real RPC and the real
 * js/online.js, over the network: sign up, paint four parts, save, then sign
 * in on a "second device" with empty storage and get the same ship back.
 *
 * STAGING ONLY, AND IT CLEANS UP AFTER ITSELF - both enforced, not promised:
 *
 *   - It refuses to run against the project js/config.js points at, i.e.
 *     production. The ref is read from that file, not typed here, so the
 *     guard cannot go stale.
 *   - It refuses to run without a way to delete what it creates. An e2e that
 *     leaves accounts behind is how a 9000-point probe ended up as #1 on the
 *     staging board and made the gold ship look broken to the person testing
 *     it. So: one throwaway account, deleted in `finally`, and a sweep of the
 *     harness's own prefix before AND after, which also clears any account a
 *     crashed earlier run left behind.
 *   - It never submits a score. The board is asserted unchanged at the end.
 *
 * Deletion needs the database (GoTrue's admin API wants the service-role key,
 * which is not kept anywhere). Node has no Postgres client and this repo has
 * no dependencies to add one to, so the teardown shells out to Python's
 * psycopg2 with the DSN in the environment.
 *
 * Not part of test:ci - CI has no staging credentials, and should not.
 *
 * Run:
 *   SKYHOOK_LIVE_URL=https://<staging-ref>.supabase.co \
 *   SKYHOOK_LIVE_ANON_KEY=<staging anon key> \
 *   SKYHOOK_LIVE_DB_URL=postgresql://postgres.<staging-ref>:<pw>@<pooler>:5432/postgres \
 *   node test/ship_live.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = o => JSON.parse(JSON.stringify(o));

const URL_ = (process.env.SKYHOOK_LIVE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SKYHOOK_LIVE_ANON_KEY || '';
const DSN = process.env.SKYHOOK_LIVE_DB_URL || '';

/* ------------------------------------------------------------- guards */

const refOf = u => ((/^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(u) || [])[1] || '');
const prodRef = refOf(((/supabaseUrl:\s*'([^']+)'/.exec(read('js/config.js'))) || [])[1] || '');
const liveRef = refOf(URL_);

if (!URL_ || !KEY || !DSN) {
  console.log('SKIP  SKYHOOK_LIVE_URL / SKYHOOK_LIVE_ANON_KEY / SKYHOOK_LIVE_DB_URL not all set.');
  console.log('      This test creates an account, so it will not start without the means to delete it.');
  process.exit(0);
}
if (!prodRef || !liveRef) { console.log('FAIL  could not read a project ref to guard on'); process.exit(1); }
if (liveRef === prodRef || DSN.includes(prodRef) || KEY.includes(prodRef)) {
  console.log(`FAIL  refusing to run: this points at PRODUCTION (${prodRef}). Staging only.`);
  process.exit(1);
}
if (!DSN.includes(liveRef)) {
  console.log('FAIL  refusing to run: the teardown database is not the project under test.');
  process.exit(1);
}
console.log(`      target ${liveRef} (production is ${prodRef} - not touched)`);

/* ----------------------------------------------------------- the database */

/* One query through psycopg2, parameters passed as JSON, rows back as JSON. */
function sql(query, params = []) {
  const py = [
    'import json,os,sys,psycopg2',
    'q,p=json.loads(sys.stdin.read())',
    "c=psycopg2.connect(os.environ['DSN'],sslmode='require',connect_timeout=10)",
    'cur=c.cursor(); cur.execute(q,p)',
    'rows=cur.fetchall() if cur.description else []',
    'c.commit(); print(json.dumps(rows,default=str))'
  ].join('\n');
  const r = spawnSync('python', ['-c', py], {
    input: JSON.stringify([query, params]), env: { ...process.env, DSN }, encoding: 'utf8'
  });
  if (r.status !== 0) throw new Error('db: ' + (r.stderr || r.error || 'failed').toString().trim().split('\n').pop());
  return JSON.parse(r.stdout);
}

const PREFIX = 'ship-live-';
const DOMAIN = '@example.com';
function sweep() {
  return sql(`delete from auth.users where email like %s returning email`, [PREFIX + '%' + DOMAIN]).length;
}

/* ------------------------------------------------------------- a device */

function device() {
  const storage = new Map();
  const sandbox = {
    Math, Date, console, JSON, Proxy, Promise, setTimeout, clearTimeout, URL,
    fetch: globalThis.fetch, AbortController, crypto: webcrypto, TextEncoder,
    Uint8Array, btoa: globalThis.btoa, atob: globalThis.atob,
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); }
    }
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = { createElement: () => ({ getContext: () => null }) };
  for (const f of ['js/utils.js', 'js/ship.js', 'js/rocket.js', 'js/online.js']) {
    vm.runInContext(read(f), sandbox);
  }
  sandbox.SK.Online.configure({ supabaseUrl: URL_, supabaseAnonKey: KEY });
  return sandbox.SK;
}

async function board() {
  const r = await fetch(`${URL_}/rest/v1/leaderboard?select=*`, {
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
  });
  return r.ok ? (await r.json()).length : -1;
}

/* ------------------------------------------------------------------ run */

const stamp = Date.now().toString(36).slice(-6);
const email = `${PREFIX}${stamp}${DOMAIN}`;
const username = `shiplive_${stamp}`.slice(0, 16);
const password = 'x' + webcrypto.randomUUID();
let userId = '';

const leftovers = sweep();
console.log(`      swept ${leftovers} leftover harness account(s) before starting`);
const boardBefore = await board();

try {
  /* Device A: sign up, paint, save. */
  const A = device();
  const up = await A.Online.signUp(username, email, password);
  check('a throwaway account signs up and gets a session', up && up.signedIn === true, JSON.stringify(up));
  userId = (sql('select id from auth.users where email = %s', [email])[0] || [])[0] || '';
  check('...and exists in auth.users', !!userId, userId);

  const want = { nose: '#ff7a1a', window: '#ff3b30', body: '#8a72ff', fire: '#1affb0' };
  for (const k of A.Ship.PARTS) A.Ship.set(k, want[k]);
  check('device A painted four parts', same(plain(A.Ship.saved()), want), JSON.stringify(A.Ship.saved()));
  check('device A saves them through set_ship_paint', (await A.Online.saveShipPaint(A.Ship.saved())) === true);

  const row = sql('select ship_nose, ship_window, ship_body, ship_fire from public.profiles where id = %s', [userId])[0];
  check('the profile row holds all four parts',
    same(row, [want.nose, want.window, want.body, want.fire]), JSON.stringify(row));

  /* Device B: empty storage, same account. */
  const B = device();
  check('device B starts on the default ship', B.Ship.isDefault());
  await B.Online.signIn(email, password);
  const got = await B.Online.loadShipPaint();
  B.Ship.setPaint(got);
  check('device B signs in and gets the same four parts back',
    same(plain(B.Ship.saved()), want), JSON.stringify(B.Ship.saved()));

  /* The server's half of the rule. */
  check('the database refuses gold on any part',
    (await A.Online.saveShipPaint({ ...want, fire: A.Ship.GOLD })) === false);
  check('the database refuses an off-menu colour',
    (await A.Online.saveShipPaint({ ...want, body: '#000000' })) === false);
  const after = sql('select ship_nose, ship_window, ship_body, ship_fire from public.profiles where id = %s', [userId])[0];
  check('...and a refused write leaves the stored ship exactly as it was',
    same(after, [want.nose, want.window, want.body, want.fire]), JSON.stringify(after));

  const anon = await fetch(`${URL_}/rest/v1/rpc/set_ship_paint`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_nose: '', p_window: '', p_body: '', p_fire: '' })
  });
  check('the anon key cannot call the paint function at all', anon.status === 401 || anon.status === 403 || anon.status === 404,
    String(anon.status));

  /* Reset stores NULLs - the default belongs to the game, not the row. */
  A.Ship.reset();
  await A.Online.saveShipPaint(A.Ship.toStored());
  const reset = sql('select ship_nose, ship_window, ship_body, ship_fire from public.profiles where id = %s', [userId])[0];
  check('resetting to default stores the default as NULL, not as today\'s hex',
    same(reset, [null, null, null, null]), JSON.stringify(reset));
  const C = device();
  await C.Online.signIn(email, password);
  const blank = await C.Online.loadShipPaint();
  C.Ship.setPaint(blank);
  check('...and a NULL row loads back as the default ship', C.Ship.isDefault(), JSON.stringify(blank));
} catch (e) {
  check('the live round trip ran to completion', false, e && e.message);
} finally {
  /* Teardown. Runs whatever happened above. */
  let removed = 0;
  try {
    if (userId) removed += sql('delete from auth.users where id = %s returning id', [userId]).length;
    removed += sweep();
  } catch (e) {
    check('teardown reached the database', false, e.message);
  }
  const left = sql('select count(*) from auth.users where email like %s', [PREFIX + '%' + DOMAIN])[0][0];
  const orphan = userId ? sql('select count(*) from public.profiles where id = %s', [userId])[0][0] : 0;
  check('teardown: the throwaway account is gone', Number(left) === 0 && Number(orphan) === 0,
    `removed ${removed}, harness accounts left ${left}, profile rows left ${orphan}`);
  const boardAfter = await board();
  check('the leaderboard is exactly as it was - this test never scores',
    boardAfter === boardBefore && boardBefore >= 0, `${boardBefore} -> ${boardAfter}`);
}

console.log(`\n${fails === 0 ? 'live round trip holds, and it left nothing behind' : fails + ' FAILURE(S)'}`);
process.exit(fails === 0 ? 0 : 1);
