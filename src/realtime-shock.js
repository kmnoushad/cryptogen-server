import WebSocket from 'ws';
import { log } from './util.js';

const STREAM_URL = 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade';

export class RealtimeShockGuard {
  constructor({ cfg, onShock = null, WebSocketImpl = WebSocket, now = () => Date.now() }) {
    this.cfg = cfg;
    this.onShock = onShock;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.socket = null;
    this.points = [];
    this.connected = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.reconnectAttempts = 0;
    this.lastMessageAt = 0;
    this.lastEventTime = 0;
    this.connectedAt = 0;
    this.lastPrice = 0;
    this.lastError = null;
    this.shockUntil = 0;
    this.lastShockAt = 0;
    this.lastShockDropPct = 0;
  }

  start() {
    if (!this.cfg.enableRealtimeShock || this.socket || this.stopping) return;
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => this.checkLiveness(), 15_000);
      this.watchdogTimer.unref?.();
    }
    this.connect();
  }

  connect() {
    if (this.stopping || !this.cfg.enableRealtimeShock) return;
    try {
      const socket = new this.WebSocketImpl(STREAM_URL);
      this.socket = socket;
      socket.on('open', () => {
        this.connected = true;
        this.connectedAt = this.now();
        this.reconnectAttempts = 0;
        this.lastError = null;
        log('BTC realtime shock stream connected');
      });
      socket.on('message', raw => {
        try {
          const message = JSON.parse(String(raw));
          this.ingest(Number(message.p), Number(message.E ?? message.T ?? this.now()));
        } catch (error) {
          this.lastError = `message parse: ${error.message}`;
        }
      });
      socket.on('error', error => {
        this.lastError = error.message;
        log(`BTC realtime stream error: ${error.message}`);
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this.connected = false;
        if (!this.stopping) this.scheduleReconnect();
      });
    } catch (error) {
      this.lastError = error.message;
      this.socket = null;
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  checkLiveness() {
    if (!this.connected || !this.socket) return;
    const lastActivity = this.lastMessageAt || this.connectedAt;
    if (lastActivity && this.now() - lastActivity > 30_000) {
      this.lastError = 'trade stream stale for more than 30 seconds';
      log('BTC realtime stream stale; reconnecting');
      this.socket.terminate?.();
    }
  }

  ingest(price, eventTime = this.now()) {
    if (!(price > 0) || !Number.isFinite(eventTime)) return null;
    // Binance aggregate trades are time ordered. Ignore a stale/out-of-order
    // event so it cannot corrupt the rolling-window peak queue.
    if (eventTime < this.lastEventTime) return { triggered: false, ignored: true };
    this.lastEventTime = eventTime;
    this.lastMessageAt = this.now();
    this.lastPrice = price;
    const cutoff = eventTime - this.cfg.realtimeShockWindowMs;
    // Monotonic peak queue: O(1) amortized per trade, even when BTC activity
    // surges. Recomputing Math.max across every 10-second trade on every event
    // would make the safety listener itself a latency source.
    while (this.points.length && this.points[this.points.length - 1].price <= price) this.points.pop();
    this.points.push({ time: eventTime, price });
    while (this.points.length && this.points[0].time < cutoff) this.points.shift();
    const peak = this.points[0].price;
    const dropPct = peak > 0 ? ((price - peak) / peak) * 100 : 0;
    if (dropPct > -this.cfg.realtimeShockDropPct) return { triggered: false, dropPct, price, peak };

    const wasBlocked = this.blocked();
    this.shockUntil = Math.max(this.shockUntil, this.now() + this.cfg.realtimeShockCooldownMs);
    if (wasBlocked) return { triggered: false, extended: true, dropPct, price, peak };

    this.lastShockAt = this.now();
    this.lastShockDropPct = dropPct;
    const event = { triggered: true, dropPct, price, peak, eventTime, shockUntil: this.shockUntil };
    log(`BTC REALTIME SHOCK: ${dropPct.toFixed(3)}%/${Math.round(this.cfg.realtimeShockWindowMs / 1000)}s`);
    if (this.onShock) void Promise.resolve(this.onShock(event)).catch(error => {
      this.lastError = `shock callback: ${error.message}`;
      log(`BTC realtime shock callback failed: ${error.message}`);
    });
    return event;
  }

  blocked(now = this.now()) {
    return this.cfg.enableRealtimeShock && now < this.shockUntil;
  }

  health() {
    return {
      enabled: this.cfg.enableRealtimeShock,
      connected: this.connected,
      stale: this.connected && Boolean(this.lastMessageAt || this.connectedAt)
        && this.now() - (this.lastMessageAt || this.connectedAt) > 30_000,
      blocked: this.blocked(),
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastPrice: this.lastPrice,
      lastShockAt: this.lastShockAt ? new Date(this.lastShockAt).toISOString() : null,
      lastShockDropPct: this.lastShockDropPct,
      shockUntil: this.shockUntil ? new Date(this.shockUntil).toISOString() : null,
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
    this.socket = null;
    this.connected = false;
  }
}
