# SKYHOOK Android - Release Checklist

This Capacitor wrapper ships **ad-free** (see the monetisation decision
below). As of 2026-09-25 every account-free item is DONE and verified: the
signed AAB, the emulator test, the store listing art and copy, the privacy
policy page and the pre-filled Console answers. What remains needs a real
Google account, money or Leo's identity, and is listed with time estimates in
**`PLAYSTORE_READY_REPORT.md` section 6** - read that first.

Legend: [x] = DONE (evidence linked)   [ ] = TODO (blocked on account/identity/money)

---

## Monetisation decision - v1 SHIPS AD-FREE (Leo, 2026-09-22)

**Read this before touching anything in section C or D.**

- **v1 ships with NO ads at all.** Not "ads configured but disabled" as a
  launch story - the shipped v1 build shows a player zero ads.
- **Ads are "in future yes", and the future model is ONE REWARDED ad to
  CONTINUE A RUN, once per run.** The player dies, is offered a single
  opt-in "watch an ad to keep going", and that offer is available at most
  once per run.
- **That is NOT what is currently wired.** The code today implements an
  *interstitial* shown every 5th game-over (`src/native/ad-gate.mjs`), which
  is an interruption the player never asked for. It is the wrong model and
  must not be what ships when ads are eventually switched on.

What this means for whoever picks this up next:

- [ ] **Do NOT rip out the AdMob wiring.** It stays in the tree, tested and
      inert. Deleting it just means rebuilding it later.
- [ ] **Do NOT build the rewarded-continue flow yet.** It is not v1 scope.
      Leo has decided the model, not scheduled the work.
- [ ] For the v1 release, ensure no ad is requested or shown. The consent
      (UMP) path in section H may stay wired - it is harmless when no ad is
      requested - but nothing should call `showInterstitial`.
- [ ] When ads DO get switched on: create a **Rewarded** ad unit, not just an
      Interstitial one (section C currently only names an Interstitial), and
      replace the every-5th-game-over cadence with a once-per-run opt-in
      offer. The cadence gate in `ad-gate.mjs` is the piece to redesign.

Sections C (AdMob) and D (Play Billing "remove ads") are therefore **not
blockers for v1**. A "remove ads" purchase has nothing to remove in an
ad-free build; revisit D together with the rewarded model.

## A. Toolchain - DONE (verified 2026-09-22, this machine)

This section used to say the build was blocked on missing tooling. That is no
longer true and the whole section is now satisfied:

- [x] **JDK 21** present - Temurin `21.0.12.1+1-LTS`,
      `JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`.
- [x] **Android SDK** present - `ANDROID_HOME=C:\Users\leops\Android\Sdk`,
      `platforms/android-36`, `build-tools/35.0.0` + `36.0.0`, licences already
      accepted in `licenses/`. No new licence had to be accepted.
- [x] Build proven end to end, no code changes:
  ```
  node scripts/sync-web.mjs
  npx cap sync android
  (cd android && ./gradlew assembleDebug)
  ```
  Produced `android/app/build/outputs/apk/debug/app-debug.apk`,
  **10,102,480 bytes (9.7 MB)**, BUILD SUCCESSFUL in 39s.
- [x] `./gradlew bundleRelease` also succeeds and produces an **UNSIGNED**
      `android/app/build/outputs/bundle/release/app-release.aab`,
      **7,696,797 bytes (7.3 MB)**. Unsigned because `app/build.gradle` has no
      `signingConfigs` - that is deliberate, see section E. The AAB is good for
      inspection only; Play will reject an unsigned upload.

> **Regression found and fixed the same day:** `www/` and
> `android/app/src/main/assets/public/` had never been re-synced after the
> input-latency fix (PR #21, merged `37742eb`). Both copies contained **zero**
> occurrences of `LOCK_SNAP`/`ACT_DEBOUNCE`, i.e. an APK built before
> 2026-09-22 would have shipped the laggy pre-#21 game that Leo's friend
> reported. **`sync-web.mjs` is not automatic - it reads the working tree.**
> Always run it from a clean checkout of `main` and verify:
> ```
> sha256sum ../js/game.js www/js/game.js android/app/src/main/assets/public/js/game.js
> ```
> All three must match. They do as of 2026-09-22 (`3990d524...`).

## B. Google Play Console  ($25, real identity)

- [ ] Create a **Google Play Developer account** - one-time **$25 USD** fee.
      Requires Leo's legal name, address, and (for individual accounts opened
      after 2023) ID verification + a **D-U-N-S number for orgs**.
- [ ] Create the app "SKYHOOK", set package name `com.leopechnicki.skyhook`.
- [ ] Complete: privacy policy URL, data-safety form, content rating, target
      audience, ads declaration (**"contains ads" = NO** - v1 is ad-free,
      see the monetisation decision above), store listing. Paste-only:
- [x] Every Console answer pre-filled from the code in
      `store-listing/PLAY_CONSOLE_ANSWERS.md` (2026-09-25).
- [x] Store listing copy within limits in `store-listing/LISTING.md`;
      icon 512x512, feature graphic 1024x500 (JPEG, no alpha) and six real
      1080x1920 screenshots of the signed build in `store-listing/`; all
      checked by `scripts/listing-check.mjs` in `npm test` and CI.
- [x] Privacy policy page written and wired into the site image
      (`privacy.html` -> https://skyhookplay.com/privacy.html once merged;
      `deploy.yml` fails if it is not served).

## C. AdMob (real account, real ad unit IDs)

> **Not required for v1 - v1 ships ad-free.** See "Monetisation decision"
> at the top. When this section is eventually worked, the target is a
> **Rewarded** ad unit for a once-per-run continue, not the interstitial
> cadence currently wired.

- [ ] Create an **AdMob account** (linked to the Play account / AdSense).
- [ ] Register the app in AdMob -> get the real **App ID**
      (`ca-app-pub-XXXX~XXXX`).
- [ ] Create a real **Interstitial ad unit** -> get `ca-app-pub-XXXX/XXXX`.
- [ ] Replace the TEST ids:
  - `src/native/ads.mjs` -> `TEST_INTERSTITIAL_ID`
  - `scripts/patch-manifest.mjs` -> `TEST_APP_ID` (then re-run it, or edit
    `android/app/src/main/AndroidManifest.xml` meta-data directly).
  - Remove `initializeForTesting: true` in `ads.mjs` for production.
- [ ] Link AdMob <-> Play for revenue reporting; complete AdMob payments/tax.

## D. Play Billing - "remove ads" non-consumable

- [ ] In Play Console -> Monetize -> Products -> **In-app products**, create a
      product with id **`remove_ads`** (must match
      `src/native/billing.mjs` `REMOVE_ADS_PRODUCT_ID`), type **non-consumable**,
      set a price. (Change the id in code if you prefer another.)
- [ ] Set up a **merchant / payments profile** (bank + tax) to be able to sell.
- [ ] Add **licence testers** (Play Console -> Setup -> License testing) so the
      purchase + restore flow can be exercised without real charges.
- The code already: registers it as `NON_CONSUMABLE`, verifies+finishes the
  transaction, derives entitlement from `store.owned()` (Play receipt, so it
  **survives reinstall**), and exposes `restore()` (`store.restorePurchases()`).

## E. Signing - DONE (upload key generated 2026-09-25, no account needed)

- [x] **Upload keystore generated OUTSIDE the repo**:
      `C:/Users/leops/.skyhook/upload-keystore.jks` (PKCS12, RSA 2048,
      alias `skyhook-upload`, valid to 2054-02-10, self-signed
      `CN=SKYHOOK upload key, O=Leonardo Pechnicki dos Santos, C=PL`).
      Cert SHA-256
      `E7:9B:25:8C:5E:69:77:59:BA:6F:98:1B:7E:A6:51:8B:B8:E2:79:59:79:0B:B5:B2:98:37:76:B8:55:B8:26:8D`.
- [x] **Passwords** (random, 32 chars each) live only in
      `C:/Users/leops/.skyhook/keystore.properties`. Not in git (`*.jks` is
      ignored and the properties file is outside the tree), not in `.env`,
      not in `config.json`.
- [x] `android/app/build.gradle` reads that file (path overridable with
      `SKYHOOK_KEYSTORE_PROPERTIES`). **Absent file = unsigned build + loud
      warning** (CI and any other machine keep building), **present but
      incomplete = build fails naming the missing key**. Both paths were
      exercised on 2026-09-25 - see `PLAYSTORE_READY_REPORT.md`.
- [x] `versionCode 2`, `versionName "1.1.0"`, `targetSdk 36` (Play's
      requirement for new apps since 2026-08-31 is API 36 - verified on
      support.google.com/googleplay/android-developer/answer/11926878).
- [x] Signed AAB built and verified with `jarsigner -verify` and
      `bundletool validate`; a universal APK was derived with `bundletool
      build-apks --mode=universal` and installed on the emulator (section I).

**Play App Signing (read this before worrying about the key):** Play App
Signing is mandatory for new apps. Google generates and holds the **app
signing key** - the one every installed copy is bound to. The key above is
only the **upload key**: it proves an upload came from Leo. If it is ever lost
or leaked, Play Console -> Setup -> App signing -> "Request upload key reset"
issues a new one without stranding a single installed player. That is why it
can live on one machine instead of a vault. Back it up anyway: copy the
`.skyhook` folder somewhere private; do **not** commit it.

## F. Closed testing requirement (time + 12 real testers)

- [ ] New personal Play accounts must run a **closed test with >=12 testers for
      >=14 continuous days** before production access is granted. Recruit 12
      real Google accounts / opt-in testers.

## G. Upload & release

- [x] Signed AAB ready: `C:\Users\leops\.skyhook\out\skyhook-1.1.0-vc2-release-signed.aab`
      (12,375,267 bytes, sha256 `2f2f13ad...e28f8`, verified in
      `PLAYSTORE_READY_REPORT.md` section 2).
- [ ] Upload it to a track (internal -> closed -> production). Bump
      `versionCode` in `android/app/build.gradle` before every further upload.
- [ ] Complete pre-launch report review, roll out.

---

## H. Privacy / consent (UMP) - code is done, console side is not

The GDPR consent flow is now implemented in `src/native/ads.mjs` (UMP
`requestConsentInfo` -> `showConsentForm`, and ads are only requested when the
SDK reports `canRequestAds`). It **fails closed**: any error, a declined form,
or a plugin without UMP results in no ad request at all. Pinned by
`src/test/ads-consent.test.mjs`.

What still needs a real account:

- [ ] In the **AdMob console -> Privacy & messaging**, create and publish a
      **GDPR consent message** (EEA/UK) and a **US states** message. Until a
      message is published, `requestConsentInfo` reports no form is available
      and the app will (correctly) serve no ads in the EEA.
- [ ] Confirm the **target audience** answers in Play Console (pre-filled as
      13+, not directed at children, in `PLAY_CONSOLE_ANSWERS.md` section 6 -
      consistent with the code) match the code defaults in `ads.mjs`
      `DEFAULT_TARGETING`
      (`tagForChildDirectedTreatment: false`, `tagForUnderAgeOfConsent: true`,
      `maxAdContentRating: 'General'`). If Leo declares the app as *directed to
      children*, flip `tagForChildDirectedTreatment` to `true` - the two must
      agree or it is a policy strike.
- [x] Privacy policy page written (`privacy.html`, audited against
      `js/online.js`, `supabase/schema.sql` and the merged manifest) and
      served by the site image; the URL
      `https://skyhookplay.com/privacy.html` is live once this branch is on
      `main`.
- [ ] Paste that URL into the store listing (Leo, Console).
- [ ] Add a **privacy options entry point** (a "Privacy settings" button) if
      `privacyOptionsRequirementStatus` comes back `REQUIRED` for EEA users;
      the plugin exposes `resetConsentInfo()` / `showConsentForm()` for this.
      Not built yet - the game currently has no settings menu to hang it on.

## I. Emulator test - DONE (2026-09-25, no account needed)

- [x] Signed release universal APK (derived from the Play AAB, production
      config) installed on a Pixel 6 / Android 15 (API 35) AVD: title, runs,
      game over, customiser and the guest leaderboard driven by real `adb`
      taps; `dumpsys package` confirms versionCode 2, targetSdk 36, not
      debuggable, only INTERNET / ACCESS_NETWORK_STATE / WAKE_LOCK /
      FOREGROUND_SERVICE.
- [x] Sign-in, session persistence, score submit and `my_rank` proven inside
      the WebView with a staging debug build against the **staging** Supabase
      project only (never production), asserted over CDP.
- [x] Android-only bug found and fixed: the WebView's synthesised click closed
      overlays on open (`js/ui_online.js`, `js/ui_ship.js`, regression check
      in `test/leaderboard_ui.mjs`, 229/229).
- Evidence: `docs/EMULATOR_TEST_2026-09-25.md` + `docs/emulator-2026-09-25/`.
- [ ] Repeat on a real phone once one is available (nothing in the emulator
      run suggests a difference; the emulator's WebView 124 is older than
      any current phone's).

### Wiring already done by Crew (no account needed)
- Capacitor project, `appId=com.leopechnicki.skyhook`, `appName=SKYHOOK`.
- Native `android/` project generated; AdMob + Billing plugins wired into gradle
  (`com.android.billingclient:billing:9.0.0` is pulled in automatically).
- AdMob **test** App ID meta-data inserted into `AndroidManifest.xml`.
- Ad-gate (every 5th game-over), ad-free skip, real non-consumable + restore.
- UMP/GDPR consent gate + target-audience declaration on every ad request.
- Entitlement re-checked on every app foreground, not only at cold boot.
- Web game reused unmodified as the build source (github.io version untouched).

### Verify before every release
```
npm test                          # ad-gate + consent + ad-free switch + Play listing limits (no device)
node ../test/leaderboard_ui.mjs   # includes the WebView backdrop regression check
jarsigner -verify <aab> && java -jar bundletool.jar validate --bundle=<aab>
```
