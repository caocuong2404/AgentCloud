import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveUsd, budgetAllows, monthKey, SIZES, RATES_USD_PER_HOUR,
} from '../src/budget.mjs';

// ---------------------------------------------------------------------------
// reserveUsd — rate table and rounding
// ---------------------------------------------------------------------------

test('SIZES exposes exactly standard-1 and standard-2', () => {
  assert.deepEqual(Object.keys(SIZES).sort(), ['standard-1', 'standard-2']);
  assert.equal(SIZES['standard-1'].vcpu, 0.5);
  assert.equal(SIZES['standard-1'].memoryGiB, 4);
  assert.equal(SIZES['standard-1'].diskGB, 8);
  assert.equal(SIZES['standard-2'].vcpu, 1);
  assert.equal(SIZES['standard-2'].memoryGiB, 6);
  assert.equal(SIZES['standard-2'].diskGB, 12);
});

test('SIZES and rates are frozen against mutation', () => {
  assert.ok(Object.isFrozen(SIZES));
  assert.ok(Object.isFrozen(SIZES['standard-1']));
  assert.ok(Object.isFrozen(RATES_USD_PER_HOUR));
});

test('standard-1 full hour is $0.074016 (documents rate table)', () => {
  // 4*0.009 + 0.5*0.072 + 8*0.000252 = 0.036 + 0.036 + 0.002016
  assert.equal(reserveUsd('standard-1', 60), 0.074016);
});

test('standard-2 full hour is $0.129024 (documents rate table)', () => {
  // 6*0.009 + 1*0.072 + 12*0.000252 = 0.054 + 0.072 + 0.003024
  assert.equal(reserveUsd('standard-2', 60), 0.129024);
});

test('reserve scales linearly with minutes', () => {
  assert.equal(reserveUsd('standard-1', 30), 0.037008);
  assert.equal(reserveUsd('standard-1', 15), 0.018504);
  assert.equal(reserveUsd('standard-2', 30), 0.064512);
});

test('1-minute lease is the smallest allowed and rounds up to micro-dollars', () => {
  const one = reserveUsd('standard-1', 1);
  assert.equal(one, 0.001234); // 0.074016/60 = 0.0012336 → ceil to 6dp
  assert.ok(one > 0);
});

test('120-minute lease is the largest allowed', () => {
  assert.equal(reserveUsd('standard-1', 120), 0.148032);
  assert.equal(reserveUsd('standard-2', 120), 0.258048);
});

test('micro-dollar rounding always ceils, never under-reserves', () => {
  for (const size of ['standard-1', 'standard-2']) {
    for (const minutes of [1, 7, 13, 29, 45, 59, 60, 61, 90, 119, 120]) {
      const usd = reserveUsd(size, minutes);
      const exact = (
        SIZES[size].memoryGiB * RATES_USD_PER_HOUR.memoryGiB
        + SIZES[size].vcpu * RATES_USD_PER_HOUR.vcpu
        + SIZES[size].diskGB * RATES_USD_PER_HOUR.diskGB
      ) * (minutes / 60);
      assert.ok(usd >= exact, `${size}/${minutes} under-reserved`);
      assert.ok(usd - exact < 1e-6, `${size}/${minutes} over-rounded`);
    }
  }
});

test('lease lengths used by the Worker (60min) stay under the $4 POC cap alone', () => {
  assert.ok(reserveUsd('standard-2', 60) < 4);
  assert.ok(reserveUsd('standard-1', 60) < 0.10);
});

test('rejects unknown instance sizes', () => {
  for (const size of ['standard-4', 'standard-0', 'STANDARD-1', 'standard-1 ', '', 'large', '1']) {
    assert.throws(() => reserveUsd(size, 60), /Unsupported/, `size=${JSON.stringify(size)}`);
  }
});

test('rejects missing/nullish size', () => {
  assert.throws(() => reserveUsd(undefined, 60));
  assert.throws(() => reserveUsd(null, 60));
});

test('rejects non-integer minutes', () => {
  for (const minutes of [0.5, 1.5, 60.1, NaN, Infinity, -Infinity, '60', null, undefined, true]) {
    assert.throws(() => reserveUsd('standard-1', minutes), /Unsupported/, `minutes=${String(minutes)}`);
  }
});

test('rejects out-of-range lease durations', () => {
  for (const minutes of [0, -1, -60, 121, 1000, 999]) {
    assert.throws(() => reserveUsd('standard-1', minutes), /Unsupported/, `minutes=${minutes}`);
  }
});

test('boundary minutes 1 and 120 are accepted, 0 and 121 are not', () => {
  assert.doesNotThrow(() => reserveUsd('standard-1', 1));
  assert.doesNotThrow(() => reserveUsd('standard-1', 120));
  assert.throws(() => reserveUsd('standard-1', 0));
  assert.throws(() => reserveUsd('standard-1', 121));
});

// ---------------------------------------------------------------------------
// monthKey
// ---------------------------------------------------------------------------

test('monthKey uses UTC year-month', () => {
  assert.equal(monthKey(new Date('2026-10-15T07:00:00Z')), 'budget:2026-10');
  assert.equal(monthKey(new Date('2026-01-01T00:00:00Z')), 'budget:2026-01');
  assert.equal(monthKey(new Date('2026-12-31T23:59:59Z')), 'budget:2026-12');
});

test('monthKey flips at the UTC month boundary even in other local zones', () => {
  // 2026-11-01T00:30:00Z is still October in e.g. UTC-5, but monthKey must be November.
  assert.equal(monthKey(new Date('2026-11-01T00:30:00Z')), 'budget:2026-11');
  assert.equal(monthKey(new Date('2026-10-31T23:59:59Z')), 'budget:2026-10');
});

test('monthKey defaults to now and always returns the budget: prefix', () => {
  const key = monthKey();
  assert.match(key, /^budget:\d{4}-\d{2}$/);
});

test('monthKey is stable across repeated calls in the same month', () => {
  const a = new Date('2026-06-10T12:00:00Z');
  const b = new Date('2026-06-20T12:00:00Z');
  assert.equal(monthKey(a), monthKey(b));
});

// ---------------------------------------------------------------------------
// budgetAllows
// ---------------------------------------------------------------------------

test('budgetAllows accepts usage exactly at the limit', () => {
  assert.equal(budgetAllows(3.9, 0.1, 4), true);
  assert.equal(budgetAllows(4, 0, 4), true);
  assert.equal(budgetAllows(0, 4, 4), true);
});

test('budgetAllows refuses anything past the limit', () => {
  assert.equal(budgetAllows(3.9, 0.129024, 4), false);
  assert.equal(budgetAllows(4, 0.000001, 4), false);
  assert.equal(budgetAllows(5, 0, 4), false);
});

test('budgetAllows tolerates float noise just under the limit', () => {
  // 3.999999999 + 1e-10 must still pass against 4 with the 1e-9 epsilon.
  assert.equal(budgetAllows(3.999999999, 0.000000001, 4), true);
});

test('budgetAllows rejects zero or negative budget', () => {
  assert.equal(budgetAllows(0, 0, 0), false);
  assert.equal(budgetAllows(0, 0, -1), false);
});

test('budgetAllows rejects non-finite inputs', () => {
  for (const [used, reservation, budget] of [
    [NaN, 0, 4], [0, NaN, 4], [0, 0, NaN],
    [Infinity, 0, 4], [0, Infinity, 4], [0, 0, Infinity],
    [-Infinity, 0, 4], [0, -Infinity, 4], [0, 0, -Infinity],
  ]) {
    assert.equal(budgetAllows(used, reservation, budget), false,
      `used=${used} reservation=${reservation} budget=${budget}`);
  }
});

test('budgetAllows rejects negative used/reservation', () => {
  assert.equal(budgetAllows(-1, 1, 4), false);
  assert.equal(budgetAllows(0, -1, 4), false);
});

test('budgetAllows is the conservative guard the Worker relies on', () => {
  const s1 = reserveUsd('standard-1', 60); // 0.074016
  const s2 = reserveUsd('standard-2', 120); // 0.258048
  // First start of the month: nothing used yet, full reservation fits.
  assert.equal(budgetAllows(0, s1, 4), true);
  // After many leases: room for one more standard-1 hour, not a 2h standard-2.
  assert.equal(budgetAllows(3.9, s1, 4), true);   // 3.974016 <= 4
  assert.equal(budgetAllows(3.9, s2, 4), false);  // 4.158048 > 4
  assert.equal(budgetAllows(3.95, s1, 4), false); // 4.024016 > 4
});
