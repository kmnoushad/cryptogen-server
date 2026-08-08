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
  const result = selectUniverse(exchangeInfo, tickers, { min24hQuoteVolumeUsd: 15_000_000, maxUniverse: 10 });
  assert.deepEqual(result.map(x => x.symbol), ['REALUSDT']);
});
