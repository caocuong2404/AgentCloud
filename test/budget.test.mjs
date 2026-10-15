import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveUsd, budgetAllows, monthKey } from '../src/budget.mjs';

test('standard-1 full-CPU worst-case is $0.074016 / hour', () => {
  assert.equal(reserveUsd('standard-1', 60), 0.074016);
});
test('standard-2 full-CPU worst-case is $0.129024 / hour', () => {
  assert.equal(reserveUsd('standard-2', 60), 0.129024);
});
test('reservation guard refuses budget exhaustion', () => {
  assert.equal(budgetAllows(3.9, 0.129024, 4), false);
  assert.equal(budgetAllows(3.7, 0.129024, 4), true);
});
test('reject oversized instances, arbitrary durations', () => {
  assert.throws(() => reserveUsd('standard-4', 60));
  assert.throws(() => reserveUsd('standard-1', 0));
  assert.throws(() => reserveUsd('standard-1', 999));
});
test('month keys are UTC', () => {
  assert.equal(monthKey(new Date('2026-10-15T07:00:00Z')), 'budget:2026-10');
});
