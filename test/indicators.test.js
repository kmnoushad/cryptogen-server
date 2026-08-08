import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atrExpansion,
  closedCandles,
  detectPumpDumpEpisodes,
  parseKlines,
  takerFlow,
} from '../src/indicators.js';

const row = ({ openTime, open, high, low, close, volume = 100, closeTime, buy = 50, quote = 10_000 }) => [
  openTime, String(open), String(high), String(low), String(close), String(volume), closeTime,
  String(quote), 100, String(buy), String(quote * buy / volume), '0',
];

test('open kline is excluded from every indicator input', () => {
  const now = 120_000;
  const rows = [
    row({ openTime: 0, open: 100, high: 101, low: 99, close: 100, closeTime: 59_999 }),
    row({ openTime: 60_000, open: 100, high: 150, low: 95, close: 145, closeTime: 120_999 }),
  ];
  const result = closedCandles(parseKlines(rows), now);
  assert.equal(result.length, 1);
  assert.equal(result[0].close, 100);
});

test('true taker delta can be negative on a green candle', () => {
  const candle = parseKlines([row({
    openTime: 0, open: 100, high: 102, low: 99, close: 101, closeTime: 59_999, volume: 100, buy: 35,
  })]);
  const flow = takerFlow(candle);
  assert.equal(flow.buyRatio, 0.35);
  assert.ok(Math.abs(flow.deltaRatio - (-0.3)) < 1e-12);
});

test('ATR expansion compares two valid windows and is not permanently -100%', () => {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 50; i++) {
    const range = i < 35 ? 1 : 2;
    candles.push({
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000 - 1,
      open: price,
      high: price + range,
      low: price - range,
      close: price + 0.1,
      volume: 100,
      quoteVolume: 10_000,
      trades: 10,
      takerBuyVolume: 55,
      takerBuyQuoteVolume: 5_500,
    });
    price += 0.1;
  }
  const expansion = atrExpansion(candles);
  assert.ok(expansion > 20);
});

test('pump/dump history counts non-overlapping episodes', () => {
  const candles = [];
  for (let i = 0; i < 80; i++) {
    let close = 100;
    if (i >= 10 && i <= 12) close = 100 + (i - 9) * 2;
    if (i > 12 && i < 25) close = 106 - (i - 12) * 0.55;
    if (i >= 40 && i <= 42) close = 100 + (i - 39) * 2;
    if (i > 42 && i < 55) close = 106 - (i - 42) * 0.55;
    candles.push({ openTime: i, closeTime: i, open: close, high: close + 0.2, low: close - 0.2, close });
  }
  const events = detectPumpDumpEpisodes(candles, {
    lookbackBars: 6, pumpBars: 3, aftermathBars: 12, pumpPct: 4, minGiveback: 0.6,
  });
  assert.equal(events.length, 2);
});
