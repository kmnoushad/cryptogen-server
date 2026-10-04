// Frozen research hypotheses. Never imported by a live worker.
import { closedSeries, trendDirection } from './futures-auto-strategy.js';
import { entryQuality } from './entry-quality.js';
export const REBUILD_MODELS = Object.freeze(['pullback5', 'compression5', 'auctionFade5']);
const ema = (xs, n) => xs.reduce((v, x) => v === null ? x : v + 2 / (n + 1) * (x - v), null);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const atr = xs => mean(xs.slice(-14).map((r, i, a) => Math.max(r.high - r.low,
  Math.abs(r.high - (a[i - 1]?.close ?? r.open)), Math.abs(r.low - (a[i - 1]?.close ?? r.open)))));
export function researchEntry({ model, symbol, m5, m15, btc15, now, gain24h, quote24h }) {
  const reject = reason => ({ allowed: false, reason, executable: false });
  if (!REBUILD_MODELS.includes(model)) return reject('Unknown research model');
  let a, b, btc;
  try { a = closedSeries(m5, 300000, now); b = closedSeries(m15, 900000, now); btc = closedSeries(btc15, 900000, now); }
  catch (error) { return reject(error.message); }
  const last = a.at(-1), previous = a.at(-2), prices = a.map(x => x.close);
  const fast = ema(prices, 20), slow = ema(prices, 50), oldFast = ema(prices.slice(0, -3), 20);
  const range = last.high - last.low, volatility = atr(a), btcTrend = trendDirection(btc);
  const signOf = d => d === 'LONG' ? 1 : -1;
  let direction = trendDirection(b), stop, level;
  if (!(range > 0 && volatility > 0)) return reject('No usable volatility');
  if (model === 'auctionFade5') {
    if (!(gain24h >= 8 && quote24h >= 15000000)) return reject('Prior pump/liquidity absent');
    const prior = a.slice(-25, -1); level = Math.max(...prior.map(x => x.high));
    const base = Math.min(...prior.map(x => x.low));
    if (level / base < 1.05) return reject('No local pump');
    // Failed auction at the high, rather than a breakdown far below it.
    if (last.high <= level || last.close >= level || last.close >= last.open
      || (last.high - Math.max(last.open, last.close)) / range < .45
      || last.buy / last.quote > .48 || last.volume < mean(prior.map(x => x.volume)) * 1.2)
      return reject('No high rejection with weak flow');
    if ((level - last.close) > volatility * .75) return reject('Fade already extended');
    const symbolReturn = b.at(-1).close / b.at(-2).close - 1;
    const btcReturn = btc.at(-1).close / btc.at(-2).close - 1;
    if (btcTrend === 'LONG' && symbolReturn >= btcReturn - .005) return reject('No relative weakness in bullish BTC');
    direction = 'SHORT'; stop = last.high + volatility * .1;
  } else {
    if (!direction) return reject('Symbol context unconfirmed');
    if (btcTrend && btcTrend !== direction) return reject('BTC context opposing');
    const sign = signOf(direction);
    if (sign * (fast - slow) <= 0 || sign * (fast - oldFast) <= 0) return reject('Local trend unconfirmed');
    if (model === 'pullback5') {
      const previousFast = ema(prices.slice(0, -1), 20);
      const touch = sign === 1 ? previous.low <= previousFast && previous.close >= slow
        : previous.high >= previousFast && previous.close <= slow;
      if (!touch || sign * (last.close - last.open) <= 0
        || (sign === 1 ? last.close <= previous.high : last.close >= previous.low)
        || Math.abs(last.close - fast) > volatility * .75) return reject('No pullback recovery near trend');
      const prior = a.slice(-3);
      stop = sign === 1 ? Math.min(...prior.map(x => x.low)) - volatility * .1
        : Math.max(...prior.map(x => x.high)) + volatility * .1;
      level = previousFast;
    } else {
      const prior = a.slice(-21, -1), compression = a.slice(-7, -1);
      const ceiling = Math.max(...prior.map(x => x.high)), floor = Math.min(...prior.map(x => x.low));
      level = sign === 1 ? ceiling : floor;
      if (Math.max(...compression.map(x => x.high)) - Math.min(...compression.map(x => x.low)) > volatility * 2)
        return reject('No compression');
      if (sign * (last.close - level) <= 0 || sign * (last.close - last.open) <= 0
        || last.volume < mean(prior.map(x => x.volume)) * 1.5
        || (sign === 1 ? last.buy / last.quote < .55 : last.buy / last.quote > .45)
        || Math.abs(last.close - level) > volatility * .3) return reject('No fresh compression breakout');
      stop = sign === 1 ? Math.min(...compression.map(x => x.low)) - volatility * .1
        : Math.max(...compression.map(x => x.high)) + volatility * .1;
    }
  }
  const quality = entryQuality({ direction, entry: last.close, stop, reference: last.close, fee: .0005 });
  if (!quality.allowed) return reject(quality.reason);
  if (Math.abs(stop / last.close - 1) > .025) return reject('Structural risk too wide');
  return { allowed: true, executable: false, model, symbol, direction, entry: last.close,
    stop, level, barCloseTime: last.end, costShare: quality.costShare };
}
