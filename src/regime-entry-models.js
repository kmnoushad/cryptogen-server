// Research only. There is no live-worker route to these candidates.
import { closedSeries } from './futures-auto-strategy.js';
import { entryQuality } from './entry-quality.js';
export const REGIME_MODELS = Object.freeze(['rangeReversion5', 'failedReclaimFade1']);
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
export function efficiency(xs) {
  let travel = 0;
  for (let i = 1; i < xs.length; i++) travel += Math.abs(xs[i] - xs[i - 1]);
  return travel ? Math.abs(xs.at(-1) - xs[0]) / travel : 0;
}
const atr = xs => mean(xs.slice(-14).map((x, i) => {
  const p = xs[xs.length - 14 + i - 1]?.close ?? x.open;
  return Math.max(x.high - x.low, Math.abs(x.high - p), Math.abs(x.low - p));
}));
export function regimeEntry({ model, symbol, m1, m5, btc1, now, gain24h, quote24h }) {
  const reject = reason => ({ allowed: false, candidate: false, executable: false, reason });
  if (!REGIME_MODELS.includes(model)) return reject('Unknown regime model');
  let a, b, btc;
  try { a = closedSeries(m1, 60000, now); b = closedSeries(m5, 300000, now); btc = closedSeries(btc1, 60000, now); }
  catch (error) { return reject(error.message); }
  const btcPrices = btc.slice(-61).map(x => x.close), btcEfficiency = efficiency(btcPrices);
  const btcReturn = btcPrices.at(-1) / btcPrices[0] - 1;
  if (Math.abs(btc.at(-1).close / btc.at(-2).close - 1) >= .0035) return reject('BTC closed-minute shock');
  let direction, stop, level, entry, closeTime, centre;
  if (model === 'rangeReversion5') {
    const prior = b.slice(-25, -1), last = b.at(-1), volatility = atr(b);
    if (btcEfficiency > .2 || efficiency(prior.map(x => x.close)) > .2) return reject('Market is not ranging');
    const floor = Math.min(...prior.map(x => x.low)), ceiling = Math.max(...prior.map(x => x.high));
    centre = prior.reduce((s, x) => s + x.quote, 0) / prior.reduce((s, x) => s + x.volume, 0);
    if (!(centre > floor && centre < ceiling)) return reject('Range centre unavailable');
    if (last.low < floor && last.close > floor && last.close > last.open && last.buy / last.quote >= .55) {
      direction = 'LONG'; stop = last.low - volatility * .1; level = floor;
    } else if (last.high > ceiling && last.close < ceiling && last.close < last.open && last.buy / last.quote <= .45) {
      direction = 'SHORT'; stop = last.high + volatility * .1; level = ceiling;
    } else return reject('No failed excursion at range edge');
    entry = last.close; closeTime = last.end;
    const sign = direction === 'LONG' ? 1 : -1;
    // Reject if the range centre cannot pay 1.5R after modeled costs.
    const risk = Math.abs(entry - stop) + entry * .0005 + stop * .001;
    const centreNet = sign * (centre - entry) - entry * .0005 - centre * .001;
    if (centreNet < 1.5 * risk) return reject('Range has insufficient net reward to centre');
  } else {
    if (!(gain24h >= 8 && quote24h >= 15000000)) return reject('Prior pump/liquidity absent');
    const last = a.at(-1), retest = a.at(-2), rejection = a.at(-3), prior = a.slice(-48, -3);
    level = Math.max(...prior.map(x => x.high));
    const base = Math.min(...a.slice(0, -3).map(x => x.low));
    const volatility = atr(b);
    if (level / base < 1.05) return reject('No local pump');
    if (rejection.high < level || rejection.close >= level || rejection.close >= rejection.open)
      return reject('No earlier rejected high');
    if (retest.high < level * .9985 || retest.high > rejection.high || retest.close >= level)
      return reject('No failed reclaim near resistance');
    if (last.close >= retest.low || last.close >= last.open || last.buy / last.quote > .45)
      return reject('No post-reclaim selling confirmation');
    if ((level - last.close) > volatility * .5) return reject('Reclaim fade already extended');
    const symbolReturn = a.at(-1).close / a.at(-16).close - 1;
    const btc15Return = btc.at(-1).close / btc.at(-16).close - 1;
    if (btcEfficiency >= .35 && btcReturn > 0 && symbolReturn >= btc15Return - .005)
      return reject('No relative weakness in trending BTC');
    direction = 'SHORT'; entry = last.close; closeTime = last.end;
    stop = Math.max(rejection.high, retest.high) + volatility * .1;
  }
  const quality = entryQuality({ direction, entry, stop, reference: entry, fee: .0005 });
  if (!quality.allowed) return reject(quality.reason.startsWith('Modeled fees') ? 'Cost ceiling' : quality.reason);
  if (Math.abs(stop / entry - 1) > .025) return reject('Structural risk too wide');
  // allowed:false prevents accidental routing into FuturesAutoExecutor.
  return { allowed: false, candidate: true, executable: false, model, symbol,
    direction, entry, stop, level, centre: centre ?? null, barCloseTime: closeTime, btcEfficiency };
}
