# Turning the global leaderboard on

SKYHOOK ships with the leaderboard **off**, and that is not a placeholder state
- it is the normal one. With the leaderboard off the game is exactly what it has
always been: one page, no build, no network, high scores saved in the browser.
Nobody is asked to sign in, nothing is sent anywhere, and the game still works
when you double-click `index.html` from your desktop with the wifi unplugged.

Everything below is optional and takes about ten minutes. It is free - Supabase's
free tier covers this by a wide margin, and the game makes no request at all
until a player opens the leaderboard panel.

> **Note for whoever ships this:** the code was built and tested entirely against
> a mock server (`test/online.mjs`, `test/leaderboard_ui.mjs`). There are no
> Supabase credentials anywhere in this repo, and none in `.env`. The five steps
> below are the credential handoff: Leo creates the project, Leo pastes the two
> values. Nobody else ever holds them.

---

## Step 1 - Make the project

1. Go to <https://supabase.com> and sign in with GitHub.
2. Click **New project**.
3. Name it `skyhook`. Pick the region closest to you (`Central EU (Frankfurt)`
   for Krakow). Let it generate the database password and click **Save password**
   in your password manager - you will never need it for this, but losing it
   later is annoying.
4. Click **Create new project** and wait about two minutes for it to finish
   setting up.

## Step 2 - Create the tables

1. In the left sidebar click **SQL Editor**, then **New query**.
2. Open the file `supabase/schema.sql` from this repo, select all of it, copy it.
3. Paste it into the editor and click **Run** (bottom right).
4. You should see **Success. No rows returned**. That is the correct answer.

This one file creates both tables, the security rules, the rate limit, and the
public board. It is safe to run again later - running it twice changes nothing.

## Step 3 - Sign-in: providers, and where links come back to

1. Left sidebar: **Authentication** -> **Sign In / Providers**.
2. **Email** is already on. Leave it on. Turn **Confirm email** off here.
   That is not a shortcut, it is the setting the live project runs with
   (switched off 2026-09-17), and the reason is mechanical: without your own
   SMTP provider, Supabase's built-in mailer sends only a few messages an
   hour, so with confirmation on the SECOND player of the hour gets
   "email rate limit exceeded" instead of an account. With it off, sign-up
   answers with a session immediately and no email is ever sent. The game
   handles both settings, so flipping it back on later (say, after wiring a
   real SMTP provider under **Project Settings -> Authentication**) needs no
   code change.
3. Click **Google**, switch it **on**, and follow the "Set up Google OAuth"
   link Supabase shows you. It walks you through Google Cloud and gives you a
   **Client ID** and a **Client Secret** to paste back into that same panel.
4. Still in that Google panel, copy the **Callback URL** Supabase displays and
   paste it into Google's "Authorised redirect URIs". Save on both sides.

Steps 3 and 4 are Google's, and Google is optional: skipping them is fine --
email and password work on their own. If you do skip them, leave
`googleSignIn: false` in `js/config.js` (it is the default). Set it to `true`
only once Google really is switched on above.

The flag exists because the button cannot fail politely: `signInWithGoogle`
navigates the tab to Supabase, and a project with Google off answers
`400 {"msg":"Unsupported provider: provider is not enabled"}` as raw JSON --
the player is thrown out of the game onto a machine error. With the flag false
the button is simply not drawn, which is the same thing the game does with the
entire account layer when there is no config at all.

### Step 3.5 - URL Configuration (required, even if you skipped Google)

Left sidebar: **Authentication** -> **URL Configuration**. Set **Site URL** to
the address players actually open the game on, and add every address it is
served from under **Redirect URLs**.

**This one is not optional, and it is not only about Google.** It is also what
makes the "Forgot password?" link work: GoTrue sends a recovery link back only
to an allow-listed address, and for anything else it silently substitutes
**Site URL** rather than refusing. So the failure mode is not an error message
-- it is a player clicking a perfectly valid reset link and landing somewhere
that is not the game, which looks to them like the link is broken. On GitHub
Pages this bites hardest, because the site root is not `/skyhook/`.

The live project is set to:

| field | value |
|---|---|
| Site URL | `https://skyhookplay.com/` |
| Redirect URLs | `https://skyhookplay.com/**`, `https://www.skyhookplay.com/**`, `https://skyhook-game.fly.dev/**`, `https://leopechnicki.github.io/skyhook/**` |

Four entries because a player may have started from any of them, and
`redirect_to` is built from the page the game is actually on (see `js/online.js`
`redirectTarget()`). The `/**` suffix is GoTrue's wildcard: without it only the
exact address matches, and a link that arrives with its token in a query string
can fail to match.

**Do not remove the `leopechnicki.github.io` entry yet.** That origin is being
retired - GitHub Pages redirects to `skyhookplay.com` now rather than serving
the game - but a confirmation or reset mail sent from it *before* the cutover
carries `redirect_to=https://leopechnicki.github.io/skyhook/`, and GoTrue
refuses a `redirect_to` that is not on this list. Dropping the entry breaks
links that are already in somebody's inbox. It can go once mail that old has
expired.

## Step 4 - Copy the two values into the game

1. Left sidebar: **Project Settings** -> **API Keys**.
2. Copy **Project URL** (it looks like `https://abcdefgh.supabase.co`).
3. Copy the key labelled **anon** / **public**.
   **Do not copy `service_role`.** That one bypasses every security rule in
   step 2 and must never go into a web page. If you ever paste it here by
   accident, go back to that page and rotate it immediately.
4. Open `js/config.js` in this repo and fill in the two empty strings:

```js
window.SKYHOOK_CONFIG = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...the long anon key...',
  boardLimit: 50
};
```

`js/config.example.js` is a filled-in copy to compare against. Nothing loads it;
it is there to look at.

**Yes, this file is committed to the repo, and yes, that is correct.** GitHub
Pages serves the repository itself, so a config that is not committed does not
exist on the live site. The anon key is designed to be public - it identifies the
project, not a person, and every browser that loads the game downloads it. What
anybody can actually *do* with it is decided entirely by the security rules in
`supabase/schema.sql`, which is why that file goes in first.

## Step 5 - Push, and check it

1. Commit `js/config.js` and push to `main`. GitHub Pages redeploys in a minute
   or two.
2. Open <https://skyhookplay.com/>. A **LEADERBOARD** button is
   now on the title screen. (If it is not, the config did not take - see below.)
3. Tap it, create an account, play a run, and watch the game-over screen say
   `RANK #1 GLOBAL`.

---

## If something is wrong

**No LEADERBOARD button appears.** The game decided there is no backend, which
it does whenever either value in `js/config.js` is empty, the URL is not a real
URL, or the placeholder text from `config.example.js` is still there. It is also
deliberate when you open `index.html` straight off your disk - accounts need a
real web address, so from `file://` the button is hidden rather than broken. Put
it on a server (`npm start`) or on GitHub Pages.

**"Cannot reach the leaderboard."** The project URL is wrong, or the project is
paused. Free projects pause after a week with no traffic; open the Supabase
dashboard and click **Restore**. Either way the game keeps working and your run
is held on your device until it can be uploaded.

**"No account matches that email and password."** Two causes, in order of how
often they happen. Either the box was given the LEADERBOARD NAME instead of the
address - sign-in is by email, the username is only the public name on the board
- or the account was created with email confirmation left on and the link in the
email has not been clicked yet. If neither is it, the password is simply
forgotten: **Forgot password?** on the sign-in form mails a one-time link.

**A player forgot their password.** They do not need a second account, and
nobody needs to touch the dashboard. **Forgot password?** on the sign-in form
asks GoTrue for a recovery link (`POST /auth/v1/recover`); opening that link
returns them to the game with a SET A NEW PASSWORD form. Notes on it:

- The confirmation deliberately says *"if there is an account for that
  address"*. The form answers identically for an address with an account and
  one without, on purpose -- otherwise it is a way for anyone to ask the server
  who plays this game.
- There is a **55-second cooldown per address** (measured against the live
  project, 2026-09-18) plus the built-in mailer's hourly quota. Asking twice in
  a row is answered with the wait, not with a second mail.
- The link is one-time and expires. A spent or stale one comes back as
  "That reset link has expired or was already used. Ask for a new one."
- If the link lands anywhere other than the game, it is step 3.5 above -- not
  the mail.

**Google sign-in bounces back signed out.** Almost always the **Site URL** /
**Redirect URLs** in step 3.5, or a redirect URI in Google Cloud that does not
match the callback Supabase gave you, character for character.

**Somebody submitted an impossible score.** They did not - the database refuses
it. `supabase/schema.sql` caps what a run can contain, checks the score against
the hook count and the hook count against the clock, and allows no more than ten
submissions a minute and 500 a day per account. Scores can only ever be added,
never edited or deleted, by anyone using the public key.

**Somebody submitted a score that is possible, but a bot played it.** That is a
different problem, and the checks above cannot see it: a bot that really plays
the game submits a real run. See *Bot review* below.

## Bot review

Every run carries a small telemetry record from the game (inputs, how many were
synthetic, releases, and how far each release landed from the frame-perfect
one). A database trigger reads it and either puts the run on the board or holds
it for review. **A held run is never deleted and never refused** - it is saved,
it just does not appear on the public board until you clear it. The player is
told "saved - held for review, not on the board yet".

A run is held when:

| reason | meaning |
|---|---|
| `synthetic_input` | at least one input did not come from a real browser input event (a script's `dispatchEvent`, `__SKYHOOK.tap()`) |
| `superhuman_timing` | over 25+ releases, 90%+ of the near-optimal ones landed within 8 ms of frame-perfect. The public `test/bot.js` does this on every run; humans do not (`test/botdef.mjs`) |
| `telemetry_mismatch` | more hooks than releases, or more releases than inputs - not something the game can produce |
| `no_telemetry` | an older cached copy of the game, or a hand-made POST |
| `telemetry_malformed` | telemetry that did not come from the game |

**Turning it on (existing project):** re-run `supabase/schema.sql` in the SQL
Editor, exactly as in step 2. It is idempotent and migrates the table in place;
every run already on the board stays on it.

**Reviewing** - SQL Editor:

```sql
select * from public.scores_review_queue;                  -- held runs, newest first
update public.scores set flagged = false where id = 123;   -- put one back on the board
```

**What it cannot do.** The telemetry is produced by the player's browser, so a
bot author who reads the source can fake it. What faking it costs them is the
point: to pass the timing rule a bot must miss by human-sized margins, and in
this game timing *is* score (`test/botdef.mjs`: the same player drops from ~34k
to ~2k going from 8 ms to 30 ms of spread). It raises the bar from "copy
`test/bot.js`" to "write a bot that plays like a very good human" - it does not
make cheating impossible, and nothing client-side can.

## What players can see about each other

Only what is on the board: username, score, hooks, altitude, date. Email
addresses live in Supabase's own auth storage, which is not reachable from the
game at all, and no part of the schema copies one out. The leaderboard cannot
leak an address because it never has one to leak.
