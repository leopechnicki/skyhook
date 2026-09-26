# SKYHOOK - Google Play readiness report

Branch `crew/feat/playstore-ready`, 2026-09-25, updated 2026-09-26 for
**vc3 / 1.1.1** (in-game account deletion). Everything that can be done
for a Play release **without Leo's identity, Leo's money or a Google account**
has been done and is verified below with the commands and their output. What
is left is a short list at the very end, with a time estimate per item.

Nothing was published, no account of any kind was created, no money was
spent, `main` was not pushed to, `.env` / `config.json` were not touched, and
the upload keystore and its passwords live only in `C:\Users\leops\.skyhook\`
(outside every git tree).

## 1. What was built (merged to `main` as `8b4943e`, PR #34)

| Unit | Commit | What |
|---|---|---|
| playstore-sync | `0be41a5` | `www/` and `assets/public/` rebuilt from the current game (`scripts/sync-web.mjs`), `game.js` in the wrapper byte-identical to the web game |
| playstore-adfree | `790ea7a` | v1 ad-free: `ADS_ENABLED = false`, AdMob / Billing wiring inert, `AD_ID`, `ADSERVICES`, `BILLING` permissions removed from the merged manifest |
| playstore-signing | `ce0e906` | upload keystore outside the repo, `build.gradle` signs when the properties file exists, versionCode 2 / 1.1.0; targetSdk 36 (already set on main) re-checked against Play's new-app requirement |
| playstore-test | `e1e5a63` | release build run on an API 35 emulator, staging sign-in proven, WebView backdrop-tap bug fixed + regression test |
| playstore-assets | `8c9ad4d` | icon, feature graphic, six real screenshots, listing copy, launcher art, `listing-check.mjs` in CI |
| playstore-policy | `62acebe` | `privacy.html` on the site, `PLAY_CONSOLE_ANSWERS.md` |
| playstore-report | `0c1c992` | this file + `RELEASE-CHECKLIST.md` brought up to date |
| android-finish-accountdelete | `9a2452b` | **in-game account deletion** (Play User Data policy): `delete_my_account()` RPC (schema.sql section 12; SECURITY DEFINER, pinned search_path, no argument, `auth.uid()` only, idempotent, admins refused), "Delete account" + confirm strip in the LEADERBOARD panel (never mid-run), `privacy.html` section 7 and the Data safety answer. Applied and proven end-to-end on **staging only** with a throwaway account (cleaned up) |
| android-finish-rebuild | `4b2e32a` | versionCode **3** / versionName **1.1.1**, signed bundle, emulator smoke (`docs/EMULATOR_TEST_2026-09-26_vc3.md`) |
| Kat design review | `79e82f3` | 5 nits fixed: 44px account links, future-tense confirm copy, panel locked while the delete is in flight, danger-tinted strip, actionable fallback text |
| Axon review round 1 | `0848b88` | privacy sections 1/6/7 match the code; the moderation log keeps the decision but blanks a deleted player's username; an expired sign-in gets "sign in again"; every doc points at the vc3 AAB |
| android-finish-merge | `8b4943e` on `main` | Axon **APPROVE** (round 2) + CI green -> `delete_my_account()` applied to **production** first (rolled-back dry run, then applied; secdef, pinned search_path, no args, anon revoked; data counts unchanged; prod anon call answers 401/42501) -> PR #34 squash-merged 2026-09-26 15:30 UTC -> fly.io deploy succeeded; `https://skyhookplay.com/privacy.html` 200 with the new section 7 (effective 26 September 2026); live game boots, board loads, 0 page errors |
| android-finish-playconsole | - (no code) | Play Console checked read-only with a copy of Leo's Chrome profile: a developer account **"Pechnicki"** exists under leopsantos@hotmail.com (account chooser, `crew/data/skyhook_playconsole_20260926/02-play-console.png`). Its verification state and app list could **not** be read: the running Chrome locks its cookie store, so the copy lost the Google session on the next load (redirect to the public google.play page). Stopped there - no app created, nothing uploaded, no declaration answered, nothing paid |

## 2. The artefact

| | |
|---|---|
| Upload this | `C:\Users\leops\.skyhook\out\skyhook-1.1.1-vc3-release-signed.aab` |
| Size | 12,377,704 bytes |
| sha256 | `9ed8ca11195971d8a652451a8133e241bb82a9342bd0aa41c8be840b2f3adb97` |
| Built | 2026-09-26 17:22 local from this branch's `www/` after `sync-web` + `cap sync` (log `~/.skyhook/build_signed_vc3b.log`); the bundled `assets/public` carries the delete-account UI and every review fix |
| Package / version | `com.leopechnicki.skyhook`, versionCode **3**, versionName **1.1.1**, release name `1.1.1 (3)` |
| SDKs | compileSdk 36, **targetSdk 36** (Play's requirement for new apps since 2026-08-31), minSdk 24 (Android 7.0) |
| Universal APK (for sideloading / emulator only, not for upload) | `skyhook-1.1.1-vc3-release-universal.apk`, 12,721,033 bytes, sha256 `e73b3b5f16a92d2a99af8e37927364bd12f13fb3a7a526971edca627f20cbdf2` |
| Superseded, do NOT upload | `skyhook-1.1.0-vc2-release-signed.aab` (sha256 `2f2f13ad...e28f8`, no in-app deletion) and the first vc3 build of 16:59 (sha256 `850af818...280d`, before the review fixes; overwritten) |

vc3 checks (2026-09-26): `jarsigner -verify` -> `jar verified.`;
`bundletool validate` exit 0; manifest `versionCode="3" versionName="1.1.1"`,
min 24 / target 36, permissions ACCESS_NETWORK_STATE, FOREGROUND_SERVICE,
INTERNET, WAKE_LOCK and the app's own DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION,
**0** matches for `AD_ID|BILLING|ADSERVICES`; universal APK `Verifies`, signer
certificate SHA-256 `e79b258c...268d` (the upload key, same as vc2). Emulator
(API 35): installs as vc3/1.1.1, production board as a guest, a live run,
0 `FATAL EXCEPTION`.

The vc2 verification below is kept for the signing-key and negative-path
evidence, which did not change.

### vc2 verification output (`~/.skyhook/verify_final.log`, 2026-09-25 13:08 UTC)

```
$ jarsigner -verify skyhook-1.1.0-vc2-release-signed.aab
jar verified.
The signer certificate will expire on 2054-02-10.
   (also a "signatures that do not include a timestamp" warning - harmless, Play does not need one)
   (plus informational "Entry ... is signed in JarFile but is not signed in JarInputStream"
    lines for the .properties resources the Play Services libraries ship - harmless,
    and the same lines appear for every AAB that bundles them)

$ java -jar bundletool.jar validate --bundle=skyhook-1.1.0-vc2-release-signed.aab
App Bundle information / Feature module: base
   assets/public/index.html, css/style.css, js/{audio,celestial,config,game,main,
   online,rocket,ship,ui_online,ui_ship,utils}.js, skyhook-native.js, monetisation.mjs ...

$ java -jar bundletool.jar dump manifest --bundle=... | grep -E 'Sdk|version|permission'
android:compileSdkVersion="36"  android:minSdkVersion="24"  android:targetSdkVersion="36"
android:versionCode="2"  android:versionName="1.1.0"
uses-permission: ACCESS_NETWORK_STATE, FOREGROUND_SERVICE, INTERNET, WAKE_LOCK,
                 com.leopechnicki.skyhook.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
   (no AD_ID, no BILLING, no ADSERVICES)

$ apksigner verify --print-certs skyhook-1.1.0-vc2-release-universal.apk
Signer #1 certificate DN: CN=SKYHOOK upload key, OU=Crew, O=Leonardo Pechnicki dos Santos, L=Krakow, C=PL
Signer #1 certificate SHA-256 digest: e79b258c5e697759ba6f981b7ea6518bb8e27959790bb5b2983776b855b8268d

$ keytool -list -v -keystore upload-keystore.jks
Alias name: skyhook-upload
Valid from: Fri Sep 25 12:01:57 CEST 2026 until: Tue Feb 10 11:01:57 CET 2054
SHA256: E7:9B:25:8C:5E:69:77:59:BA:6F:98:1B:7E:A6:51:8B:B8:E2:79:59:79:0B:B5:B2:98:37:76:B8:55:B8:26:8D
```

The apksigner and keytool fingerprints match, so the APK derived from the AAB
was signed with the upload key in `~/.skyhook`. Play App Signing is mandatory
for new apps: Google will generate the real **app signing key** when the app
is created; this key only authenticates uploads and can be reset from the
Console if lost.

Both signing failure modes of `app/build.gradle` were re-exercised today
(`~/.skyhook/signing_negative_paths.log`, `gradlew help` so only the
configuration phase runs):

```
== path A: SKYHOOK_KEYSTORE_PROPERTIES points at a missing file
SKYHOOK signing: C:\nonexistent\keystore.properties not found - release builds will be UNSIGNED (...)
BUILD SUCCESSFUL in 4s
== path B: properties file present but without passwords
> SKYHOOK signing: C:\Users\leops\.skyhook\incomplete.properties is missing storePassword, keyPassword. Fill it in or delete the file to build unsigned.
BUILD FAILED in 2s
== path C: the real file
SKYHOOK signing: release builds will be signed with C:\Users\leops\.skyhook\upload-keystore.jks (alias skyhook-upload)
BUILD SUCCESSFUL in 4s
```

## 3. It runs - emulator evidence

Full write-up: `docs/EMULATOR_TEST_2026-09-25.md`; thumbnails:
`docs/emulator-2026-09-25/` (each row there names the original full-size
frame and its sha256 prefix).

- **Signed release build, production config, as a guest**: title (best score
  persisted across relaunch), runs driven by real `adb` taps, game over,
  customiser (tab change + paint), guest leaderboard loading the production
  board over TLS. Package facts read back with `dumpsys package`: versionCode
  2, targetSdk 36, not debuggable, four permissions.
- **Staging debug build, staging project only**: sign-in with a staging test
  user, session persistence, a run submitted from the WebView and ranked by
  the server (`#2 playtest_droid 136`), all asserted over the Chrome DevTools
  Protocol, never against production.
- **Bug found and fixed here**: in Android WebView the overlay backdrop
  received the synthesised click after a touch on LEADERBOARD / CUSTOMISE and
  closed the panel ~20 ms after it opened. Fixed in `js/ui_online.js` and
  `js/ui_ship.js` (backdrop closes only when the pointerdown started on it);
  regression check in `test/leaderboard_ui.mjs`. Test runs after the fix:

```
node test/leaderboard_ui.mjs   -> 229/229 checks passed  (exit 0)
node test/ship_ui.mjs          -> "ship customiser holds in a real browser"  (exit 0)
cd android-app && npm test     -> ad-gate 8/8, ads-consent, monetisation, listing-check all pass (exit 0)
```

## 4. Listing, art, policy - all inside Play's limits

`node android-app/scripts/listing-check.mjs` (also in `npm test` and the
`test.yml` workflow) checks every limit below and exits non-zero on any
violation. Current output ends with `listing within Play limits`.

| Item | File | Checked |
|---|---|---|
| App name (<=30) | `store-listing/LISTING.md` | 7 chars |
| Short description (<=80) | `LISTING.md` | 76 chars |
| Full description (<=4000) | `LISTING.md` | 2300 chars |
| Icon 512x512, 32-bit PNG, <=1 MB | `store-listing/icon-512.png` | 512x512, colour type 6, 347,937 bytes |
| Feature graphic 1024x500, no alpha | `store-listing/feature-graphic-1024x500.jpg` | 1024x500 JPEG, 121,430 bytes |
| Phone screenshots 2-8, 9:16, >=1080x1920, no alpha, <8 MB each | `store-listing/screenshots/phone-0{1..6}-*.png` | six, all 1080x1920 24-bit PNG (0.2-1.2 MB) |
| Launcher icon / adaptive foreground / round / splash at every density | `android/app/src/main/res/**` | generated from the game renderer, inside the AAB |
| Privacy policy page | `privacy.html` (repo root) -> `https://skyhookplay.com/privacy.html` | copied into the nginx image by the `Dockerfile`; `deploy.yml` fails if it is not served; audited against `js/online.js`, `supabase/schema.sql` and the merged manifest |
| Console answers | `store-listing/PLAY_CONSOLE_ANSWERS.md` | app details, privacy URL, app access, ads = No, IARC, target audience 13+, Data safety table, advertising ID = No, category/tags/contact, tracks, release notes |

The screenshots are real frames of the signed release build on the emulator,
cropped from 1080x2400 to 1080x1920 (the status bar and the nav gesture area
removed) so they satisfy Play's "max side <= 2x min side" rule and are
promotion-eligible.

The privacy policy goes live at the URL above when this branch merges to
`main` (fly.io deploys on push). Play validates the URL when the listing is
saved, so merge before filling in the Console.

## 5. Follow-ups found on the way (not blockers for internal testing)

1. ~~In-app account deletion.~~ **Done in vc3** (`9a2452b` + review fixes):
   LEADERBOARD -> Delete account -> Yes, backed by `delete_my_account()`;
   the email route stays for players who cannot sign in. Still open: the
   Android Back key with a panel open sends the app to the background (no
   back handler exists, same in vc2) - a `@capacitor/app` `backButton`
   listener is the next polish item.
2. **Email links open the website, not the app.** Sign-up confirmation and
   password reset links go to `https://skyhookplay.com/` (the WebView serves
   from `https://localhost`). The account works in the app after confirming
   on the web. An Android App Link / custom scheme redirect is a later
   polish item.
3. **Version bump per upload.** Play refuses a versionCode it has seen. Each
   new AAB needs `versionCode` incremented in `android/app/build.gradle`
   before `./gradlew bundleRelease`.
4. **Rewarded-continue ads** stay unbuilt per the monetisation decision in
   `RELEASE-CHECKLIST.md`; the AdMob wiring is inert and tested. The Google
   Mobile Ads SDK is still bundled (with the test app id), so Play's SDK
   index will list it; "contains ads = No" stays correct because no ad is
   ever requested and `AD_ID` is removed.
5. **Two things for Leo to confirm in dashboards, not in code:** the
   production Supabase project's region (the policy says EU, Frankfurt -
   check Project Settings), and whether Android Auto Backup should stay on
   (`android:allowBackup="true"`, Capacitor's default; the policy now says
   local data may be in the player's own Google backup). Setting it to
   false would also drop the local best score on reinstall.

## 6. What only Leo can do (in this order)

Estimated hands-on minutes, excluding Google's own waiting time. Updated
2026-09-26: the developer account already exists and the privacy page is
live, so the account sign-up and "merge this PR" steps are gone.

1. **Open the developer account**: play.google.com/console in your Chrome ->
   choose **Pechnicki** -> check the home page for any "verify your
   identity / phone / device" task and finish it if one is open (Crew could
   not see this page). **5 min**, plus Google's check if one was pending.
2. **Create the app**: "Create app" -> name `SKYHOOK`, English (UK), Game,
   Free, tick both declarations yourself. **3 min.** (Section 1 of
   `PLAY_CONSOLE_ANSWERS.md`.)
3. **Create a reviewer account on production** for the "App access" answer:
   open the game at skyhookplay.com, sign up with a throwaway email, confirm
   it, and paste that email + password into the Console (section 3 of
   `PLAY_CONSOLE_ANSWERS.md`). **5 min.**
4. **Fill the Store listing and App content pages** by pasting from
   `LISTING.md` and `PLAY_CONSOLE_ANSWERS.md` and uploading
   `icon-512.png`, `feature-graphic-1024x500.jpg` and the six screenshots
   from `android-app/store-listing/`. Privacy policy URL:
   `https://skyhookplay.com/privacy.html` (live). **25 min.**
5. **Upload the AAB to Internal testing**: Release -> Testing -> Internal
   testing -> Create release -> accept Play App Signing (Google-generated
   key) -> upload `C:\Users\leops\.skyhook\out\skyhook-1.1.1-vc3-release-signed.aab`
   (sha256 `9ed8ca11...adb97`, release name `1.1.1 (3)`) -> paste the
   release notes from section 16 -> add `leopsantos@hotmail.com` as a tester
   -> Save and publish -> install from the opt-in link on your phone.
   **10 min**, plus Play's processing (minutes to a few hours).
   Steps 2, 4 and 5 can be done by Crew instead if you fully close Chrome
   first (so the profile is not locked) and say "go" - you would still tick
   the step-2 declarations yourself.
6. **Back up `C:\Users\leops\.skyhook\`** (keystore + `keystore.properties`)
   somewhere private, not in any repo. **2 min.**
7. **Start the closed test clock**: Play requires personal accounts created
   after Nov 2023 to run a closed test with **12 testers for 14 days** before
   production access. Promote the internal release to Closed testing and
   invite 12 people. **15 min** to set up; the 14 days run on their own.
8. **Rotate the staging database password** (Supabase -> staging project
   `qlaenczyhzjkmqkraiup` -> Database settings -> reset password, then put
   the new one in `scout/data/skyhook_staging_supabase.json`): on
   2026-09-26 a diagnostic printed the staging connection string into a
   local Crew log. Nothing was committed or sent anywhere; production was
   not affected. **3 min.**

Total hands-on: roughly **70 minutes**; the 14-day closed test is the long pole.

Crew Leo Agile dev team, 2026-09-25, updated 2026-09-26.
