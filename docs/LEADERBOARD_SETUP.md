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

## Step 3 - Turn on Google sign-in

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
5. Left sidebar: **Authentication** -> **URL Configuration**. Set **Site URL**
   to `https://leopechnicki.github.io/skyhook/` and add the same address under
   **Redirect URLs**. Without this, Google sends players back to the wrong page
   after they sign in.

Skipping this whole step is fine -- email and password work on their own -- but
if you skip it, leave `googleSignIn: false` in `js/config.js` (it is the
default). Set it to `true` only once Google really is switched on above.

The flag exists because the button cannot fail politely: `signInWithGoogle`
navigates the tab to Supabase, and a project with Google off answers
`400 {"msg":"Unsupported provider: provider is not enabled"}` as raw JSON --
the player is thrown out of the game onto a machine error. With the flag false
the button is simply not drawn, which is the same thing the game does with the
entire account layer when there is no config at all.

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
2. Open <https://leopechnicki.github.io/skyhook/>. A **LEADERBOARD** button is
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
email has not been clicked yet.

**Google sign-in bounces back signed out.** Almost always the **Site URL** /
**Redirect URLs** in step 3.5, or a redirect URI in Google Cloud that does not
match the callback Supabase gave you, character for character.

**Somebody submitted an impossible score.** They did not - the database refuses
it. `supabase/schema.sql` caps what a run can contain, checks the score against
the hook count and the hook count against the clock, and allows no more than ten
submissions a minute per account. Scores can only ever be added, never edited or
deleted, by anyone using the public key.

## What players can see about each other

Only what is on the board: username, score, hooks, altitude, date. Email
addresses live in Supabase's own auth storage, which is not reachable from the
game at all, and no part of the schema copies one out. The leaderboard cannot
leak an address because it never has one to leak.
