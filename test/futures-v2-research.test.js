import test from 'node:test';
import assert from 'node:assert/strict';
import { trendPullbackSignal, emaSeries, atr } from '../scripts/futures-v2-research.js';

const now = Date.parse('2026-10-01T00:00:30Z');
const row = (t, ms, [o, h, l, c]) => [t, o, h, l, c, 10, t + ms - 1, c * 10, 0, 0, c * 5, 0];
const series = (bars, ms, at = now) => bars.map((b, i) => row(at - 30000 - (bars.length - i) * ms, ms, b));
const trendBars = (n, step) => { let c = 100; return Array.from({ length: n }, () => { const o = c; c = o * (1 + step); return [o, Math.max(o, c) * 1.001, Math.min(o, c) * .999, c]; }); };
const flatBars = n => Array.from({ length: n }, () => [100, 100.05, 99.95, 100]);
const invert = bars => bars.map(([o, h, l, c]) => [10000 / o, 10000 / l, 10000 / h, 10000 / c]);
function longSetup(extendBy = .2) {
  const bars = []; let c = 100;
  for (let i = 0; i < 111; i++) { const o = c; c = o * 1.003; bars.push([o, c * 1.001, o * .999, c]); }
  for (let i = 0; i < 8; i++) { const o = c; c = o * .997; bars.push([o, o * 1.0005, c * .9985, c]); }
  const e20 = emaSeries(bars.map(b => b[3]), 20).at(-1), a = atr(bars.map(b => ({ open: b[0], high: b[1], low: b[2], close: b[3] })));
  const close = Math.max(bars.at(-1)[1] * 1.001, e20 + extendBy * a);
  bars.push([c, close * 1.0005, c * .999, close]);
  return bars;
}
const base = (m15Bars, over = {}) => ({ symbol: 'ETHUSDT', m15: series(m15Bars, 900000), h1: series(trendBars(120, .002), 3600000),
  btc1h: series(flatBars(120), 3600000), btc15: series(flatBars(120), 900000), now, ...over });

test('v2: 1h uptrend + 15m pullback to EMA20 + resumption bar gives a LONG with a stop at least 1 ATR away', () => {
  const s = trendPullbackSignal(base(longSetup()));
  assert.equal(s.allowed, true); assert.equal(s.direction, 'LONG');
  assert.ok(s.entry - s.stop >= s.atr * .999, 'stop must be outside normal 15m noise');
});
test('v2: SHORT is the exact mirror', () => {
  const s = trendPullbackSignal(base(invert(longSetup()), { h1: series(invert(trendBars(120, .002)), 3600000) }));
  assert.equal(s.allowed, true); assert.equal(s.direction, 'SHORT'); assert.ok(s.stop - s.entry >= s.atr * .999);
});
test('v2: no 1h trend, opposing BTC 1h trend, or opposing relative strength -> no trade', () => {
  assert.match(trendPullbackSignal(base(longSetup(), { h1: series(flatBars(120), 3600000) })).reason, /1h trend not confirmed/);
  assert.match(trendPullbackSignal(base(longSetup(), { btc1h: series(invert(trendBars(120, .002)), 3600000) })).reason, /BTC 1h opposes/);
  assert.match(trendPullbackSignal(base(longSetup(), { btc15: series(trendBars(120, .01), 900000) })).reason, /relative strength/);
});
test('v2: only evaluated on the minute a 15m bar closes; extended entries are skipped', () => {
  assert.match(trendPullbackSignal(base(longSetup(), { now: now + 120000 })).reason, /fresh 15m close/);
  assert.match(trendPullbackSignal(base(longSetup(3))).reason, /extended/);
});
