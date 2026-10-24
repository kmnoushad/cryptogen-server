import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFuturesUniverse } from '../src/futures-auto-strategy.js';

const now = Date.parse('2026-10-13T10:00:00Z');
function fixture() {
  const symbols = [], tickers = [];
  const add = (base, volume, change) => {
    const symbol = `${base}USDT`;
    symbols.push({ symbol, baseAsset: base, status: 'TRADING', contractType: 'PERPETUAL',
      quoteAsset: 'USDT', marginAsset: 'USDT', onboardDate: now - 60 * 86400000 });
    tickers.push({ symbol, quoteVolume: String(volume), count: '10000', lastPrice: '1', priceChangePercent: String(change) });
  };
  add('BTC', 1e9, 1);
  for (let i = 0; i < 40; i++) {
    add(`V${i}`, 500e6 - i * 1e6, 0);
    add(`F${i}`, 100e6 - i * 1e6, -10 - i / 10);
    add(`G${i}`, 50e6 - i * 1e5, 20 - i / 10);
    add(`R${i}`, 25e6 - i * 1e4, 5);
  }
  add('HOT', 150e6, 40); // Eligible for scanning, disallowed for long entries.
  return { exchangeInfo: { symbols }, tickers, now };
}

test('60-slot selection preserves 15 distinct risers, 15 fallers and 10 rotating symbols', () => {
  const input = fixture();
  const first = selectFuturesUniverse({ ...input, maxSymbols: 60, cursor: 0 });
  const second = selectFuturesUniverse({ ...input, maxSymbols: 60, cursor: 1 });
  assert.equal(first.symbols.length, 60);
  assert.equal(new Set(first.symbols).size, 60);
  assert.equal(first.symbols[0], 'BTCUSDT');
  assert.equal(first.symbols.slice(1, 20).filter(s => s.startsWith('V')).length, 19);
  assert.equal(first.symbols.slice(20, 35).filter(s => s.startsWith('F')).length, 15);
  assert.equal(first.symbols.slice(35, 50).filter(s => s.startsWith('G')).length, 15);
  assert.equal(first.symbols.slice(50).length, 10);
  assert.deepEqual(first.symbols.slice(0, 50), second.symbols.slice(0, 50));
  assert.notDeepEqual(first.symbols.slice(50), second.symbols.slice(50));
  assert.ok(!first.symbols.slice(35, 50).includes('HOTUSDT'));
  assert.ok(first.symbols.every(s => first.quality.has(s)));
});

test('overlapping volume leaders and risers do not waste their quotas', () => {
  const input = fixture();
  for (const row of input.tickers) if (row.symbol.startsWith('V')) row.priceChangePercent = '24';
  const u = selectFuturesUniverse({ ...input, maxSymbols: 60 });
  assert.equal(u.symbols.length, 60);
  assert.equal(new Set(u.symbols).size, 60);
  assert.equal(u.symbols.slice(35, 50).filter(s => s.startsWith('V')).length, 15);
  assert.equal(u.symbols.slice(50).length, 10);
});

test('rotation eventually visits every eligible contract under a stable market snapshot', () => {
  const input = fixture(), seen = new Set();
  for (let cursor = 0; cursor < 30; cursor++) {
    const u = selectFuturesUniverse({ ...input, maxSymbols: 60, cursor });
    u.symbols.forEach(s => seen.add(s));
  }
  assert.equal(seen.size, input.exchangeInfo.symbols.length);
});

test('empty long-eligible group releases its quota to rotation without weakening quality', () => {
  const input = fixture();
  input.exchangeInfo.symbols.forEach(s => s.onboardDate = now - 5 * 86400000);
  const u = selectFuturesUniverse({ ...input, maxSymbols: 60 });
  assert.equal(u.symbols.length, 60);
  assert.ok([...u.quality.values()].every(q => !q.longAllowed));
});

test('small, zero and oversized caps are respected', () => {
  for (const maxSymbols of [0, 1, 2, 40, 60, 120, 150]) {
    const u = selectFuturesUniverse({ ...fixture(), maxSymbols });
    assert.equal(u.symbols.length, Math.min(120, maxSymbols));
    assert.equal(new Set(u.symbols).size, u.symbols.length);
  }
  assert.match(selectFuturesUniverse({ ...fixture(), maxSymbols: NaN }).reason, /Invalid/);
});

test('small eligible universe is scanned once without duplicates', () => {
  const input = fixture();
  input.exchangeInfo.symbols = input.exchangeInfo.symbols.slice(0, 8);
  const u = selectFuturesUniverse({ ...input, maxSymbols: 60 });
  assert.equal(u.symbols.length, 8);
  assert.equal(new Set(u.symbols).size, 8);
});
