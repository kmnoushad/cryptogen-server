import WebSocket from 'ws';
import { parseKlines } from './indicators.js';
import { log } from './util.js';

// One combined BTCUSDT stream: trades + 1m klines + top-20 book. Zero REST
// weight after boot — this is the ban-safety answer for the bias engine.
// Binance split WS endpoints into /public, /market, /private (legacy unrouted
// URLs decommissioned 2026-04-23). aggTrade and kline belong to /market;
// partial book depth belongs to /public. They therefore require two sockets.
const MARKET_STREAM_URL = 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m';
const PUBLIC_STREAM_URL = 'wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@500ms';
const TAKER_HORIZON_MS = 31 * 60_000; // longest taker/CVD window (30m) + slack
const MAX_TRADES = 20_000; // hard cap so a burst can never grow memory unbounded
const CLOSE_RING = 300; // keep ≥240 closed 1m candles for EMAs + outcome tracking

export class BtcFeed {
  constructor({ cfg, binance = null, onCandle = null, WebSocketImpl = WebSocket, now = () => Date.now() }) {
    this.cfg = cfg;
    this.binance = binance;
    this.onCandle = onCandle;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.socket = null;
    this.connected = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.reconnectAttempts = 0;
    this.lastMessageAt = 0;
    this.connectedAt = 0;
    this.lastError = null;
    this.lastPrice = 0;
    this.lastKlineAt = 0;
    this.lastBookAt = 0;
    this.warmed = false;
    this.trades = []; // { t, buy, sell } quote-volume taker buckets
    this.closes = []; // closed 1m candles: { t, closeTime, open, high, low, close, qv }
    this.liveCandle = null;
    this.book = null; // { bids: [[price, qty]...], asks: [[price, qty]...], at }
  }

  start() {
    if (!this.cfg.enableBtcFeed || this.socket || this.stopping) return;
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => this.checkLiveness(), 15_000);
      this.watchdogTimer.unref?.();
    }
    this.connect();
  }

  // One-time REST warm-up (weight ~4): seed the 1m close ring so EMA9/21/50
  // are valid within seconds of boot. Failure only defers to WS accumulation.
  async seed() {
    if (!this.cfg.enableBtcFeed || !this.binance || this.warmed) return false;
    try {
      const rows = await this.binance.klines('BTCUSDT', '1m', 240);
      const candles = parseKlines(rows);
      // The final REST kline is often the still-open candle: its close is not
      // final, so it must never enter the closed-candle ring.
      const last = candles.at(-1);
      const closed = last && last.closeTime > this.now() ? candles.slice(0, -1) : candles;
      for (const candle of closed) {
        this.pushClose({
          t: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          qv: candle.quoteVolume,
        });
      }
      this.warmed = this.closes.length >= 50;
      if (this.closes.length) this.lastPrice = this.closes.at(-1).close;
      log(`BTC feed boot seed: ${this.closes.length} closed 1m candles (warmed=${this.warmed})`);
      return this.warmed;
    } catch (error) {
      this.warmed = false;
      this.lastError = `boot seed: ${error.message}`;
      log(`BTC feed boot seed failed (${error.message}); relying on WS accumulation`);
      return false;
    }
  }

  connect() {
    if (this.stopping || !this.cfg.enableBtcFeed) return;
    // Two sockets: /market carries aggTrade + kline_1m, /public carries depth20.
    // this.socket stays the MARKET socket so price/EMA liveness semantics are
    // unchanged; the depth socket is auxiliary and reconnects on the same timer.
    this.openSocket(MARKET_STREAM_URL, 'market');
    this.openSocket(PUBLIC_STREAM_URL, 'public');
  }

  openSocket(url, kind) {
    if (this.stopping || !this.cfg.enableBtcFeed) return;
    const isMarket = kind === 'market';
    if (isMarket ? this.socket : this.depthSocket) return;
    try {
      const socket = new this.WebSocketImpl(url);
      if (isMarket) this.socket = socket; else this.depthSocket = socket;
      socket.on('open', () => {
        if (isMarket) {
          this.connected = true;
          this.connectedAt = this.now();
          this.reconnectAttempts = 0;
          this.lastError = null;
        }
        log(`BTC feed ${kind} stream connected`);
      });
      socket.on('message', raw => this.handleMessage(raw));
      socket.on('error', error => {
        this.lastError = error.message;
        log(`BTC feed ${kind} stream error: ${error.message}`);
      });
      socket.on('close', () => {
        const current = isMarket ? this.socket : this.depthSocket;
        if (current !== socket) return; // stale socket must not kill a replacement
        if (isMarket) { this.socket = null; this.connected = false; }
        else this.depthSocket = null;
        if (!this.stopping) this.scheduleReconnect();
      });
    } catch (error) {
      this.lastError = error.message;
      if (isMarket) { this.socket = null; this.connected = false; }
      else this.depthSocket = null;
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return null;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
    return delay;
  }

  checkLiveness() {
    if (!this.connected || !this.socket) return;
    const lastActivity = this.lastMessageAt || this.connectedAt;
    if (lastActivity && this.now() - lastActivity > 30_000) {
      this.lastError = 'BTC feed stream stale for more than 30 seconds';
      log('BTC feed stream stale; reconnecting');
      this.socket.terminate?.();
      this.depthSocket?.terminate?.();
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (error) {
      this.lastError = `message parse: ${error.message}`;
      return;
    }
    const stream = String(message?.stream ?? '');
    const data = message?.data ?? message;
    try {
      if (stream.includes('@aggTrade') || data?.e === 'aggTrade') this.ingestAggTrade(data);
      else if (stream.includes('@kline') || data?.e === 'kline') this.ingestKline(data);
      else if (stream.includes('@depth') || (data?.b && data?.a)) this.ingestDepth(data);
    } catch (error) {
      this.lastError = `ingest: ${error.message}`;
    }
  }

  // aggTrade {p, q, m, T}: m===true ⇒ the buyer is the maker ⇒ sell aggressor.
  ingestAggTrade(trade) {
    const price = Number(trade?.p);
    const qty = Number(trade?.q);
    const eventTime = Number(trade?.T ?? this.now());
    if (!(price > 0) || !(qty >= 0) || !Number.isFinite(eventTime)) return null;
    const quote = price * qty;
    const point = { t: eventTime, buy: trade.m ? 0 : quote, sell: trade.m ? quote : 0 };
    // Trades arrive time-ordered; an out-of-order event must not corrupt the
    // rolling windows (same guard as RealtimeShockGuard).
    const last = this.trades.at(-1);
    if (last && eventTime < last.t) return { ignored: true };
    this.lastMessageAt = this.now();
    this.lastPrice = price;
    this.trades.push(point);
    const cutoff = eventTime - TAKER_HORIZON_MS;
    while (this.trades.length && this.trades[0].t < cutoff) this.trades.shift();
    while (this.trades.length > MAX_TRADES) this.trades.shift();
    return point;
  }

  ingestKline(event) {
    const k = event?.k ?? event;
    const candle = {
      t: Number(k?.t),
      closeTime: Number(k?.T),
      open: Number(k?.o),
      high: Number(k?.h),
      low: Number(k?.l),
      close: Number(k?.c),
      qv: Number(k?.q),
    };
    if (!(candle.t > 0) || !(candle.close > 0) || !Object.values(candle).every(Number.isFinite)) return null;
    this.lastMessageAt = this.now();
    this.lastKlineAt = this.now();
    this.lastPrice = candle.close;
    this.liveCandle = candle;
    if (k?.x !== true) return { closed: false };
    this.pushClose(candle);
    if (this.onCandle) {
      try { this.onCandle(candle); }
      catch (error) {
        this.lastError = `onCandle: ${error.message}`;
        log(`BTC feed onCandle callback failed: ${error.message}`);
      }
    }
    return { closed: true, candle };
  }

  pushClose(candle) {
    const last = this.closes.at(-1);
    if (last && candle.t === last.t) this.closes[this.closes.length - 1] = candle; // re-seed of same bar
    else if (last && candle.t < last.t) return; // out-of-order seed row
    else this.closes.push(candle);
    while (this.closes.length > CLOSE_RING) this.closes.shift();
  }

  // depth20@1000ms partial book: replace the snapshot wholesale, never merge.
  ingestDepth(data) {
    const bids = data?.b ?? data?.bids;
    const asks = data?.a ?? data?.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) return null;
    const parse = levels => levels
      .map(level => [Number(level[0]), Number(level[1])])
      .filter(([price, qty]) => price > 0 && qty >= 0);
    const book = { bids: parse(bids), asks: parse(asks), at: this.now() };
    if (!book.bids.length || !book.asks.length) return null;
    this.book = book;
    this.lastMessageAt = this.now();
    this.lastBookAt = this.now();
    return book;
  }

  // Taker buy/sell quote-volume bucket over the last `minutes`.
  takerWindow(minutes, nowMs = this.now()) {
    const cutoff = nowMs - minutes * 60_000;
    let buy = 0;
    let sell = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const point = this.trades[i];
      if (point.t < cutoff) break;
      buy += point.buy;
      sell += point.sell;
    }
    const total = buy + sell;
    return { buy, sell, total, buyRatio: total > 0 ? buy / total : null };
  }

  // CVD delta (taker buy − taker sell quote volume) over the last `minutes`.
  cvdWindow(minutes, nowMs = this.now()) {
    const { buy, sell, total } = this.takerWindow(minutes, nowMs);
    return { delta: buy - sell, volume: total };
  }

  health() {
    return {
      enabled: Boolean(this.cfg.enableBtcFeed),
      connected: this.connected,
      stale: this.connected && Boolean(this.lastMessageAt || this.connectedAt)
        && this.now() - (this.lastMessageAt || this.connectedAt) > 30_000,
      warmed: this.warmed,
      closes: this.closes.length,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastKlineAt: this.lastKlineAt ? new Date(this.lastKlineAt).toISOString() : null,
      lastBookAt: this.lastBookAt ? new Date(this.lastBookAt).toISOString() : null,
      lastPrice: this.lastPrice,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    try { this.socket?.close(); } catch { }
    try { this.depthSocket?.close(); } catch { }
    this.socket = null;
    this.depthSocket = null;
    this.connected = false;
  }
}


