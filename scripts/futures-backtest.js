// Legacy entry research plus v2 variants; NOT a v6.9.68 structure/re-entry backtest.
// v3: candle-based research with explicit model limitations.
// v3.1: adds 'ratchet' exit research: no profit target; stop to break-even at +1R net,
//       then the stop follows 1R behind each new whole net-R level (+2R -> +1R, +3R -> +2R ...).
// v3.2: adds 'inverse' research: every signal traded in the OPPOSITE direction as an exact mirror
//       (target = the original stop price; stop = the original entry +/- 1.5x the original stop distance; no break-even).
// v3.3: adds research signal 'v2' (scripts/futures-v2-research.js): 1h trend + 15m pullback/resumption,
//       stop at least 1 ATR(15m); tested with 1.5R, 2R and ratchet exits, 4h and 12h max hold.
// Read-only analysis. No API keys, no orders, no live setting is touched.
//   node scripts/futures-backtest.js fetch --days 60
//   nice -n 19 node --max-semi-space-size=1 --min-semi-space-size=1 --single-threaded --max-old-space-size=32 scripts/futures-backtest.js run
// Options: --symbols BTCUSDT,ETHUSDT,SOLUSDT  --days 60  --equity 180  --dir /var/tmp/nexio-futures-bt
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { closedSeries, legacyDirectionalSignal as directionalSignal, trendDirection } from '../src/futures-auto-strategy.js';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';
import { futuresExitPlan } from '../src/futures-auto-executor.js';
import { trendPullbackSignal } from './futures-v2-research.js';
import { entryQuality } from '../src/entry-quality.js';
import { FadeExchange, fadeFilters } from '../src/fade-orders.js';

const TF = { '1m': 60000, '15m': 900000, '1h': 3600000 };
const COOLDOWN_LOSSES = 3, COOLDOWN_MS = 2 * 3600000; // Research assumptions; verify live configuration separately.
const FEE = 0.0005, MARKET_SLIP = 0.0005, ENTRY_SLIP = 0.0002, MAX_HOLD_MS = 4 * 3600000, DUBAI_MS = 4 * 3600000;
export const APPROXIMATE_FILTERS = {
  BTCUSDT: { step: 0.001, min: 0.001, notional: 100, tick: 0.1 }, ETHUSDT: { step: 0.001, min: 0.001, notional: 20, tick: 0.01 },
  SOLUSDT: { step: 0.01, min: 0.01, notional: 5, tick: 0.01 }, BNBUSDT: { step: 0.01, min: 0.01, notional: 5, tick: 0.01 },
  XRPUSDT: { step: 0.1, min: 0.1, notional: 5, tick: 0.0001 }, ADAUSDT: { step: 1, min: 1, notional: 5, tick: 0.0001 },
  LINKUSDT: { step: 0.01, min: 0.01, notional: 5, tick: 0.001 }, AVAXUSDT: { step: 1, min: 1, notional: 5, tick: 0.001 },
  LTCUSDT: { step: 0.001, min: 0.001, notional: 5, tick: 0.01 },
};
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (value, width) => String(value).padEnd(width);
const num = (value, digits = 2) => (Number.isNaN(value) || value == null ? 'N/A' : Number.isFinite(value) ? value.toFixed(digits) : 'inf');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// ---- data: Float64 files, 8 numbers per candle: time, open, high, low, close, volume, quote, takerBuyQuote
function publicExchange() {
  if (!process.env.NEXIO_BINANCE_BUDGET_DIR) throw Error('fetch requires NEXIO_BINANCE_BUDGET_DIR pointing to the workers shared budget');
  return new FadeExchange({ environment: 'live' });
}
export async function fetchSeries(symbol, tf, fromMs, toMs, pauseMs = 1000, exchange = publicExchange()) {
  const ms = TF[tf];
  if (!ms || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw Error('Invalid historical range');
  const rows = []; let start = fromMs;
  while (start < toMs) {
    // Shared budget and bounded HTTP deadlines. On refusal/429/418 stop;
    // never blindly retry a ban or consume protection headroom.
    const batch = await exchange.request('GET', '/fapi/v1/klines',
      {symbol, interval: tf, limit: 499, startTime: start, endTime: toMs - 1}, false);
    if (!Array.isArray(batch) || !batch.length) throw Error('Historical data ended early for ' + symbol + ' ' + tf);
    for (const r of batch) {
      if (!Array.isArray(r) || r.length < 11 || Number(r[0]) < start || Number(r[6]) !== Number(r[0]) + ms - 1)
        throw Error('Malformed historical page');
      if (Number(r[6]) < toMs) rows.push([Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5]), Number(r[7]), Number(r[10])]);
    }
    const next = Number(batch.at(-1)[0]) + ms;
    if (!(next > start)) throw Error('Historical page did not advance');
    start = next;
    if (start < toMs) await sleep(pauseMs);
  }
  validateSeries(toFloats(rows), ms, symbol + ' ' + tf);
  return rows;
}
const toFloats = (rows) => { const a = new Float64Array(rows.length * 8); rows.forEach((r, i) => a.set(r, i * 8)); return a; };
async function fetchAll(dir, symbols, days) {
  await mkdir(dir, { recursive: true });
  const exchange = publicExchange();
  const info = await exchange.request('GET', '/fapi/v1/exchangeInfo', {}, false);
  const filters = {};
  for (const symbol of symbols) {
    const meta = info?.symbols?.find(x => x.symbol === symbol && x.status === 'TRADING' && x.contractType === 'PERPETUAL');
    if (!meta) throw Error('Unknown/non-trading contract: ' + symbol);
    const f = fadeFilters(meta); filters[symbol] = {step:f.step,min:f.min,notional:f.notional,tick:f.tick,max:f.max};
  }
  const now = Date.now(); const to = now - (now % 3600000);
  await writeFile(dir + '/filters.json', JSON.stringify({capturedAt: now, note:'Current exchange filters, not historical filters', filters}, null, 2));
  for (const symbol of symbols) {
    for (const tf of ['1m', '15m', '1h']) {
      const warm = tf === '1m' ? 0 : 8;
      const from = to - ((days + warm) * 86400000);
      const rows = await fetchSeries(symbol, tf, from, to, 1000, exchange);
      if (rows.length < 200) throw new Error('Too little ' + tf + ' data for ' + symbol + ' (' + rows.length + ')');
      await writeFile(dir + '/' + symbol + '_' + tf + '.f64', Buffer.from(toFloats(rows).buffer));
      console.log(symbol + ' ' + tf + ': ' + rows.length + ' candles, ' + stamp(rows[0][0]) + ' to ' + stamp(rows.at(-1)[0]) + ' UTC');
    }
  }
}
async function loadFloats(file) {
  const buf = await readFile(file);
  if (buf.length % 64) throw Error('Truncated Float64 candle file: ' + file);
  return new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}
export function validateSeries(a, ms, name = 'candles') {
  if (!(a instanceof Float64Array) || !a.length || a.length % 8) throw Error(name + ': invalid candle buffer');
  for (let o = 0; o < a.length; o += 8) {
    for (let j = 0; j < 8; j++) if (!Number.isFinite(a[o+j])) throw Error(name + ': non-finite candle');
    const [t, open, high, low, close, volume, quote, buy] = a.subarray(o,o+8);
    if (!Number.isSafeInteger(t) || t % ms || low <= 0 || high < Math.max(open,close) || low > Math.min(open,close)
      || volume < 0 || quote < 0 || buy < 0 || buy > quote || (o && t - a[o-8] !== ms)) throw Error(name + ': invalid/gapped candles');
  }
}
const lastAtOrBefore = (a, value) => {
  let lo = 0, hi = a.length / 8 - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid * 8] <= value) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
};
const rowsEnding = (a, ms, last, count) => {
  const out = [];
  for (let i = Math.max(0, last - count + 1); i <= last; i += 1) {
    const o = i * 8; out.push([a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5], a[o] + ms - 1, a[o + 6], 0, 0, a[o + 7], 0]);
  }
  return out;
};

// Legacy strict gate and research-only 15m variant. Current rules are called directly.
export function signalCopy(input, useHourly) {
  const { symbol, m1, m15, h1, btc15, btc1h, now } = input;
  const reject = (reason) => ({ allowed: false, reason: reason });
  let a, b, c, d, e;
  try {
    a = closedSeries(m1, 60000, now); b = closedSeries(m15, 900000, now); c = closedSeries(h1, 3600000, now);
    d = closedSeries(btc15, 900000, now); e = closedSeries(btc1h, 3600000, now);
  } catch (err) { return reject(err.message); }
  const direction = trendDirection(b);
  const others = useHourly === 'none' ? [] : useHourly ? [c, d, e] : [d];
  if (!direction || others.some((x) => trendDirection(x) !== direction)) return reject('trend');
  const sign = direction === 'LONG' ? 1 : -1;
  for (let k = b.length - 1; k >= b.length - 2; k--) {
    const burst = b[k], prior = b.slice(k - 20, k);
    const level = direction === 'LONG' ? Math.max(...prior.map((x) => x.high)) : Math.min(...prior.map((x) => x.low));
    if (sign * (burst.close - level) <= 0 || sign * (burst.close - burst.open) <= 0
      || burst.volume < prior.reduce((s, x) => s + x.volume, 0) / prior.length * 1.3) continue;
    const after = a.filter((x) => x.time > burst.end), reclaim = after.at(-1);
    if (!reclaim || now - reclaim.end > 90000 || after.length < 2) continue;
    const retests = after.slice(0, -1).filter((x) => direction === 'LONG'
      ? x.low <= level * 1.001 && x.close >= level * 0.999
      : x.high >= level * 0.999 && x.close <= level * 1.001);
    const retest = retests.at(-1);
    if (!retest || sign * (reclaim.close - level) <= 0 || sign * (reclaim.close - reclaim.open) <= 0
      || (direction === 'LONG' ? reclaim.close <= retest.high : reclaim.close >= retest.low)
      || (direction === 'LONG' ? reclaim.buy / reclaim.quote < 0.55 : reclaim.buy / reclaim.quote > 0.45)) continue;
    const atr = b.slice(-14).reduce((s, r, i, arr) => s + Math.max(r.high - r.low,
      Math.abs(r.high - (arr[i - 1]?.close ?? r.open)), Math.abs(r.low - (arr[i - 1]?.close ?? r.open))), 0) / 14;
    if (Math.abs(reclaim.close - level) > atr * 0.5) return reject('extended');
    const stop = direction === 'LONG' ? Math.min(retest.low, reclaim.low) - atr * 0.1 : Math.max(retest.high, reclaim.high) + atr * 0.1;
    if (Math.abs(stop / reclaim.close - 1) > 0.015) return reject('wide stop');
    return { allowed: true, symbol, direction, entry: reclaim.close, stop, barCloseTime: reclaim.end,
      breakoutTime: burst.end, level, atr, score: Math.abs(burst.close - level) / atr };
  }
  return reject('no setup');
}

// ---- signals: evaluated once per minute, exactly when the live scan would look
export function computeSignals(data, symbols) {
  const btc = data.BTCUSDT; const n1 = btc.m1.length / 8;
  const events = {}; const gateCache = new Map(); const stats = { minutes: 0, liveGate: 0, m15Gate: 0, checks: 0 };
  for (const s of symbols) events[s] = [];
  const winCache = new Map();
  const win = (id, a, ms, last) => { const c = winCache.get(id); if (c && c.last === last) return c.rows; const rows = rowsEnding(a, ms, last, 120); winCache.set(id, { last: last, rows: rows }); return rows; };
  const dirOf = (a, ms, last, now) => { try { return trendDirection(closedSeries(rowsEnding(a, ms, last, 120), ms, now)); } catch { return undefined; } };
  for (let k = 130; k < n1; k += 1) {
    const t = btc.m1[k * 8]; const now = t + 60000; stats.minutes += 1;
    if (k % 4000 === 0) collect();
    const b15 = lastAtOrBefore(btc.m15, now - 900000), b1h = lastAtOrBefore(btc.h1, now - 3600000);
    if (b15 < 60 || b1h < 60) continue;
    for (const symbol of symbols) {
      const d = data[symbol]; const i1 = lastAtOrBefore(d.m1, t);
      if (i1 < 120 || d.m1[i1 * 8] !== t) continue;
      const i15 = lastAtOrBefore(d.m15, now - 900000), i1h = lastAtOrBefore(d.h1, now - 3600000);
      if (i15 < 60 || i1h < 60) continue;
      const key = symbol + ':' + i15 + ':' + i1h + ':' + b15 + ':' + b1h;
      let g = gateCache.get(key);
      if (!g) {
        const s15 = dirOf(d.m15, 900000, i15, now), s1h = dirOf(d.h1, 3600000, i1h, now);
        const x15 = dirOf(btc.m15, 900000, b15, now), x1h = dirOf(btc.h1, 3600000, b1h, now);
        g = { live: Boolean(s15 && s15 === s1h && s15 === x15 && s15 === x1h), m15: Boolean(s15 && s15 === x15) };
        gateCache.set(key, g); if (gateCache.size > 4000) gateCache.delete(gateCache.keys().next().value);
      }
      if (g.live) stats.liveGate += 1;
      if (g.m15) stats.m15Gate += 1;
      const input = { symbol, now, m1: rowsEnding(d.m1, 60000, i1, 120), m15: win(symbol + '15', d.m15, 900000, i15),
        h1: win(symbol + '1h', d.h1, 3600000, i1h), btc15: win('B15', btc.m15, 900000, b15), btc1h: win('B1h', btc.h1, 3600000, b1h) };
      const current = directionalSignal(input);
      let live = null;
      if (g.live) {
        const copy = signalCopy(input, true); stats.checks += 1;
        if (copy.allowed) live = copy;
      }
      const m15 = signalCopy(input, false), noBtc = signalCopy(input, 'none');
      const v2 = (now - d.m15[i15 * 8] - 900000) < 60000 ? trendPullbackSignal(input) : { allowed: false };
      if (current.allowed || live || m15.allowed || noBtc.allowed || v2.allowed) events[symbol].push({ k, current: current.allowed ? current : null, live, m15: m15.allowed ? m15 : null, noBtc: noBtc.allowed ? noBtc : null, v2: v2.allowed ? v2 : null });
    }
  }
  return { events, stats };
}

// Candle-only execution model. Historical universe, OI/event gates and funding
// are omitted. Both OHLC path scenarios are simulated; neither is known truth.
export function simulate(data, events, pick, equity, symbols, exitMode = 'live', options = {}) {
  if (!Number.isFinite(equity) || equity <= 0) throw Error('Invalid starting equity');
  if (!['live','noBE','target2R','partial','ratchet','inverse'].includes(exitMode)) throw Error('Unknown exit mode');
  const pathMode = options.pathMode ?? 'adverse-first';
  if (!['adverse-first','favorable-first'].includes(pathMode)) throw Error('Unknown candle path');
  const filters = options.filters ?? APPROXIMATE_FILTERS;
  for (const symbol of ['BTCUSDT', ...symbols]) {
    if (!data[symbol]?.m1) throw Error('Missing 1m series: ' + symbol);
    validateSeries(data[symbol].m1, 60000, symbol);
    if (!filters[symbol]) throw Error('Missing exchange filters for ' + symbol);
    const f = filters[symbol];
    if (![f.step,f.min,f.notional,f.tick].every(x => Number.isFinite(x) && x > 0)) throw Error('Invalid filters for ' + symbol);
  }
  const btc = data.BTCUSDT, n1 = btc.m1.length / 8;
  const byK = new Map();
  for (const symbol of symbols) for (const ev of events[symbol] ?? []) {
    const sig = ev[pick]; if (!sig) continue;
    if (!byK.has(ev.k)) byK.set(ev.k, []);
    byK.get(ev.k).push({symbol,sig});
  }
  for (const rows of byK.values()) rows.sort((a,b) => (b.sig.score ?? 0) - (a.sig.score ?? 0) || a.symbol.localeCompare(b.symbol));
  const open = new Map(), pending = new Map(), trades = [], skipped = {}, lastBreakout = {};
  let wallet = equity, day = -1, dayPnl = 0, dayPeak = 0, lockedDay = -1, coolUntil = 0, signals = 0;
  let peakEquity = equity, maxDrawdownUsd = 0;
  const startMs = options.startMs ?? -Infinity, endMs = options.endMs ?? Infinity;
  const skip = why => {skipped[why] = (skipped[why] ?? 0) + 1;};
  const barOf = (symbol,k) => {
    const a = data[symbol].m1, t = btc.m1[k*8], i = lastAtOrBefore(a,t), o = i*8;
    if (i < 0 || a[o] !== t) throw Error('Missing position-management candle for ' + symbol + ' at ' + stamp(t));
    return {t,open:a[o+1],high:a[o+2],low:a[o+3],close:a[o+4]};
  };
  const markPnl = (tr,px) => tr.qty * (tr.dir === 'LONG' ? px-tr.fill : tr.fill-px);
  const resetDay = time => {
    const d = Math.floor((time+DUBAI_MS)/86400000);
    if (d !== day) {day=d;dayPnl=0;dayPeak=0;}
    return d;
  };
  const cash = (amount,time) => {
    resetDay(time); wallet += amount; dayPnl += amount; dayPeak = Math.max(dayPeak,dayPnl);
    if (dayPnl <= -.02*wallet || (dayPeak >= Math.max(3,wallet*.02) && dayPeak-dayPnl >= Math.max(2,wallet*.01))) lockedDay=day;
  };
  const exitQuantity = (tr,quantity,px,market,time) => {
    const actual = px*(tr.dir==='LONG' ? 1-(market?MARKET_SLIP:0) : 1+(market?MARKET_SLIP:0));
    const amount = quantity*((tr.dir==='LONG' ? actual-tr.fill : tr.fill-actual)-actual*FEE);
    cash(amount,time); tr.realized += amount;
    tr.qty = Number((tr.qty-quantity).toFixed(12));
    tr.margin = tr.qty*tr.fill/2;
    tr.remainingRisk = tr.loss * tr.qty/tr.originalQty;
  };
  const close = (tr,px,market,reason,time) => {
    exitQuantity(tr,tr.qty,px,market,time);open.delete(tr.symbol);
    const pnl=tr.realized;
    trades.push({symbol:tr.symbol,dir:tr.dir,entryTime:tr.entryTime,exitTime:time,reason,pnl,R:pnl/tr.loss,holdMin:(time-tr.entryTime)/60000});
    const recent=trades.slice(-COOLDOWN_LOSSES);
    if (recent.length===COOLDOWN_LOSSES && recent.every(t=>t.pnl<0) && recent[0].exitTime>=time-7*86400000) coolUntil=time+COOLDOWN_MS;
  };
  const enter = (p,k) => {
    if (exitMode==='inverse') {
      const o=p.sig,d=Math.abs(o.entry-o.stop),up=o.direction==='LONG';
      p={...p,sig:{...o,direction:up?'SHORT':'LONG',stop:up?o.entry+1.5*d:o.entry-1.5*d,mirrorTarget:o.stop}};
    }
    const bar=barOf(p.symbol,k),f=filters[p.symbol],long=p.sig.direction==='LONG';
    if (bar.t<coolUntil || lockedDay===resetDay(bar.t)) {skip('risk gate changed before fill');return;}
    const fill=bar.open*(long?1+ENTRY_SLIP:1-ENTRY_SLIP);
    const quality=entryQuality({direction:p.sig.direction,entry:fill,stop:p.sig.stop,reference:p.sig.entry,fee:FEE});
    if (!quality.allowed) {skip(quality.reason);return;}
    const used=[...open.values()];
    const markEquity=wallet+used.reduce((sum,tr)=>sum+markPnl(tr,barOf(tr.symbol,k).open),0);
    const marginUsed=used.reduce((sum,tr)=>sum+tr.margin,0);
    const plan=planFuturesAutoTrade({direction:p.sig.direction,entry:bar.open,stop:p.sig.stop,equity:markEquity,
      available:Math.max(0,markEquity-marginUsed),open:used.map(tr=>({riskUsd:tr.remainingRisk,marginUsd:tr.margin})),
      feeRate:FEE,qtyStep:f.step,minQty:f.min,minNotional:f.notional});
    if (!plan.allowed) {skip(plan.reason);return;}
    let ep,be1,target;
    try {
      ep=futuresExitPlan(p.sig.direction,fill,plan.qty,p.sig.stop,FEE,f.tick);
      be1=futuresExitPlan(p.sig.direction,fill,plan.qty,p.sig.stop,FEE,f.tick,1).target;
      target=['target2R','partial'].includes(exitMode)?futuresExitPlan(p.sig.direction,fill,plan.qty,p.sig.stop,FEE,f.tick,2).target:ep.target;
    } catch {skip('entry fill already beyond stop');return;}
    if (exitMode==='inverse') {
      target=p.sig.mirrorTarget;
      if (long ? !(target>fill) : !(target<fill)) {skip('entry fill already beyond mirror target');return;}
    }
    if (ep.plannedLossUsd>Math.min(5,markEquity*.01)+1e-8 || ep.plannedLossUsd+used.reduce((sum,tr)=>sum+tr.remainingRisk,0)>markEquity*.03+1e-8
      || ep.marginUsd+marginUsed>markEquity*.5+1e-8 || fill*plan.qty>150+1e-8 || (f.max && plan.qty>f.max)) {skip('actual fill exceeds modeled budgets');return;}
    const half=Number((Math.floor(plan.qty/2/f.step+1e-9)*f.step).toFixed(12));
    if (exitMode==='partial' && (half<f.min || plan.qty-half<f.min || half*be1<f.notional || (plan.qty-half)*target<f.notional)) {
      skip('partial exit below exchange minimum');return;
    }
    const fee=plan.qty*fill*FEE;
    cash(-fee,bar.t);
    open.set(p.symbol,{symbol:p.symbol,dir:p.sig.direction,fill,qty:plan.qty,originalQty:plan.qty,stop:p.sig.stop,target,breakEven:ep.breakEven,
      be1,loss:ep.plannedLossUsd,remainingRisk:ep.plannedLossUsd,margin:ep.marginUsd,entryTime:bar.t,beMoved:false,
      realized:-fee,half:exitMode==='partial'?half:0,partialDone:false,
      ...(exitMode==='ratchet'?{target:null,nextStep:2,
        rLevel:n=>futuresExitPlan(p.sig.direction,fill,plan.qty,p.sig.stop,FEE,f.tick,n).target}:{})});
    lastBreakout[p.symbol]=p.sig.breakoutTime;
  };
  const manage = (tr,bar) => {
    const long=tr.dir==='LONG',end=bar.t+60000;
    const favorable=px=>tr.target!=null&&(long?px>=tr.target:px<=tr.target);
    const stepLevel=()=>tr.rLevel(tr.nextStep);
    const stopReached=px=>long?px<=tr.stop:px>=tr.stop;
    const applyAt=px=>{
      if(stopReached(px)){close(tr,px,true,tr.ratcheted?'RATCHET_STOP':tr.beMoved?'BREAK_EVEN':'STOP',end);return;}
      const reached1=long?px>=tr.be1:px<=tr.be1;
      if(tr.half&&!tr.partialDone&&reached1){exitQuantity(tr,tr.half,tr.be1,false,end);tr.partialDone=true;}
      if(favorable(px)){close(tr,tr.target,false,'TARGET',end);return;}
      if(!['noBE','inverse'].includes(exitMode)&&!tr.beMoved&&reached1&&(long?tr.breakEven>tr.stop:tr.breakEven<tr.stop)){tr.stop=tr.breakEven;tr.beMoved=true;}
      if(exitMode==='ratchet'&&tr.beMoved){
        for(let guard=0;guard<100&&(long?px>=stepLevel():px<=stepLevel());guard++){
          const next=tr.rLevel(tr.nextStep-1);
          if(long?next>tr.stop:next<tr.stop){tr.stop=next;tr.ratcheted=true;}
          tr.nextStep++;
        }
      }
    };
    applyAt(bar.open); if(!open.has(tr.symbol))return;
    const adverse=long?bar.low:bar.high,positive=long?bar.high:bar.low;
    const path=pathMode==='adverse-first'?[bar.open,adverse,positive,bar.close]:[bar.open,positive,adverse,bar.close];
    for(let j=1;j<path.length&&open.has(tr.symbol);j++){
      let from=path[j-1]; const to=path[j],up=to>from;
      for(let iter=0;iter<8&&open.has(tr.symbol);iter++){
        const levels=[tr.stop];if(tr.target!=null)levels.push(tr.target);
        if(exitMode==='ratchet'&&tr.beMoved)levels.push(stepLevel());
        if((tr.half&&!tr.partialDone)||(!['noBE','inverse'].includes(exitMode)&&!tr.beMoved))levels.push(tr.be1);
        const crosses=levels.filter(px=>up?px>from&&px<=to:px<from&&px>=to).sort((a,b)=>up?a-b:b-a);
        if(!crosses.length)break;
        from=crosses[0];applyAt(from);
      }
    }
    if(open.has(tr.symbol)&&end-tr.entryTime>=(options.maxHoldMs??MAX_HOLD_MS))close(tr,bar.close,true,'MAX_HOLD',end);
  };
  let lastK=-1;
  for(let k=130;k<n1;k++){
    const t=btc.m1[k*8],end=t+60000;
    if(t<startMs||end>endMs)continue;
    lastK=k;resetDay(t);
    for(const p of pending.get(k)??[])enter(p,k);
    pending.delete(k);
    for(const tr of [...open.values()])manage(tr,barOf(tr.symbol,k));
    const currentEquity=wallet+[...open.values()].reduce((sum,tr)=>sum+markPnl(tr,barOf(tr.symbol,k).close),0);
    peakEquity=Math.max(peakEquity,currentEquity);maxDrawdownUsd=Math.max(maxDrawdownUsd,peakEquity-currentEquity);
    for(const ev of byK.get(k)??[]){
      signals++;const queued=pending.get(k+1)??[];
      if(open.has(ev.symbol)||queued.some(x=>x.symbol===ev.symbol)){skip('already in this symbol');continue;}
      if(lastBreakout[ev.symbol]===ev.sig.breakoutTime){skip('same breakout as last trade');continue;}
      if(open.size+queued.length>=5){skip('five-position cap');continue;}
      if(end<coolUntil){skip('loss cooldown');continue;}
      if(lockedDay===day){skip('daily loss lock');continue;}
      queued.push(ev);pending.set(k+1,queued);
    }
  }
  const unrealized=lastK<0?0:[...open.values()].reduce((sum,tr)=>sum+markPnl(tr,barOf(tr.symbol,lastK).close),0);
  return {trades,skipped,signals,stillOpen:open.size,endingWallet:wallet,endingEquity:wallet+unrealized,maxDrawdownUsd,
    unresolved: [...open.values()].map(tr=>({symbol:tr.symbol,remainingQty:tr.qty,realizedCash:tr.realized,remainingMargin:tr.margin,remainingRisk:tr.remainingRisk})),
    pathMode,exitMode,cooldownLosses:COOLDOWN_LOSSES,cooldownHours:COOLDOWN_MS/3600000};
}

export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, avgR: 0, lo: NaN, hi: NaN, pf: 0, ddR: 0, usd: 0 };
  const rs = trades.map((t) => t.R); const mean = rs.reduce((a, b) => a + b, 0) / n;
  let lo = NaN, hi = NaN;
  const blocks = new Map();
  for (const tr of trades) {
    if (!Number.isFinite(tr.entryTime)) continue;
    const key = Math.floor((tr.entryTime + DUBAI_MS) / (7 * 86400000));
    if (!blocks.has(key)) blocks.set(key, []); blocks.get(key).push(tr.R);
  }
  if (blocks.size >= 4 && trades.every(tr => Number.isFinite(tr.entryTime))) {
    const groups = [...blocks.values()], estimates = []; let state = 123456789;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (let iteration = 0; iteration < 500; iteration++) {
      let sum = 0, count = 0;
      for (let j = 0; j < groups.length; j++) { const block = groups[Math.floor(random() * groups.length)]; for (const r of block) sum += r; count += block.length; }
      estimates.push(sum / count);
    }
    estimates.sort((a,b) => a-b); lo=estimates[12]; hi=estimates[487];
  }
  const win = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = -trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  let cum = 0, peak = 0, dd = 0; for (const x of rs) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { n: n, winRate: trades.filter((t) => t.pnl > 0).length / n * 100, avgR: mean, lo, hi, intervalMethod: 'weekly-block-bootstrap', blocks: blocks.size,
    pf: loss > 0 ? win / loss : Infinity, ddR: dd, usd: trades.reduce((a, t) => a + t.pnl, 0) };
}
const line = (name, seg, s) => console.log(pad(name, 30) + pad(seg, 6) + pad(s.n, 7) + pad(num(s.winRate, 1), 7) + pad(num(s.avgR, 3), 8)
  + pad(num(s.lo, 2) + '..' + num(s.hi, 2), 14) + pad(num(s.pf, 2), 6) + pad(num(s.ddR, 1), 9) + (s.usd < 0 ? '-' : '') + '$' + Math.abs(s.usd).toFixed(2));

async function runBacktest(dir,symbols,equity) {
  const all=[...new Set(['BTCUSDT',...symbols])],data={};
  let filters=APPROXIMATE_FILTERS,filterSource='Approximate fallback filters; results require sensitivity checking';
  try {
    const snapshot=JSON.parse(await readFile(dir+'/filters.json','utf8'));
    if(!snapshot.filters||!Number.isFinite(snapshot.capturedAt))throw Error('Invalid filter snapshot');
    filters=snapshot.filters;filterSource='Exchange filters captured '+stamp(snapshot.capturedAt)+' UTC (not historical rules)';
  } catch(e) {if(e.code!=='ENOENT')throw e;}
  for(const symbol of all){
    if(!filters[symbol])throw Error('No filters for '+symbol+'; fetch a fresh dataset/metadata first');
    data[symbol]={m1:await loadFloats(dir+'/'+symbol+'_1m.f64'),m15:await loadFloats(dir+'/'+symbol+'_15m.f64'),h1:await loadFloats(dir+'/'+symbol+'_1h.f64')};
    for(const [tf,key] of [['1m','m1'],['15m','m15'],['1h','h1']])validateSeries(data[symbol][key],TF[tf],symbol+' '+tf);
  }
  const m=data.BTCUSDT.m1,t0=m[0],t1=m[m.length-8]+60000;
  for(const symbol of all)if(data[symbol].m1[0]!==t0||data[symbol].m1.at(-8)+60000!==t1)throw Error('1m coverage differs for '+symbol);
  console.log('CANDLE-ONLY FUTURES RESEARCH v3 · no orders or account access');
  console.log(filterSource);
  console.log('Data: '+all.join(' ')+' | '+stamp(t0)+' to '+stamp(t1)+' UTC | initial equity $'+equity);
  console.log('Historical 60-symbol membership and long-quality, event/OI gates, funding and liquidation are NOT replayed.');
  console.log('Research cooldown assumption: three losses / two hours. Confirm separately against deployed Futures settings.');
  const {events,stats}=computeSignals(data,symbols);
  console.log('Minutes '+stats.minutes+' | legacy strict gate open '+num(stats.liveGate/(stats.minutes*symbols.length)*100,1)+'% (not current gate)');
  const split=Math.floor((t0+(t1-t0)*.6)/60000)*60000;
  console.log('Train/test below are independent cash accounts: test starts flat at the same initial equity. Signals may use earlier closed bars for warm-up.');
  console.log(pad('variant',30)+pad('seg',6)+pad('trades',7)+pad('win%',7)+pad('avgR',8)+pad('weekly boot',14)+pad('PF',6)+pad('DD(R)',9)+'closed net$');
  const runs={},specs=[['current','current','live'],['legacy hourly','live','live'],['15m only','m15','live'],['no BTC research','noBtc','live'],
    ['current/noBE','current','noBE'],['current/target2R','current','target2R'],['current/partial','current','partial'],['current/ratchet','current','ratchet'],['current/INVERSE','current','inverse'],
    ['V2 1.5R','v2','live'],['V2 2R','v2','target2R'],['V2 ratchet','v2','ratchet'],
    ['V2 2R 12h','v2','target2R',{maxHoldMs:12*3600000}],['V2 ratchet 12h','v2','ratchet',{maxHoldMs:12*3600000}]];
  for(const [name,pick,mode,extra={}] of specs){
    runs[name]={};
    for(const pathMode of ['adverse-first','favorable-first']){
      const r=simulate(data,events,pick,equity,symbols,mode,{filters,pathMode,...extra});
      runs[name][pathMode]=r;
      line(name+'/'+(pathMode==='adverse-first'?'AF':'FF'),'all',summarize(r.trades));
      if(pathMode==='adverse-first'){
        const train=simulate(data,events,pick,equity,symbols,mode,{filters,pathMode,endMs:split,...extra});
        const test=simulate(data,events,pick,equity,symbols,mode,{filters,pathMode,startMs:split,...extra});
        runs[name].independentTrain=train;runs[name].independentTest=test;
        line(name,'train',summarize(train.trades));line(name,'test',summarize(test.trades));
      }
      console.log('  wallet $'+num(r.endingWallet)+' · equity $'+num(r.endingEquity)+' · open '+r.stillOpen+' · minute-close equity DD $'+num(r.maxDrawdownUsd));
      console.log('  skipped '+JSON.stringify(r.skipped));
    }
  }
  const current=runs.current['adverse-first'];
  console.log('Current rules, adverse-first: by UAE entry hour (descriptive, not a discovered trading window)');
  for(let h=0;h<24;h++){
    const rows=current.trades.filter(t=>Math.floor(((t.entryTime+DUBAI_MS)%86400000)/3600000)===h);
    if(rows.length)line(String(h).padStart(2,'0')+':00','all',summarize(rows));
  }
  for(const direction of ['LONG','SHORT'])line(direction,'all',summarize(current.trades.filter(t=>t.dir===direction)));
  for(const symbol of symbols)line(symbol,'all',summarize(current.trades.filter(t=>t.symbol===symbol)));
  await writeFile(dir+'/review-results-v3.json',JSON.stringify({generatedAt:new Date().toISOString(),symbols,equity,filterSource,stats,
    limitations:['No historical universe/long-quality replay','No funding/event/OI/liquidation','OHLC paths are scenarios, not actual intrabar ordering','Independent test uses historical warm-up','Current/approximate filters, fixed modeled costs'],runs},(_,v)=>typeof v==='number'&&!Number.isFinite(v)?null:v,2));
  console.log('Fees: 0.05% per side; entry slippage 0.02%; market-exit slippage 0.05%. Limit fills are assumed when touched.');
  console.log('AF/FF are per-position adverse-first/favorable-first OHLC scenarios, not bounds or known market paths. Portfolio intrabar synchronisation is not modelled.');
  console.log('Closed-trade R drawdown differs from minute-close equity drawdown. Wallet includes entry fees and partial realisations; equity includes remaining unrealised PnL.');
  console.log('Weekly-bootstrap intervals describe this sample, not profitability certification; fewer than four weekly blocks prints N/A.');
  console.log('Do not select a variant solely because its holdout wins. Repeated tuning consumes the holdout; validate on untouched periods.');
  console.log('Peak memory: '+Math.round(process.resourceUsage().maxRSS/1024)+' MB');
}

async function main(){
  const args=process.argv.slice(2),command=args[0]??'help';
  const opt=(name,fallback)=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:fallback;};
  const dir=opt('dir','/var/tmp/nexio-futures-bt');
  const symbols=[...new Set(String(opt('symbols','BTCUSDT,ETHUSDT,SOLUSDT')).split(',').map(s=>s.trim().toUpperCase()))];
  const days=Number(opt('days',60)),equity=Number(opt('equity',180));
  try{
    if(symbols.some(s=>! /^[A-Z0-9]+USDT$/.test(s))||!symbols.length)throw Error('Invalid symbols');
    if(!Number.isInteger(days)||days<1||days>365||!Number.isFinite(equity)||equity<=0)throw Error('Invalid days/equity');
    if(command==='fetch')await fetchAll(dir,[...new Set(['BTCUSDT',...symbols])],days);
    else if(command==='run')await runBacktest(dir,symbols,equity);
    else console.log('Usage: futures-backtest.js fetch --days 60 | run (--symbols, --equity, --dir). Fetch requires shared budget environment.');
  }catch(e){console.error('Error: '+e.message);process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
