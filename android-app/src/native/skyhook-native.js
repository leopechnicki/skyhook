/*
 * skyhook-native.js - Capacitor-only bridge for the SKYHOOK Android wrapper.
 *
 * Loaded as <script type="module"> and injected into www/index.html at sync
 * time by scripts/sync-web.mjs. It is NEVER present in the web version - the
 * game's own repo assets are untouched, so github.io keeps working exactly as
 * before. This file is the ONLY glue between the game and native services.
 *
 * How it detects game-over WITHOUT editing the game:
 *   main.js exposes window.__SKYHOOK.game. Its .state field moves
 *   'playing' -> 'dying' -> 'over'. We watch that field on requestAnimationFrame
 *   and fire exactly once on each rising edge into 'over'. No game code changes.
 */

import { createAdGate } from './ad-gate.mjs';
import { createAds } from './ads.mjs';
import { createBilling } from './billing.mjs';

(function () {
  'use strict';

  function log() {
    try { console.log.apply(console, ['[skyhook-native]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  var ads = createAds({ log: log });
  var billing = createBilling({
    log: log,
    onEntitlementChange: function (adFree) {
      log('entitlement changed: adFree =', adFree);
    }
  });

  var adGate = createAdGate({
    interval: 5,
    isAdFree: function () { return billing.isAdFree(); },
    showInterstitial: function () { ads.showInterstitial(); },
    onError: function (e) { log('adGate error:', e); }
  });

  // Expose for the on-device manual test harness / debugging.
  window.__SKYHOOK_NATIVE = {
    adGate: adGate,
    ads: ads,
    billing: billing,
    buyRemoveAds: function () { return billing.buyRemoveAds(); },
    restore: function () { return billing.restore(); }
  };

  function initNative() {
    /* Restore entitlement, THEN init ads.
     *
     * The comment here used to claim "billing first so isAdFree() is correct
     * before the first possible game-over" while actually firing both
     * initialize() calls concurrently - the stated invariant was never
     * enforced. Chain them so it is. An owner must never watch an ad load
     * because the receipt query had not come back yet. */
    billing.initialize()
      .then(function (adFree) {
        log('billing initialized, adFree =', adFree);
        if (adFree) {
          log('ads: skipping AdMob init entirely - user owns remove-ads');
          return false;
        }
        return ads.initialize();
      })
      .then(function (ok) { log('ads initialized, available =', ok); })
      .catch(function (e) { log('initNative failed', e); });
  }

  /* Re-check the Play receipt whenever the app comes back to the foreground.
   *
   * Without this the entitlement was only ever read at cold boot, so a purchase
   * made on another device, a purchase that completed while the app was
   * backgrounded, or a refund would keep showing (or keep hiding) ads until the
   * process was killed and relaunched.
   *
   * Deliberately uses visibilitychange rather than @capacitor/app's
   * appStateChange: it fires on WebView foreground just the same, and it needs
   * no extra Capacitor plugin dependency - so this stays a zero-new-dependency
   * fix and keeps working in a plain browser. */
  function watchForeground() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!billing.isAvailable()) return;
      billing.restore()
        .then(function (adFree) { log('foreground entitlement re-check, adFree =', adFree); })
        .catch(function (e) { log('foreground restore failed', e); });
    });
  }

  // Watch the game state for the rising edge into 'over'.
  function watchGameOver() {
    var g = window.__SKYHOOK && window.__SKYHOOK.game;
    if (!g) { requestAnimationFrame(watchGameOver); return; }
    var wasOver = (g.state === 'over');
    function tick() {
      var isOver = (g.state === 'over');
      if (isOver && !wasOver) {
        // finished a game
        try { adGate.onGameOver(); } catch (e) { log('onGameOver error', e); }
      }
      wasOver = isOver;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function boot() {
    // Only meaningful inside the Capacitor native runtime; harmless otherwise.
    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    log('boot, isNativePlatform =', isNative);
    initNative();
    watchForeground();
    watchGameOver();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    // Defer a tick so the game's own scripts (which populate __SKYHOOK) run first.
    setTimeout(boot, 0);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 0); });
  }
}());
