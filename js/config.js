/* SKYHOOK - online configuration.
 *
 * EMPTY ON PURPOSE. With the fields below blank the game is exactly the game
 * it has always been: one file, no build, no network, high scores in
 * localStorage. Nothing in js/online.js will make a single request, and no
 * account UI is drawn. That is the DEFAULT and it must stay playable forever.
 *
 * Filling these in switches the global leaderboard on. See
 * docs/LEADERBOARD_SETUP.md for the five things to click in Supabase.
 *
 * Is it safe to commit the anon key?
 *   Yes - that is what "anon, public" means in the Supabase dashboard. It is
 *   shipped to every browser that loads the page and identifies the PROJECT,
 *   not a person. What it can actually do is decided entirely by Row Level
 *   Security in supabase/schema.sql, which is why that file exists and why it
 *   must be run before this one is filled in.
 *   The SERVICE ROLE key is the opposite: it bypasses RLS. It must NEVER
 *   appear in this file, in this repo, or anywhere a browser can reach.
 */
window.SKYHOOK_CONFIG = {
  /* https://<project-ref>.supabase.co  - no trailing slash */
  supabaseUrl: '',

  /* The "anon" / "public" API key from Project Settings -> API Keys. */
  supabaseAnonKey: '',

  /* Rows shown in the board panel. */
  boardLimit: 50
};
