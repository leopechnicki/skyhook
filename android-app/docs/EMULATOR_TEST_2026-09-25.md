# Emulator test of the Play release build - 2026-09-25

What was run, on what, and what it proved. Thumbnails of every frame referred
to below are in `emulator-2026-09-25/` (360x800 JPEGs, cut from the raw
1080x2400 `adb screencap` frames; the full-size originals are kept outside
the repo under `C:\Users\leops\.skyhook\shots\`, sha256 prefixes in the
tables so a thumbnail can be matched to its original).

## The device

| | |
|---|---|
| AVD | `skyhook_api35` (created for this run with `avdmanager`, lives in `~/.android/avd/`) |
| Profile | Pixel 6 - 1080x2400, 420 dpi (Android's `sdk_gphone64_x86_64`) |
| System image | `system-images;android-35;google_apis;x86_64` (Android 15, API 35, Google APIs, no Play Store) |
| Emulator | the SDK's `emulator/` package, Windows Hypervisor Platform ("Windows Hypervisor Platform accelerator is operational" in the emulator log) |
| Boot | 72 s to `Boot completed` (`emu_boot.png`, frame `00`) |
| WebView | Google WebView 124.0.6367.219 (what the image ships; a phone with a current WebView is only newer) |

Why an emulator and not a phone: no Android device is attached to this
machine. The SDK already had `platforms;android-36` and the build-tools; the
API 35 system image and the emulator package were the only additions and
both are free.

## Two builds were installed, in this order

1. **Staging DEBUG APK** - `assembleDebug` with `staging/config.staging.js`
   copied over `js/config.js` in `www/` and `assets/public/` (exactly what
   the Dockerfile's staging overlay does for the website), so it talks to the
   **staging** Supabase project `qlaenczyhzjkmqkraiup` and shows the orange
   STAGING banner. This build is debuggable, which is what made the WebView
   inspectable over Chrome DevTools Protocol (`adb forward tcp:9333
   localabstract:webview_devtools_remote_<pid>`) - every state assertion in
   the sign-in steps below was read from `window.__SKYHOOK.game` and the DOM,
   not guessed from pixels. After the test `www/` and `assets/public/` were
   re-synced from the production config and `git status` confirmed no
   staging bytes remained.
2. **Signed release, universal APK** - `bundletool build-apks
   --mode=universal` from the signed AAB (`skyhook-1.1.0-vc2-release-signed.aab`,
   sha256 `2f2f13ad...`), installed with `adb install` after `adb uninstall`
   of the debug build (different signing certificate, so an in-place update
   is refused). Production config, no banner, not debuggable. Signed in
   **nowhere**: the production project was only ever read (the public
   leaderboard, as any guest player reads it) and never written.

`adb shell dumpsys package com.leopechnicki.skyhook` after step 2:
`versionCode=2 minSdk=24 targetSdk=36 versionName=1.1.0`, `pkgFlags=[ HAS_CODE
ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]` (no `DEBUGGABLE`), requested
permissions `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`,
`FOREGROUND_SERVICE` only - no `AD_ID`, no `BILLING`.

## What was exercised

### On the signed release build (production config, guest)

| Frame | sha256 prefix (original file under `shots/`) | What it shows |
|---|---|---|
| `01-release-title` | `f1c31d3b8c607f80` (`release/rel_13_title_best.png`) | Title screen with the generated launcher art in the tether demo, BEST 67 persisted in local storage across a force-stop + relaunch. |
| `02-release-run` | `0483ae65512f1cbf` (`burst_1.3/f04.png`) | Mid-run: score 67, combo x3, target ring and launch line drawn. Input is real `adb shell input tap` on the canvas. |
| `03-release-game-over` | `4a8478eac73a81b8` (`burst_1.3/f34.png`) | SIGNAL LOST screen: score 29, 1 hook, 24 m, BEST 67, TAP TO RETRY / LEADERBOARD / CUSTOMISE SHIP. |
| `04-release-customiser` | `f4cac925e4ceb1a4` (`release/rel_06_customiser_fire.png`) | Customiser opened from the game-over screen, FIRE tab selected by tap, Nebula chosen ("Fire: Nebula."), DONE closes it. Locked `#1` gold swatch shown locked for a guest. |
| `05-release-leaderboard-guest` | `0fe77c27b179c29d` (`release/rel_11_leaderboard_signedout.png`) | LEADERBOARD from game over as a guest: the production board loads over TLS (top 7 shown), "Playing as a guest - sign in to appear on the board", SIGN IN / CREATE ACCOUNT button. Closed with the Android back gesture, game-over screen intact. |

Runs were driven blind (fixed-cadence taps, the release WebView cannot be
inspected), which is why scores are modest; 67 at combo x3 is the best of
~200 taps. Every run ended the way the game ends runs ("YOU LEFT THE COLUMN"
/ "YOU FELL OUT OF THE SKY") and every retry started a new one. No crash, no
ANR, no blank frame after the first 4 s of WebView start-up in ~15 minutes of
input.

### On the staging debug build (staging config, signed in)

| Frame | sha256 prefix (original file under `shots/`) | What it shows |
|---|---|---|
| `10-staging-title` | `7be9d6850c4b6f6e` (`staging_11_title_newicon.png`) | Title with the STAGING banner and the new icon in the demo; BEST 136. |
| `11-staging-customiser` | `74f44583d8dade9f` (`staging_03_customiser.png`) | Customiser from the title screen, BODY tab. |
| `12-staging-run` | `0a0a8e3ca1d9121d` (`staging_06_run_mid.png`) | Mid-run with the yellow RELEASE cue and the launch line. |
| `13-staging-game-over` | `36c2d0174f7c5009` (`staging_09_gameover.png`) | Game over, guest. |
| `14-staging-auth-form` | `09a83eaecd2a43d0` (`staging_13_auth_form.png`) | LEADERBOARD -> SIGN IN opens the email + password form inside the WebView. |
| `15-staging-auth-filled` | frame withheld from the repo (it showed the test account's email; original `staging_14_auth_filled.png`, `26087e8c5456c965`) | Fields filled with the staging test user (`playtest_droid`, created on staging for this run; the credentials live in `~/.skyhook/staging_test_user.txt`, outside the repo). |
| `16-staging-signed-in` | `71d249dcd0043965` (`staging_15_signed_in.png`) | Submit -> "Signed in as playtest_droid", Change username / Change password links, SIGN OUT. `game.online.signedIn === true` read over CDP. |
| `17-staging-signed-run` | `39505676cc9271d3` (`staging_16_signed_run.png`) | A run while signed in. |
| `18-staging-board-signed-in` | `91af0154ae3527f7` (`staging_18_board_signed.png`) | After that run the board shows `#2 playtest_droid 136` under `#1 leo 1800`, "Your best: #2 with 136" - the run was submitted from the WebView and ranked by the server. |

Supabase auth inside the WebView therefore works end to end with the
password flow: sign-up (done earlier the same day for this user), sign-in,
session persistence, score submit, `my_rank`. No redirect is involved in
that flow. The one flow that does redirect - the confirmation / password
reset **email link** - lands on `https://skyhookplay.com/` in the phone's
browser, not in the app, because the WebView serves the game from
`https://localhost/` (Capacitor's scheme) and `redirect_to` is the public
site; the session is then established there. Deep-linking that back into the
app is a follow-up, not a v1 blocker: the account can be confirmed on the web
and then used in the app, which is what the test user did.

`file://` / origin assumptions: none broke. Capacitor serves the assets from
`https://localhost`, so `localStorage`, `fetch` to Supabase and the Auth
session all behave as on the website; the sync script does not rewrite a
single URL.

## Bug found on the emulator, fixed on this branch

On the game-over screen, tapping **LEADERBOARD** opened the board and then
closed it ~20 ms later, so on a phone the board could not be opened by touch
at all. Cause: Chromium's Android WebView targets the click it synthesises
after a touch at whatever is under the finger *when the click fires*, which
by then is the overlay's backdrop; the backdrop handler took that as "tap
outside" and closed the panel. Playwright's mouse keeps the pointerdown
target, so no browser test had ever seen it.

Fix (`js/ui_online.js`, same guard in `js/ui_ship.js` for the customiser):
the backdrop only closes on a click whose **pointerdown** also landed on the
backdrop. Regression test added to `test/leaderboard_ui.mjs` (synthesises the
exact event order, checks the panel stays, then checks a real backdrop tap
still closes it). `node test/leaderboard_ui.mjs`: **229/229 checks passed**
after the fix. The staging debug APK and the signed AAB were both rebuilt
after the fix (`assets/public/js/ui_online.js` inside the AAB is
sha256-identical to `js/ui_online.js`, `68bc8c8a...`), and frames `05` and
`18` above are the board staying open on touch.

## Repeating this

```
# emulator (once)
sdkmanager "system-images;android-35;google_apis;x86_64" "emulator"
avdmanager create avd -n skyhook_api35 -k "system-images;android-35;google_apis;x86_64" -d pixel_6
emulator -avd skyhook_api35 -no-snapshot -no-boot-anim &
adb wait-for-device

# release build, as Play would install it
java -jar bundletool.jar build-apks --bundle=app-release.aab --output=skyhook.apks --mode=universal \
     --ks=%USERPROFILE%\.skyhook\upload-keystore.jks --ks-key-alias=skyhook-upload
unzip -p skyhook.apks universal.apk > skyhook-universal.apk
adb uninstall com.leopechnicki.skyhook
adb install skyhook-universal.apk
adb shell monkey -p com.leopechnicki.skyhook -c android.intent.category.LAUNCHER 1
adb exec-out screencap -p > frame.png
```
