/* SKYHOOK self-service account deletion - supabase/schema.sql section 12 run
 * on a REAL Postgres.
 *
 * Google Play's User Data policy: an app that lets people create an account
 * in the app must let them delete it in the app. delete_my_account() is that
 * door. What has to be true of it is database behaviour, not text, so - like
 * test/moderation_db.mjs - this runs the schema on PGlite behind the same
 * three-piece Supabase shim (anon / authenticated roles, auth.users,
 * auth.uid() reading request.jwt.claims) and makes every call AS a role, the
 * way PostgREST does.
 *
 * The same flow was run end-to-end against the staging project
 * (qlaenczyhzjkmqkraiup) with a throwaway account before the PR merged; this
 * file keeps it true afterwards.
 *
 * Run:  node test/account_delete_db.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');

let fails = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
}

/* What Supabase gives every project before a line of our SQL runs - the same
   shim as test/moderation_db.mjs. */
const SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create table auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;
`;

const db = new PGlite();

async function as(uid) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`,
    [uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : JSON.stringify({ role: 'anon' })]);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
}
async function asOwner() {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
}
async function attempt(sql, params = []) {
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows, code: '', message: '' };
  } catch (e) {
    return { ok: false, rows: null, code: e.code || '', message: String(e.message || e).split('\n')[0] };
  }
}

const TEL = JSON.stringify({ v: 1, hz: 120, n: 30, syn: 0, rel: 12, miss: 0, forced: 0, off: [3, -4, 5] });
let n = 0;
async function newUser(name) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  await asOwner();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [id, name + '@example.invalid', JSON.stringify({ username: name })]);
  await db.query(`insert into auth.identities (user_id) values ($1)`, [id]);
  return id;
}
async function submit(uid, score) {
  await as(uid);
  return attempt(`insert into public.scores (user_id, score, hooks, altitude, duration_ms, telemetry)
                  values ($1, $2, 10, 100, 20000, $3::jsonb)`, [uid, score, TEL]);
}
async function leftOf(uid) {
  await asOwner();
  return (await db.query(`select
      (select count(*)::int from auth.users where id = $1) u,
      (select count(*)::int from auth.identities where user_id = $1) i,
      (select count(*)::int from public.profiles where id = $1) p,
      (select count(*)::int from public.scores where user_id = $1) s,
      (select count(*)::int from public.bans where user_id = $1) b`, [uid])).rows[0];
}
const NONE = JSON.stringify({ u: 0, i: 0, p: 0, s: 0, b: 0 });
const DEL = 'select public.delete_my_account() gone';

async function main() {
  await db.exec(SHIM);
  const apply = () => db.exec(SCHEMA).then(() => ({ ok: true, message: '' }),
    e => ({ ok: false, message: String(e.message || e).split(/\r?\n/)[0] }));
  let r = await apply();
  check('schema.sql applies cleanly on a fresh Postgres', r.ok, r.message);
  if (!r.ok) return;
  r = await apply();
  check('...and a second time (delete_my_account is idempotent to install)', r.ok, r.message);

  /* ---- the shape of the door ---- */
  await asOwner();
  const fn = (await db.query(`select p.prosecdef, p.pronargs, p.proconfig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'delete_my_account'`)).rows;
  check('delete_my_account() exists exactly once', fn.length === 1, String(fn.length));
  if (fn.length !== 1) return;
  check('it takes NO argument - there is no way to name somebody else', fn[0].pronargs === 0);
  check('it is SECURITY DEFINER (deleting an auth user needs the owner)', fn[0].prosecdef === true);
  check('its search_path is pinned', (fn[0].proconfig || []).some(c => /^search_path=/.test(c)),
    JSON.stringify(fn[0].proconfig));
  const priv = (await db.query(`select
      has_function_privilege('anon', 'public.delete_my_account()', 'execute') anon,
      has_function_privilege('authenticated', 'public.delete_my_account()', 'execute') authd`)).rows[0];
  check('anon cannot execute it, authenticated can', priv.anon === false && priv.authd === true, JSON.stringify(priv));

  const ALICE = await newUser('ad_alice');
  const BOB = await newUser('ad_bob');
  const BANNED = await newUser('ad_banned');
  const ADMIN = await newUser('ad_admin');
  await asOwner();
  await db.query(`insert into public.admins (user_id, note) values ($1, 'test')`, [ADMIN]);
  await submit(ALICE, 3000);
  await submit(ALICE, 3100);
  await submit(BOB, 2000);
  await submit(BANNED, 1500);
  /* Moderated through the real section-11 functions, so admin_audit holds
     the rows a real moderated player would have: BANNED is banned, BOB was
     banned and unbanned (and must keep his name in the log). */
  await as(ADMIN);
  await db.query(`select public.admin_ban_user($1, 'automated play')`, [BANNED]);
  await db.query(`select public.admin_ban_user($1, 'mistake')`, [BOB]);
  await db.query(`select public.admin_unban_user($1)`, [BOB]);
  await asOwner();
  const auditOf = async (uid) => (await db.query(
    `select action, target_username, reason from public.admin_audit where target_id = $1 order by id`, [uid])).rows;
  check('setup: the moderated players have audit rows naming them',
    (await auditOf(BANNED)).length === 1 && (await auditOf(BANNED))[0].target_username === 'ad_banned' &&
    (await auditOf(BOB)).length === 2, JSON.stringify(await auditOf(BANNED)));

  /* ---- signed out ---- */
  await as(null);
  r = await attempt(DEL);
  check('signed out, the call is refused', !r.ok && r.code === '42501', r.code + ' ' + r.message);

  /* ---- a player deletes their own account ---- */
  const before = await leftOf(ALICE);
  check('the player starts with an account, a profile and two runs',
    before.u === 1 && before.p === 1 && before.s === 2, JSON.stringify(before));
  await as(ALICE);
  r = await attempt(DEL);
  check('a signed-in player deletes their own account, and is told it happened',
    r.ok && r.rows[0].gone === true, r.message || JSON.stringify(r.rows));
  check('the auth user, its identities, the profile and every run are gone',
    JSON.stringify(await leftOf(ALICE)) === NONE, JSON.stringify(await leftOf(ALICE)));

  /* ---- idempotent: a retry after a dropped response is not an error ---- */
  await as(ALICE);
  r = await attempt(DEL);
  check('calling it again with the same (still unexpired) token is harmless and says nothing was left',
    r.ok && r.rows[0].gone === false, r.message || JSON.stringify(r.rows));
  check('...and a stale token cannot put a run back on the board', !(await submit(ALICE, 5000)).ok);

  /* ---- nobody else is touched ---- */
  const bob = await leftOf(BOB);
  check('another player keeps their account and runs', bob.u === 1 && bob.p === 1 && bob.s === 1, JSON.stringify(bob));
  await as(null);
  const board = (await db.query(`select username from public.leaderboard order by rank`)).rows.map(x => x.username);
  check('the deleted player is off the public board, the others are not',
    !board.includes('ad_alice') && board.includes('ad_bob'), board.join(','));

  /* ---- a banned player may still leave ---- */
  await as(BANNED);
  r = await attempt(DEL);
  check('a banned player can delete their own account (the right to leave is not a privilege)',
    r.ok && r.rows[0].gone === true, r.message);
  check('...and the ban row goes with it', JSON.stringify(await leftOf(BANNED)) === NONE, JSON.stringify(await leftOf(BANNED)));
  await asOwner();
  const kept = await auditOf(BANNED);
  check('...the moderation record stays, but no longer names the player',
    kept.length === 1 && kept[0].action === 'ban' && kept[0].reason === 'automated play' &&
    kept[0].target_username === null, JSON.stringify(kept));
  check('...and the audit rows of other players are untouched',
    (await auditOf(BOB)).every(x => x.target_username === 'ad_bob'), JSON.stringify(await auditOf(BOB)));

  /* ---- an admin cannot remove themselves in one tap ---- */
  await as(ADMIN);
  r = await attempt(DEL);
  check('an admin is refused (demote in the SQL editor first, same rule as section 11)',
    !r.ok && r.code === '22023', r.code + ' ' + r.message);
  const adm = await leftOf(ADMIN);
  check('...and the admin account is untouched', adm.u === 1 && adm.p === 1, JSON.stringify(adm));

  /* ---- the ledger rules for everyone else are unchanged ---- */
  await as(BOB);
  r = await attempt('delete from public.scores where user_id = $1', [BOB]);
  check('a player still cannot delete a score directly', !r.ok && r.code === '42501', r.message);
  r = await attempt('delete from public.profiles where id = $1', [BOB]);
  check('a player still cannot delete a profile directly', !r.ok && r.code === '42501', r.message);
}

main()
  .catch(e => { fails++; console.error(e); })
  .finally(async () => {
    try { await db.close(); } catch { /* ignore */ }
    console.log(`\n${total - fails}/${total} checks passed`);
    console.log(fails === 0
      ? 'account deletion holds: own account only, everything goes, idempotent, admins refused'
      : fails + ' FAILURE(S)');
    process.exit(fails === 0 ? 0 : 1);
  });
