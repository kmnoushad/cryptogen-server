import { requestJson } from './http.js';
import { closedCandles, ema, parseKlines } from './indicators.js';
import { pctChange } from './util.js';

const BASE = 'https://fapi.binance.com';

const qs = params => new URLSearchParams(Object.entries(params)
  .filter(([, value]) => value !== undefined && value !== null)
  .map(([key, value]) => [key, String(value)])).toString();

export const classifyBtcRegime = (hourly, five, {
  ema50RetestBufferPct = 0.35,
  minEma50Slope6hPct = -0.05,
} = {}) => {
  if (hourly.length < 205 || five.length < 40) throw new Error('BTC regime data incomplete');

  const hourCloses = hourly.map(c => c.close);
  const fiveCloses = five.map(c => c.close);
  const hourlyClose = hourCloses.at(-1);
  const price = fiveCloses.at(-1);
  const ema50 = ema(hourCloses, 50);
  const ema200 = ema(hourCloses, 200);
  const ema50SixHoursAgo = ema(hourCloses.slice(0, -6), 50);
  const ema20Five = ema(fiveCloses, 20);
  if (![ema50, ema200, ema50SixHoursAgo, ema20Five].every(value => value > 0)) {
    throw new Error('BTC EMA calculation incomplete');
  }

  const fiveMinuteReturn = pctChange(fiveCloses.at(-2), price);
  const fifteenMinuteReturn = pctChange(fiveCloses.at(-4), price);
  const oneHourReturn = pctChange(fiveCloses.at(-13), price);
  const distanceFromEma50Pct = pctChange(ema50, price);
  const ema50Slope6hPct = pctChange(ema50SixHoursAgo, ema50);
  const majorTrend = ema50 > ema200 && ema50Slope6hPct >= minEma50Slope6hPct;
  const htfTrend = majorTrend && distanceFromEma50Pct >= 0;
  // Do not switch the entire Futures engine off because BTC briefly trades a
  // few basis points under a rising EMA50. This is allowed only while the
  // larger EMA structure remains bullish and price stays inside a tight,
  // configurable support-retest buffer.
  const supportRetest = majorTrend
    && distanceFromEma50Pct >= -ema50RetestBufferPct
    && oneHourReturn > -0.60;
  const microTrend = price > ema20Five && fifteenMinuteReturn > -0.25;
  const shock = fiveMinuteReturn <= -1 || fifteenMinuteReturn <= -1.5 || oneHourReturn <= -2;
  const allowed = !shock && microTrend && (htfTrend || supportRetest);
  const regime = shock ? 'SHOCK_BLOCK'
    : allowed && htfTrend ? 'BULLISH'
    : allowed ? 'BULLISH_RETEST'
    : 'NO_LONG_EDGE';

  return {
    regime,
    allowed,
    htfTrend,
    supportRetest,
    majorTrend,
    microTrend,
    shock,
    price,
    hourlyClose,
    ema50,
    ema200,
    ema50Slope6hPct,
    distanceFromEma50Pct,
    fiveMinuteReturn,
    fifteenMinuteReturn,
    oneHourReturn,
    barCloseTime: five.at(-1).closeTime,
    hourBarCloseTime: hourly.at(-1).closeTime,
  };
};

export class BinanceClient {
  constructor({ btcEma50RetestBufferPct = 0.35, btcMinEma50Slope6hPct = -0.05 } = {}) {
    this.btcOptions = {
      ema50RetestBufferPct: btcEma50RetestBufferPct,
      minEma50Slope6hPct: btcMinEma50Slope6hPct,
    };
  }

  async ping() {
    await requestJson(`${BASE}/fapi/v1/ping`);
    return true;
  }

  exchangeInfo() {
    return requestJson(`${BASE}/fapi/v1/exchangeInfo`, { timeoutMs: 12_000 });
  }

  ticker24h(symbol) {
    const query = symbol ? `?${qs({ symbol })}` : '';
    return requestJson(`${BASE}/fapi/v1/ticker/24hr${query}`, { timeoutMs: 12_000 });
  }

  price(symbol) {
    return requestJson(`${BASE}/fapi/v1/ticker/price?${qs({ symbol })}`);
  }

  klines(symbol, interval = '1m', limit = 90, extra = {}) {
    return requestJson(`${BASE}/fapi/v1/klines?${qs({ symbol, interval, limit, ...extra })}`, { timeoutMs: 10_000 });
  }

  depth(symbol, limit = 100) {
    return requestJson(`${BASE}/fapi/v1/depth?${qs({ symbol, limit })}`, { timeoutMs: 8_000 });
  }

  premiumIndex(symbol) {
    return requestJson(`${BASE}/fapi/v1/premiumIndex?${qs({ symbol })}`);
  }

  openInterestHistory(symbol, period = '5m', limit = 3) {
    return requestJson(`${BASE}/futures/data/openInterestHist?${qs({ symbol, period, limit })}`);
  }

  async oiContext(symbol) {
    const rows = await this.openInterestHistory(symbol, '5m', 3);
    if (!Array.isArray(rows) || rows.length < 2) throw new Error(`Insufficient OI history for ${symbol}`);
    const sorted = [...rows].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const previous = Number(sorted.at(-2).sumOpenInterest);
    const current = Number(sorted.at(-1).sumOpenInterest);
    if (!(previous > 0) || !(current > 0)) throw new Error(`Invalid OI history for ${symbol}`);
    return {
      previous,
      current,
      changePct: pctChange(previous, current),
      timestamp: Number(sorted.at(-1).timestamp),
    };
  }

  async btcRegime(now = Date.now()) {
    const [hourRows, fiveRows] = await Promise.all([
      this.klines('BTCUSDT', '1h', 220),
      this.klines('BTCUSDT', '5m', 80),
    ]);
    const hourly = closedCandles(parseKlines(hourRows), now);
    const five = closedCandles(parseKlines(fiveRows), now);
    return classifyBtcRegime(hourly, five, this.btcOptions);
  }
}

export const selectUniverse = (exchangeInfo, tickers, cfg, excludedSymbols = new Set(), acceleration = new Map()) => {
  const tickerMap = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.symbol, t]));
  const eligible = (exchangeInfo?.symbols ?? [])
    .filter(s => s.status === 'TRADING')
    .filter(s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
    .filter(s => !s.underlyingType || s.underlyingType === 'COIN')
    .filter(s => !(s.underlyingSubType ?? []).some(tag => String(tag).toLowerCase() === 'meme'))
    .filter(s => !excludedSymbols.has(s.symbol))
    .map(s => {
      const ticker = tickerMap.get(s.symbol);
      return {
        symbol: s.symbol,
        quoteVolume: Number(ticker?.quoteVolume),
        change24h: Number(ticker?.priceChangePercent),
        lastPrice: Number(ticker?.lastPrice),
        accelerationPct: Number(acceleration.get(s.symbol) ?? 0),
      };
    })
    .filter(x => Number.isFinite(x.quoteVolume) && x.quoteVolume >= cfg.min24hQuoteVolumeUsd)
    .filter(x => Number.isFinite(x.change24h) && x.change24h > -10 && x.change24h < cfg.maxUniverse24hGainPct);

  const momentumSlots = Math.max(1, Math.round(cfg.maxUniverse * cfg.universeMomentumSlotsPct / 100));
  const liquiditySlots = Math.max(1, cfg.maxUniverse - momentumSlots);
  const liquid = [...eligible].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, liquiditySlots);
  const movers = [...eligible]
    .filter(x => x.accelerationPct > 0)
    .sort((a, b) => b.accelerationPct - a.accelerationPct || b.quoteVolume - a.quoteVolume)
    .slice(0, momentumSlots);
  const selected = new Map([...liquid, ...movers].map(item => [item.symbol, item]));
  if (selected.size < cfg.maxUniverse) {
    for (const item of [...eligible].sort((a, b) => b.quoteVolume - a.quoteVolume)) {
      selected.set(item.symbol, item);
      if (selected.size >= cfg.maxUniverse) break;
    }
  }
  return [...selected.values()].slice(0, cfg.maxUniverse);
};
