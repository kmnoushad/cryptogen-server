import WebSocket from 'ws';
import { closedCandles, parseKlines, takerFlow } from './indicators.js';
import { FUTURES_EXCLUDED } from './engine.js';
import { escapeHtml, formatPrice, gstTime, log, sleep } from './util.js';

const STREAM_URL = 'wss://fstream.binance.com/stream?streams=!miniTicker@arr';
const HORIZON_MS = 10 * 60_000; // ring-buffer horizon per symbol
const MAX_POINTS = 700; // hard cap per symbol (~1s ticks over the horizon)
const LOOKUP_TOLERANCE_MS = 10_000; // a 60s/180s reference tick may be this stale
const CONFIRM_TAKER_BUY_RATIO = 0.52; // REST klines confirm floor (spec: informational)
const CONFIRM_RETRY_THROTTLE_MS = 60_000; // min gap between REST confirm flights per symbol

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const usdCompact = value => Number(value || 0) >= 1_000_000
  ? `$${(Number(value) / 1_000_000).toFixed(1)}M`
  : `$${Math.round(Number(value || 0) / 1_000)}k`;

// Fast-Mover (sudden pump) detector. Independent of the slow closed-candle
// Futures funnel: it watches the Binance USD-M `!miniTicker@arr` firehose for
// violent 1m/3m moves with volume acceleration, confirms them against REST
// klines + order book, and sends an informational-actionable radar ping.
// It never opens a database trade.
export class FastMoverDetector {
  constructor({
    cfg,
    binance,
    store,
    telegram,
    realtimeShock = null,
    isPaused = () => false,
    WebSocketImpl = WebSocket,
    now = () => Date.now(),
    sleepImpl = sleep,
  }) {
    this.cfg = cfg;
    this.binance = binance;
    this.store = store;
    this.telegram = telegram;
    this.realtimeShock = realtimeShock;
    this.isPaused = isPaused;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now;
    this.sleepImpl = sleepImpl;
    this.socket = null;
    this.connected = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.reconnectAttempts = 0;
    this.lastMessageAt = 0;
    this.connectedAt = 0;
    this.lastError = null;
    this.buffers = new Map(); // symbol -> [{ t, price, q }]
    this.cooldowns = new Map(); // symbol -> last alert ms
    this.alertTimestamps = []; // global per-hour cap window
    this.pendingConfirms = new Set(); // one REST confirm flight per symbol
    this.lastConfirmAttempt = new Map(); // symbol -> last confirm-flight start ms (throttles failures)
    this.metrics = {
      triggers: 0,
      alerts: 0,
      confirmRejected: 0,
      dedupSkipped: 0,
      suppressed: { cooldown: 0, cap: 0, shock: 0, paused: 0 },
    };
  }

  start() {
    if (!this.cfg.enableFastMoverAlerts || this.socket || this.stopping) return;
    if (!this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => this.checkLiveness(), 15_000);
      this.watchdogTimer.unref?.();
    }
    this.connect();
  }

  connect() {
    if (this.stopping || !this.cfg.enableFastMoverAlerts) return;
    try {
      const socket = new this.WebSocketImpl(STREAM_URL);
      this.socket = socket;
      socket.on('open', () => {
        this.connected = true;
        this.connectedAt = this.now();
        this.reconnectAttempts = 0;
        this.lastError = null;
        log('Fast-mover miniTicker stream connected');
      });
      socket.on('message', raw => this.handleMessage(raw));
      socket.on('error', error => {
        this.lastError = error.message;
        log(`Fast-mover stream error: ${error.message}`);
      });
      socket.on('close', () => {
        // A stale socket's close must not kill a healthy replacement.
        if (this.socket !== socket) return;
        this.socket = null;
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
    // Symbols that stopped ticking keep only dead points; drop them so the
    // tracked-symbol count reflects the live firehose.
    const nowMs = this.now();
    for (const [symbol, buffer] of this.buffers) {
      if (!buffer.length || nowMs - buffer.at(-1).t > HORIZON_MS) this.buffers.delete(symbol);
    }
    if (!this.connected || !this.socket) return;
    const lastActivity = this.lastMessageAt || this.connectedAt;
    if (lastActivity && nowMs - lastActivity > 30_000) {
      this.lastError = 'miniTicker stream stale for more than 30 seconds';
      log('Fast-mover stream stale; reconnecting');
      this.socket.terminate?.();
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
    // Combined-stream endpoint wraps payloads as { stream, data: [...] };
    // accept a bare array (or single tick object) too for robustness.
    const payload = message?.data ?? message;
    const ticks = Array.isArray(payload) ? payload : [payload];
    for (const tick of ticks) {
      try {
        this.ingestTick(tick);
      } catch (error) {
        this.lastError = `tick: ${error.message}`;
      }
    }
  }

  ingestTick(tick) {
    const symbol = String(tick?.s ?? '');
    const price = Number(tick?.c);
    const quoteVolume24h = Number(tick?.q);
    const eventTime = Number(tick?.E ?? this.now());
    if (!symbol.endsWith('USDT') || symbol.includes('_')) return null; // USDT-M perpetuals only
    if (!(price > 0) || !Number.isFinite(quoteVolume24h) || !Number.isFinite(eventTime)) return null;
    this.lastMessageAt = this.now();
    let buffer = this.buffers.get(symbol);
    if (!buffer) {
      buffer = [];
      this.buffers.set(symbol, buffer);
    }
    buffer.push({ t: eventTime, price, q: quoteVolume24h });
    const cutoff = eventTime - HORIZON_MS;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
    while (buffer.length > MAX_POINTS) buffer.shift();
    return this.evaluate(symbol, buffer, eventTime, price, quoteVolume24h);
  }

  // Latest buffered point at or before `target`, within a small staleness
  // tolerance so a momentarily quiet symbol cannot fabricate a reference.
  pointAt(buffer, target) {
    for (let i = buffer.length - 1; i >= 0; i--) {
      const point = buffer[i];
      if (point.t <= target) {
        return target - point.t <= LOOKUP_TOLERANCE_MS ? point : null;
      }
    }
    return null;
  }

  // Volume velocity: quote volume over the last 60s (from the rolling 24h
  // counter) versus the median of the same 60s deltas sampled every 30s over
  // the previous 9 minutes. The 24h roll-off error is minor over 60s, so this
  // stays a soft gate; REST klines hard-confirm before any alert.
  volumeAcceleration(buffer, eventTime, quoteVolume24h) {
    const reference = this.pointAt(buffer, eventTime - 60_000);
    if (!reference) return null;
    const volPerMin = quoteVolume24h - reference.q;
    const deltas = [];
    for (let end = eventTime - 60_000; end >= eventTime - HORIZON_MS; end -= 30_000) {
      const endPoint = this.pointAt(buffer, end);
      const startPoint = this.pointAt(buffer, end - 60_000);
      if (endPoint && startPoint) deltas.push(endPoint.q - startPoint.q);
    }
    const baseline = median(deltas);
    if (baseline === null) return null;
    return { volPerMin, baseline, accel: baseline > 0 ? volPerMin / baseline : Infinity };
  }

  evaluate(symbol, buffer, eventTime, price, quoteVolume24h) {
    if (symbol === 'BTCUSDT' || FUTURES_EXCLUDED.has(symbol)) return null;
    if (quoteVolume24h < this.cfg.fastMoverMinQuoteUsd) return null;
    const p60 = this.pointAt(buffer, eventTime - 60_000);
    const p180 = this.pointAt(buffer, eventTime - 180_000);
    const move1m = p60 ? ((price - p60.price) / p60.price) * 100 : null;
    const move3m = p180 ? ((price - p180.price) / p180.price) * 100 : null;
    const hit1m = move1m !== null && move1m >= this.cfg.fastMoverMin1mPct;
    const hit3m = move3m !== null && move3m >= this.cfg.fastMoverMin3mPct;
    if (!hit1m && !hit3m) return null;
    const move = hit1m ? { pct: move1m, windowSec: 60 } : { pct: move3m, windowSec: 180 };
    const volume = this.volumeAcceleration(buffer, eventTime, quoteVolume24h);
    if (!volume || !(volume.baseline > 0) || volume.accel < this.cfg.fastMoverVolumeAccel) return null;

    if (this.realtimeShock?.blocked?.()) {
      this.metrics.suppressed.shock++;
      return { triggered: true, suppressed: 'shock', symbol };
    }
    if (this.isPaused()) {
      this.metrics.suppressed.paused++;
      return { triggered: true, suppressed: 'paused', symbol };
    }
    const nowMs = this.now();
    const cooldownMs = this.cfg.fastMoverCooldownMin * 60_000;
    const lastAlertAt = this.cooldowns.get(symbol) ?? 0;
    if (nowMs - lastAlertAt < cooldownMs || this.pendingConfirms.has(symbol)) {
      this.metrics.suppressed.cooldown++;
      return { triggered: true, suppressed: 'cooldown', symbol };
    }
    // Throttle failed confirm flights: without this a symbol hovering past the
    // price/volume gates would re-fire a full REST confirm every tick. Set when
    // a flight STARTS, so in-flight and just-failed attempts are both covered.
    const lastConfirmAt = this.lastConfirmAttempt.get(symbol) ?? -Infinity;
    if (nowMs - lastConfirmAt < CONFIRM_RETRY_THROTTLE_MS) {
      this.metrics.suppressed.cooldown++;
      return { triggered: true, suppressed: 'cooldown', symbol };
    }
    this.alertTimestamps = this.alertTimestamps.filter(ts => nowMs - ts < 3_600_000);
    if (this.alertTimestamps.length >= this.cfg.fastMoverMaxAlertsPerHour) {
      this.metrics.suppressed.cap++;
      return { triggered: true, suppressed: 'cap', symbol };
    }

    this.metrics.triggers++;
    this.pendingConfirms.add(symbol);
    this.lastConfirmAttempt.set(symbol, nowMs);
    void this.confirmAndAlert({ symbol, price, quoteVolume24h, move, volume, eventTime })
      .catch(error => {
        this.lastError = `alert pipeline: ${error.message}`;
        log(`Fast-mover pipeline failed for ${symbol}: ${error.message}`);
      })
      .finally(() => this.pendingConfirms.delete(symbol));
    return { triggered: true, symbol, movePct: move.pct, windowSec: move.windowSec, volumeAccel: volume.accel };
  }

  async confirm(symbol) {
    const rows = await this.binance.klines(symbol, '1m', 5);
    const closed = closedCandles(parseKlines(rows), this.now());
    if (closed.length < 2) return { ok: false, reason: 'insufficient closed 1m candles' };
    const movePct = closed[0].open > 0 ? ((closed.at(-1).close - closed[0].open) / closed[0].open) * 100 : 0;
    const flow = takerFlow(closed);
    if (!(movePct > 0)) return { ok: false, reason: `closed candles show no up move (${movePct.toFixed(2)}%)` };
    if (flow.buyRatio < CONFIRM_TAKER_BUY_RATIO) {
      return { ok: false, reason: `1m taker buy ${(flow.buyRatio * 100).toFixed(0)}% below 52%` };
    }
    // Gentle pacing between the two confirm calls; injectable so tests never wait.
    await this.sleepImpl(150);
    const book = await this.binance.depth(symbol, 20);
    const bestBid = Number(book?.bids?.[0]?.[0]);
    const bestAsk = Number(book?.asks?.[0]?.[0]);
    if (!(bestBid > 0) || !(bestAsk > bestBid)) return { ok: false, reason: 'order book invalid' };
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
    if (spreadBps > this.cfg.fastMoverMaxSpreadBps) {
      return { ok: false, reason: `spread ${spreadBps.toFixed(1)} bps above ${this.cfg.fastMoverMaxSpreadBps}` };
    }
    return { ok: true, movePct, buyRatio: flow.buyRatio, spreadBps };
  }

  cooldownBucket(nowMs) {
    return Math.floor(nowMs / (this.cfg.fastMoverCooldownMin * 60_000));
  }

  alertMessage(trigger, confirm) {
    return `⚡ <b>[FUTURES] FAST MOVER</b>\n` +
      `<b>${escapeHtml(trigger.symbol.replace('USDT', ''))}</b> +${trigger.move.pct.toFixed(2)}% in ${trigger.move.windowSec}s\n` +
      `Price: $${formatPrice(trigger.price)} · 24h quote ${usdCompact(trigger.quoteVolume24h)}\n` +
      `Volume accel: ${trigger.volume.accel.toFixed(1)}× baseline · 1m taker buy ${(confirm.buyRatio * 100).toFixed(0)}%\n` +
      `Spread: ${confirm.spreadBps.toFixed(1)} bps\n` +
      `⚠️ <b>Sudden moves can reverse sharply.</b> This is a live radar ping, not the gated FIRE entry — no database trade was opened.\n` +
      `⏰ ${gstTime()} GST`;
  }

  async confirmAndAlert(trigger) {
    const confirmation = await this.confirm(trigger.symbol);
    if (!confirmation.ok) {
      this.metrics.confirmRejected++;
      log(`Fast-mover confirm rejected ${trigger.symbol}: ${confirmation.reason}`);
      return;
    }
    // Re-check the suppression gates after the async confirm flight so a burst
    // of simultaneous triggers cannot overrun the cooldown or the hourly cap.
    const nowMs = this.now();
    const lastAlertAt = this.cooldowns.get(trigger.symbol) ?? 0;
    if (nowMs - lastAlertAt < this.cfg.fastMoverCooldownMin * 60_000) {
      this.metrics.suppressed.cooldown++;
      return;
    }
    this.alertTimestamps = this.alertTimestamps.filter(ts => nowMs - ts < 3_600_000);
    if (this.alertTimestamps.length >= this.cfg.fastMoverMaxAlertsPerHour) {
      this.metrics.suppressed.cap++;
      return;
    }
    this.cooldowns.set(trigger.symbol, nowMs);
    this.alertTimestamps.push(nowMs);
    // Persist BEFORE alerting: a 409 dedup hit (insertEvent → false) means this
    // cooldown bucket already alerted — e.g. a restart wiped the in-memory
    // cooldowns — so skip the Telegram send instead of double-alerting. A DB
    // ERROR (throw) must never silence the alert: log it and still send.
    let persisted;
    try {
      persisted = await this.store.insertEvent({
        event_key: `fast-mover:${trigger.symbol}:${this.cooldownBucket(nowMs)}`,
        event_type: 'FUTURES_FAST_MOVER',
        symbol: trigger.symbol,
        payload: {
          price: trigger.price,
          movePct: Number(trigger.move.pct.toFixed(4)),
          windowSec: trigger.move.windowSec,
          volumeAccel: Number(trigger.volume.accel.toFixed(3)),
          volPerMin: Math.round(trigger.volume.volPerMin),
          baselinePerMin: Math.round(trigger.volume.baseline),
          quoteVolume24h: Math.round(trigger.quoteVolume24h),
          confirmMovePct: Number(confirmation.movePct.toFixed(4)),
          takerBuyRatio: Number(confirmation.buyRatio.toFixed(4)),
          spreadBps: Number(confirmation.spreadBps.toFixed(2)),
          eventTime: trigger.eventTime,
        },
      });
    } catch (error) {
      persisted = true; // persistence failure must not silence the alert
      log(`Fast-mover persistence failed for ${trigger.symbol}: ${error.message}`);
    }
    if (persisted === false) {
      this.metrics.dedupSkipped++;
      log(`Fast-mover dedup skip ${trigger.symbol}: cooldown-bucket event already persisted; alert suppressed`);
      return;
    }
    this.metrics.alerts++;
    await this.telegram.send(this.alertMessage(trigger, confirmation));
    log(`FAST MOVER ${trigger.symbol}: +${trigger.move.pct.toFixed(2)}%/${trigger.move.windowSec}s, volume ${trigger.volume.accel.toFixed(1)}×`);
  }

  health() {
    return {
      enabled: Boolean(this.cfg.enableFastMoverAlerts),
      connected: this.connected,
      stale: this.connected && Boolean(this.lastMessageAt || this.connectedAt)
        && this.now() - (this.lastMessageAt || this.connectedAt) > 30_000,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      trackedSymbols: this.buffers.size,
      metrics: this.metrics,
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
