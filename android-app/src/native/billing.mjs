/*
 * billing.mjs - Google Play Billing wrapper for the "remove ads" entitlement.
 *
 * Uses cordova-plugin-purchase (CdvPurchase, v13+), which Capacitor loads as a
 * Cordova-compat plugin. Accessed via the global window.CdvPurchase so this
 * works in the no-build vanilla setup (no bundler required) and degrades to a
 * harmless no-op in a plain desktop browser (the web version keeps working).
 *
 * The entitlement is a REAL non-consumable product on Google Play. Ownership is
 * derived from store.owned(), which reflects the receipt Google Play returns on
 * initialize()/restorePurchases() - so it SURVIVES REINSTALL. This is NOT a
 * local flag.
 *
 * NOTE ON PRODUCT ID: 'remove_ads' below is a placeholder id. It only becomes a
 * chargeable product once the real product is created in Play Console under
 * Leo's account (see RELEASE-CHECKLIST.md). Until then, on a debug build with
 * no Play account context, queries simply report "not owned" and billing UI is
 * unavailable - nothing is charged and no account is created.
 */

export var REMOVE_ADS_PRODUCT_ID = 'remove_ads';

export function createBilling(opts) {
  var o = opts || {};
  var productId = o.productId || REMOVE_ADS_PRODUCT_ID;
  var onEntitlementChange = typeof o.onEntitlementChange === 'function' ? o.onEntitlementChange : function () {};
  var log = typeof o.log === 'function' ? o.log : function () {};

  var CdvPurchase = (typeof window !== 'undefined') ? window.CdvPurchase : undefined;
  var available = !!(CdvPurchase && CdvPurchase.store);

  // In-memory mirror of the on-device entitlement. Seeded from the plugin's
  // store.owned() so it reflects the Play Store receipt, not a persisted flag.
  var adFree = false;

  function refreshEntitlement() {
    if (!available) return;
    try {
      var owned = CdvPurchase.store.owned(productId);
      if (owned !== adFree) {
        adFree = owned;
        onEntitlementChange(adFree);
      }
    } catch (e) {
      log('billing: refreshEntitlement failed: ' + e);
    }
  }

  return {
    isAvailable: function () { return available; },

    /* True iff the user owns the non-consumable. Source: Play Store receipt. */
    isAdFree: function () { return adFree; },

    initialize: function () {
      if (!available) {
        log('billing: CdvPurchase not present (plain browser / no native runtime) - ad-free stays false');
        return Promise.resolve(false);
      }
      var store = CdvPurchase.store;
      var Platform = CdvPurchase.Platform;
      var ProductType = CdvPurchase.ProductType;

      store.register([{
        id: productId,
        type: ProductType.NON_CONSUMABLE,
        platform: Platform.GOOGLE_PLAY
      }]);

      // Approve -> verify -> finish is the standard receipt-validation flow.
      store.when()
        .approved(function (t) { return t.verify(); })
        .verified(function (r) { r.finish(); refreshEntitlement(); })
        .receiptUpdated(function () { refreshEntitlement(); });

      // initialize() queries Google Play for the catalogue AND owned items, so
      // on a fresh install the previously-purchased non-consumable is restored
      // automatically.
      return store.initialize([Platform.GOOGLE_PLAY])
        .then(function () { refreshEntitlement(); return adFree; })
        .catch(function (e) { log('billing: initialize failed: ' + e); return false; });
    },

    /* Trigger the purchase flow for the remove-ads product. */
    buyRemoveAds: function () {
      if (!available) return Promise.resolve(false);
      try {
        var product = CdvPurchase.store.get(productId, CdvPurchase.Platform.GOOGLE_PLAY);
        var offer = product && product.getOffer && product.getOffer();
        if (!offer) { log('billing: no offer for ' + productId); return Promise.resolve(false); }
        return CdvPurchase.store.order(offer).then(function () { refreshEntitlement(); return adFree; });
      } catch (e) {
        log('billing: buy failed: ' + e);
        return Promise.resolve(false);
      }
    },

    /* Explicit restore - re-queries Google Play for owned purchases. */
    restore: function () {
      if (!available) return Promise.resolve(false);
      try {
        return CdvPurchase.store.restorePurchases().then(function () {
          refreshEntitlement();
          return adFree;
        });
      } catch (e) {
        log('billing: restore failed: ' + e);
        return Promise.resolve(false);
      }
    }
  };
}
