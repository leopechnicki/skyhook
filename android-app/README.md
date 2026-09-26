# SKYHOOK - Android (Capacitor wrapper)

Wraps the SKYHOOK web game (in the parent folder, live at
https://skyhookplay.com/) as an Android app, adding:

- **v1 is AD-FREE** (Leo, 2026-09-22). `src/native/monetisation.mjs` has
  `ADS_ENABLED = false`, and while it does the bridge never constructs AdMob,
  the UMP consent flow or Play Billing. Pinned by
  `src/test/monetisation.test.mjs`; the ad permissions the SDKs would merge in
  are stripped in `android/app/src/main/AndroidManifest.xml`.
- Kept in the tree, inert, for later: an **AdMob interstitial** gate (every
  5th game-over, test IDs only) and a **"Remove ads"** one-time purchase - a
  real Google Play **non-consumable** with **restore-purchase** support. When
  ads are switched on the model is a once-per-run rewarded continue, so the
  gate has to be redesigned first - see RELEASE-CHECKLIST.md.

## Google Play status (2026-09-25)
Everything that needs no Google account is done: signed AAB, emulator test,
store art + copy, privacy policy, pre-filled Console answers. Read
`PLAYSTORE_READY_REPORT.md` (section 6 is the short list of what only Leo can
do) and `RELEASE-CHECKLIST.md`. Listing material lives in `store-listing/`.

## The web game is the single source of truth
`scripts/sync-web.mjs` copies the parent game's `index.html`, `css/`, `js/`
into `www/` and injects one `<script type="module" src="skyhook-native.js">`
tag into the **copied** index only. The web repo is never modified. `game.js`
in the APK is byte-identical to the source.

## How game-over is detected without editing the game
`main.js` exposes `window.__SKYHOOK.game`. The bridge
(`src/native/skyhook-native.js`) watches `game.state` on `requestAnimationFrame`
and fires once on each rising edge into `'over'`. Zero game-code changes.

## Layout
```
src/native/monetisation.mjs  ADS_ENABLED (false for v1) + the wiring it gates - unit tested
src/native/ad-gate.mjs   pure counter logic (every Nth game-over) - unit tested
src/native/ads.mjs       AdMob interstitial wrapper (TEST IDs only)
src/native/billing.mjs   CdvPurchase non-consumable + restore
src/native/skyhook-native.js  bridge that wires the three together
src/test/ad-gate.test.mjs     Node unit tests (no device needed)
src/test/ads-consent.test.mjs UMP consent gate tests
src/test/monetisation.test.mjs  proves the ad-free build never touches AdMob/Billing
scripts/sync-web.mjs     builds www/ from the untouched game + injects bridge
scripts/patch-manifest.mjs   inserts AdMob TEST app id into AndroidManifest
```

## Build (needs JDK 21 + Android SDK - see RELEASE-CHECKLIST.md section A)
```
npm install
npm test                       # ad-gate unit tests
node scripts/sync-web.mjs      # build www/ from the game
npx cap add android            # first time only (already done)
node scripts/patch-manifest.mjs
npx cap sync android
(cd android && ./gradlew assembleDebug)
# -> android/app/build/outputs/apk/debug/app-debug.apk  (ad-free; TEST ids only if ADS_ENABLED)
```

## Test / real IDs
Only Google's **public test IDs** are hardcoded (safe, no revenue, no account).
`RELEASE-CHECKLIST.md` lists every step blocked on a real account / money /
Leo's identity.
