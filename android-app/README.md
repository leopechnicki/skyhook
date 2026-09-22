# SKYHOOK - Android (Capacitor wrapper)

Wraps the SKYHOOK web game (in the parent folder, live at
https://leopechnicki.github.io/skyhook/) as an Android app, adding:

- **AdMob interstitial** shown after every **5th** game-over (test IDs only).
- **"Remove ads"** one-time purchase - a real Google Play **non-consumable**
  with **restore-purchase** support (survives reinstall).
- When the ad-free entitlement is owned, all interstitials are skipped.

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
src/native/ad-gate.mjs   pure counter logic (every Nth game-over) - unit tested
src/native/ads.mjs       AdMob interstitial wrapper (TEST IDs only)
src/native/billing.mjs   CdvPurchase non-consumable + restore
src/native/skyhook-native.js  bridge that wires the three together
src/test/ad-gate.test.mjs     Node unit tests (no device needed)
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
# -> android/app/build/outputs/apk/debug/app-debug.apk  (shows TEST ads)
```

## Test / real IDs
Only Google's **public test IDs** are hardcoded (safe, no revenue, no account).
`RELEASE-CHECKLIST.md` lists every step blocked on a real account / money /
Leo's identity.
