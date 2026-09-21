import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeGoldBars, atr, emaSeries, rsi } from '../src/gold/indicators.js';

const makeBars = () => Array.from({ length: 80 }, (_, index) => {
  const base = 2_500 + (index * 1.2);
  return {
    time: 1_700_000_000_000 + (index * 300_000),
    open: base - 0.4,
    high: base + 1.2,
    low: base - 1.1,
    close: base + 0.5,
  };
});

test('indicator primitives return finite values', () => {
  const bars = makeBars();
  const closes = bars.map((bar) => bar.close);
  assert.ok(Number.isFinite(emaSeries(closes, 20).at(-1)));
  assert.ok(Number.isFinite(rsi(closes)));
  assert.ok(Number.isFinite(atr(bars)));
});

test('gold analysis returns levels and a bounded confidence', () => {
  const analysis = analyzeGoldBars(makeBars());
  assert.equal(analysis.ready, true);
  assert.ok(analysis.support < analysis.resistance);
  assert.ok(analysis.confidence >= 0 && analysis.confidence <= 100);
  assert.ok(['LONG', 'SHORT', 'NONE'].includes(analysis.direction));
});

