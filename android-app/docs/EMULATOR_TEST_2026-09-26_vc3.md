# Emulator smoke test - vc3 / 1.1.1 (2026-09-26)

Same rig as `EMULATOR_TEST_2026-09-25.md` (AVD `skyhook_api35`, API 35
google_apis x86_64, WHPX). Booted in ~15 s. Screenshots are kept outside the
repo in `~/.skyhook/shots/vc3/` (sha256 prefixes below).

| Build | sha256 |
|---|---|
| `skyhook-1.1.1-vc3-release-signed.aab` (the Play upload) | `850af81841c7060cb779c77b70e5b9c7b5dc2ee5460ea0dfdec33f0f98ed280d` |
| `skyhook-1.1.1-vc3-release-universal.apk` (bundletool `--mode=universal` from that AAB, same upload key) | `3dde6117824bd7eedda2973d13d6bcb6254e304c7566e94f15e203e0921e33d6` |

Build checks (`~/.skyhook/build_signed_vc3.log`): gradle `bundleRelease`
BUILD SUCCESSFUL, signed with the upload key (cert SHA-256 `e79b258c...268d`,
same as vc2); `jarsigner -verify` -> `jar verified.`; `bundletool validate`
exit 0; manifest `versionCode="3" versionName="1.1.1"`, min 24 / target 36,
permissions INTERNET, ACCESS_NETWORK_STATE, WAKE_LOCK, FOREGROUND_SERVICE and
the app's own DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION - **0** matches for
`AD_ID|BILLING|ADSERVICES`; the bundled `assets/public/index.html` carries
`ol-delete-account`.

| Frame | sha256 prefix | What it shows |
|---|---|---|
| `01-launch` | `60b128aea3d89651` | Fresh install (`adb uninstall` + `adb install`), `dumpsys` versionCode=3 versionName=1.1.1; title screen drawn. |
| `02-board` | `623ef9f85d643959` | LEADERBOARD as a guest: production board over TLS, top 7, SIGN IN / CREATE ACCOUNT. No "Delete account" for a guest (correct). |
| `03-run`, `04-back` | `4fc2ec216c0c1aa5`, `a8630987f2939698` | Android Back with the panel open: app goes to the launcher (see follow-up below). |
| `05-resume` | `00fe52e00035e881` | Relaunched from the launcher after Back: same process (pid unchanged), state kept. |
| `06-run` | `c5497c6099ee0ad3` | A real run from `adb shell input tap`: score 30, combo x2, hook line drawn. |

`logcat`: 0 `FATAL EXCEPTION`, process alive for the whole session.

## Follow-up (not a regression, not a Play blocker)

The Android Back key with the leaderboard open sends the app to the
background instead of closing the panel. Nothing in the game or the native
bridge handles Back (no `@capacitor/app` listener, no `popstate`), so the
WebView falls through to Android's default; vc2 had the same code. The app
resumes intact. Proper fix: `@capacitor/app` `backButton` listener that
closes the top overlay / pauses a run and only exits from the title screen.
