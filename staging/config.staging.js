/* SKYHOOK - online configuration, STAGING BUILD.
 *
 * This file is not loaded by anything in the repo. The Dockerfile copies it
 * OVER js/config.js, and only when built with --build-arg SKYHOOK_ENV=staging
 * (see the stage-one overlay). A normal build never sees it, so nothing here
 * can reach skyhookplay.com by accident: there is no flag to get wrong at
 * runtime, only a build that either applied the overlay or did not.
 *
 * STAGING HAS ITS OWN SUPABASE PROJECT
 * ------------------------------------
 * It did not always. Until 2026-09-23 this file pointed at the SAME project as
 * production and bought its safety with a flag: `readOnlyScores: true`, which
 * js/online.js honours by refusing to submit. That bought exactly one thing -
 * a staging run could not land on the real leaderboard - and it left a hole
 * the flag could not cover, because a score is not the only write the game
 * makes. Signing up created a real production account. Changing a username
 * renamed a real production profile. The account-settings work is precisely a
 * feature whose writes are NOT scores, so testing it against the shared
 * project meant editing production rows to find out whether the editor worked.
 *
 * Leo created a second project (Central EU / Frankfurt, free tier) and
 * supabase/schema.sql was applied to it whole, so staging now has its own
 * tables, its own RLS policies, its own triggers and its own leaderboard view.
 * The two stacks are the same schema from the same file; they are not the same
 * data.
 *
 * CONSEQUENCE, AND IT IS THE POINT RATHER THAN A BUG
 *   Staging's database starts EMPTY. No accounts, no scores, no leaderboard.
 *   Leo's production account does not exist here and signing in with it will
 *   fail; testing staging means signing up on staging. Scores rolled here are
 *   real and they are saved - to staging's board, which nobody else sees.
 *
 * WHY readOnlyScores IS NOW false
 *   The flag existed to stop writes reaching PRODUCTION's board. Staging owns
 *   its board now, so refusing to write would only mean the leaderboard - the
 *   feature this site exists to test - could never be exercised end to end.
 *   The guard is not deleted, though: js/online.js still honours the flag, and
 *   test/staging.mjs still proves it works, against a forced-on fixture. It is
 *   kept loaded so that repointing this file at production without also
 *   turning it back on is a red build rather than a quiet accident.
 *
 * WHAT THIS DOES NOT PROTECT
 *   Nothing here is a secret. The anon key below is public by definition, and
 *   RLS in supabase/schema.sql is what actually decides what it may do. The
 *   separation is between two DATABASES, not between a trusted and an
 *   untrusted client.
 */
window.SKYHOOK_CONFIG = {
  /* The STAGING project - deliberately NOT the one in js/config.js. The
     invariant test/staging.mjs pins is exactly this: staging may write freely
     as long as it is a different project from production, and must be
     read-only if it is ever pointed back at the same one. */
  supabaseUrl: 'https://qlaenczyhzjkmqkraiup.supabase.co',

  /* The "anon" / "public" key. Public by definition, shipped to every browser
     that loads the game, and powerless on its own - Row Level Security in
     supabase/schema.sql decides what it can do. test/staging.mjs decodes it
     and fails the build unless the role claim is literally "anon", so a
     service_role key pasted here cannot ship. It also fails the build if the
     `ref` claim is production's, which is the mistake that would matter: a
     staging URL with a production key is a production client wearing a
     staging banner. */
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsYWVuY3p5aHpqa21xa3JhaXVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMTI2MzEsImV4cCI6MjEwNTY4ODYzMX0.L_DGdRS9H5ru49J4Jda5XFsAw1GljB3sAn5Q1qfC75I',

  boardLimit: 50,

  googleSignIn: false,

  /* false, and that is the whole change. See the block comment above: the flag
     guarded production's leaderboard, staging no longer shares it, and a
     staging site that cannot save a score cannot test saving a score.
     js/online.js still reads and honours this flag - it is off, not gone. */
  readOnlyScores: false
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
      el.textContent = 'STAGING - separate database, your production account does not exist here';
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
