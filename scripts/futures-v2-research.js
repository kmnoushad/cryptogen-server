// Futures v2 research signal: higher-timeframe trend + 15m pullback + resumption.
// RESEARCH ONLY: used by scripts/futures-backtest.js. The live bots never import this file.
//
// Rules (LONG; SHORT is the exact mirror):
//  1. Trend (1h): close > EMA20 > EMA50 and EMA20 rising versus 3 hours ago.
//  2. BTC 1h trend must not confirm the opposite direction (neutral is allowed).
//  3. Relative strength: symbol 24h return minus BTC 24h return > 0 (for SHORT: < 0).
//  4. Pullback (15m): within the last 8 closed bars price came back to the 15m EMA20
//     (low <= EMA20 + 0.25 ATR), but stayed above EMA50 - 0.5 ATR (trend intact).
//  5. Resumption: evaluated only on the minute a 15m bar closes. That bar is bullish,
//     closes above EMA20 and above the previous bar's high.
//  6. Not extended: close - EMA20 <= 0.75 ATR(15m).
//  7. Stop: the further of (pullback low - 0.25 ATR) and (close - 1.0 ATR): at least 1 ATR
//     away, outside normal 15m noise. Stops wider than 3% are skipped.
const num = x => Number(x);
const rowsToBars = rows => rows.map(r => ({ time: num(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), end: num(r[6]) }));
export function emaSeries(values, n) {
  const k = 2 / (n + 1), out = []; let v = null;
  for (const x of values) { v = v === null ? x : v + k * (x - v); out.push(v); }
  return out;
}
export function atr(bars, n = 14) {
  const tr = bars.map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - (bars[i - 1]?.close ?? b.open)), Math.abs(b.low - (bars[i - 1]?.close ?? b.open))));
  const last = tr.slice(-n); return last.reduce((s, x) => s + x, 0) / last.length;
}
function trend1h(h) {
  const closes = h.map(b => b.close), e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const last = closes.at(-1), f = e20.at(-1), s = e50.at(-1), prev = e20.at(-4);
  if (last > f && f > s && f > prev) return 'LONG';
  if (last < f && f < s && f < prev) return 'SHORT';
  return null;
}
export function trendPullbackSignal({ symbol, m15, h1, btc1h, btc15, now }) {
  const reject = reason => ({ allowed: false, reason });
  const b = rowsToBars(m15).filter(x => x.end < now), h = rowsToBars(h1).filter(x => x.end < now);
  const bh = rowsToBars(btc1h).filter(x => x.end < now), b15 = rowsToBars(btc15).filter(x => x.end < now);
  if (b.length < 100 || h.length < 60 || bh.length < 60 || b15.length < 97) return reject('history');
  const bar = b.at(-1);
  if (now - bar.end > 60000) return reject('not a fresh 15m close');
  const direction = trend1h(h);
  if (!direction) return reject('1h trend not confirmed');
  const btcTrend = trend1h(bh);
  if (btcTrend && btcTrend !== direction) return reject('BTC 1h opposes');
  const ret = (bars) => bars.at(-1).close / bars.at(-97).close - 1;
  const rs = ret(b) - ret(b15);
  if (direction === 'LONG' ? !(rs > 0) : !(rs < 0)) return reject('relative strength opposes');
  const closes = b.map(x => x.close), e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const a = atr(b), E20 = e20.at(-1), E50 = e50.at(-1), prevBar = b.at(-2);
  if (!(a > 0)) return reject('atr');
  const window = b.slice(-9, -1); // the 8 bars before the trigger bar
  const long = direction === 'LONG';
  const touched = window.some((x, i) => long ? x.low <= e20.at(-9 + i) + .25 * a : x.high >= e20.at(-9 + i) - .25 * a);
  if (!touched) return reject('no pullback to 15m EMA20');
  const extreme = long ? Math.min(...window.map(x => x.low), bar.low) : Math.max(...window.map(x => x.high), bar.high);
  if (long ? extreme < E50 - .5 * a : extreme > E50 + .5 * a) return reject('pullback broke the trend');
  const resumed = long ? bar.close > bar.open && bar.close > E20 && bar.close > prevBar.high
    : bar.close < bar.open && bar.close < E20 && bar.close < prevBar.low;
  if (!resumed) return reject('no resumption bar');
  if (Math.abs(bar.close - E20) > .75 * a) return reject('extended from EMA20');
  const stop = long ? Math.min(extreme - .25 * a, bar.close - a) : Math.max(extreme + .25 * a, bar.close + a);
  if (Math.abs(stop / bar.close - 1) > .03) return reject('stop wider than 3%');
  const pullbackBar = window.reduce((best, x) => (long ? x.low < best.low : x.high > best.high) ? x : best, window[0]);
  return { allowed: true, symbol, direction, entry: bar.close, stop, barCloseTime: bar.end,
    breakoutTime: pullbackBar.time, atr: a, score: Math.abs(rs) };
}
