const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export const emaSeries = (values, period) => {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result = Array(period - 1).fill(null);
  let current = average(values.slice(0, period));
  result.push(current);
  for (let index = period; index < values.length; index += 1) {
    current = ((values[index] - current) * multiplier) + current;
    result.push(current);
  }
  return result;
};

export const rsi = (values, period = 14) => {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = ((avgGain * (period - 1)) + Math.max(change, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
};

export const atr = (bars, period = 14) => {
  if (bars.length <= period) return null;
  const ranges = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1].close;
    ranges.push(Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    ));
  }
  let current = average(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index += 1) {
    current = ((current * (period - 1)) + ranges[index]) / period;
  }
  return current;
};

const round = (value, digits = 2) => Number(value.toFixed(digits));

export const analyzeGoldBars = (bars) => {
  if (!Array.isArray(bars) || bars.length < 60) return { ready: false, reason: 'Need at least 60 bars.' };
  const closes = bars.map((bar) => bar.close);
  const ema20 = emaSeries(closes, 20).at(-1);
  const ema50 = emaSeries(closes, 50).at(-1);
  const currentRsi = rsi(closes, 14);
  const currentAtr = atr(bars, 14);
  const bar = bars.at(-1);
  const previous = bars.at(-2);
  const levelWindow = bars.slice(-49, -1);
  const support = Math.min(...levelWindow.map((item) => item.low));
  const resistance = Math.max(...levelWindow.map((item) => item.high));
  const nearEma = Math.abs(bar.close - ema20) <= currentAtr * 0.65;
  const bullishTrend = bar.close > ema20 && ema20 > ema50;
  const bearishTrend = bar.close < ema20 && ema20 < ema50;
  const bullishCandle = bar.close > bar.open && bar.close > previous.close;
  const bearishCandle = bar.close < bar.open && bar.close < previous.close;

  let direction = 'NONE';
  let confidence = 0;
  const evidence = [];
  if (bullishTrend) {
    direction = 'LONG';
    confidence += 40;
    evidence.push('price above EMA20 and EMA50');
    if (currentRsi >= 50 && currentRsi <= 68) { confidence += 20; evidence.push('RSI supports upside without being stretched'); }
    if (nearEma) { confidence += 20; evidence.push('controlled pullback near EMA20'); }
    if (bullishCandle) { confidence += 15; evidence.push('bullish confirmation candle'); }
  } else if (bearishTrend) {
    direction = 'SHORT';
    confidence += 40;
    evidence.push('price below EMA20 and EMA50');
    if (currentRsi <= 50 && currentRsi >= 32) { confidence += 20; evidence.push('RSI supports downside without being stretched'); }
    if (nearEma) { confidence += 20; evidence.push('controlled retest near EMA20'); }
    if (bearishCandle) { confidence += 15; evidence.push('bearish confirmation candle'); }
  }

  if (direction === 'NONE' || !nearEma) confidence = Math.min(confidence, 59);
  const entry = bar.close;
  const stopDistance = Math.max(currentAtr * 1.25, entry * 0.0015);
  const stop = direction === 'LONG' ? entry - stopDistance : entry + stopDistance;
  const target1 = direction === 'LONG' ? entry + stopDistance : entry - stopDistance;
  const target2 = direction === 'LONG' ? entry + (stopDistance * 2) : entry - (stopDistance * 2);

  return {
    ready: true,
    time: bar.time,
    price: round(entry),
    ema20: round(ema20),
    ema50: round(ema50),
    rsi: round(currentRsi, 1),
    atr: round(currentAtr),
    support: round(support),
    resistance: round(resistance),
    direction,
    confidence,
    evidence,
    setup: direction === 'NONE' ? null : {
      direction,
      entry: round(entry),
      stop: round(stop),
      target1: round(target1),
      target2: round(target2),
      riskDistance: round(stopDistance),
    },
  };
};

