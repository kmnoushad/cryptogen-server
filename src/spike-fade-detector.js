// Tick-based research detector. Candidates cannot submit orders.
import { entryQuality } from './entry-quality.js';
export class SpikeFadeDetector {
  constructor({ symbols, now = () => Date.now() }) {
    this.symbols = new Set(symbols); this.now = now; this.states = new Map();
  }
  reset() { this.states.clear(); } // Required on disconnect/reconnect.
  ingest(symbol, trade, context) {
    const now = this.now(), { a: id, T: time, m: sell } = trade;
    const price = Number(trade.p), qty = Number(trade.q);
    const reject = reason => ({ allowed: false, executable: false, candidate: false, reason });
    if (!this.symbols.has(symbol) || !Number.isSafeInteger(id) || !Number.isFinite(time)
      || typeof sell !== 'boolean' || !(price > 0 && qty > 0 && Number.isFinite(price * qty))
      || now - time > 2000 || time > now) return reject('Invalid or stale trade');
    let s = this.states.get(symbol);
    if (!s) { s = { ticks: [], id: -1, time: -1, watch: null, cooldown: 0 }; this.states.set(symbol, s); }
    if (id <= s.id || time < s.time) return reject('Duplicate or out-of-order trade');
    if (s.time >= 0 && time - s.time > 5000) { s.ticks = []; s.watch = null; }
    s.id = id; s.time = time;
    s.ticks.push({ time, price, quote: price * qty, sell });
    s.ticks = s.ticks.filter(t => time - t.time <= 150000);
    if (s.ticks.length > 20000) { s.ticks = []; s.watch = null; return reject('Tick capacity exceeded; warmup required'); }
    if (time < s.cooldown) return reject('Pattern cooldown');
    if (s.watch && time - s.watch.started > 45000) s.watch = null;
    if (!s.watch) {
      const base = s.ticks.filter(t => time - t.time > 30000), burst = s.ticks.filter(t => time - t.time <= 30000);
      if (!base.length || time - s.ticks[0].time < 140000) return reject('Warming up');
      const baseline = base.reduce((v, t) => v + t.quote, 0) / 120;
      const quote = burst.reduce((v, t) => v + t.quote, 0), gain = price / burst[0].price - 1;
      if (gain < .02 || quote < baseline * 30 * 3) return reject('No sudden spike');
      s.watch = { started: time, highAt: time, high: price, gain, quote };
      return { ...reject('Spike detected; awaiting rejection'), watch: true, symbol, ...s.watch };
    }
    const w = s.watch;
    if (price > w.high) { w.high = price; w.highAt = time; }
    const retreat = 1 - price / w.high;
    if (retreat > .009) { s.watch = null; s.cooldown = time + 60000; return reject('Spike already faded; no chasing'); }
    if (retreat < .005 || time - w.highAt < 2000) return reject('Spike still rising or no rejection');
    const flow = s.ticks.filter(t => time - t.time <= 5000), quote = flow.reduce((v, t) => v + t.quote, 0);
    const sellShare = flow.reduce((v, t) => v + (t.sell ? t.quote : 0), 0) / quote;
    if (sellShare < .6 || flow.length < 3) return reject('Selling not confirmed');
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
    return { allowed: false, executable: false, candidate: true, model: 'spike-fade-ticks-v1',
      symbol, direction: 'SHORT', detectedAt: now, entry: book.bid, stop, resistance: w.high,
      spikeGain: w.gain, sellShare, costShare: quality.costShare, maxModeledLossUsd: 5 };
  }
}
