import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFadePerformance } from '../src/fade-performance.js';
import { readFadeIncome } from '../src/fade-risk.js';

const now = Date.parse('2026-09-26T12:00:00Z'), since = now - 7 * 86400000;
const cash = (symbol, incomeType, income, time, tranId) =>
  ({ symbol, incomeType, income: String(income), time, asset: 'USDT', tranId });

test('audit distinguishes deposits, realized drawdown, fee costs and verified job losses', () => {
  const first = now - 300000, second = now - 120000;
  const rows = [cash('', 'TRANSFER', 20, first - 1000, 1),
    cash('AAAUSDT', 'REALIZED_PNL', 4, first, 2),
    cash('AAAUSDT', 'COMMISSION', -1, first, 3),
    cash('BBBUSDT', 'REALIZED_PNL', -5, second, 4),
    cash('BBBUSDT', 'COMMISSION', -1, second, 5),
    cash('BBBUSDT', 'FUNDING_FEE', -0.5, second, 6)];
  const jobs = [
    { symbol: 'AAAUSDT', phase: 'CLOSED', filledQty: 1, createdAt: first - 30000,
      closedAt: first, closeReason: 'TP', peakOpenNet: 4.5 },
    { symbol: 'BBBUSDT', phase: 'CLOSED', filledQty: 1, createdAt: second - 30000,
      closedAt: second, closeReason: 'STOP_PRICE_REACHED' },
  ];
  const result = summarizeFadePerformance(rows, jobs, since, now);
  assert.equal(result.net, -3.5);
  assert.equal(result.peak, 3);
  assert.equal(result.currentGiveback, 6.5);
  assert.equal(result.maxRealizedDrawdown, 6.5);
  assert.equal(result.totals.COMMISSION, -2);
  assert.equal(result.count, 2); assert.equal(result.wins, 1); assert.equal(result.losses, 1);
  assert.equal(result.trades[0].peakSampledNet, 4.5);
  assert.equal(result.trades[1].peakSampledNet, null);
  assert.equal(result.otherOrOpenNet, 0);
});

test('unverified closed outcome is reported without counting it as a win', () => {
  const rows = [cash('AAAUSDT', 'COMMISSION', -0.1, now - 30000, 123),
    cash('AAAUSDT', 'COMMISSION', -0.1, now - 30000, 123)];
  const jobs = [{ symbol: 'AAAUSDT', phase: 'CLOSED', filledQty: 1, createdAt: now - 60000, closedAt: now - 1000 }];
  const result = summarizeFadePerformance(rows, jobs, since, now);
  assert.equal(result.net, -0.1);
  assert.equal(result.count, 0);
  assert.equal(result.trades[0].verified, false);
  assert.equal(result.otherOrOpenNet, -0.1);
  assert.throws(() => summarizeFadePerformance([cash('AAAUSDT', 'REALIZED_PNL', 'NaN', now - 1000)], [], since, now));
});

test('paginated audit errors instead of reporting incomplete exchange income', async () => {
  const requested = [];
  const exchange = { income: async p => {
    requested.push(p);
    return p.page === 1 ? Array(1000).fill(cash('AAAUSDT', 'COMMISSION', 0, now, 7)) : [];
  } };
  assert.equal((await readFadeIncome(exchange, since, now, 3)).length, 1000);
  assert.deepEqual(requested.map(p => p.page), [1, 2]);
  await assert.rejects(readFadeIncome({ income: async () => Array(1000).fill({}) }, since, now, 1),
    /pagination exceeded/);
});
