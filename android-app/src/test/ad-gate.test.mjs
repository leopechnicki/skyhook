/*
 * Unit tests for the ad-gate counter logic. Pure Node, no device needed.
 * Run: node src/test/ad-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { createAdGate } from '../native/ad-gate.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

// --- fires on every 5th game-over ---
test('fires on the 5th, 10th, 15th game-over and no other', () => {
  const fired = [];
  let n = 0;
  const gate = createAdGate({ interval: 5, showInterstitial: () => fired.push(++n && gate.getCount()) });
  const firedOn = [];
  const g2 = createAdGate({ interval: 5, showInterstitial: () => firedOn.push(g2.getCount()) });
  for (let i = 1; i <= 17; i++) g2.onGameOver();
  assert.deepEqual(firedOn, [5, 10, 15]);
});

test('onGameOver returns true exactly on the interval boundary', () => {
  const gate = createAdGate({ interval: 5, showInterstitial: () => {} });
  const results = [];
  for (let i = 1; i <= 10; i++) results.push(gate.onGameOver());
  assert.deepEqual(results, [false, false, false, false, true, false, false, false, false, true]);
});

// --- ad-free entitlement disables the gate ---
test('never fires while ad-free, and does not advance the counter', () => {
  let adFree = true;
  let fires = 0;
  const gate = createAdGate({ interval: 5, isAdFree: () => adFree, showInterstitial: () => fires++ });
  for (let i = 0; i < 20; i++) gate.onGameOver();
  assert.equal(fires, 0);
  assert.equal(gate.getCount(), 0, 'counter must not advance while ad-free');
});

test('losing entitlement resumes clean cadence (no catch-up burst)', () => {
  let adFree = true;
  const firedOn = [];
  const gate = createAdGate({ interval: 5, isAdFree: () => adFree, showInterstitial: () => firedOn.push(gate.getCount()) });
  for (let i = 0; i < 7; i++) gate.onGameOver();   // ad-free: nothing counted
  assert.equal(gate.getCount(), 0);
  adFree = false;                                   // e.g. refund
  for (let i = 0; i < 5; i++) gate.onGameOver();    // now the 5th fires
  assert.deepEqual(firedOn, [5]);
});

// --- custom interval + robustness ---
test('respects a custom interval', () => {
  const firedOn = [];
  const gate = createAdGate({ interval: 3, showInterstitial: () => firedOn.push(gate.getCount()) });
  for (let i = 0; i < 9; i++) gate.onGameOver();
  assert.deepEqual(firedOn, [3, 6, 9]);
});

test('rejects a non-positive / non-integer interval', () => {
  assert.throws(() => createAdGate({ interval: 0 }));
  assert.throws(() => createAdGate({ interval: -5 }));
  assert.throws(() => createAdGate({ interval: 2.5 }));
});

test('a throwing showInterstitial does not break the counter', () => {
  let calls = 0;
  const gate = createAdGate({ interval: 5, showInterstitial: () => { calls++; throw new Error('boom'); }, onError: () => {} });
  for (let i = 0; i < 10; i++) gate.onGameOver();
  assert.equal(calls, 2, 'still attempts on 5th and 10th despite throwing');
  assert.equal(gate.getCount(), 10);
});

test('reset() zeroes the counter', () => {
  const gate = createAdGate({ interval: 5, showInterstitial: () => {} });
  for (let i = 0; i < 4; i++) gate.onGameOver();
  gate.reset();
  assert.equal(gate.getCount(), 0);
});

console.log('\n' + passed + ' test(s) passed.');
