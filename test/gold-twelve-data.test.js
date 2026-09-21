import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTwelveDataBars } from '../src/gold/twelve-data.js';

test('Twelve Data values are normalized into ascending bars', () => {
  const bars = parseTwelveDataBars({ values: [
    { datetime: '2026-09-20 10:05:00', open: '2501', high: '2503', low: '2500', close: '2502' },
    { datetime: '2026-09-20 10:00:00', open: '2500', high: '2502', low: '2499', close: '2501' },
  ] });
  assert.equal(bars.length, 2);
  assert.equal(bars[0].close, 2501);
  assert.ok(bars[0].time < bars[1].time);
});

test('Twelve Data error payload becomes an exception', () => {
  assert.throws(() => parseTwelveDataBars({ status: 'error', message: 'bad key' }), /bad key/);
});

