export const FUTURES_AUTO_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT']);
const ema = (values, n) => values.reduce((v, x) => v === null ? x : v + 2 / (n + 1) * (x - v), null);
export function closedSeries(rows, interval, now) {
  if (!Array.isArray(rows)) throw Error('Candle data unavailable');
  const c = rows.map(r => ({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), end: Number(r[6]), quote: Number(r[7]), buy: Number(r[10]) }))
    .filter(r => r.end < now);
  if (c.length < 60 || c.some(r => !Object.values(r).every(Number.isFinite) || r.low <= 0
    || r.high < Math.max(r.open, r.close) || r.low > Math.min(r.open, r.close) || r.volume <= 0
    || r.quote <= 0 || r.buy < 0 || r.buy > r.quote || r.end - r.time !== interval - 1)
    || c.some((r, i) => i && r.time - c[i - 1].time !== interval)
    || now - c.at(-1).end > interval + 5000 || c.at(-1).end > now) throw Error('Candle data stale or invalid');
  return c;
}
export function trendDirection(c) {
  const prices = c.map(r => r.close), fast = ema(prices, 20), slow = ema(prices, 50), previous = ema(prices.slice(0, -3), 20);
  const last = prices.at(-1);
  return last > fast && fast > slow && fast > previous ? 'LONG'
    : last < fast && fast < slow && fast < previous ? 'SHORT' : null;
}
// Closed 15m breakout, followed by distinct 1m retest and reclaim bars.
// Both symbol and BTC 15m/1h trends must agree; no countertrend hedging.
export function directionalSignal({ symbol, m1, m15, h1, btc15, btc1h, now }) {
  const reject = reason => ({ allowed: false, reason });
  if (!FUTURES_AUTO_SYMBOLS.includes(symbol)) return reject('Symbol outside initial allowlist');
  let a, b, c, d, e;
  try { a = closedSeries(m1, 60000, now); b = closedSeries(m15, 900000, now); c = closedSeries(h1, 3600000, now);
    d = closedSeries(btc15, 900000, now); e = closedSeries(btc1h, 3600000, now); }
  catch (err) { return reject(err.message); }
  const direction = trendDirection(b);
  if (!direction || [c, d, e].some(x => trendDirection(x) !== direction)) return reject('15m/1h symbol and BTC trends do not agree');
  const sign = direction === 'LONG' ? 1 : -1;
  // Search only the last two closed 15m bars for a breakout; expire after 30m.
  for (let k = b.length - 1; k >= b.length - 2; k--) {
    const burst = b[k], prior = b.slice(k - 20, k);
    const level = direction === 'LONG' ? Math.max(...prior.map(x => x.high)) : Math.min(...prior.map(x => x.low));
    if (sign * (burst.close - level) <= 0 || sign * (burst.close - burst.open) <= 0
      || burst.volume < prior.reduce((s, x) => s + x.volume, 0) / prior.length * 1.3) continue;
    const after = a.filter(x => x.time > burst.end), reclaim = after.at(-1);
    if (!reclaim || now - reclaim.end > 90000 || after.length < 2) continue;
    const retests = after.slice(0, -1).filter(x => direction === 'LONG'
      ? x.low <= level * 1.001 && x.close >= level * .999
      : x.high >= level * .999 && x.close <= level * 1.001);
    const retest = retests.at(-1);
    if (!retest || sign * (reclaim.close - level) <= 0 || sign * (reclaim.close - reclaim.open) <= 0
      || (direction === 'LONG' ? reclaim.close <= retest.high : reclaim.close >= retest.low)
      || (direction === 'LONG' ? reclaim.buy / reclaim.quote < .55 : reclaim.buy / reclaim.quote > .45)) continue;
    const atr = b.slice(-14).reduce((s, r, i, arr) => s + Math.max(r.high - r.low,
      Math.abs(r.high - (arr[i-1]?.close ?? r.open)), Math.abs(r.low - (arr[i-1]?.close ?? r.open))), 0) / 14;
    if (Math.abs(reclaim.close - level) > atr * .5) return reject('Reclaim already extended');
    const stop = direction === 'LONG' ? Math.min(retest.low, reclaim.low) - atr * .1 : Math.max(retest.high, reclaim.high) + atr * .1;
    if (Math.abs(stop / reclaim.close - 1) > .015) return reject('Structural stop too wide');
    return { allowed: true, symbol, direction, entry: reclaim.close, stop, barCloseTime: reclaim.end,
      breakoutTime: burst.end, level, atr, score: Math.abs(burst.close - level) / atr };
  }
  return reject('No fresh breakout/retest/reclaim confirmation');
}
