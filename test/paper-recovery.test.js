import test from 'node:test';
import assert from 'node:assert/strict';
import { AltcoinBreadth, applyPaperRecovery, summarizeBreadth, fifteenMinuteReturn,
  selectBreadthSymbols, breadthReasons } from '../src/paper-recovery.js';
import { Engine } from '../src/engine.js';
import { classifyBtcRegime } from '../src/binance.js';

const now = Date.parse('2026-09-14T13:26:00Z');
const symbols = Array.from({ length: 30 }, (_, i) => `ALT${i}USDT`);
const cfg = { paperMode: true, paper100Test: true, enablePaperBtcRecovery: true };
const btc = { allowed: false, regime: 'NO_LONG_EDGE', recoveryCandidate: true,
  recoveryBlockReasons: [], barCloseTime: Math.floor(now / 300000) * 300000 - 1,
  hourBarCloseTime: Math.floor(now / 3600000) * 3600000 - 1 };
const shock = { enabled: true, connected: true, stale: false, blocked: false,
  lastMessageAt: new Date(now).toISOString() };
const breadth = () => summarizeBreadth(symbols, symbols.map(() => 0.2), now, now);
const rows = () => Array.from({ length: 5 }, (_, i) => {
  const open = Math.floor(now / 300000) * 300000 + (i - 4) * 300000;
  const price = 100 + i;
  return [open, price, price, price, price, 100, open + 299999, 10000, 50, 60, 6000];
});

test('rising EMA50 below EMA200 is diagnosed without changing legacy classification', () => {
  const hourly = Array.from({ length: 220 }, (_, i) => ({ close: i < 180 ? 120 - i * 0.12 : 98.4 + (i - 180) * 0.15 }));
  const five = Array.from({ length: 80 }, (_, i) => ({ close: 104 + i * 0.005 }));
  const result = classifyBtcRegime(hourly, five);
  assert.equal(result.allowed, false);
  assert.equal(result.regime, 'NO_LONG_EDGE');
  assert.equal(result.recoveryCandidate, true);
  assert.match(result.blockReasons.join(';'), /EMA50 is not above EMA200/);
});

test('paper recovery opens only with all fresh confirmations', () => {
  const result = applyPaperRecovery(btc, breadth(), cfg, shock, now);
  assert.equal(result.allowed, true);
  assert.equal(result.regime, 'BULLISH_RECOVERY');
  assert.equal(result.baseAllowed, false);
});

for (const key of Object.keys(cfg)) test(`recovery cannot bypass disabled ${key}`, () => {
  assert.equal(applyPaperRecovery(btc, breadth(), { ...cfg, [key]: false }, shock, now).allowed, false);
});
for (const patch of [{ enabled: false }, { connected: false }, { stale: true },
  { blocked: true }, { lastMessageAt: null }, { lastMessageAt: new Date(now - 30001).toISOString() }]) {
  test(`recovery fails closed for shock health ${JSON.stringify(patch)}`, () => {
    assert.equal(applyPaperRecovery(btc, breadth(), cfg, { ...shock, ...patch }, now).allowed, false);
  });
}
for (const patch of [{ shock: true }, { regime: 'DATA_BLOCK' }, { recoveryCandidate: false },
  { barCloseTime: now - 330001 }, { hourBarCloseTime: now - 3630001 },
  { recoveryBlockReasons: ['falling trend'] }]) {
  test(`recovery fails closed for BTC ${JSON.stringify(patch)}`, () => {
    assert.equal(applyPaperRecovery({ ...btc, ...patch }, breadth(), cfg, shock, now).allowed, false);
  });
}
test('derived recovery permission expires and cannot become a legacy permission', () => {
  const active = applyPaperRecovery(btc, breadth(), cfg, shock, now);
  assert.equal(applyPaperRecovery(active, breadth(), cfg, shock, now + 90001).allowed, false);
  assert.equal(applyPaperRecovery(active, null, cfg, shock, now).allowed, false);
  assert.equal(applyPaperRecovery(active, breadth(), { ...cfg, paperMode: false }, shock, now).allowed, false);
});
test('legacy allowed regime remains unchanged without recovery data', () => {
  const result = applyPaperRecovery({ allowed: true, regime: 'BULLISH_RETEST' }, null, {}, null, now);
  assert.equal(result.allowed, true);
  assert.equal(result.regime, 'BULLISH_RETEST');
  assert.equal(result.recoveryActive, false);
});
test('breadth requires sample size, coverage, rising majority and positive median', () => {
  for (const returns of [Array(19).fill(0.2), Array(23).fill(0.2), Array(30).fill(-0.2),
    Array(30).fill(0.05), [...Array(17).fill(1), ...Array(13).fill(-1)]]) {
    assert.equal(summarizeBreadth(symbols, returns, now, now).allowed, false);
  }
  assert.equal(summarizeBreadth(symbols, Array(24).fill(0.2), now, now).allowed, true);
  assert.ok(breadthReasons({ ...breadth(), observedAt: now - 90001 }, now).length);
  assert.ok(breadthReasons({ ...breadth(), selectedAt: now - 600001 }, now).length);
  assert.ok(breadthReasons({ ...breadth(), barCloseTime: now - 330001 }, now).length);
});
test('15m breadth ignores open candles and rejects missing, old or discontinuous bars', () => {
  assert.ok(Math.abs(fifteenMinuteReturn(rows(), now) - 3) < 1e-8);
  const live = rows(); live[4][4] = 10000;
  assert.equal(fifteenMinuteReturn(live, now), fifteenMinuteReturn(rows(), now));
  assert.equal(fifteenMinuteReturn(rows().slice(1), now), null);
  const gap = rows(); gap[1][0] -= 300000; gap[1][6] -= 300000;
  assert.equal(fifteenMinuteReturn(gap, now), null);
  assert.equal(fifteenMinuteReturn(rows(), now + 600000), null);
});
const info = { symbols: symbols.map(symbol => ({ symbol, status: 'TRADING',
  contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN' })) };
const tickers = symbols.map(symbol => ({ symbol, quoteVolume: '30000000', priceChangePercent: '80' }));
test('breadth selects liquidity without filtering out winners', () => {
  assert.equal(selectBreadthSymbols(info, tickers, 15000000).length, 30);
  assert.equal(selectBreadthSymbols(info, tickers, 15000000, new Set(symbols.slice(0, 5))).length, 25);
  assert.equal(selectBreadthSymbols(info, tickers.map(t => ({ ...t, quoteVolume: '1000' })), 15000000).length, 0);
});
test('breadth API failures count against coverage; refresh throttles and stale universe closes', async () => {
  let calls = 0;
  const sampler = new AltcoinBreadth({ klines: async symbol => {
    calls++;
    if (symbols.slice(0, 7).includes(symbol)) throw new Error('offline');
    return rows();
  } });
  sampler.setUniverse(info, tickers, 15000000, new Set(), now);
  assert.equal((await sampler.refresh(now)).allowed, false);
  assert.equal(sampler.snapshot.valid, 23);
  await sampler.refresh(now + 1000);
  assert.equal(calls, 30);
  assert.equal((await sampler.refresh(now + 600001)).allowed, false);
  assert.equal(calls, 30);
});
test('manual scan reports already-running rather than zero symbols', async () => {
  const messages = [];
  const engine = new Engine({ cfg: { ownerChatId: '1' }, binance: {}, store: {},
    telegram: { send: async text => messages.push(text) } });
  engine.scanRunning = true;
  await engine.command({ chat: { id: 1 }, text: '/scan' });
  assert.match(messages.join('\n'), /already running/);
  assert.doesNotMatch(messages.join('\n'), /0 symbols in 0ms/);
});
