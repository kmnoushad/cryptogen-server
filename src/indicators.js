import { clamp, pctChange } from './util.js';

export const parseKlines = rows => (Array.isArray(rows) ? rows : []).map(row => ({
  openTime: Number(row[0]),
  open: Number(row[1]),
  high: Number(row[2]),
  low: Number(row[3]),
  close: Number(row[4]),
  volume: Number(row[5]),
  closeTime: Number(row[6]),
  quoteVolume: Number(row[7]),
  trades: Number(row[8]),
  takerBuyVolume: Number(row[9]),
  takerBuyQuoteVolume: Number(row[10]),
})).filter(c => Object.values(c).every(Number.isFinite));

export const closedCandles = (rowsOrCandles, now = Date.now()) => {
  const candles = rowsOrCandles.length && Array.isArray(rowsOrCandles[0]) ? parseKlines(rowsOrCandles) : rowsOrCandles;
  return candles.filter(c => c.closeTime < now);
};

export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const robustZ = (value, baseline) => {
  if (baseline.length < 5) return 0;
  const med = median(baseline);
  const mad = median(baseline.map(x => Math.abs(x - med)));
  if (mad > 0) return (value - med) / (1.4826 * mad);
  const avg = mean(baseline);
  const variance = mean(baseline.map(x => (x - avg) ** 2));
  return variance > 0 ? (value - avg) / Math.sqrt(variance) : 0;
};

export const ema = (values, period) => {
  if (values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) result = values[i] * alpha + result * (1 - alpha);
  return result;
};

export const rsi = (candles, period = 14) => {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
};

export const atr = (candles, period = 14) => {
  if (candles.length < period + 1) return null;
  const start = candles.length - period;
  let total = 0;
  for (let i = start; i < candles.length; i++) {
    const candle = candles[i];
    const previousClose = candles[i - 1].close;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  }
  return total / period;
};

export const atrExpansion = candles => {
  if (candles.length < 40) return null;
  const recent = atr(candles.slice(-25), 14);
  const previous = atr(candles.slice(-40, -10), 14);
  if (!(recent > 0) || !(previous > 0)) return null;
  return ((recent - previous) / previous) * 100;
};

const candleShape = candle => {
  const range = candle.high - candle.low;
  if (!(range > 0)) return { bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, green: false };
  return {
    bodyPct: Math.abs(candle.close - candle.open) / range * 100,
    upperWickPct: (candle.high - Math.max(candle.open, candle.close)) / range * 100,
    lowerWickPct: (Math.min(candle.open, candle.close) - candle.low) / range * 100,
    green: candle.close > candle.open,
  };
};

export const takerFlow = candles => {
  const volume = candles.reduce((sum, c) => sum + c.volume, 0);
  const buys = candles.reduce((sum, c) => sum + c.takerBuyVolume, 0);
  const buyRatio = volume > 0 ? buys / volume : 0.5;
  return { buyRatio, deltaRatio: volume > 0 ? ((2 * buys) - volume) / volume : 0 };
};

export const buildFeatures = candles => {
  if (candles.length < 45) return null;
  const last = candles.at(-1);
  const previous = candles.at(-2);
  const last3 = candles.slice(-3);
  const baseline = candles.slice(-36, -6);
  const baselineQuote = baseline.map(c => c.quoteVolume).filter(v => v > 0);
  const baselineMedian = median(baselineQuote);
  const flow1 = takerFlow([last]);
  const flow3 = takerFlow(last3);
  const atr14 = atr(candles, 14);
  const ema20 = ema(candles.map(c => c.close), 20);
  if (!(atr14 > 0) || !(ema20 > 0) || !(baselineMedian > 0)) return null;

  const priorStructure = candles.slice(-24, -3);
  const breakoutLevel = Math.max(...priorStructure.map(c => c.high));
  const recentPeak = Math.max(...candles.slice(-10).map(c => c.high));
  const shape = candleShape(last);
  const quoteVolumeRatio = last.quoteVolume / baselineMedian;
  const impulseVolumeRatio = mean(last3.map(c => c.quoteVolume)) / baselineMedian;

  const features = {
    last,
    previous,
    atr: atr14,
    atrPct: atr14 / last.close * 100,
    atrExpansionPct: atrExpansion(candles),
    ema20,
    extensionAtr: (last.close - ema20) / atr14,
    rsi: rsi(candles),
    ret1m: pctChange(previous.close, last.close),
    ret3m: pctChange(candles.at(-4).close, last.close),
    ret5m: pctChange(candles.at(-6).close, last.close),
    breakoutLevel,
    breakoutPct: pctChange(breakoutLevel, last.close),
    recentPeak,
    drawdownFromPeakPct: pctChange(recentPeak, last.close),
    quoteVolumeRatio,
    volumeZ: robustZ(last.quoteVolume, baselineQuote),
    impulseVolumeRatio,
    buyRatio1: flow1.buyRatio,
    buyRatio3: flow3.buyRatio,
    deltaRatio1: flow1.deltaRatio,
    deltaRatio3: flow3.deltaRatio,
    ...shape,
  };

  features.impulse = features.ret3m >= 0.6
    && features.ret3m <= 2.6
    && features.ret5m <= 3.4
    && features.breakoutPct >= 0.10
    && features.impulseVolumeRatio >= 1.5
    && features.buyRatio3 >= 0.56
    && features.upperWickPct <= 35
    && features.extensionAtr <= 2.2;

  features.setupScore = clamp(
    (features.breakoutPct >= 0.1 ? 2 : 0)
    + (features.buyRatio3 >= 0.58 ? 2 : features.buyRatio3 >= 0.56 ? 1 : 0)
    + (features.impulseVolumeRatio >= 2 ? 2 : features.impulseVolumeRatio >= 1.5 ? 1 : 0)
    + (features.upperWickPct <= 20 ? 2 : features.upperWickPct <= 35 ? 1 : 0)
    + (features.extensionAtr <= 1.5 ? 2 : features.extensionAtr <= 2.2 ? 1 : 0),
    0, 10,
  );

  return features;
};

export const impulseBlockers = features => [
  features.ret3m < 0.6 && '3m move below 0.60%',
  features.ret3m > 2.6 && '3m move above 2.60%',
  features.ret5m > 3.4 && '5m move above 3.40%',
  features.breakoutPct < 0.10 && 'no 21m breakout',
  features.impulseVolumeRatio < 1.5 && 'impulse volume below 1.50x',
  features.buyRatio3 < 0.56 && '3m taker buying below 56%',
  features.upperWickPct > 35 && 'upper wick above 35%',
  features.extensionAtr > 2.2 && 'extension above 2.20 ATR',
].filter(Boolean);

export const detectPumpDumpEpisodes = (candles, {
  lookbackBars = 6, pumpBars = 3, aftermathBars = 12, pumpPct = 4, minGiveback = 0.65,
} = {}) => {
  const events = [];
  let i = lookbackBars;
  while (i < candles.length - pumpBars - aftermathBars) {
    const base = Math.min(...candles.slice(i - lookbackBars, i + 1).map(c => c.low));
    const pumpWindow = candles.slice(i, i + pumpBars + 1);
    let peak = -Infinity;
    let peakOffset = 0;
    pumpWindow.forEach((c, index) => {
      if (c.high > peak) { peak = c.high; peakOffset = index; }
    });
    const gainPct = pctChange(base, peak);
    if (gainPct < pumpPct) { i++; continue; }
    const peakIndex = i + peakOffset;
    const aftermath = candles.slice(peakIndex + 1, peakIndex + 1 + aftermathBars);
    if (!aftermath.length) break;
    const lowAfter = Math.min(...aftermath.map(c => c.low));
    const giveback = (peak - lowAfter) / Math.max(peak - base, Number.EPSILON);
    if (giveback >= minGiveback) {
      events.push({
        base, peak, lowAfter, gainPct, giveback,
        peakTime: candles[peakIndex].closeTime,
      });
      i = peakIndex + aftermathBars;
    } else {
      i = peakIndex + 1;
    }
  }
  return events;
};
