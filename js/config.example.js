/* SKYHOOK - online configuration, filled-in example.
 *
 * This file is documentation, not code: nothing loads it. Copy the two values
 * into js/config.js (which IS loaded, and IS committed - GitHub Pages serves
 * the repo, so a config that is not committed does not exist on the live site).
 *
 * Where the values come from: Supabase dashboard -> your project ->
 * Project Settings -> API Keys.
 *   supabaseUrl      = "Project URL"
 *   supabaseAnonKey  = the key labelled "anon" / "public" - NEVER "service_role"
 *
 * Full walkthrough: docs/LEADERBOARD_SETUP.md
 */
window.SKYHOOK_CONFIG = {
  supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.PLACEHOLDER.PLACEHOLDER',
  boardLimit: 50,

  /* true ONLY if Google is enabled as a provider in the Supabase dashboard.
     Left false, the "Continue with Google" button is not drawn at all. */
  googleSignIn: false
};
