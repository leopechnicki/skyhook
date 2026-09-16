/* SKYHOOK - online configuration.
 *
 * FILLED IN. The global leaderboard is live against the project named below.
 * The game itself did not change: it is still one page, no build, no
 * dependency, and it is still completely playable with no account and with
 * this backend dead or unreachable. High scores still land in localStorage
 * first. The network is an addition, never a requirement - js/online.js has to
 * keep that true and test/leaderboard_ui.mjs has a dead-backend case that
 * fails the build if it stops being true.
 *
 * Blanking the two strings below is the off switch, and it must keep working:
 * with them empty js/online.js makes not a single request and no account UI is
 * drawn. That path is pinned by tests, not by this file happening to be empty.
 *
 * Setup for a fresh project: docs/LEADERBOARD_SETUP.md.
 *
 * Is it safe to commit the anon key?
 *   Yes - that is what "anon, public" means in the Supabase dashboard. It is
 *   shipped to every browser that loads the page and identifies the PROJECT,
 *   not a person. What it can actually do is decided entirely by Row Level
 *   Security in supabase/schema.sql, which is why that file exists and why it
 *   must be run before this one is filled in.
 *   The SERVICE ROLE key is the opposite: it bypasses RLS. It must NEVER
 *   appear in this file, in this repo, or anywhere a browser can reach. Both
 *   keys are JWTs and look alike, so test/online.mjs decodes whatever is here
 *   and fails the build unless its role claim is literally "anon".
 */
window.SKYHOOK_CONFIG = {
  /* https://<project-ref>.supabase.co  - no trailing slash */
  supabaseUrl: 'https://ievfcqnyrekdixxbsite.supabase.co',

  /* The "anon" / "public" API key from Project Settings -> API Keys. */
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlldmZjcW55cmVrZGl4eGJzaXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NzQ0MjYsImV4cCI6MjEwNTE1MDQyNn0.DPaeAv6WFnAQMomXQzlMWZulkM12jqicrymSInQygOM',

  /* Rows shown in the board panel. */
  boardLimit: 50,

  /* Show "Continue with Google"? Only set this true if Google is actually
     switched on as a provider in Authentication -> Sign In / Providers
     (docs/LEADERBOARD_SETUP.md step 3). It is not on this project, and a
     button pointing at a disabled provider does not fail politely - it
     navigates the player out of the game onto a raw GoTrue JSON error. Email
     and password work either way. */
  googleSignIn: false
};
