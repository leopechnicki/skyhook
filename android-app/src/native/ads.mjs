/*
 * ads.mjs - AdMob interstitial wrapper for SKYHOOK Android.
 *
 * Uses @capacitor-community/admob, accessed via the global
 * window.Capacitor.Plugins.AdMob so it works in the no-build vanilla setup and
 * no-ops safely in a plain browser (the web version is unaffected).
 *
 * ============================ TEST IDS ONLY =============================
 * These are Google's PUBLIC, OFFICIAL sample ad unit IDs. They serve test
 * ads, are safe to hardcode, are not tied to any account, and generate no
 * revenue. Real IDs must be swapped in only after Leo creates an AdMob
 * account (see RELEASE-CHECKLIST.md). DO NOT ship real IDs from here.
 *   App ID (goes in AndroidManifest meta-data):
 *     ca-app-pub-3940256099942544~3347511713
 *   Interstitial test unit:
 *     ca-app-pub-3940256099942544/1033173712
 * Source: https://developers.google.com/admob/android/test-ads
 * ========================================================================
 *
 * ---------------------------------------------------------------------------
 * CONSENT + TARGETING (added 2026-09-09, Crew)
 *
 * The previous version went straight from initialize() to prepareInterstitial()
 * with no consent step and no audience declaration. Two real gaps:
 *
 *   1. GDPR/UMP. AdMob policy requires a certified CMP to gather consent from
 *      users in the EEA and UK BEFORE any ad request. Leo is in Krakow, so the
 *      very first real install is an EEA install - this is the default path,
 *      not an edge case. We now run the UMP flow the plugin already ships
 *      (requestConsentInfo -> showConsentForm) and only request an ad when the
 *      SDK reports canRequestAds.
 *   2. Target audience. Play requires a target-audience declaration, and the
 *      COPPA / TFUA / content-rating signals have to be attached to the ad
 *      REQUEST, not just ticked in a console form. SKYHOOK is a one-touch
 *      arcade game with no violence and obvious appeal to under-13s, so it
 *      ships General-rated ads by default.
 *
 * Both are declared here as explicit, overridable defaults rather than left
 * implicit, so the values are reviewable in one place.
 *
 * NOTE: the API surface used below was verified field-by-field against the
 * installed plugin's own typings (node_modules/@capacitor-community/admob/
 * dist/esm/consent/*.d.ts and definitions.d.ts) - not from memory.
 * ------------------------------------------------------------------------- */

export var TEST_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
export var TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';

/* Audience declaration applied to every ad request. Conservative on purpose:
   a mis-declared kids app is a policy strike, an over-restricted one only
   costs eCPM. Override via createAds({ targeting: {...} }) if Leo's Play
   Console target-audience answer ends up differing. */
export var DEFAULT_TARGETING = {
  tagForChildDirectedTreatment: false,  // not *directed* at children...
  tagForUnderAgeOfConsent: true,        // ...but assume the user may be a minor (TFUA)
  maxAdContentRating: 'General'         // MaxAdContentRating.General
};

export function createAds(opts) {
  var o = opts || {};
  var adId = o.interstitialId || TEST_INTERSTITIAL_ID;
  var log = typeof o.log === 'function' ? o.log : function () {};
  var targeting = o.targeting || DEFAULT_TARGETING;
  /* Injectable for unit tests; defaults to the live Capacitor plugin. */
  var getPlugin = typeof o.getPlugin === 'function' ? o.getPlugin : function () {
    var Cap = (typeof window !== 'undefined') ? window.Capacitor : undefined;
    return (Cap && Cap.Plugins && Cap.Plugins.AdMob) ? Cap.Plugins.AdMob : null;
  };

  function plugin() { return getPlugin(); }

  var prepared = false;
  /* Until UMP says otherwise we are NOT allowed to request an ad. Defaulting
     this to false is the whole point: a failure anywhere in the consent flow
     must end with no ad, never with an unconsented one. */
  var canRequestAds = false;

  function prepare() {
    var AdMob = plugin();
    if (!AdMob) return Promise.resolve(false);
    if (!canRequestAds) { log('ads: prepare skipped - no consent to request ads'); return Promise.resolve(false); }
    return AdMob.prepareInterstitial({ adId: adId })
      .then(function () { prepared = true; return true; })
      .catch(function (e) { log('ads: prepare failed: ' + e); prepared = false; return false; });
  }

  /* Run the UMP consent flow and resolve with whether ads may be requested.
     Every failure path resolves false rather than throwing, so a consent
     outage degrades to "no ads" instead of "crash" or "ads anyway". */
  function gatherConsent(AdMob) {
    if (typeof AdMob.requestConsentInfo !== 'function') {
      /* Older plugin build with no UMP support. Fail CLOSED: we cannot prove
         we have consent, so we do not request ads. */
      log('ads: plugin exposes no UMP consent API - refusing to request ads');
      return Promise.resolve(false);
    }
    return AdMob.requestConsentInfo({
      tagForUnderAgeOfConsent: !!targeting.tagForUnderAgeOfConsent
    }).then(function (info) {
      info = info || {};
      var needsForm = info.status === 'REQUIRED' && info.isConsentFormAvailable
        && typeof AdMob.showConsentForm === 'function';
      if (!needsForm) return info;
      return AdMob.showConsentForm().then(function (after) { return after || info; });
    }).then(function (info) {
      /* canRequestAds is the SDK's own verdict and covers NOT_REQUIRED,
         OBTAINED, and partial-consent cases. Trust it rather than
         re-deriving the rule from status. */
      var ok = !!(info && info.canRequestAds);
      log('ads: consent status=' + (info && info.status) + ' canRequestAds=' + ok);
      return ok;
    }).catch(function (e) {
      log('ads: consent flow failed, ads stay disabled: ' + e);
      return false;
    });
  }

  return {
    isAvailable: function () { return !!plugin(); },

    /* Whether UMP currently permits an ad request. Exposed so the caller (and
       the on-device harness) can tell "no ad because no consent" apart from
       "no ad because the gate has not reached 5 yet". */
    canRequestAds: function () { return canRequestAds; },

    initialize: function () {
      var AdMob = plugin();
      if (!AdMob) {
        log('ads: AdMob plugin not present (plain browser / no native runtime) - interstitials disabled');
        return Promise.resolve(false);
      }
      // initializeForTesting keeps us on test ads even on a real device.
      return AdMob.initialize({
        initializeForTesting: true,
        testingDevices: [],
        tagForChildDirectedTreatment: !!targeting.tagForChildDirectedTreatment,
        tagForUnderAgeOfConsent: !!targeting.tagForUnderAgeOfConsent,
        maxAdContentRating: targeting.maxAdContentRating
      })
        .then(function () { return gatherConsent(AdMob); })
        .then(function (ok) {
          canRequestAds = ok;
          if (!ok) return false;
          return prepare();
        })
        .catch(function (e) { log('ads: initialize failed: ' + e); canRequestAds = false; return false; });
    },

    /*
     * Show one interstitial. Returns a promise. Re-prepares the next ad after
     * dismissal so a subsequent 5th-game-over has an ad ready. Safe no-op when
     * the plugin is absent OR when consent has not been granted.
     */
    showInterstitial: function () {
      var AdMob = plugin();
      if (!AdMob) return Promise.resolve(false);
      if (!canRequestAds) { log('ads: interstitial suppressed - no consent'); return Promise.resolve(false); }
      var chain = prepared ? Promise.resolve(true) : prepare();
      return chain.then(function (ok) {
        if (!ok) return false;
        return AdMob.showInterstitial()
          .then(function () { prepared = false; return prepare().then(function () { return true; }); })
          .catch(function (e) { log('ads: show failed: ' + e); prepared = false; return false; });
      });
    }
  };
}
