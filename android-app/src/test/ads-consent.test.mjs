/*
 * Unit tests for the AdMob consent gate + audience targeting. Pure Node, no
 * device and no AdMob account needed - createAds() takes an injectable
 * getPlugin, so we drive it with a fake that records every call.
 *
 * The property under test is deliberately one-sided: there are many ways for
 * the consent flow to go wrong and exactly one acceptable outcome for all of
 * them - NO ad request. These tests exist so a future refactor cannot quietly
 * turn a consent failure into "show the ad anyway".
 *
 * Run: node src/test/ads-consent.test.mjs
 */
import assert from 'node:assert/strict';
import { createAds, DEFAULT_TARGETING, TEST_INTERSTITIAL_ID } from '../native/ads.mjs';

let passed = 0;
const only = [];
function test(name, fn) { only.push([name, fn]); }

/* A fake AdMob plugin. `consent` is what requestConsentInfo resolves with;
   `formConsent` is what showConsentForm resolves with. Every call is logged. */
function fakePlugin(overrides) {
  const o = overrides || {};
  const calls = [];
  const plugin = {
    calls,
    initialize(opts) { calls.push(['initialize', opts]); return Promise.resolve(); },
    requestConsentInfo(opts) {
      calls.push(['requestConsentInfo', opts]);
      if (o.consentThrows) return Promise.reject(new Error('UMP offline'));
      return Promise.resolve(o.consent);
    },
    showConsentForm() {
      calls.push(['showConsentForm', null]);
      return Promise.resolve(o.formConsent);
    },
    prepareInterstitial(opts) { calls.push(['prepareInterstitial', opts]); return Promise.resolve(); },
    showInterstitial() { calls.push(['showInterstitial', null]); return Promise.resolve(); }
  };
  if (o.noUmp) { delete plugin.requestConsentInfo; delete plugin.showConsentForm; }
  return plugin;
}

const named = (p, name) => p.calls.filter(c => c[0] === name);
const mk = (p, extra) => createAds(Object.assign({ getPlugin: () => p }, extra || {}));

/* ---------------- consent is REQUIRED and granted via the form ------------ */
test('REQUIRED consent shows the form, then ads are allowed', async () => {
  const p = fakePlugin({
    consent: { status: 'REQUIRED', isConsentFormAvailable: true, canRequestAds: false },
    formConsent: { status: 'OBTAINED', canRequestAds: true }
  });
  const ads = mk(p);
  const ok = await ads.initialize();
  assert.equal(named(p, 'showConsentForm').length, 1, 'consent form must be shown');
  assert.equal(ads.canRequestAds(), true);
  assert.equal(ok, true);
  assert.equal(named(p, 'prepareInterstitial').length, 1);
});

/* ---------------- consent NOT_REQUIRED (outside the EEA) ----------------- */
test('NOT_REQUIRED consent skips the form but still allows ads', async () => {
  const p = fakePlugin({ consent: { status: 'NOT_REQUIRED', canRequestAds: true } });
  const ads = mk(p);
  await ads.initialize();
  assert.equal(named(p, 'showConsentForm').length, 0, 'no form when consent is not required');
  assert.equal(ads.canRequestAds(), true);
});

/* ---------------- the fail-closed cases ---------------------------------- */
test('consent REQUIRED but refused -> no ad is ever requested', async () => {
  const p = fakePlugin({
    consent: { status: 'REQUIRED', isConsentFormAvailable: true, canRequestAds: false },
    formConsent: { status: 'REQUIRED', canRequestAds: false }   // user declined
  });
  const ads = mk(p);
  const ok = await ads.initialize();
  assert.equal(ok, false);
  assert.equal(ads.canRequestAds(), false);
  assert.equal(named(p, 'prepareInterstitial').length, 0, 'must not prepare without consent');
  const shown = await ads.showInterstitial();
  assert.equal(shown, false);
  assert.equal(named(p, 'showInterstitial').length, 0, 'must not show without consent');
});

test('consent flow throwing does NOT fall through to showing an ad', async () => {
  const p = fakePlugin({ consentThrows: true });
  const ads = mk(p);
  assert.equal(await ads.initialize(), false);
  assert.equal(ads.canRequestAds(), false);
  await ads.showInterstitial();
  assert.equal(named(p, 'showInterstitial').length, 0);
});

test('a plugin with no UMP API fails closed rather than serving unconsented ads', async () => {
  const p = fakePlugin({ noUmp: true });
  const ads = mk(p);
  assert.equal(await ads.initialize(), false);
  assert.equal(ads.canRequestAds(), false);
  assert.equal(named(p, 'prepareInterstitial').length, 0);
});

test('showInterstitial before initialize() is a no-op (consent defaults to false)', async () => {
  const p = fakePlugin({ consent: { status: 'NOT_REQUIRED', canRequestAds: true } });
  const ads = mk(p);
  assert.equal(await ads.showInterstitial(), false);
  assert.equal(named(p, 'showInterstitial').length, 0);
});

test('no plugin at all (plain browser) is a safe no-op', async () => {
  const ads = createAds({ getPlugin: () => null });
  assert.equal(ads.isAvailable(), false);
  assert.equal(await ads.initialize(), false);
  assert.equal(await ads.showInterstitial(), false);
});

/* ---------------- audience targeting reaches the ad request -------------- */
test('target-audience flags are passed to AdMob.initialize', async () => {
  const p = fakePlugin({ consent: { status: 'NOT_REQUIRED', canRequestAds: true } });
  const ads = mk(p);
  await ads.initialize();
  const opts = named(p, 'initialize')[0][1];
  assert.equal(opts.tagForChildDirectedTreatment, DEFAULT_TARGETING.tagForChildDirectedTreatment);
  assert.equal(opts.tagForUnderAgeOfConsent, DEFAULT_TARGETING.tagForUnderAgeOfConsent);
  assert.equal(opts.maxAdContentRating, DEFAULT_TARGETING.maxAdContentRating);
  assert.equal(opts.initializeForTesting, true, 'must still be on Google test ads');
});

test('TFUA is forwarded to the consent request, not just to initialize', async () => {
  const p = fakePlugin({ consent: { status: 'NOT_REQUIRED', canRequestAds: true } });
  const ads = mk(p, { targeting: Object.assign({}, DEFAULT_TARGETING, { tagForUnderAgeOfConsent: true }) });
  await ads.initialize();
  assert.equal(named(p, 'requestConsentInfo')[0][1].tagForUnderAgeOfConsent, true);
});

test('targeting is overridable without editing the module', async () => {
  const p = fakePlugin({ consent: { status: 'NOT_REQUIRED', canRequestAds: true } });
  const ads = mk(p, {
    targeting: { tagForChildDirectedTreatment: true, tagForUnderAgeOfConsent: false, maxAdContentRating: 'Teen' }
  });
  await ads.initialize();
  const opts = named(p, 'initialize')[0][1];
  assert.equal(opts.tagForChildDirectedTreatment, true);
  assert.equal(opts.maxAdContentRating, 'Teen');
});

/* ---------------- the shipped defaults are the conservative ones --------- */
test('shipped defaults declare a general audience and assume a possible minor', () => {
  assert.equal(DEFAULT_TARGETING.maxAdContentRating, 'General');
  assert.equal(DEFAULT_TARGETING.tagForUnderAgeOfConsent, true);
  assert.equal(TEST_INTERSTITIAL_ID.startsWith('ca-app-pub-3940256099942544/'), true,
    'must still be Google\'s public test unit, never a real revenue id');
});

/* ---------------- runner ------------------------------------------------- */
for (const [name, fn] of only) {
  try { await fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
console.log('\n' + passed + '/' + only.length + ' test(s) passed.');
