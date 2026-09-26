/*
 * skyhook-native.js - Capacitor-only bridge for the SKYHOOK Android wrapper.
 *
 * Loaded as <script type="module"> and injected into www/index.html at sync
 * time by scripts/sync-web.mjs. It is NEVER present in the web version - the
 * game's own repo assets are untouched, so skyhookplay.com keeps working
 * exactly as before. This file is the ONLY glue between the game and native
 * services.
 *
 * v1 is AD-FREE (Leo, 2026-09-22). ADS_ENABLED in monetisation.mjs is false,
 * so createMonetisation() returns an inert object: no AdMob, no UMP consent
 * form, no Play Billing - none of it is even constructed. The wiring stays in
 * the tree for the day ads are switched on (as a once-per-run rewarded
 * continue, not the interstitial cadence ad-gate.mjs still implements).
 *
 * How it detects game-over WITHOUT editing the game:
 *   main.js exposes window.__SKYHOOK.game. Its .state field moves
 *   'playing' -> 'dying' -> 'over'. We watch that field on requestAnimationFrame
 *   and fire exactly once on each rising edge into 'over'. No game code changes.
 */

import { createAdGate } from './ad-gate.mjs';
import { createAds } from './ads.mjs';
import { createBilling } from './billing.mjs';
import { ADS_ENABLED, createMonetisation } from './monetisation.mjs';

(function () {
  'use strict';

  function log() {
    try { console.log.apply(console, ['[skyhook-native]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  var monetisation = createMonetisation({
    adsEnabled: ADS_ENABLED,
    interval: 5,
    log: log,
    createAds: createAds,
    createBilling: createBilling,
    createAdGate: createAdGate
  });

  // Expose for the on-device manual test harness / debugging.
  window.__SKYHOOK_NATIVE = {
    adsEnabled: monetisation.enabled,
    monetisation: monetisation,
    adGate: monetisation.adGate,
    ads: monetisation.ads,
    billing: monetisation.billing,
    buyRemoveAds: function () {
      return monetisation.billing ? monetisation.billing.buyRemoveAds() : Promise.resolve(false);
    },
    restore: function () {
      return monetisation.billing ? monetisation.billing.restore() : Promise.resolve(true);
    }
  };

  function initNative() {
    monetisation.initialize()
      .catch(function (e) { log('initNative failed', e); });
  }

  /* Re-check the Play receipt whenever the app comes back to the foreground.
   *
   * Without this the entitlement was only ever read at cold boot, so a purchase
   * made on another device, a purchase that completed while the app was
   * backgrounded, or a refund would keep showing (or keep hiding) ads until the
   * process was killed and relaunched. A no-op in the ad-free build.
   *
   * Deliberately uses visibilitychange rather than @capacitor/app's
   * appStateChange: it fires on WebView foreground just the same, and it needs
   * no extra Capacitor plugin dependency - so this stays a zero-new-dependency
   * fix and keeps working in a plain browser. */
  function watchForeground() {
    if (!monetisation.enabled) return;
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      monetisation.restoreOnForeground()
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
        try { monetisation.onGameOver(); } catch (e) { log('onGameOver error', e); }
      }
      wasOver = isOver;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function boot() {
    // Only meaningful inside the Capacitor native runtime; harmless otherwise.
    var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    log('boot, isNativePlatform =', isNative, 'adsEnabled =', monetisation.enabled);
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
