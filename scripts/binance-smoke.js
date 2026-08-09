import { BinanceClient, selectUniverse } from '../src/binance.js';
import { buildFeatures, closedCandles, parseKlines } from '../src/indicators.js';
import { depthMetrics } from '../src/risk.js';

const binance = new BinanceClient();
const [exchangeInfo, tickers, btc] = await Promise.all([
  binance.exchangeInfo(),
  binance.ticker24h(),
  binance.btcRegime(),
]);
const universe = selectUniverse(exchangeInfo, tickers, {
  min24hQuoteVolumeUsd: 15_000_000,
  maxUniverse: 5,
  maxUniverse24hGainPct: 15,
  universeMomentumSlotsPct: 30,
}, new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'PAXGUSDT']));
if (!universe.length) throw new Error('No liquid crypto perpetuals passed the smoke-test universe');

const symbol = universe[0].symbol;
const [klineRows, oi, book, premium] = await Promise.all([
  binance.klines(symbol, '1m', 90),
  binance.oiContext(symbol),
  binance.depth(symbol, 100),
  binance.premiumIndex(symbol),
]);
const candles = closedCandles(parseKlines(klineRows));
const features = buildFeatures(candles);
if (!features) throw new Error(`Feature calculation failed for ${symbol}`);
const depth = depthMetrics(book, features.last.close);

console.log(JSON.stringify({
  ok: true,
  btcRegime: btc.regime,
  universe: universe.map(x => x.symbol),
  sample: symbol,
  closedCandles: candles.length,
  oiChangePct: Number(oi.changePct.toFixed(3)),
  spreadBps: Number(depth.spreadBps.toFixed(2)),
  fundingPct: Number((Number(premium.lastFundingRate) * 100).toFixed(4)),
}, null, 2));
