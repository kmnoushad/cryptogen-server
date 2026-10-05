import WebSocket from 'ws';
import { SpikeFadeDetector } from './spike-fade-detector.js';

export const spikeContracts = info => [...new Set((info.symbols ?? []).filter(s =>
  s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL'
  && (!s.underlyingType || s.underlyingType === 'COIN') && s.symbol !== 'BTCUSDT'
  && /^[A-Z0-9]+USDT$/.test(s.symbol)).map(s => s.symbol))].sort();
export function spikeSubscriptions(symbols) {
  const streams = [];
  for (let i=0;i<symbols.length;i+=100) {
    const group=symbols.slice(i,i+100),index=i/100;
    streams.push({key:`market:${index}`,route:'market',names:[...group,...(i===0?['BTCUSDT']:[])].map(s=>s.toLowerCase()+'@aggTrade')});
    streams.push({key:`public:${index}`,route:'public',names:group.map(s=>s.toLowerCase()+'@bookTicker')});
  }
  return streams;
}

// Public market data only. Orders always pass through FadeExecutor.
export class FadeSpikeSource {
  constructor({ exchange, environment, isPaused, now = () => Date.now(), WebSocketImpl = WebSocket,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { exchange, environment, isPaused, now, WebSocketImpl, schedule, cancel });
    this.stopped = false; this.generation = 0; this.sockets = new Map(); this.connected = new Set();
    this.streams = new Map(); this.symbolStreams = new Map(); this.retryTimers = new Map();
    this.retryCounts = new Map(); this.stableTimers = new Map();
    this.books = new Map(); this.btc = []; this.pending = []; this.latest = new Map();
    this.detector = null; this.lastReason = 'Starting'; this.lastError = null;
    this.watches = 0; this.candidates = 0; this.retries = 0; this.retry = null;
    this.lastCandidate = null; this.candidateBlocks = 0;
    this.requiredConnections = 2;
  }
  ready(symbol) {
    if (symbol) {
      const keys = this.symbolStreams.get(symbol);
      return Boolean(keys && this.connected.has(keys.market) && this.connected.has(keys.book)
        && this.connected.has('market:0') && this.btcContext());
    }
    return this.connected.size === this.requiredConnections;
  }
  health() {
    const candidate = this.lastCandidate
      ? ` · last ${this.lastCandidate.symbol} ${this.lastCandidate.outcome}${this.lastCandidate.reason ? `: ${this.lastCandidate.reason}` : ''}` : '';
    const readySymbols = this.detector ? [...this.detector.symbols].filter(s => this.ready(s)).length : 0;
    const streamState = this.ready() ? 'connected' : readySymbols ? 'partial' : 'unavailable';
    return `spike stream ${streamState} (${this.connected.size}/${this.requiredConnections}) · ${this.detector?.symbols.size ?? 0} symbols · executable feeds ${readySymbols} · WATCH ${this.watches} · candidates ${this.candidates} · blocked ${this.candidateBlocks}${candidate} · ${this.lastError ?? this.lastReason}`;
  }
  clear() {
    this.generation++; this.detector?.reset(); this.books.clear(); this.btc = [];
    this.pending = []; this.latest.clear(); this.connected.clear();
  }
  stop() {
    this.stopped = true; this.cancel(this.retry); this.cancel(this.refresh); this.clear();
    for (const timer of this.retryTimers.values()) this.cancel(timer);
    for (const timer of this.stableTimers.values()) this.cancel(timer);
    this.retryTimers.clear(); this.stableTimers.clear();
    for (const socket of this.sockets.values()) socket.terminate(); this.sockets.clear();
  }
  async start() {
    if (this.stopped) return;
    this.clear(); const generation = this.generation;
    try {
      const [info, btcRows] = await Promise.all([this.exchange.info(), this.exchange.btcCandles()]);
      if (this.stopped || generation !== this.generation) return;
      const symbols = spikeContracts(info);
      if (!symbols.length) throw Error('No active USDT coin perpetuals');
      this.detector = new SpikeFadeDetector({ symbols, now: this.now });
      // Seed only BTC context; no historical coin pattern can trigger an entry.
      this.btc = btcRows.filter(r => Number(r[6]) < this.now()).map(r => ({ time: Number(r[6]), price: Number(r[4]) }))
        .filter(r => Number.isFinite(r.time) && r.price > 0);
      const host = this.environment === 'live' ? 'fstream.binance.com' : 'fstream.binancefuture.com';
      const subscriptions = spikeSubscriptions(symbols);
      this.requiredConnections = subscriptions.length;
      this.streams = new Map(subscriptions.map(s => [s.key, s]));
      this.symbolStreams.clear();
      for (const s of subscriptions) for (const name of s.names) {
        const symbol = name.split('@')[0].toUpperCase();
        if (symbol === 'BTCUSDT') continue;
        const pair = this.symbolStreams.get(symbol) ?? {};
        if (name.endsWith('@aggTrade')) pair.market = s.key;
        if (name.endsWith('@bookTicker')) pair.book = s.key;
        this.symbolStreams.set(symbol, pair);
      }
      for (const stream of subscriptions) this.connectStream(stream, host, generation);
      // Refresh universe and renew before Binance's 24h disconnect; existing positions stay managed.
      this.refresh = this.schedule(() => this.reconnect(), 3600000); this.refresh.unref?.();
    } catch (error) { this.lastError = error.message; this.reconnect(); }
  }
  connectStream(stream, host, generation) {
    if (this.stopped || generation !== this.generation) return;
    const { key, route, names } = stream;
    try {
      const socket = new this.WebSocketImpl(`wss://${host}/${route}/stream?streams=${names.join('/')}`);
      this.sockets.set(key, socket);
      socket.on('open', () => {
        if (generation !== this.generation || this.stopped || this.sockets.get(key) !== socket) return;
        this.connected.add(key); this.lastError = null;
        this.cancel(this.retryTimers.get(key)); this.retryTimers.delete(key);
        this.cancel(this.stableTimers.get(key));
        const timer = this.schedule(() => {
          if (generation === this.generation && this.connected.has(key)) this.retryCounts.set(key, 0);
          this.stableTimers.delete(key);
        }, 60000);
        timer.unref?.(); this.stableTimers.set(key, timer);
      });
      socket.on('message', raw => {
        if (generation !== this.generation || this.stopped || this.sockets.get(key) !== socket) return;
        try { this.ingest(JSON.parse(String(raw)).data, key); }
        catch { this.lastError = 'Invalid market stream message'; }
      });
      socket.on('error', () => { this.lastError = `Market stream error ${key}`; socket.terminate(); });
      socket.on('close', () => {
        if (generation === this.generation && !this.stopped && this.sockets.get(key) === socket) this.reconnectStream(key, generation);
      });
    } catch {
      this.lastError = `Market stream failed ${key}`;
      this.reconnectStream(key, generation);
    }
  }
  reconnectStream(key, generation) {
    this.connected.delete(key);
    this.cancel(this.stableTimers.get(key)); this.stableTimers.delete(key);
    const socket = this.sockets.get(key); this.sockets.delete(key);
    // Keep the seeded 15m BTC history across a short websocket reconnect.
    // btcContext still fails closed until a fresh live BTC tick arrives.
    const affected = [];
    for (const [symbol, pair] of this.symbolStreams) if (pair.market === key || pair.book === key) affected.push(symbol);
    this.detector?.reset(affected);
    for (const symbol of affected) { this.books.delete(symbol); this.latest.delete(symbol); }
    this.pending = this.pending.filter(signal => !affected.includes(signal.symbol));
    if (socket && socket.readyState !== 3) socket.terminate();
    if (this.stopped || generation !== this.generation || this.retryTimers.has(key)) return;
    const count = (this.retryCounts.get(key) ?? 0) + 1; this.retryCounts.set(key, count);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5));
    const timer = this.schedule(() => {
      this.retryTimers.delete(key);
      const stream = this.streams.get(key);
      const host = this.environment === 'live' ? 'fstream.binance.com' : 'fstream.binancefuture.com';
      if (stream) this.connectStream(stream, host, generation);
    }, delay);
    timer.unref?.(); this.retryTimers.set(key, timer);
  }
  reconnect() {
    this.cancel(this.refresh); this.clear();
    for (const timer of this.retryTimers.values()) this.cancel(timer);
    for (const timer of this.stableTimers.values()) this.cancel(timer);
    this.retryTimers.clear(); this.stableTimers.clear();
    for (const socket of this.sockets.values()) socket.terminate(); this.sockets.clear();
    if (this.stopped || this.retry) return;
    this.retry = this.schedule(() => { this.retry = null; void this.start(); }, Math.min(30000,1000*2**this.retries++));
    this.retry.unref?.();
  }
  checkLiveness() {
    if (!this.stopped && this.connected.has('market:0') && this.now() - (this.btc.at(-1)?.time ?? 0) > 30000) {
      this.lastError = 'BTC stream stale; rewarming'; this.reconnectStream('market:0', this.generation);
    }
  }
  btcContext() {
    const last = this.btc.at(-1); if (!last || this.now()-last.time>2000) return null;
    const before = duration => {
      let lo=0,hi=this.btc.length-1,index=-1;
      while(lo<=hi) { const mid=(lo+hi)>>1;
        if(this.btc[mid].time<=last.time-duration) {index=mid;lo=mid+1;} else hi=mid-1;
      }
      return this.btc[index];
    };
    const a = before(30000), b = before(900000);
    if (!a || !b || last.time-a.time>32000 || last.time-b.time>960000) return null;
    return { at: last.time, return30s: last.price/a.price-1, return15m: last.price/b.price-1 };
  }
  ingest(data, streamKey) {
    if (!data || this.stopped || !this.detector) return;
    const now = this.now();
    const pair = this.symbolStreams.get(data.s);
    if (data.e === 'bookTicker' && this.detector.symbols.has(data.s)
      && (!streamKey || !pair || streamKey === pair.book)) {
      const at = Number(data.T ?? data.E), bid = Number(data.b), ask = Number(data.a);
      if (Number.isFinite(at) && at <= now && now-at<=1000 && bid>0 && ask>=bid) this.books.set(data.s,{at,bid,ask});
      return;
    }
    if (data.e !== 'aggTrade') return;
    if (data.s === 'BTCUSDT' && (!streamKey || streamKey === 'market:0')) {
      const time=Number(data.T),price=Number(data.p);
      if (!(time<=now && now-time<=2000 && price>0) || time <= (this.btc.at(-1)?.time ?? -Infinity)) return;
      if (Math.floor(time/1000) !== Math.floor((this.btc.at(-1)?.time ?? 0)/1000)) this.btc.push({time,price});
      else this.btc[this.btc.length-1]={time,price};
      this.btc=this.btc.filter(t => time-t.time<=1000000); return;
    }
    if (!this.detector.symbols.has(data.s) || !this.connected.has(pair?.market ?? 'market:0')) return;
    if (this.isPaused()) { this.detector.reset(); this.pending=[]; this.latest.clear(); this.lastReason='Paused'; return; }
    const result=this.detector.ingest(data.s,data,{btc:this.btcContext(),book:this.books.get(data.s)});
    this.lastReason=result.reason ?? 'Spike rejection candidate';
    if (result.watch) this.watches++;
    this.latest.set(data.s,{at:Number(data.T),price:Number(data.p)});
    if (!result.candidate) return;
    const signal={...result, price:result.entry, peakTime:result.detectedAt-1,
      barCloseTime:result.detectedAt, generation:this.generation};
    this.candidates++;
    this.lastCandidate={symbol:data.s, detectedAt:now, outcome:'queued', reason:null};
    this.pending=[signal]; // latest only; never build an execution backlog
    this.onCandidate?.();
  }
  rejectCandidate(symbol, signal, reason) {
    this.candidateBlocks++;
    this.lastCandidate={symbol, detectedAt:signal?.detectedAt ?? null, outcome:'blocked', reason};
    return false;
  }
  authorize(symbol, signal) {
    const now=this.now(),btc=this.btcContext(),book=this.books.get(symbol),last=this.latest.get(symbol);
    const reject=reason=>this.rejectCandidate(symbol,signal,reason);
    if (this.stopped) return reject('source stopped');
    if (this.isPaused()) return reject('entries paused');
    if (!this.ready(symbol)) return reject('symbol/BTC market stream unavailable');
    if (!this.detector?.symbols.has(symbol)) return reject('symbol outside active universe');
    if (signal?.generation!==this.generation || signal?.model!=='spike-fade-ticks-v1') return reject('candidate generation/model mismatch');
    if (!Number.isFinite(signal.detectedAt) || now<signal.detectedAt || now-signal.detectedAt>10000) return reject('candidate expired (>10s)');
    if (!btc) return reject('BTC tick context stale');
    if (btc.return30s>.001 || btc.return15m>0) return reject('BTC momentum gate');
    if (!book || now-book.at>1000) return reject('symbol book missing/stale');
    if (book.ask/book.bid-1>.001) return reject('spread exceeds 0.10%');
    if (!last || now-last.at>2000) return reject('symbol trade tick stale');
    if (!(book.ask<signal.resistance)) return reject('ask reclaimed resistance');
    if (Math.abs(book.bid/signal.price-1)>.0015) return reject('price moved >0.15% from spike signal');
    if (1-book.bid/signal.resistance>.009) return reject('entry is >0.9% below failed high');
    this.lastCandidate={symbol,detectedAt:signal.detectedAt,outcome:'authorized',reason:null};
    return true;
  }
  drain() { const result=this.pending; this.pending=[]; return result; }
}
