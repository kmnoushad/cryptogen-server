import WebSocket from 'ws';
import { SpikeFadeDetector } from './spike-fade-detector.js';

// Public market data only. Orders always pass through FadeExecutor.
export class FadeSpikeSource {
  constructor({ exchange, environment, isPaused, now = () => Date.now(), WebSocketImpl = WebSocket,
    schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { exchange, environment, isPaused, now, WebSocketImpl, schedule, cancel });
    this.stopped = false; this.generation = 0; this.sockets = []; this.connected = new Set();
    this.books = new Map(); this.btc = []; this.pending = []; this.latest = new Map();
    this.detector = null; this.lastReason = 'Starting'; this.lastError = null;
    this.watches = 0; this.candidates = 0; this.retries = 0; this.retry = null;
  }
  health() {
    return `spike stream ${this.connected.size === 2 ? 'connected' : 'unavailable'} · ${this.detector?.symbols.size ?? 0} symbols · WATCH ${this.watches} · candidates ${this.candidates} · ${this.lastError ?? this.lastReason}`;
  }
  clear() {
    this.generation++; this.detector?.reset(); this.books.clear(); this.btc = [];
    this.pending = []; this.latest.clear(); this.connected.clear();
  }
  stop() {
    this.stopped = true; this.cancel(this.retry); this.cancel(this.refresh); this.clear();
    for (const socket of this.sockets) socket.terminate(); this.sockets = [];
  }
  async start() {
    if (this.stopped) return;
    this.clear(); const generation = this.generation;
    try {
      const [info, tickers, btcRows] = await Promise.all([this.exchange.info(),
        this.exchange.request('GET', '/fapi/v1/ticker/24hr', {}, false), this.exchange.btcCandles()]);
      if (this.stopped || generation !== this.generation) return;
      const contracts = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT'
        && s.contractType === 'PERPETUAL' && (!s.underlyingType || s.underlyingType === 'COIN')).map(s => s.symbol));
      const symbols = tickers.filter(t => contracts.has(t.symbol) && t.symbol !== 'BTCUSDT'
        && Number(t.quoteVolume) >= 15000000).sort((a,b) => Number(b.quoteVolume)-Number(a.quoteVolume))
        .slice(0,40).map(t => t.symbol);
      if (!symbols.length) throw Error('No eligible liquid contracts');
      this.detector = new SpikeFadeDetector({ symbols, now: this.now });
      // Seed only BTC context; no historical coin pattern can trigger an entry.
      this.btc = btcRows.filter(r => Number(r[6]) < this.now()).map(r => ({ time: Number(r[6]), price: Number(r[4]) }))
        .filter(r => Number.isFinite(r.time) && r.price > 0);
      const host = this.environment === 'live' ? 'fstream.binance.com' : 'fstream.binancefuture.com';
      this.sockets = [];
      for (const [route, names] of [['market', [...symbols,'BTCUSDT'].map(s => s.toLowerCase()+'@aggTrade')],
        ['public', symbols.map(s => s.toLowerCase()+'@bookTicker')]]) {
        const socket = new this.WebSocketImpl(`wss://${host}/${route}/stream?streams=${names.join('/')}`);
        this.sockets.push(socket);
        socket.on('open', () => { if (generation === this.generation && !this.stopped) {
          this.connected.add(route); this.lastError = null; this.retries = 0;
        } });
        socket.on('message', raw => {
          if (generation !== this.generation || this.stopped) return;
          try { this.ingest(JSON.parse(String(raw)).data); }
          catch { this.lastError = 'Invalid market stream message'; }
        });
        socket.on('error', () => { this.lastError = 'Market stream connection error'; socket.terminate(); });
        socket.on('close', () => { if (generation === this.generation && !this.stopped) this.reconnect(); });
      }
      // Refresh universe and renew before Binance's 24h disconnect; existing positions stay managed.
      this.refresh = this.schedule(() => this.reconnect(), 3600000); this.refresh.unref?.();
    } catch (error) { this.lastError = error.message; this.reconnect(); }
  }
  reconnect() {
    this.cancel(this.refresh); this.clear();
    for (const s of this.sockets) s.terminate(); this.sockets = [];
    if (this.stopped || this.retry) return;
    this.retry = this.schedule(() => { this.retry = null; void this.start(); }, Math.min(30000,1000*2**this.retries++));
    this.retry.unref?.();
  }
  checkLiveness() {
    if (!this.stopped && this.connected.size === 2 && this.now() - (this.btc.at(-1)?.time ?? 0) > 30000) {
      this.lastError = 'BTC stream stale; rewarming'; this.reconnect();
    }
  }
  btcContext() {
    const last = this.btc.at(-1); if (!last || this.now()-last.time>2000) return null;
    const before = duration => this.btc.findLast(t => t.time <= last.time-duration);
    const a = before(30000), b = before(900000);
    if (!a || !b || last.time-a.time>32000 || last.time-b.time>960000) return null;
    return { at: last.time, return30s: last.price/a.price-1, return15m: last.price/b.price-1 };
  }
  ingest(data) {
    if (!data || this.stopped || !this.detector) return;
    const now = this.now();
    if (data.e === 'bookTicker' && this.detector.symbols.has(data.s)) {
      const at = Number(data.T ?? data.E), bid = Number(data.b), ask = Number(data.a);
      if (Number.isFinite(at) && at <= now && now-at<=1000 && bid>0 && ask>=bid) this.books.set(data.s,{at,bid,ask});
      return;
    }
    if (data.e !== 'aggTrade') return;
    if (data.s === 'BTCUSDT') {
      const time=Number(data.T),price=Number(data.p);
      if (!(time<=now && now-time<=2000 && price>0) || time <= (this.btc.at(-1)?.time ?? -Infinity)) return;
      if (Math.floor(time/1000) !== Math.floor((this.btc.at(-1)?.time ?? 0)/1000)) this.btc.push({time,price});
      else this.btc[this.btc.length-1]={time,price};
      this.btc=this.btc.filter(t => time-t.time<=1000000); return;
    }
    if (this.connected.size !== 2 || !this.detector.symbols.has(data.s)) return;
    if (this.isPaused()) { this.detector.reset(); this.pending=[]; this.latest.clear(); this.lastReason='Paused'; return; }
    const result=this.detector.ingest(data.s,data,{btc:this.btcContext(),book:this.books.get(data.s)});
    this.lastReason=result.reason ?? 'Spike rejection candidate';
    if (result.watch) this.watches++;
    this.latest.set(data.s,{at:Number(data.T),price:Number(data.p)});
    if (!result.candidate) return;
    const signal={...result, price:result.entry, peakTime:result.detectedAt-1,
      barCloseTime:result.detectedAt, generation:this.generation};
    this.candidates++;
    this.pending=[signal]; // latest only; never build an execution backlog
    this.onCandidate?.();
  }
  authorize(symbol, signal) {
    const now=this.now(),btc=this.btcContext(),book=this.books.get(symbol),last=this.latest.get(symbol);
    return !this.stopped && !this.isPaused() && this.connected.size===2 && this.detector?.symbols.has(symbol)
      && signal.generation===this.generation && signal.model==='spike-fade-ticks-v1'
      && now>=signal.detectedAt && now-signal.detectedAt<=10000
      && btc && btc.return30s<=.001 && btc.return15m<=0
      && book && now-book.at<=1000 && book.ask/book.bid-1<=.001
      && last && now-last.at<=2000 && book.ask<signal.resistance
      && Math.abs(book.bid/signal.price-1)<=.0015 && 1-book.bid/signal.resistance<=.009;
  }
  drain() { const result=this.pending; this.pending=[]; return result; }
}
