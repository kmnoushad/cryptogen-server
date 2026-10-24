import { detectStructure } from './structure-policy.js';
const LEVERAGED_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;
const asNum = x => Number.isFinite(Number(x)) ? Number(x) : NaN;

// Select a broad USDT-perpetual universe from live exchange metadata and the
// all-symbol 24h ticker snapshot. Deep candle scans are bounded and rotated;
// metadata/tickers still cover every eligible contract each minute.
export function selectFuturesUniverse({ exchangeInfo, tickers, now, cursor = 0, maxSymbols = 120 }) {
  const reject = { eligible: [], symbols: [], quality: new Map(), nextCursor: cursor, reason: null };
  if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickers)) {
    reject.reason = 'Universe metadata/ticker snapshot unavailable'; return reject;
  }
  const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
  const eligible = [];
  for (const s of exchangeInfo.symbols) {
    const t = tickerMap.get(s.symbol);
    if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT'
      || (s.marginAsset && s.marginAsset !== 'USDT') || !/^[A-Z0-9]+USDT$/.test(s.symbol)
      || LEVERAGED_SUFFIX.test(String(s.baseAsset ?? s.symbol.replace(/USDT$/, '')))) continue;
    const quoteVolume = asNum(t?.quoteVolume), trades = asNum(t?.count), price = asNum(t?.lastPrice);
    const changePct = asNum(t?.priceChangePercent), onboard = asNum(s.onboardDate);
    if (!(quoteVolume >= 5_000_000 && trades >= 1000 && price > 0 && Number.isFinite(changePct)
      && Number.isFinite(onboard) && onboard > 0 && onboard <= now && now - onboard >= 3 * 86400000)) continue;
    const longAllowed = now - onboard >= 14 * 86400000 && quoteVolume >= 20_000_000
      && trades >= 5000 && changePct >= -20 && changePct <= 25;
    eligible.push({ symbol: s.symbol, quoteVolume, trades, price, changePct, onboard,
      quality: { checkedAt: now, longAllowed, quoteVolume, trades, listingAgeDays: (now - onboard) / 86400000,
        changePct, reason: !longAllowed ? 'Long quality filter: listing age, liquidity, activity, or abnormal 24h move' : null } });
  }
  eligible.sort((a,b) => b.quoteVolume-a.quoteVolume || a.symbol.localeCompare(b.symbol));
  if (!eligible.length) { reject.reason = 'No contracts meet basic liquidity/activity filters'; return reject; }
  const bySymbol = new Map(eligible.map(x => [x.symbol,x]));
  // Scale group quotas with the caller's scan cap; reserve rotation slots.
  const limit = Math.min(120, Math.floor(Number(maxSymbols)));
  if (!Number.isFinite(limit) || limit < 0) {
    reject.reason = 'Invalid universe scan limit'; return reject;
  }
  const selected = new Set();
  const selectionGroups = { btc: 0, volume: 0, fallers: 0, risers: 0, rotation: 0 };
  const addDistinct = (rows, quota, group) => {
    let added = 0;
    for (const row of rows) {
      if (added >= quota || selected.size >= limit) break;
      if (selected.has(row.symbol)) continue;
      selected.add(row.symbol); added++; selectionGroups[group]++;
    }
  };
  if (limit > 0 && bySymbol.has('BTCUSDT')) { selected.add('BTCUSDT'); selectionGroups.btc++; }
  // At 60: BTC 1 + volume 19 + fallers 15 + long-eligible risers 15
  // leaves at least 10 for rotation. Empty groups add rotation capacity.
  addDistinct(eligible, Math.floor(limit * 19 / 60), 'volume');
  addDistinct([...eligible].sort((a,b) => a.changePct-b.changePct), Math.floor(limit * 15 / 60), 'fallers');
  addDistinct(eligible.filter(x => x.quality.longAllowed)
    .sort((a,b) => b.changePct-a.changePct), Math.floor(limit * 15 / 60), 'risers');
  const rest = eligible.filter(x => !selected.has(x.symbol));
  const slots = Math.max(0, limit - selected.size);
  const start = rest.length ? (cursor * Math.max(1, slots)) % rest.length : 0;
  for (let i = 0; i < Math.min(slots, rest.length); i++) { selected.add(rest[(start+i) % rest.length].symbol); selectionGroups.rotation++; }
  const symbols = [...selected].filter(s => bySymbol.has(s));
  reject.eligible = eligible.map(x => x.symbol); reject.symbols = symbols;
  reject.selectionGroups = selectionGroups; reject.notSelected = eligible.length - symbols.length;
  reject.quality = new Map(symbols.map(s => [s,bySymbol.get(s).quality]));
  reject.nextCursor = cursor + 1;
  return reject;
}
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
// The symbol 15m trend is the trigger. BTC and symbol 1h trends are filters:
// neutral is allowed, but a confirmed opposing direction blocks the setup.
export function legacyDirectionalSignal({ symbol, m1, m15, h1, btc15, btc1h, now, marketQuality }) {
  const reject = reason => ({ allowed: false, reason });
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return reject('Symbol is not a USDT contract');
  let a, b, c, d, e;
  try { a = closedSeries(m1, 60000, now); b = closedSeries(m15, 900000, now); c = closedSeries(h1, 3600000, now);
    d = closedSeries(btc15, 900000, now); e = closedSeries(btc1h, 3600000, now); }
  catch (err) { return reject(err.message); }
  const direction = trendDirection(b);
  const symbolH1 = trendDirection(c), btc15Trend = trendDirection(d), btcH1 = trendDirection(e);
  const opposes = x => x && x !== direction;
  if (!direction) return reject('Symbol 15m trend not confirmed');
  // Research replays may omit the live-market snapshot. The execution layer
  // separately fails closed unless its fresh universe-quality proof is present.
  if (direction === 'LONG' && marketQuality && (!marketQuality.longAllowed || now - Number(marketQuality.checkedAt) > 90000
    || Number(marketQuality.checkedAt) > now)) return reject(marketQuality.reason ?? 'Long market-quality gate stale');
  if (btc15Trend && btc15Trend !== direction) return reject(`BTC 15m trend ${btc15Trend} opposes symbol ${direction}`);
  if (opposes(symbolH1)) return reject('Symbol 1h trend strongly opposes setup');
  if (opposes(btcH1)) return reject('BTC 1h trend strongly opposes setup');
  const sign = direction === 'LONG' ? 1 : -1;
  let stage = 0;
  // Search only the last two closed 15m bars for a breakout; expire after 30m.
  for (let k = b.length - 1; k >= b.length - 2; k--) {
    const burst = b[k], prior = b.slice(k - 20, k);
    const level = direction === 'LONG' ? Math.max(...prior.map(x => x.high)) : Math.min(...prior.map(x => x.low));
    if (sign * (burst.close - level) <= 0 || sign * (burst.close - burst.open) <= 0
      || burst.volume < prior.reduce((s, x) => s + x.volume, 0) / prior.length * 1.3) continue;
    stage = Math.max(stage, 1);
    const after = a.filter(x => x.time > burst.end), reclaim = after.at(-1);
    if (!reclaim || now - reclaim.end > 90000 || after.length < 2) continue;
    const retests = after.slice(0, -1).filter(x => direction === 'LONG'
      ? x.low <= level * 1.001 && x.close >= level * .999
      : x.high >= level * .999 && x.close <= level * 1.001);
    const retest = retests.at(-1);
    if (retest) stage = Math.max(stage, 2);
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
  return reject('No fresh breakout/retest/reclaim confirmation: ' + [
    'no closed 15m breakout with required volume',
    'breakout found; distinct 1m retest missing or confirmation too early/stale',
    'retest found; latest 1m reclaim or taker flow not confirmed'][stage]);
}

export function directionalSignal({ symbol, m1, m15, h1, btc15, btc1h, now, marketQuality }) {
  const reject = reason => ({ allowed: false, reason });
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return reject('Symbol is not a USDT contract');
  let a, b, c, d, e;
  try { a = closedSeries(m1, 60000, now); b = closedSeries(m15, 900000, now); c = closedSeries(h1, 3600000, now);
    d = closedSeries(btc15, 900000, now); e = closedSeries(btc1h, 3600000, now); }
  catch (err) { return reject(err.message); }
  const direction = trendDirection(b);
  const symbolH1 = trendDirection(c), btc15Trend = trendDirection(d), btcH1 = trendDirection(e);
  const opposes = x => x && x !== direction;
  if (!direction) return reject('Symbol 15m trend not confirmed');
  // Research replays may omit the live-market snapshot. The execution layer
  // separately fails closed unless its fresh universe-quality proof is present.
  if (direction === 'LONG' && marketQuality && (!marketQuality.longAllowed || now - Number(marketQuality.checkedAt) > 90000
    || Number(marketQuality.checkedAt) > now)) return reject(marketQuality.reason ?? 'Long market-quality gate stale');
  if (btc15Trend && btc15Trend !== direction) return reject(`BTC 15m trend ${btc15Trend} opposes symbol ${direction}`);
  if (opposes(symbolH1)) return reject('Symbol 1h trend strongly opposes setup');
  if (opposes(btcH1)) return reject('BTC 1h trend strongly opposes setup');
  const setup = detectStructure(a, direction, now);
  return { ...setup, symbol };
}
