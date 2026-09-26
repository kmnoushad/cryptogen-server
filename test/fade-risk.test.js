import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeRiskDecision, gstDayStart, readFadeRisk } from '../src/fade-risk.js';
import { FadeEventGate, fadePositioningGate } from '../src/fade-entry-gates.js';
import { entryPlan } from '../src/fade-orders.js';

const now = Date.parse('2026-09-26T10:00:00Z');
const row = (incomeType, income, time = now - 60000, symbol = 'AAAUSDT') =>
  ({ asset: 'USDT', incomeType, income: String(income), time, symbol });
const job = (symbol, createdAt, closedAt) => ({ phase: 'CLOSED', filledQty: 1, symbol, createdAt, closedAt });

test('GST day boundary and daily cap count net income, not wallet transfers', () => {
  const start = gstDayStart(now);
  assert.equal(start, Date.parse('2026-09-25T20:00:00Z'));
  const rows = [row('REALIZED_PNL', -2, start + 1), row('COMMISSION', -1, start + 2),
    row('REALIZED_PNL', -100, start - 1), row('TRANSFER', 1000, start + 2)];
  assert.match(fadeRiskDecision({ rows, jobs: [], equity: 100, now }).reason, /Daily net loss/);
  assert.equal(fadeRiskDecision({ rows: rows.slice(2), jobs: [], equity: 100, now }).allowed, true);
});

test('two verified losing closes block four hours; a verified winner breaks streak', () => {
  const a = job('AAAUSDT', now - 1200000, now - 1000000);
  const b = job('BBBUSDT', now - 600000, now - 400000);
  const rows = [row('REALIZED_PNL', -0.5, a.closedAt, a.symbol), row('COMMISSION', -0.1, a.createdAt, a.symbol),
    row('REALIZED_PNL', -0.6, b.closedAt, b.symbol), row('COMMISSION', -0.1, b.createdAt, b.symbol)];
  assert.match(fadeRiskDecision({ rows, jobs: [a, b], equity: 100, now }).reason, /Two consecutive losses/);
  assert.equal(fadeRiskDecision({ rows: [...rows.slice(0, 2), row('REALIZED_PNL', 1, b.closedAt, b.symbol), rows.at(-1)],
    jobs: [a, b], equity: 100, now }).allowed, true);
  assert.equal(fadeRiskDecision({ rows: [row('COMMISSION', -0.1, b.createdAt, b.symbol)],
    jobs: [b], equity: 100, now }).allowed, false);
  assert.equal(fadeRiskDecision({ rows: [], jobs: [a, b], equity: 100, now: now + 5 * 3600000 }).allowed, true);
  const earlierLoss = job('CCCUSDT', now - 6 * 3600000, now - 5 * 3600000);
  const recentLoss = job('DDDUSDT', now - 600000, now - 400000);
  const spreadRows = [row('REALIZED_PNL', -0.5, earlierLoss.closedAt, earlierLoss.symbol),
    row('COMMISSION', -0.1, earlierLoss.createdAt, earlierLoss.symbol),
    row('REALIZED_PNL', -0.5, recentLoss.closedAt, recentLoss.symbol),
    row('COMMISSION', -0.1, recentLoss.createdAt, recentLoss.symbol)];
  assert.match(fadeRiskDecision({ rows: spreadRows, jobs: [earlierLoss, recentLoss], equity: 100, now }).reason,
    /Two consecutive losses/);
});

test('exchange income is paged and a truncated history fails closed', async () => {
  const calls = [];
  const exchange = { income: async p => { calls.push(p); return calls.length === 1 ? Array(1000).fill(row('TRANSFER', 10)) : []; } };
  const result = await readFadeRisk(exchange, [], 100, now);
  assert.equal(result.allowed, true);
  assert.deepEqual(calls.map(c => c.page), [1, 2]);
  assert.equal((await readFadeRisk({ income: async () => null }, [], 100, now)).allowed, false);
  const old = job('AAAUSDT', now - 8 * 86400000, now - 300000);
  assert.match((await readFadeRisk(exchange, [old], 100, now)).reason, /older than seven days/);
});

test('OI spike, stale samples, stale or extreme funding and settlement block entry', () => {
  const oi = Array.from({ length: 5 }, (_, i) => ({ symbol: 'AAAUSDT', timestamp: now - (4 - i) * 300000,
    sumOpenInterestValue: String(1000 + i) }));
  const f = { symbol: 'AAAUSDT', time: now, lastFundingRate: '0.0001', nextFundingTime: now + 3600000 };
  assert.equal(fadePositioningGate(oi, f, 'AAAUSDT', now).allowed, true);
  assert.match(fadePositioningGate(oi.map((x, i) => ({ ...x, sumOpenInterestValue: i === 4 ? 1100 : x.sumOpenInterestValue })), f, 'AAAUSDT', now).reason, /OI expansion/);
  assert.equal(fadePositioningGate(oi, { ...f, lastFundingRate: '0.0008' }, 'AAAUSDT', now).allowed, false);
  assert.equal(fadePositioningGate(oi, { ...f, nextFundingTime: now + 60000 }, 'AAAUSDT', now).allowed, false);
  assert.equal(fadePositioningGate(oi, { ...f, time: now - 100000 }, 'AAAUSDT', now).allowed, false);
  assert.equal(fadePositioningGate(oi, f, 'AAAUSDT', now + 11 * 60000).allowed, false);
});

test('economic feed outages and event windows block, no key never means clear', async () => {
  const feed = { economicCalendar: [{ country: 'US', impact: 'high', event: 'US CPI', time: new Date(now + 30 * 60000).toISOString() }] };
  const gate = new FadeEventGate({ cfg: { finnhubKey: 'fake-test-key' }, now: () => now, fetcher: async () => feed });
  assert.match((await gate.check()).reason, /US CPI/);
  const clear = new FadeEventGate({ cfg: { finnhubKey: 'fake-test-key' }, now: () => now,
    fetcher: async () => ({ economicCalendar: [{ country: 'US', impact: 'high', event: 'US jobs', time: new Date(now + 2 * 3600000).toISOString() }] }) });
  assert.equal((await clear.check()).allowed, true);
  const empty = new FadeEventGate({ cfg: { finnhubKey: 'fake-test-key' }, now: () => now,
    fetcher: async () => ({ economicCalendar: [] }) });
  assert.equal((await empty.check()).allowed, false);
  const failed = new FadeEventGate({ cfg: { finnhubKey: 'fake-test-key' }, now: () => now,
    fetcher: async () => { throw Error('401'); } });
  assert.equal((await failed.check()).allowed, false);
  assert.equal((await new FadeEventGate({ cfg: {}, now: () => now }).check()).allowed, false);
});

test('late chase is skipped rather than moving stop above the peak', () => {
  const info = { filters: [
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
    { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
    { filterType: 'PRICE_FILTER', tickSize: '0.001', minPrice: '0.001', maxPrice: '100000' },
    { filterType: 'MIN_NOTIONAL', notional: '5' },
  ] };
  const signal = { price: 100, resistance: 100.8, barCloseTime: now - 1000 };
  const plan = entryPlan({ signal, bid: 100, ask: 100.01, info, fee: 0.0005, available: 100, equity: 100, now });
  assert.ok(plan.stop < signal.resistance && plan.riskDollars <= 0.5);
  assert.throws(() => entryPlan({ signal: { ...signal, price: 99, resistance: 100.8 }, bid: 99,
    ask: 99.01, info, fee: 0.0005, available: 100, equity: 100, now }), /Stale, extended/);
});
