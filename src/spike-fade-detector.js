// Tick-based research detector. Candidates cannot submit orders.
import { entryQuality } from './entry-quality.js';
export class SpikeFadeDetector {
  constructor({ symbols, now = () => Date.now() }) {
    this.symbols = new Set(symbols); this.now = now; this.states = new Map();
  }
  reset(symbols) {
    if (!symbols) { this.states.clear(); return; }
    for (const symbol of symbols) this.states.delete(symbol);
  } // Reset only symbols whose market/book shard was interrupted.
  ingest(symbol, trade, context) {
    const now = this.now(), { a: id, T: time, m: sell } = trade;
    const price = Number(trade.p), qty = Number(trade.q);
    let s = this.states.get(symbol);
    const reject = reason => {
      if (s) s.lastReason = reason;
      return { allowed: false, executable: false, candidate: false, reason };
    };
    if (!this.symbols.has(symbol) || !Number.isSafeInteger(id) || !Number.isFinite(time)
      || typeof sell !== 'boolean' || !(price > 0 && qty > 0 && Number.isFinite(price * qty))
      || now - time > 2000 || time > now) return reject('Invalid or stale trade');
    if (!s) { s = { ticks: [], id: -1, time: -1, windowStart: time, watch: null, cooldown: 0, evaluated: -Infinity, lastReason: 'Warming up' }; this.states.set(symbol, s); }
    if (id <= s.id || time < s.time) return reject('Duplicate or out-of-order trade');
    // A trade lull breaks an in-progress spike/rejection pattern, but it does
    // not erase the rolling volume baseline. This lets intermittently traded
    // contracts warm up while the bounded 150s deque still ages old data out.
    if (s.time >= 0 && time - s.time > 5000) { s.watch = null; s.windowStart = time; }
    s.id = id; s.time = time;
    // One-second flow buckets preserve all quote volume and aggressor counts,
    // without retaining millions of raw trades across the full universe.
    const bucket=s.ticks.at(-1),second=Math.floor(time/1000);
    if(bucket?.second===second) {
      bucket.time=time;bucket.quote+=price*qty;bucket.sellQuote+=sell?price*qty:0;bucket.count++;
    } else s.ticks.push({second,time,firstTime:time,price,quote:price*qty,sellQuote:sell?price*qty:0,count:1});
    while(s.ticks.length && time-s.ticks[0].firstTime>150000) s.ticks.shift();
    if(s.watch && price>s.watch.high) {s.watch.high=price;s.watch.highAt=time;}
    if(time-s.evaluated<250) return reject('Sampling flow');
    s.evaluated=time;
    const result=reject;
    if (time < s.cooldown) return reject('Pattern cooldown');
    if (s.watch && time - s.watch.started > 45000) s.watch = null;
    if (!s.watch) {
      const base = s.ticks.filter(t => time - t.time > 30000),
        burst = s.ticks.filter(t => time - t.time <= 30000 && t.time >= s.windowStart);
      if (!base.length || time - s.ticks[0].firstTime < 140000) return reject('Warming up');
      const baseline = base.reduce((v, t) => v + t.quote, 0) / 120;
      const quote = burst.reduce((v, t) => v + t.quote, 0), gain = price / burst[0].price - 1;
      if (gain < .02 || quote < baseline * 30 * 3) return reject('No sudden spike');
      s.watch = { started: time, highAt: time, high: price, gain, quote };
      s.lastReason = 'Spike detected; awaiting rejection';
      return { ...reject('Spike detected; awaiting rejection'), watch: true, symbol, ...s.watch };
    }
    const w = s.watch;
    if (price > w.high) { w.high = price; w.highAt = time; }
    const retreat = 1 - price / w.high;
    if (retreat > .009) { s.watch = null; s.cooldown = time + 60000; return reject('Spike already faded; no chasing'); }
    if (retreat < .005 || time - w.highAt < 2000) return reject('Spike still rising or no rejection');
    const flow = s.ticks.filter(t => time - t.time <= 5000), quote = flow.reduce((v, t) => v + t.quote, 0);
    const sellShare = flow.reduce((v, t) => v + t.sellQuote, 0) / quote;
    if (sellShare < .6 || flow.reduce((v,t)=>v+t.count,0) < 3) return reject('Selling not confirmed');
    const { btc, book } = context ?? {};
    if (!btc || !Number.isFinite(btc.at) || now - btc.at > 2000 || btc.at > now
      || ![btc.return30s, btc.return15m].every(Number.isFinite)) return reject('BTC context unavailable');
    if (btc.return30s > .001 || btc.return15m > 0) return reject('BTC supports upside');
    if (!book || !Number.isFinite(book.at) || now - book.at > 1000 || book.at > now
      || ![book.bid, book.ask].every(Number.isFinite) || !(book.bid > 0 && book.ask >= book.bid)
      || book.ask / book.bid - 1 > .001) return reject('Book stale or spread too wide');
    const stop = w.high * 1.001, quality = entryQuality({ direction: 'SHORT', entry: book.bid,
      stop, reference: price, fee: .0005 });
    if (!quality.allowed) return reject(quality.reason);
    if (1 - book.bid / w.high > .009) return reject('Executable quote already extended');
    s.watch = null; s.cooldown = time + 60000;
    s.lastReason = 'Spike fade candidate';
    return { allowed: false, executable: false, candidate: true, model: 'spike-fade-ticks-v1',
      symbol, direction: 'SHORT', detectedAt: now, entry: book.bid, stop, resistance: w.high,
      spikeGain: w.gain, sellShare, costShare: quality.costShare, maxModeledLossUsd: 5 };
  }
  diagnostics(now = this.now()) {
    const d={unseen:0,quiet:0,warming:0,ready:0,watch:0,candidate:0,gates:{}};
    for(const symbol of this.symbols) {
      const s=this.states.get(symbol);
      if(!s) {d.unseen++;continue;}
      if(s.watch && now-s.watch.started<=45000) {d.watch++;continue;}
      if(now-s.time>5000) {d.quiet++;continue;}
      if(!s.ticks.length || now-s.ticks[0].firstTime<140000) {d.warming++;continue;}
      d.ready++;
      const reason=s.lastReason ?? 'Unknown';
      d.gates[reason]=(d.gates[reason]??0)+1;
    }
    return d;
  }
}
