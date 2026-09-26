/*
 * Unit tests for the monetisation switch. Pure Node, no device needed.
 *
 * The property under test: with ADS_ENABLED false (the v1 decision) the
 * shipped build must never construct, initialise or call into AdMob, UMP
 * consent, or Play Billing - not on boot, not on game-over, not on
 * foreground. The factories are injected so a fake can prove "never called"
 * rather than "called and then suppressed".
 *
 * Run: node src/test/monetisation.test.mjs
 */
import assert from 'node:assert/strict';
import { ADS_ENABLED, createMonetisation } from '../native/monetisation.mjs';

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function fakes() {
  const calls = [];
  let adFree = false;
  const ads = {
    initialize() { calls.push('ads.initialize'); return Promise.resolve(true); },
    showInterstitial() { calls.push('ads.showInterstitial'); return Promise.resolve(true); }
  };
  const billing = {
    isAvailable() { return true; },
    isAdFree() { return adFree; },
    setAdFree(v) { adFree = v; },
    initialize() { calls.push('billing.initialize'); return Promise.resolve(adFree); },
    restore() { calls.push('billing.restore'); return Promise.resolve(adFree); }
  };
  let count = 0;
  const factories = {
    createAds() { calls.push('createAds'); return ads; },
    createBilling() { calls.push('createBilling'); return billing; },
    createAdGate(o) {
      calls.push('createAdGate');
      return {
        onGameOver() {
          if (o.isAdFree()) return false;
          count += 1;
          if (count % o.interval === 0) { o.showInterstitial(); return true; }
          return false;
        }
      };
    }
  };
  return { calls, ads, billing, factories };
}

// --- the shipped decision ---
test('v1 ships ad-free: ADS_ENABLED is literally false', () => {
  assert.equal(ADS_ENABLED, false);
});

test('ads disabled: no ad, billing or gate factory is ever called', async () => {
  const f = fakes();
  const m = createMonetisation({ adsEnabled: ADS_ENABLED, ...f.factories });
  assert.equal(m.enabled, false);
  assert.equal(await m.initialize(), false);
  for (let i = 0; i < 25; i++) assert.equal(m.onGameOver(), false);
  assert.equal(await m.restoreOnForeground(), true);
  assert.equal(m.isAdFree(), true);
  assert.deepEqual(f.calls, []);
  assert.equal(m.ads, null);
  assert.equal(m.billing, null);
  assert.equal(m.adGate, null);
});

test('ads disabled: only a literal true enables them (truthy strings do not)', () => {
  for (const v of [undefined, null, 0, '', 'true', 'false', 1, {}]) {
    const f = fakes();
    const m = createMonetisation({ adsEnabled: v, ...f.factories });
    assert.equal(m.enabled, false, 'adsEnabled=' + JSON.stringify(v));
    assert.deepEqual(f.calls, []);
  }
});

// --- the path that is kept in the tree for later ---
test('ads enabled: factories are built, billing initialises before ads', async () => {
  const f = fakes();
  const m = createMonetisation({ adsEnabled: true, ...f.factories });
  assert.equal(m.enabled, true);
  assert.equal(await m.initialize(), true);
  assert.deepEqual(f.calls, ['createAds', 'createBilling', 'createAdGate', 'billing.initialize', 'ads.initialize']);
});

test('ads enabled: an owner of remove-ads never initialises AdMob', async () => {
  const f = fakes();
  f.billing.setAdFree(true);
  const m = createMonetisation({ adsEnabled: true, ...f.factories });
  assert.equal(await m.initialize(), false);
  assert.ok(!f.calls.includes('ads.initialize'));
});

test('ads enabled: the every-5th cadence still reaches showInterstitial', () => {
  const f = fakes();
  const m = createMonetisation({ adsEnabled: true, interval: 5, ...f.factories });
  const fired = [];
  for (let i = 1; i <= 12; i++) if (m.onGameOver()) fired.push(i);
  assert.deepEqual(fired, [5, 10]);
  assert.equal(f.calls.filter((c) => c === 'ads.showInterstitial').length, 2);
});

test('ads enabled: foreground re-checks the receipt', async () => {
  const f = fakes();
  const m = createMonetisation({ adsEnabled: true, ...f.factories });
  await m.restoreOnForeground();
  assert.ok(f.calls.includes('billing.restore'));
});

test('ads enabled without factories is a loud error, not a silent no-ads build', () => {
  assert.throws(() => createMonetisation({ adsEnabled: true }), /createAds/);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  - ' + name); }
    catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
  }
  console.log('\n' + passed + '/' + tests.length + ' test(s) passed.');
  if (passed !== tests.length) process.exitCode = 1;
})();
