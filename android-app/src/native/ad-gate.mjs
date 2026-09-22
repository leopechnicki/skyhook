/*
 * ad-gate.mjs - PURE, side-effect-free ad-gating logic for SKYHOOK Android.
 *
 * This is the single source of truth for "when do we show an interstitial".
 * It has NO dependency on AdMob, Capacitor, the DOM, or billing - those are
 * injected as callbacks. That keeps it fully unit-testable under plain Node
 * (see ../test/ad-gate.test.mjs) and identical between test and runtime.
 *
 * Contract:
 *   - onGameOver() is called exactly once per finished game.
 *   - An interstitial fires on every Nth game-over (default N = 5): the
 *     5th, 10th, 15th, ... game-over.
 *   - If isAdFree() returns true (user owns the "remove ads" entitlement),
 *     the counter is NOT advanced and NO ad ever fires.
 */

export function createAdGate(opts) {
  var o = opts || {};
  var interval = (o.interval == null) ? 5 : o.interval;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error('ad-gate: interval must be a positive integer');
  }
  var isAdFree = typeof o.isAdFree === 'function' ? o.isAdFree : function () { return false; };
  var showInterstitial = typeof o.showInterstitial === 'function' ? o.showInterstitial : function () {};
  var onError = typeof o.onError === 'function' ? o.onError : function () {};

  var count = 0;

  return {
    /* Call once when a game finishes. Returns true if an ad was triggered. */
    onGameOver: function () {
      // Owning the entitlement disables the gate entirely. We deliberately do
      // NOT increment the counter while ad-free, so that if the entitlement is
      // ever lost (refund) the cadence resumes cleanly rather than firing a
      // burst of "catch-up" ads.
      if (isAdFree()) return false;

      count += 1;
      if (count % interval === 0) {
        try {
          showInterstitial();
        } catch (e) {
          onError(e);
        }
        return true;
      }
      return false;
    },

    /* Introspection helpers - handy for tests / debugging overlays. */
    getCount: function () { return count; },
    reset: function () { count = 0; }
  };
}
