/*
 * monetisation.mjs - the ONE switch between "this build shows ads" and
 * "this build is ad-free", and the wiring that honours it.
 *
 * Decision (Leo, 2026-09-22, RELEASE-CHECKLIST.md "Monetisation decision"):
 * v1 ships with NO ads. Not "ads configured but disabled" as a launch story -
 * the shipped build shows a player zero ads, requests zero ads, and never
 * initialises the Google Mobile Ads SDK or Play Billing at all.
 *
 * Why a module and not a deleted import: the AdMob + Billing wiring
 * (ads.mjs, billing.mjs, ad-gate.mjs) is tested and stays in the tree, inert,
 * because ripping it out only means rebuilding it later. When ads are
 * eventually switched on the model is ONE rewarded ad to continue a run, once
 * per run - which is NOT the every-5th-game-over interstitial the gate below
 * still implements. So flipping ADS_ENABLED to true is not the whole job; the
 * cadence in ad-gate.mjs has to be redesigned first. The flag is here so the
 * decision is one reviewable line, pinned by src/test/monetisation.test.mjs.
 *
 * Everything the bridge (skyhook-native.js) needs goes through the object
 * createMonetisation() returns, so the bridge itself has no ad code path to
 * get wrong: with ads disabled the ad, billing and gate factories are never
 * even called.
 */

/* v1 = ad-free. Flip deliberately, together with the rewarded-continue
   redesign, never as a side effect. Also re-add the ad permissions that
   android/app/src/main/AndroidManifest.xml strips (see the tools:node="remove"
   block there) - an ads-on build with no AD_ID permission serves nothing. */
export var ADS_ENABLED = false;

export function createMonetisation(opts) {
  var o = opts || {};
  var enabled = o.adsEnabled === true;
  var log = typeof o.log === 'function' ? o.log : function () {};
  var interval = (o.interval == null) ? 5 : o.interval;

  if (!enabled) {
    /* The ad-free build. Nothing below is constructed: no plugin lookup, no
       SDK initialize, no consent form, no Play Billing catalogue query, no
       counter. A player who never sees an ad also never sees a consent
       dialog for ads they will not be served. */
    return {
      enabled: false,
      ads: null,
      billing: null,
      adGate: null,
      initialize: function () {
        log('monetisation: this build is ad-free - AdMob and Play Billing are not initialised');
        return Promise.resolve(false);
      },
      /* Nothing to remove in an ad-free build, so the entitlement is moot;
         reporting true keeps any caller that asks "may I show an ad?" on the
         no path. */
      isAdFree: function () { return true; },
      onGameOver: function () { return false; },
      restoreOnForeground: function () { return Promise.resolve(true); }
    };
  }

  /* ---- ads on: the wiring exactly as it was before this module existed ---- */
  var createAds = o.createAds, createBilling = o.createBilling, createAdGate = o.createAdGate;
  if (typeof createAds !== 'function' || typeof createBilling !== 'function' || typeof createAdGate !== 'function') {
    throw new Error('monetisation: adsEnabled needs createAds, createBilling and createAdGate');
  }

  var ads = createAds({ log: log });
  var billing = createBilling({
    log: log,
    onEntitlementChange: function (adFree) { log('entitlement changed: adFree =', adFree); }
  });
  var adGate = createAdGate({
    interval: interval,
    isAdFree: function () { return billing.isAdFree(); },
    showInterstitial: function () { ads.showInterstitial(); },
    onError: function (e) { log('adGate error:', e); }
  });

  return {
    enabled: true,
    ads: ads,
    billing: billing,
    adGate: adGate,

    /* Restore entitlement, THEN init ads - chained, so an owner never watches
       an ad load because the receipt query had not come back yet. */
    initialize: function () {
      return billing.initialize()
        .then(function (adFree) {
          log('billing initialized, adFree =', adFree);
          if (adFree) {
            log('ads: skipping AdMob init entirely - user owns remove-ads');
            return false;
          }
          return ads.initialize();
        })
        .then(function (ok) { log('ads initialized, available =', ok); return ok; });
    },

    isAdFree: function () { return billing.isAdFree(); },
    onGameOver: function () { return adGate.onGameOver(); },

    /* Re-check the Play receipt on foreground - a purchase or refund made
       elsewhere must not wait for a process restart. */
    restoreOnForeground: function () {
      if (!billing.isAvailable()) return Promise.resolve(billing.isAdFree());
      return billing.restore();
    }
  };
}
