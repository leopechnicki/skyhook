/* SKYHOOK - online configuration, STAGING BUILD.
 *
 * This file is not loaded by anything in the repo. The Dockerfile copies it
 * OVER js/config.js, and only when built with --build-arg SKYHOOK_ENV=staging
 * (see the stage-one overlay). A normal build never sees it, so nothing here
 * can reach skyhookplay.com by accident: there is no flag to get wrong at
 * runtime, only a build that either applied the overlay or did not.
 *
 * WHY THE SAME SUPABASE PROJECT AS PRODUCTION
 * -------------------------------------------
 * A second Supabase project is the textbook answer and it was the first
 * choice. It is not available: the only credential this repo has is a
 * PROJECT-scoped personal access token (~/skyhook_supabase.local.txt, expires
 * 2026-09-28). GET /v1/organizations returns [] with it, so it cannot create
 * a project, and project creation is an account-level action Leo would have
 * to take by hand in the dashboard - after which the schema, the auth
 * settings, the email templates and the OAuth redirect allow-list all become
 * a second stack that drifts from the first one silently.
 *
 * The failure mode actually worth preventing is narrower than "staging
 * touches production": it is "test runs pollute Leo's real scores". So the
 * isolation is aimed exactly there.
 *
 *   public.leaderboard is a VIEW over public.scores joined to profiles
 *   (supabase/schema.sql, section 6). A user with no row in `scores` has no
 *   row on the board - no rank, no entry, nothing rendered.
 *
 * Therefore blocking the ONE insert into `scores` is sufficient to keep the
 * visible leaderboard clean, and it leaves everything else - sign up, sign
 * in, Google OAuth, password recovery, reading the board, my_rank(), the
 * profile row - working against real data. That is what makes the staging
 * site worth deploying: items 2 and 3 of the brief (the rank-#1 golden ship,
 * the ship customiser) are READS and profile writes, and a staging build that
 * disabled the backend outright could not test either of them.
 *
 * The enforcement is not in this file. This file only sets the flag;
 * js/online.js refuses the request in submitRun(), which is the single
 * function every score has ever gone through, and test/staging.mjs fails the
 * build if that refusal stops happening or if this file ever loses the flag.
 *
 * WHAT THIS DOES NOT PROTECT
 *   A staging tester who opens devtools and calls PostgREST by hand can still
 *   write a score - the anon key and the RLS policies are the production
 *   ones. That is accepted: the tester is Leo. This guards against the
 *   accident (a test run landing on the real board), not against its author.
 */
window.SKYHOOK_CONFIG = {
  /* Identical to js/config.js on purpose - see the block comment above. If a
     dedicated staging Supabase project is ever created, these two strings and
     nothing else are what change, and readOnlyScores below can then go false. */
  supabaseUrl: 'https://ievfcqnyrekdixxbsite.supabase.co',

  /* The "anon" / "public" key. Public by definition, shipped to every browser
     that loads the game, and powerless on its own - Row Level Security in
     supabase/schema.sql decides what it can do. test/online.mjs decodes it and
     fails the build unless the role claim is literally "anon", so a
     service_role key pasted here cannot ship. */
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlldmZjcW55cmVrZGl4eGJzaXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NzQ0MjYsImV4cCI6MjEwNTE1MDQyNn0.DPaeAv6WFnAQMomXQzlMWZulkM12jqicrymSInQygOM',

  boardLimit: 50,

  googleSignIn: false,

  /* THE staging flag. js/online.js reads it in normalise() and refuses every
     score submission while it is true, without queueing the run for later -
     a queued run is a run waiting for a session that can write, and no such
     moment may ever arrive for a score rolled here. */
  readOnlyScores: true
};

/* ---------------------------------------------------------------------------
 * The two things that keep staging from being mistaken for production.
 *
 * Both live here rather than in index.html because index.html must stay
 * byte-identical between the two builds: it is the file that declares the
 * canonical origin, and a staging-only edit to it is a staging-only edit to
 * the thing production's CI asserts. One overlaid file is the whole diff.
 * ------------------------------------------------------------------------ */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  /* 1. noindex. Belt to staging/robots.txt's braces, and the more reliable of
        the two: Disallow stops a crawler FETCHING the page, which also stops
        it reading this tag - but a URL that is linked from elsewhere can be
        indexed from the link alone despite being disallowed. The X-Robots-Tag
        header nginx sends (conf/site.conf.template, ROBOTS_TAG) is the third
        and strongest, because it needs no JavaScript to be seen. */
  try {
    var m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    (document.head || document.documentElement).appendChild(m);
  } catch (e) { /* a missing meta tag must not cost anybody a game */ }

  /* 2. The visible mark. Deliberately loud, deliberately at the very top, and
        deliberately pointer-events:none so it can never eat a tap - this game
        is played by tapping anywhere on the screen, and a banner that
        swallowed the first tap would make staging behave differently from
        production, which is the one thing a staging site must not do. */
  function banner() {
    try {
      if (document.getElementById('sk-staging-banner')) return;
      var el = document.createElement('div');
      el.id = 'sk-staging-banner';
      el.textContent = 'STAGING - scores are not saved';
      el.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'pointer-events:none',
        'padding:3px 8px',
        'background:#ff6a00', 'color:#12060a',
        'font:700 11px/1.4 "Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif',
        'letter-spacing:1.5px', 'text-align:center',
        'text-transform:uppercase',
        'box-shadow:0 1px 6px rgba(0,0,0,0.5)'
      ].join(';') + ';';
      (document.body || document.documentElement).appendChild(el);
    } catch (e) { /* ditto */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', banner);
  } else {
    banner();
  }
}());
