import test from 'node:test';
import assert from 'node:assert/strict';
import { selectUniverse } from '../src/binance.js';

test('universe uses exchange metadata to reject memes and TradFi contracts', () => {
  const exchangeInfo = { symbols: [
    { symbol: 'REALUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', underlyingSubType: ['DeFi'] },
    { symbol: 'NEWMEMEUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', underlyingSubType: ['Meme'] },
    { symbol: 'STOCKUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'EQUITY', underlyingSubType: ['TradFi'] },
  ] };
  const tickers = ['REALUSDT', 'NEWMEMEUSDT', 'STOCKUSDT'].map(symbol => ({
    symbol, quoteVolume: '20000000', priceChangePercent: '1', lastPrice: '1',
  }));
  const result = selectUniverse(exchangeInfo, tickers, {
    min24hQuoteVolumeUsd: 15_000_000,
    maxUniverse: 10,
    maxUniverse24hGainPct: 15,
    universeMomentumSlotsPct: 30,
  });
  assert.deepEqual(result.map(x => x.symbol), ['REALUSDT']);
});

test('universe reserves slots for accelerating liquid contracts', () => {
  const symbols = ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'];
  const exchangeInfo = { symbols: symbols.map(symbol => ({
    symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', underlyingSubType: ['DeFi'],
  })) };
  const tickers = symbols.map((symbol, index) => ({
    symbol, quoteVolume: String(100_000_000 - index * 20_000_000), priceChangePercent: '2', lastPrice: '1',
  }));
  const cfg = {
    min24hQuoteVolumeUsd: 15_000_000, maxUniverse: 3, maxUniverse24hGainPct: 15, universeMomentumSlotsPct: 34,
  };
  const acceleration = new Map([['DUSDT', 1.5]]);
  const result = selectUniverse(exchangeInfo, tickers, cfg, new Set(), acceleration);
  assert.equal(result.length, 3);
  assert.ok(result.some(item => item.symbol === 'DUSDT'));
});
