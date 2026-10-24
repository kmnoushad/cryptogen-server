import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSignals, summarize } from '../scripts/futures-backtest.js';
import { simulateTrade } from '../scripts/fast-mover-study.js';

const now = Date.parse('2026-09-30T12:07:00Z');
function rows(interval, n, lastEnd, price) {
  return Array.from({ length: n }, (_, i) => {
    const close = price(i), t = lastEnd - (n - 1 - i) * interval - interval + 1;
    return [t, close - .02, close + .04, close - .04, close, 100, t + interval - 1, 10000, 0, 0, 6000];
  });
}
const floats = rs => new Float64Array(rs.flatMap(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[7], r[10]]));
test('research replays the current signal when hourly trend is neutral', () => {
  const m15 = rows(900000, 121, Date.parse('2026-09-30T12:00:00Z') - 1, i => 90 + i * .05);
  m15.at(-1)[4] = 96.03; m15.at(-1)[2] = 96.06; m15.at(-1)[5] = 150;
  const h1 = rows(3600000, 121, Date.parse('2026-09-30T12:00:00Z') - 1, () => 96);
  const m1 = rows(60000, 150, now + 3 * 60000 - 1, () => 96.01);
  const retest = m1.find(r => r[0] === now - 2 * 60000);
  Object.assign(retest, { 1: 95.99, 2: 96, 3: 95.98, 4: 95.99 });
  const reclaim = m1.find(r => r[0] === now - 60000);
  Object.assign(reclaim, { 1: 96, 2: 96.05, 3: 96, 4: 96.025 });
  const series = { m1: floats(m1), m15: floats(m15), h1: floats(h1) };
  const { events } = computeSignals({ BTCUSDT: series, ETHUSDT: series }, ['ETHUSDT']);
  assert.ok(events.ETHUSDT.some(e => e.current?.allowed));
  assert.equal(events.ETHUSDT.filter(e => e.live).length, 0);
});
test('dollar profit factor is distinct from risk-normalized expectancy', () => {
  const result = summarize([{ pnl: 1, R: 2 }, { pnl: -4, R: -1 }]);
  assert.equal(result.pf, .25);
  assert.equal(result.avgR, .5);
  assert.equal(result.usd, -3);
});
test('alert study refuses truncated horizons and malformed candles', () => {
  const variant = { side: 'LONG', stopPct: 1, targetR: 1.5, be: true, holdMin: 5 };
  const valid = () => ({ open: 100, high: 100.2, low: 99.8, close: 100 });
  assert.equal(simulateTrade(valid, 3, 0, variant), null);
  assert.equal(simulateTrade(() => ({ ...valid(), high: NaN }), 5, 0, variant), null);
  assert.equal(simulateTrade(valid, 5, 0, variant).reason, 'TIME');
});
test('ambiguous stop and target candle is conservatively a stop', () => {
  const variant = { side: 'SHORT', stopPct: 1, targetR: 1.5, be: true, holdMin: 1 };
  const outcome = simulateTrade(() => ({ open: 100, high: 103, low: 97, close: 100 }), 1, 0, variant);
  assert.equal(outcome.reason, 'STOP');
  assert.ok(outcome.R < -1);
});
