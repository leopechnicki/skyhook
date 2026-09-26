# SKYHOOK - Google Play Console answers, pre-filled

Everything Play Console asks under **Grow > Store presence** and **Monitor and
manage > Policy and programs > App content**, answered from the code as it is
on this branch. Paste as-is. Where an answer is a judgement call it says so and
gives the reasoning, so Leo can overrule it knowingly rather than guess.

Sources for every claim: `js/online.js` (what the client sends),
`supabase/schema.sql` (what the server stores), `js/game.js` / `js/ship.js` /
`js/online.js` (what stays in local storage), the merged `AndroidManifest.xml`
inside the AAB (`bundletool dump manifest`), and
`android-app/src/native/monetisation.mjs` (`ADS_ENABLED = false`). The public
privacy policy that repeats all of this for players is `privacy.html` at the
repo root, served at <https://skyhookplay.com/privacy.html>.

---

## 1. App details (Create app)

| Field | Answer |
|---|---|
| App name | `SKYHOOK` |
| Default language | English (United Kingdom) - en-GB |
| App or game | **Game** |
| Free or paid | **Free** (cannot be changed to paid later; there is nothing to sell) |
| Package name (from the AAB, fixed) | `com.leopechnicki.skyhook` |
| Declarations | tick "Developer Program Policies" and "US export laws" |

Store listing copy, category, tags, contact details and the art files are in
`LISTING.md` in this folder (checked by `node scripts/listing-check.mjs`).

## 2. Privacy policy

| Field | Answer |
|---|---|
| Privacy policy URL | `https://skyhookplay.com/privacy.html` |

Live once this branch is merged: `Dockerfile` copies `privacy.html` into the
nginx image and `deploy.yml` fails the deploy if the page is not reachable.
The URL must be public and must not be a PDF or a Google Doc; a plain HTML page
on the game's own domain satisfies Play.

## 3. App access

The leaderboard is behind sign-in, and sign-up requires clicking a
confirmation email, so a reviewer cannot self-register in a few seconds.
Answer **"All or some functionality in my app is restricted"** and add ONE
instruction set:

| Field | Answer |
|---|---|
| Instruction name | `Leaderboard account (email + password)` |
| Username / email | *(Leo: create a throwaway account on the PRODUCTION project for reviewers, e.g. `playreview@...`, confirm its email, and paste it here)* |
| Password | *(the password of that account)* |
| Any other information | `Playing needs no account. The account only unlocks the optional global leaderboard: game over -> LEADERBOARD -> SIGN IN. Sign-up is free and open to anyone with an email address; the account above is provided so the review does not have to wait for a confirmation email.` |

Do NOT paste the staging test user here: staging is a different database
(project `qlaenczyhzjkmqkraiup`), the store build talks to production
(`ievfcqnyrekdixxbsite`), and that login would simply fail.

## 4. Ads

| Question | Answer |
|---|---|
| Does your app contain ads? | **No** |

Reasoning: `ADS_ENABLED = false` in `src/native/monetisation.mjs`; the bridge
never constructs the AdMob plugin, never requests consent, never requests an
ad. The `com.google.android.gms.permission.AD_ID` permission is stripped from
the merged manifest (`tools:node="remove"`), which is what Play checks against
this answer. If ads are ever switched on (the agreed future model is one
optional rewarded ad to continue a run), this answer, the Data safety form and
the privacy policy all change in the same release.

## 5. Content rating (IARC questionnaire)

| Field | Answer |
|---|---|
| Email address | `leopsantos@hotmail.com` |
| Category | **Game** |

Then answer every question **No**, except as noted:

| Question (paraphrased) | Answer | Why |
|---|---|---|
| Violence - any cartoon, fantasy or realistic violence? | No | A rocket swings between planets; "SIGNAL LOST" when you drift away. Nothing is attacked, hurt or destroyed. |
| Fear / horror | No | |
| Sexuality / nudity | No | |
| Language (profanity) | No | Usernames are 3-16 letters, digits and underscore; there is no chat and no free text anywhere. |
| Controlled substances (alcohol, tobacco, drugs) | No | |
| Gambling - simulated or real | No | |
| Crude humour | No | |
| Does the app allow users to interact or exchange content (chat, voice, sharing images or audio)? | **No** | No chat, no messaging, no media sharing. The only thing one player sees of another is a username and a score on the leaderboard. *(Judgement call: if the IARC form phrases it as "shares user-generated content", the username is user-typed text visible to everyone - answering Yes there is also defensible and would add a "Users Interact" descriptor. Recommended: No.)* |
| Does the app share the user's location with other users? | No | Location is never read. |
| Does the app allow users to purchase digital goods? | No | No in-app products; the Play Billing permission is removed from the manifest. |
| Does the app contain miscellaneous / promotional content, or references to gambling? | No | |
| Web / social features (opening a browser, sharing to social) | No | The only outbound link is the privacy policy page. |

Expected outcome: **PEGI 3 / ESRB Everyone / USK 0 / IARC 3+** with no
descriptors.

## 6. Target audience and content

| Question | Answer |
|---|---|
| Target age groups | tick **13-15**, **16-17**, **18 and over**. Do NOT tick any group under 13. |
| Does your app's store listing (icon, screenshots, description) appeal to children? | **No** |
| Is the app designed for children? | No (follows from the age groups) |

Reasoning: the game has nothing objectionable, but ticking an under-13 group
opts the app into the Families policy (teacher-approved review, Families ads
policy, extra data-safety rules, a "designed for families" declaration) with
no benefit for an arcade game whose only online feature asks for an email
address. The privacy policy says the same: general audience, not directed at
children under 13, parents can have a child's account deleted by email.

If Leo later wants a "Kids" listing, revisit this together with the privacy
policy section 5, and note `ads.mjs` `tagForChildDirectedTreatment: false`
would then have to flip (only matters once ads exist).

## 7. News app

| Question | Answer |
|---|---|
| Is your app a news app? | **No** |

## 8. COVID-19 contact tracing and status apps

| Question | Answer |
|---|---|
| Is this a COVID-19 contact tracing or status app? | **No** - "My app is not a publicly available COVID-19 contact tracing or status app" |

## 9. Data safety

### Overview questions

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** (only if the player creates the optional leaderboard account) |
| Is all of the user data collected by your app encrypted in transit? | **Yes** - every request goes to `https://ievfcqnyrekdixxbsite.supabase.co` over TLS; the WebView loads the game from the app's own assets and makes no plain-HTTP request. |
| Do you provide a way for users to request that their data is deleted? | **Yes** - in the app (LEADERBOARD -> Delete account, immediate) and by email via the deletion URL below |
| Does your app allow users to create an account? | **Yes** (email + password, optional) |
| Account deletion URL | `https://skyhookplay.com/privacy.html#delete-account` |
| Can users request deletion of some data without deleting the account? | **No** - a run cannot stay on the board without the account it belongs to; deletion is all-or-nothing. |

**In-app deletion (Play User Data policy): done.** Signed-in players delete
their own account from the game itself: LEADERBOARD -> "Delete account" ->
"Yes, delete my account". It calls the `delete_my_account()` RPC
(`supabase/schema.sql` section 12), which deletes the auth user and, by
cascade, the profile (username, ship colours), every run and any ban row,
immediately; `privacy.html` section 7 describes both routes. The deletion URL
above still matters: it is where a player who can no longer sign in (or who
uninstalled the app) asks by email, and it is the web resource the Console
form requires.

### Data types (tick exactly these; everything else stays unticked)

| Category | Data type | Collected? | Shared? | Ephemeral? | Required or optional | Purposes |
|---|---|---|---|---|---|---|
| Personal info | **Email address** | Yes | No | No | **Optional** (only if the player creates an account) | Account management |
| Personal info | **User IDs** (the public username and the account id Supabase Auth assigns) | Yes | No | No | Optional | App functionality, Account management |
| App activity | **Other user-generated content** (the username the player types, shown on the public leaderboard) | Yes | No | No | Optional | App functionality |
| App activity | **Other actions** (each finished run: score, hooks, altitude, duration; the count and timing of releases used for bot detection; the four ship colours) | Yes | No | No | Optional | App functionality, Fraud prevention, security and compliance |

Everything else - **Location, Financial info, Health and fitness, Messages,
Photos and videos, Audio, Files and docs, Calendar, Contacts, App info and
performance (crash logs, diagnostics), Web browsing, Device or other IDs** -
is **not collected**. No analytics or crash-reporting SDK is bundled; no
advertising ID is read (permission removed); no device identifier is sent.

Notes for the "shared" column: nothing is shared with third parties. Supabase
is the processor hosting the database on the developer's behalf, which Play
does not count as sharing. IP addresses appear in Supabase's transient
infrastructure logs like on any web server and are not used by the game;
Play treats that as ephemeral processing and it is not declared.

Notes for "required or optional": the game is fully playable with **no**
account and **no** network. Every data type above is only ever sent after the
player chooses to sign up or sign in, so every row is Optional.

### Data stored only on the device (not declared - never leaves the phone)

Best score, mute flag, tutorial-done flag, the four ship colours, the Supabase
session token while signed in, and a run parked for upload while offline.
Keys: `skyhook.best`, `skyhook.muted`, `skyhook.tutorialComplete`,
`skyhook.shipPaint`, `skyhook.session`, `skyhook.pendingRun`.

## 10. Government apps

| Question | Answer |
|---|---|
| Is your app developed by or on behalf of a government? | **No** |

## 11. Financial features

| Question | Answer |
|---|---|
| Does your app provide any financial features? | **No** - "My app doesn't provide any financial features" |

## 12. Health

| Question | Answer |
|---|---|
| Health features / health data | **No** - none of the listed categories apply |

## 13. Advertising ID

| Question | Answer |
|---|---|
| Does your app use advertising ID? | **No** |

Play verifies this against the manifest: the AAB's merged manifest has no
`com.google.android.gms.permission.AD_ID` (the AdMob dependency would have
merged it in; `AndroidManifest.xml` removes it). If the answer and the manifest
ever disagree, Play rejects the release - keep `monetisation.mjs`, the
manifest and this answer in step.

## 14. App category, tags and contact details

| Field | Answer |
|---|---|
| Category | Game > **Arcade** |
| Tags | Arcade, Casual, Single player, Offline, Physics |
| Email address (public, on the listing) | `leopsantos@hotmail.com` |
| Phone number | leave empty (optional) |
| Website | `https://skyhookplay.com` |
| External marketing | leave on (default) |

## 15. Testing tracks (what to do with the AAB)

1. **Internal testing** first: Release > Testing > Internal testing > Create
   release > upload `skyhook-1.1.1-vc3-release-signed.aab` (sha256
   `9ed8ca11195971d8a652451a8133e241bb82a9342bd0aa41c8be840b2f3adb97`; path
   in `android-app/PLAYSTORE_READY_REPORT.md` section 2). It is the first
   build with the in-game account deletion that section 9 declares - never
   upload the older vc2 file. Play App Signing: accept "Use Google-generated
   key" - Google creates the app signing key, the AAB was signed with the
   upload key only. Release name `1.1.1 (3)`.
2. Add tester emails (Leo's own Google account is enough for internal) and
   open the opt-in link on a phone.
3. Only afterwards, **Closed testing**: Play requires new personal developer
   accounts to run a closed test with at least **12 testers opted in for 14
   days** before applying for production access. That clock cannot start
   before this step, so start it as soon as the internal install works.
4. Production comes after Play grants production access.

## 16. Release notes (paste into "Release notes", en-GB)

    <en-GB>
    First Google Play release of SKYHOOK.
    - One-touch orbital arcade: orbit, release, hook the next planet, climb.
    - Ship customiser: paint the nose, window, body and fire.
    - Optional global leaderboard with a free account; play fully offline without one.
    - No ads, no purchases, no tracking.
    </en-GB>
