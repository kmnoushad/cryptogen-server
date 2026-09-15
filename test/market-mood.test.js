import test from 'node:test';
import assert from 'node:assert/strict';
import { marketAssessment, marketReport, MarketMood } from '../src/market-mood.js';
import { summarizeBreadth } from '../src/paper-recovery.js';
const now = Date.parse('2026-09-15T08:26:00Z');
const symbols = Array.from({ length: 30 }, (_, i) => `ALT${i}`);
const btc = (score = 35) => ({ at: now, stale: false,
  h15: { score, label: score > 0 ? 'UP' : 'DOWN', drivers: ['flow'] },
  h30: { score, label: score > 0 ? 'UP' : 'DOWN' }, indicators: { fundingPct: -0.04, buyRatio15m: 0.4, oiChgPct: 0.1 } });
const breadth = (n = 0.2) => summarizeBreadth(symbols, Array(30).fill(n), now, now);
const health = { enabled: true, configured: true, lastError: null, lastFetchAt: new Date(now).toISOString() };

test('bullish and bearish agreement, mixed divergence and no forecast probability', () => {
  assert.equal(marketAssessment(btc(), breadth(), now).mood, 'BULLISH');
  assert.equal(breadth(-0.2).allowed, false);
  assert.equal(marketAssessment(btc(-35), breadth(-0.2), now).mood, 'BEARISH');
  assert.equal(marketAssessment(btc(), breadth(-0.2), now).mood, 'MIXED / SIDEWAYS');
  const report = marketReport({ btc: btc(), breadth: breadth(), calendarHealth: health }, now);
  assert.match(report, /not a price forecast or probability/);
  assert.match(report, /short crowding\/squeeze risk/);
});
test('stale, missing and low-coverage data cannot establish direction', () => {
  for (const b of [null, { ...btc(), stale: true }, { ...btc(), at: now - 180001 }]) {
    assert.equal(marketAssessment(b, breadth(), now).mood, 'INSUFFICIENT DATA');
  }
  for (const b of [null, { ...breadth(), observedAt: now - 90001 },
    { ...breadth(), valid: 19 }, { ...breadth(), valid: 23 }, { ...breadth(), selectedAt: now - 600001 }]) {
    assert.equal(marketAssessment(btc(), b, now).mood, 'INSUFFICIENT DATA');
  }
});
test('calendar HTTP401 with no events is unknown risk, never all-clear', () => {
  const report = marketReport({ btc: btc(), breadth: breadth(), calendarHealth: { ...health, lastError: 'HTTP 401' } }, now);
  assert.match(report, /Event risk: UNKNOWN/);
  assert.match(report, /empty calendar does not mean no events/);
  assert.doesNotMatch(report, /No loaded high-impact release within/);
});
test('near releases change event risk, not market direction; GST times and HTML escaping', () => {
  const report = marketReport({ btc: btc(-35), breadth: breadth(-0.2), calendarHealth: health,
    events: [{ name: 'CPI <test>', eventTime: now + 30 * 60000 }] }, now);
  assert.match(report, /BEARISH/);
  assert.match(report, /Event risk: ELEVATED/);
  assert.match(report, /12:56 GST/);
  assert.match(report, /CPI &lt;test&gt;/);
  assert.match(report, /Actual results, expectations and the market reaction are not evaluated/);
});
test('recent release remains event risk and stale calendar retains marked cached events', () => {
  const input = { btc: btc(), breadth: breadth(), calendarHealth: health,
    events: [{ name: 'Employment', eventTime: now - 5 * 60000 }] };
  assert.match(marketReport(input, now), /just released/);
  assert.match(marketReport(input, now), /Event risk: ELEVATED/);
  const report = marketReport({ ...input, calendarHealth: { ...health, lastFetchAt: new Date(now - 86400001).toISOString() } }, now);
  assert.match(report, /Event risk: UNKNOWN/);
  assert.match(report, /cached times are unverified/);
});
test('concurrent requests share one refresh; repeat requests throttle; errors are visible', async () => {
  let calls = 0;
  const mood = new MarketMood({ cfg: { enableBtcFeed: true }, now: () => now,
    binance: { exchangeInfo: async () => { calls++; throw Error('REST unavailable'); }, ticker24h: async () => [] },
    btcBias: { evaluate: () => btc() }, calendar: { configured: () => false, health: () => ({ configured: false }) } });
  const reports = await Promise.all([mood.report(), mood.report()]);
  await mood.report();
  assert.equal(calls, 1);
  assert.match(reports[0], /REST unavailable/);
  assert.match(reports[1], /INSUFFICIENT DATA/);
});
