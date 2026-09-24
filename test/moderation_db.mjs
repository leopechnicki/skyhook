/* SKYHOOK moderation gate - supabase/schema.sql run on a REAL Postgres.
 *
 * test/online.mjs reads the schema as text. That catches a deleted policy,
 * but it cannot tell whether a ban actually hides a player, whether a banned
 * insert is actually refused, or whether a non-admin calling the admin RPC is
 * actually turned away. Those are behaviours of the database, so this file
 * runs the database: PGlite (Postgres 17+ compiled to WebAssembly, in-process,
 * no server, no Docker), with a small shim standing in for the three things
 * Supabase provides and plain Postgres does not - the `anon` and
 * `authenticated` roles, an `auth.users` table, and `auth.uid()` reading the
 * caller out of `request.jwt.claims`, which is exactly how Supabase's own
 * auth.uid() reads it.
 *
 * Every call below is made AS a role, the way PostgREST makes it: SET ROLE
 * plus the JWT claims. So RLS, grants and SECURITY DEFINER behave as they do
 * in production, not as they do for a superuser.
 *
 * The same checks were also run against the real staging project
 * (qlaenczyhzjkmqkraiup) inside a rolled-back transaction before this PR
 * was opened; this file is what keeps them true afterwards.
 *
 * Run:  node test/moderation_db.mjs
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

/* What Supabase gives every project before a line of our SQL runs. */
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

/* Become a caller. null = signed out (anon). */
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

/* { ok, rows, code, message } - never throws, so a refusal is data. */
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
                  values ($1, $2, 10, 100, 20000, $3::jsonb) returning flagged`, [uid, score, TEL]);
}
async function board() {
  await as(null);
  const r = await attempt(`select username, score, rank from public.leaderboard order by rank`);
  return r.ok ? r.rows.map(x => [x.username, x.score, Number(x.rank)]) : r.message;
}
const names = rows => Array.isArray(rows) ? rows.map(r => r[0]).join(',') : String(rows);

async function main() {
  await db.exec(SHIM);

  /* ---- the schema applies, and applies again ---- */
  const apply = () => db.exec(SCHEMA).then(() => ({ ok: true, message: '' }),
    e => ({ ok: false, message: String(e.message || e).split(/\r?\n/)[0] }));
  let r = await apply();
  check('schema.sql applies cleanly on a fresh Postgres', r.ok, r.message);
  if (!r.ok) return;
  r = await apply();
  check('...and a second time (it is idempotent)', r.ok, r.message);

  const ADMIN = await newUser('mt_admin');
  const BOT = await newUser('mt_botty');
  const HUMAN = await newUser('mt_human');
  await asOwner();
  await db.query(`insert into public.admins (user_id, note) values ($1, 'test')`, [ADMIN]);

  check('a normal player can submit', (await submit(BOT, 4000)).ok);
  await submit(BOT, 3000);
  await submit(HUMAN, 2000);
  await submit(ADMIN, 1000);
  check('everyone starts on the public board', names(await board()) === 'mt_botty,mt_human,mt_admin', names(await board()));

  /* ---- is_admin decides only what is DRAWN ---- */
  await as(ADMIN);
  check('is_admin() is true for an admin', (await attempt('select public.is_admin() a')).rows[0].a === true);
  await as(HUMAN);
  check('is_admin() is false for a player', (await attempt('select public.is_admin() a')).rows[0].a === false);
  await as(null);
  check('is_admin() is false signed out', (await attempt('select public.is_admin() a')).rows[0].a === false);

  /* ---- 1. non-admin RPC calls are rejected ---- */
  const CALLS = [
    ['admin_ban_user', 'select public.admin_ban_user($1, $2)', [BOT, 'x']],
    ['admin_unban_user', 'select public.admin_unban_user($1)', [BOT]],
    ['admin_delete_user', 'select public.admin_delete_user($1)', [BOT]],
    ['admin_board', 'select * from public.admin_board(50)', []]
  ];
  for (const [who, uid] of [['a player', HUMAN], ['a signed-out caller', null], ['the target itself', BOT]]) {
    for (const [fn, sql, params] of CALLS) {
      await as(uid);
      r = await attempt(sql, params);
      check(`${who} calling ${fn} is refused (42501)`, !r.ok && r.code === '42501', r.code + ' ' + r.message);
    }
  }
  await as(HUMAN);
  for (const t of ['bans', 'admins', 'admin_audit']) {
    r = await attempt(`select * from public.${t}`);
    check(`a player cannot read ${t}`, !r.ok && r.code === '42501', r.message);
  }
  r = await attempt('insert into public.admins (user_id) values ($1)', [HUMAN]);
  check('a player cannot make themselves an admin', !r.ok && r.code === '42501', r.message);
  r = await attempt('insert into public.bans (user_id) values ($1)', [HUMAN]);
  check('a player cannot write a ban row directly', !r.ok && r.code === '42501', r.message);
  r = await attempt('delete from public.bans');
  check('a player cannot lift a ban directly', !r.ok && r.code === '42501', r.message);
  r = await attempt('select public.admin_require()');
  check('the internal admin gate is not callable on its own', !r.ok && r.code === '42501', r.message);
  await asOwner();
  check('none of the refused calls changed anything',
    (await db.query('select count(*)::int c from public.bans')).rows[0].c === 0 &&
    (await db.query('select count(*)::int c from public.admin_audit')).rows[0].c === 0);

  /* ---- the admin board ---- */
  await as(ADMIN);
  r = await attempt('select username, rank, banned, is_admin, user_id::text id from public.admin_board(50)');
  check('the admin board lists every player with the id to act on',
    r.ok && r.rows.map(x => x.username).join(',') === 'mt_botty,mt_human,mt_admin' &&
    r.rows[0].id === BOT && r.rows[2].is_admin === true, r.message || JSON.stringify(r.rows));

  /* ---- limits on what an admin may do ---- */
  r = await attempt('select public.admin_ban_user($1, $2)', [ADMIN, 'me']);
  check('an admin cannot ban themselves', !r.ok && r.code === '22023', r.message);
  r = await attempt('select public.admin_delete_user($1)', [ADMIN]);
  check('an admin cannot delete themselves', !r.ok && r.code === '22023', r.message);
  const ADMIN2 = await newUser('mt_admin2');
  await asOwner();
  await db.query(`insert into public.admins (user_id) values ($1)`, [ADMIN2]);
  await as(ADMIN);
  r = await attempt('select public.admin_ban_user($1, $2)', [ADMIN2, 'x']);
  check('an admin cannot ban another admin', !r.ok && r.code === '22023', r.message);
  r = await attempt('select public.admin_delete_user($1)', [ADMIN2]);
  check('an admin cannot delete another admin', !r.ok && r.code === '22023', r.message);
  r = await attempt('select public.admin_ban_user($1, $2)', ['00000000-0000-4000-8000-999999999999', 'x']);
  check('banning an account that does not exist is refused', !r.ok && r.code === 'P0002', r.message);

  /* ---- 2 + 3. ban: hidden from the board, inserts refused ---- */
  r = await attempt('select public.admin_ban_user($1, $2)', [BOT, 'suspected bot']);
  check('an admin bans a player', r.ok, r.message);
  let b = await board();
  check('a banned player is hidden from the public leaderboard', names(b) === 'mt_human,mt_admin', names(b));
  check('...and the ranks close up behind them', Array.isArray(b) && b[0][2] === 1 && b[1][2] === 2, JSON.stringify(b));
  r = await submit(BOT, 5000);
  check('a banned player\'s insert is rejected with SKBAN', !r.ok && r.code === 'SKBAN', r.code + ' ' + r.message);
  r = await submit(BOT, 500);
  check('...every time, not only the first', !r.ok && r.code === 'SKBAN', r.code);
  await as(BOT);
  r = await attempt('select * from public.my_rank()');
  check('my_rank() has nothing for a banned player', r.ok && r.rows.length === 0, JSON.stringify(r.rows));
  await asOwner();
  check('a ban deletes nothing - both runs are still in the ledger',
    (await db.query('select count(*)::int c from public.scores where user_id = $1', [BOT])).rows[0].c === 2);
  check('the ban records who banned and why',
    JSON.stringify((await db.query('select banned_by::text by, reason from public.bans where user_id = $1', [BOT])).rows[0]) ===
    JSON.stringify({ by: ADMIN, reason: 'suspected bot' }));
  await db.exec('alter table public.scores disable trigger scores_ban_guard_trg');
  r = await submit(BOT, 5000);
  check('with the trigger gone, the restrictive policy still refuses a banned insert',
    !r.ok && r.code === '42501', r.code + ' ' + r.message);
  await asOwner();
  await db.exec('alter table public.scores enable trigger scores_ban_guard_trg');
  await as(ADMIN);
  r = await attempt('select username, rank, banned, ban_reason from public.admin_board(50)');
  const last = r.ok ? r.rows[r.rows.length - 1] : null;
  check('the admin still sees the banned player, last and unranked, with the reason',
    !!last && last.username === 'mt_botty' && last.rank === null && last.banned === true &&
    last.ban_reason === 'suspected bot', JSON.stringify(last));
  r = await attempt('select public.admin_ban_user($1, $2)', [BOT, 'confirmed bot']);
  check('banning again updates the reason instead of failing', r.ok, r.message);

  /* ---- 4. unban restores ---- */
  r = await attempt('select public.admin_unban_user($1) lifted', [BOT]);
  check('an admin unbans', r.ok && r.rows[0].lifted === true, r.message);
  b = await board();
  check('unban restores the player to the board with their best run',
    Array.isArray(b) && b[0][0] === 'mt_botty' && b[0][1] === 4000, JSON.stringify(b));
  check('an unbanned player can submit again', (await submit(BOT, 4100)).ok);
  await as(ADMIN);
  r = await attempt('select public.admin_unban_user($1) lifted', [BOT]);
  check('unbanning an account that is not banned is harmless, and says so', r.ok && r.rows[0].lifted === false);

  /* ---- 5. delete removes ---- */
  await attempt('select public.admin_ban_user($1, $2)', [BOT, 'bot']);
  r = await attempt('select public.admin_delete_user($1)', [BOT]);
  check('an admin deletes a player', r.ok, r.message);
  await asOwner();
  const left = (await db.query(`select
      (select count(*)::int from auth.users where id = $1) u,
      (select count(*)::int from auth.identities where user_id = $1) i,
      (select count(*)::int from public.profiles where id = $1) p,
      (select count(*)::int from public.scores where user_id = $1) s,
      (select count(*)::int from public.bans where user_id = $1) b`, [BOT])).rows[0];
  check('delete removes the auth user, its identities, profile, every score and the ban row',
    JSON.stringify(left) === JSON.stringify({ u: 0, i: 0, p: 0, s: 0, b: 0 }), JSON.stringify(left));
  b = await board();
  check('the deleted player is gone from the board', names(b) === 'mt_human,mt_admin', names(b));
  await as(ADMIN);
  r = await attempt('select public.admin_delete_user($1)', [BOT]);
  check('deleting it twice is refused, not silently "done"', !r.ok && r.code === 'P0002', r.message);

  /* ---- the audit log ---- */
  await asOwner();
  const log = (await db.query(
    `select action, target_username, admin_id::text admin from public.admin_audit where target_id = $1 order by id`, [BOT])).rows;
  check('every admin action on the account is in the audit log, delete included',
    log.map(x => x.action).join(',') === 'ban,ban,unban,unban,ban,delete' &&
    log.every(x => x.admin === ADMIN) && log[log.length - 1].target_username === 'mt_botty',
    JSON.stringify(log.map(x => x.action)));
  check('refused actions left no audit rows',
    (await db.query(`select count(*)::int c from public.admin_audit where target_id in ($1, $2)`, [ADMIN, ADMIN2])).rows[0].c === 0);

  /* ---- players keep exactly the rules they had ---- */
  await as(HUMAN);
  r = await attempt('update public.scores set score = 1 where user_id = $1', [HUMAN]);
  check('a player still cannot update a score', !r.ok && r.code === '42501', r.message);
  r = await attempt('delete from public.scores where user_id = $1', [HUMAN]);
  check('a player still cannot delete a score', !r.ok && r.code === '42501', r.message);
  check('a player who was never banned submits as before', (await submit(HUMAN, 2500)).ok);
}

main()
  .catch(e => { fails++; console.error(e); })
  .finally(async () => {
    try { await db.close(); } catch { /* ignore */ }
    console.log(`\n${total - fails}/${total} checks passed`);
    console.log(fails === 0
      ? 'moderation holds: admins only, bans hide and block, unban restores, delete removes'
      : fails + ' FAILURE(S)');
    process.exit(fails === 0 ? 0 : 1);
  });
