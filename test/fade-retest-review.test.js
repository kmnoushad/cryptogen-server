import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFadeRetest } from '../src/fade-retest-review.js';

const start = Date.parse('2026-09-30T01:00:00Z');
const signal = { price: 97, resistance: 100, barCloseTime: start - 1 };
const candles = peaks => peaks.map((peak, i) => [start + i * 60000, 97, peak, 96, 97, '1', start + i * 60000 + 59999]);
test('a later return to the 1% band is observed without treating it as a fill', () => {
  assert.equal(reviewFadeRetest(signal, candles([98, 99.2, 99.4]), 3), 'retested_band_first');
  assert.equal(reviewFadeRetest(signal, candles([98, 98.5, 98.7]), 3), 'no_retest');
});
test('invalidation before or within a retest candle takes priority', () => {
  assert.equal(reviewFadeRetest(signal, candles([100.1, 99.2]), 2), 'invalidated_first');
  assert.equal(reviewFadeRetest(signal, candles([98, 100.1]), 2), 'invalidated_first');
});
test('missing or discontinuous candles cannot create a retest observation', () => {
  const rows = candles([98, 99.2, 98]); rows[1][0] += 60000;
  assert.equal(reviewFadeRetest(signal, rows, 3), 'unknown');
  assert.equal(reviewFadeRetest(signal, rows.slice(0, 2), 3), 'unknown');
});
