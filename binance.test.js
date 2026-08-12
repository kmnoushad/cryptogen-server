import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBtcRegime, selectUniverse } from '../src/binance.js';
import { ema } from '../src/indicators.js';

const candlesFromCloses = (closes, intervalMs) => closes.map((close, index) => ({
  openTime: index * intervalMs,
  closeTime: (index + 1) * intervalMs - 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  quoteVolume: close,
  trades: 1,
  takerBuyVolume: 0.5,
  takerBuyQuoteVolume: close * 0.5,
}));

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

test('BTC remains long-eligible during a shallow EMA50 support retest', () => {
  const hourCloses = Array.from({ length: 220 }, (_, index) => 100 + index * 0.1);
  const hourly = candlesFromCloses(hourCloses, 60 * 60_000);
  const ema50 = ema(hourCloses, 50);
  const fiveCloses = Array.from({ length: 80 }, (_, index) => ema50 * (0.996 + index * 0.003 / 79));
  const five = candlesFromCloses(fiveCloses, 5 * 60_000);
  const result = classifyBtcRegime(hourly, five, { ema50RetestBufferPct: 0.35 });
  assert.equal(result.htfTrend, false);
  assert.equal(result.supportRetest, true);
  assert.equal(result.microTrend, true);
  assert.equal(result.allowed, true);
  assert.equal(result.regime, 'BULLISH_RETEST');
});

test('BTC support retest tolerates only a nearly flat six-hour EMA50 slope', () => {
  const classifyWithDecline = decline => {
    const hourCloses = Array.from({ length: 220 }, (_, index) =>
      index < 180 ? 100 + index * 0.15 : 126.85 - (index - 179) * decline);
    const hourly = candlesFromCloses(hourCloses, 60 * 60_000);
    const ema50 = ema(hourCloses, 50);
    const fiveCloses = Array.from({ length: 80 }, (_, index) => ema50 * (0.996 + index * 0.003 / 79));
    return classifyBtcRegime(hourly, candlesFromCloses(fiveCloses, 5 * 60_000));
  };

  const nearlyFlat = classifyWithDecline(0.05);
  assert.ok(nearlyFlat.ema50Slope6hPct < 0 && nearlyFlat.ema50Slope6hPct >= -0.05);
  assert.equal(nearlyFlat.allowed, true);

  const falling = classifyWithDecline(0.07);
  assert.ok(falling.ema50Slope6hPct < -0.05);
  assert.equal(falling.allowed, false);
});

test('BTC support buffer does not allow a deep EMA50 loss or a shock', () => {
  const hourCloses = Array.from({ length: 220 }, (_, index) => 100 + index * 0.1);
  const hourly = candlesFromCloses(hourCloses, 60 * 60_000);
  const ema50 = ema(hourCloses, 50);
  const deepFiveCloses = Array.from({ length: 80 }, (_, index) => ema50 * (0.988 + index * 0.004 / 79));
  const deep = classifyBtcRegime(hourly, candlesFromCloses(deepFiveCloses, 5 * 60_000));
  assert.equal(deep.allowed, false);
  assert.equal(deep.regime, 'NO_LONG_EDGE');

  const shockCloses = Array.from({ length: 80 }, (_, index) => ema50 * (0.999 + index * 0.003 / 79));
  shockCloses[79] = shockCloses[78] * 0.985;
  const shock = classifyBtcRegime(hourly, candlesFromCloses(shockCloses, 5 * 60_000));
  assert.equal(shock.shock, true);
  assert.equal(shock.allowed, false);
  assert.equal(shock.regime, 'SHOCK_BLOCK');
});

test('BTC higher-timeframe uptrend survives a controlled intraday pullback', () => {
  const hourCloses = Array.from({ length: 220 }, (_, index) => 100 + index * 0.12);
  const hourly = candlesFromCloses(hourCloses, 60 * 60_000);
  const ema50 = ema(hourCloses, 50);
  const fiveCloses = Array.from({ length: 80 }, (_, index) => ema50 * (1.006 + index * 0.001 / 79));
  fiveCloses[76] = ema50 * 1.008;
  fiveCloses[77] = ema50 * 1.006;
  fiveCloses[78] = ema50 * 1.0045;
  fiveCloses[79] = ema50 * 1.0035;
  const result = classifyBtcRegime(hourly, candlesFromCloses(fiveCloses, 5 * 60_000));
  assert.equal(result.htfTrend, true);
  assert.equal(result.microTrend, false);
  assert.equal(result.controlledMicroPullback, true);
  assert.equal(result.allowed, true);
  assert.equal(result.regime, 'BULLISH_PULLBACK');
});

test('BTC intraday selloff beyond the controlled pullback limit remains blocked', () => {
  const hourCloses = Array.from({ length: 220 }, (_, index) => 100 + index * 0.12);
  const hourly = candlesFromCloses(hourCloses, 60 * 60_000);
  const ema50 = ema(hourCloses, 50);
  const fiveCloses = Array.from({ length: 80 }, () => ema50 * 1.02);
  fiveCloses[76] = ema50 * 1.019;
  fiveCloses[77] = ema50 * 1.014;
  fiveCloses[78] = ema50 * 1.010;
  fiveCloses[79] = ema50 * 1.006;
  const result = classifyBtcRegime(hourly, candlesFromCloses(fiveCloses, 5 * 60_000));
  assert.equal(result.shock, false);
  assert.equal(result.controlledMicroPullback, false);
  assert.equal(result.allowed, false);
  assert.equal(result.regime, 'NO_LONG_EDGE');
});
