import test from 'node:test';
import assert from 'node:assert/strict';
import { FastMoverDetector } from '../src/pump-detector.js';

const BASE = 1_000_000_000;
const NOW = BASE + 600_000;
const Q0 = 20_000_000; // 24h rolling quote volume, above the 10M gate

const cfg = {
  enableFastMoverAlerts: true,
  fastMoverMin1mPct: 0.8,
  fastMoverMin3mPct: 1.5,
  fastMoverVolumeAccel: 3.0,
  fastMoverMinQuoteUsd: 10_000_000,
  fastMoverCooldownMin: 30,
  fastMoverMaxAlertsPerHour: 6,
  fastMoverMaxSpreadBps: 30,
};

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const tick = (t, symbol, price, q) => ({ E: t, s: symbol, c: String(price), q: String(q) });

// 1m kline rows: [openTime, open, high, low, close, volume, closeTime, quote, trades, takerBuy, takerBuyQuote]
const risingKlines = (takerRatio = 0.6) => [0, 1, 2, 3, 4].map(i => [
  NOW - 6 * 60_000 + i * 60_000, String(99 + i * 0.5), String(99 + i * 0.5 + 0.6),
  String(99 + i * 0.5 - 0.2), String(99 + i * 0.5 + 0.5), '1000',
  NOW - 6 * 60_000 + i * 60_000 + 59_999, '100000', 100,
  String(1000 * takerRatio), String(100_000 * takerRatio),
]);

const tightBook = { bids: [['101', '10']], asks: [['101.01', '10']] }; // ~1 bps
const wideBook = { bids: [['100', '10']], asks: [['100.5', '10']] }; // ~50 bps

const makeDetector = (overrides = {}) => {
  const sent = [];
  const events = [];
  const deps = {
    sent,
    events,
    binance: {
      klines: async () => overrides.klines ?? risingKlines(),
      depth: async () => overrides.depth ?? tightBook,
    },
    store: { insertEvent: async event => { events.push(event); return true; } },
    telegram: { send: async message => { sent.push(message); return true; } },
  };
  if (overrides.storeThrow) deps.store.insertEvent = async () => { throw new Error('db down'); };
  if (overrides.storeDedup) deps.store.insertEvent = async event => { events.push(event); return false; };
  const detector = new FastMoverDetector({
    cfg: { ...cfg, ...overrides.cfg },
    binance: deps.binance,
    store: deps.store,
    telegram: deps.telegram,
    realtimeShock: overrides.realtimeShock ?? null,
    isPaused: overrides.isPaused ?? (() => false),
    WebSocketImpl: overrides.WebSocketImpl,
    now: overrides.now ?? (() => NOW),
    sleepImpl: async () => { },
  });
  return { detector, deps };
};

// 10 minutes of 5-second ticks; baseline volume slope 200 quote/s so every
// rolling 60s delta is 12_000. `pump` overrides the final tick.
const feedHistory = (detector, {
  symbol = 'PUMPUSDT',
  seconds = 600,
  stepSec = 5,
  priceAt = () => 100,
  qBase = Q0,
  pump = null,
} = {}) => {
  let result = null;
  for (let s = 0; s <= seconds; s += stepSec) {
    const isLast = s === seconds;
    const price = isLast && pump ? pump.price : priceAt(s);
    const q = qBase + s * 200 + (isLast && pump ? (pump.qJump ?? 0) : 0);
    result = detector.ingestTick(tick(BASE + s * 1_000, symbol, price, q));
  }
  return result;
};

const PUMP = { price: 101, qJump: 30_000 }; // +1% in 60s, volume accel 3.5×

test('ring buffer prunes points beyond the 10-minute horizon', () => {
  const { detector } = makeDetector();
  for (let s = 0; s <= 900; s += 5) {
    detector.ingestTick(tick(BASE + s * 1_000, 'CALMUSDT', 100, Q0 + s * 200));
  }
  const buffer = detector.buffers.get('CALMUSDT');
  assert.ok(buffer.length > 0);
  assert.ok(buffer[0].t >= BASE + 900_000 - 600_000, 'old points pruned');
  assert.equal(buffer.at(-1).t, BASE + 900_000);
});

test('ring buffer is capped at ~700 points per symbol', () => {
  const { detector } = makeDetector();
  for (let i = 0; i < 800; i++) {
    detector.ingestTick(tick(BASE + i * 500, 'CALMUSDT', 100, Q0 + i * 100));
  }
  assert.equal(detector.buffers.get('CALMUSDT').length, 700);
});

test('full pump triggers, confirms, persists with the cooldown dedup key, and alerts', async () => {
  const { detector, deps } = makeDetector();
  const result = feedHistory(detector, { pump: PUMP });
  assert.equal(result.triggered, true);
  assert.equal(result.windowSec, 60);
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /\[FUTURES\] FAST MOVER/);
  assert.match(deps.sent[0], /\+1\.00% in 60s/);
  assert.match(deps.sent[0], /3\.5× baseline/);
  assert.match(deps.sent[0], /radar ping, not the gated FIRE entry/);
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0].event_type, 'FUTURES_FAST_MOVER');
  assert.equal(deps.events[0].symbol, 'PUMPUSDT');
  assert.equal(deps.events[0].event_key, `fast-mover:PUMPUSDT:${Math.floor(NOW / (30 * 60_000))}`);
  assert.equal(detector.metrics.triggers, 1);
  assert.equal(detector.metrics.alerts, 1);
});

test('price gate off: volume spike alone never triggers', async () => {
  const { detector, deps } = makeDetector();
  const result = feedHistory(detector, { pump: { price: 100.3, qJump: 60_000 } });
  assert.equal(result, null);
  await flush();
  assert.equal(detector.metrics.triggers, 0);
  assert.equal(deps.sent.length, 0);
});

test('volume acceleration gate off: price spike alone never triggers', async () => {
  const { detector, deps } = makeDetector();
  const result = feedHistory(detector, { pump: { price: 101, qJump: 0 } });
  assert.equal(result, null);
  await flush();
  assert.equal(detector.metrics.triggers, 0);
  assert.equal(deps.sent.length, 0);
});

test('3-minute window triggers when the 1-minute window is below its threshold', async () => {
  const { detector, deps } = makeDetector();
  // Slow ramp: +1.6% over the last 180s but only ~+0.53% over the last 60s.
  const result = feedHistory(detector, {
    priceAt: s => (s <= 420 ? 100 : 100 + ((s - 420) / 180) * 1.6),
    pump: { price: 101.6, qJump: 30_000 },
  });
  assert.equal(result.triggered, true);
  assert.equal(result.windowSec, 180);
  await flush();
  assert.match(deps.sent[0], /in 180s/);
});

test('24h quote volume gate blocks illiquid symbols', () => {
  const { detector } = makeDetector();
  const result = feedHistory(detector, { qBase: 5_000_000, pump: PUMP });
  assert.equal(result, null);
  assert.equal(detector.metrics.triggers, 0);
});

test('sub-quote symbol with no burst move never counts quoteLow suppression', () => {
  const { detector } = makeDetector();
  // Illiquid (5M < 10M floor) and flat price: every tick misses the move gate,
  // so the quote floor must stay silent and not dominate the /why reasons.
  const result = feedHistory(detector, { symbol: 'THINUSDT', qBase: 5_000_000 });
  assert.equal(result, null);
  assert.equal(detector.metrics.suppressed.quoteLow, 0);
  assert.equal(detector.lastSuppressedReason, null);
});

test('burst move on a sub-quote symbol counts quoteLow after the move gate', () => {
  const { detector } = makeDetector();
  const result = feedHistory(detector, { symbol: 'THINUSDT', qBase: 5_000_000, pump: PUMP });
  assert.equal(result, null, 'quote floor still blocks the trigger');
  assert.equal(detector.metrics.triggers, 0);
  assert.equal(detector.metrics.suppressed.quoteLow, 1, 'only the burst-move tick counts');
  assert.equal(detector.lastSuppressedReason, 'quoteLow');
});

test('BTC and FUTURES_EXCLUDED symbols never trigger', () => {
  const { detector } = makeDetector();
  assert.equal(feedHistory(detector, { symbol: 'BTCUSDT', pump: PUMP }), null);
  assert.equal(feedHistory(detector, { symbol: 'DOGEUSDT', pump: PUMP }), null);
  assert.equal(detector.metrics.triggers, 0);
});

test('per-symbol cooldown suppresses a repeated trigger', async () => {
  const { detector, deps } = makeDetector();
  feedHistory(detector, { pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 1);
  // 5s later the move is still violent; the 30-minute cooldown must hold it.
  const again = detector.ingestTick(tick(BASE + 605_000, 'PUMPUSDT', 101, Q0 + 605 * 200 + 60_000));
  assert.equal(again.suppressed, 'cooldown');
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(detector.metrics.suppressed.cooldown, 1);
  assert.equal(detector.metrics.alerts, 1);
});

test('global hourly cap suppresses triggers on other symbols', async () => {
  const { detector, deps } = makeDetector({ cfg: { fastMoverMaxAlertsPerHour: 1 } });
  feedHistory(detector, { symbol: 'PUMPUSDT', pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 1);
  const second = feedHistory(detector, { symbol: 'ALTUSDT', pump: PUMP });
  assert.equal(second.suppressed, 'cap');
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(detector.metrics.suppressed.cap, 1);
});

test('realtime shock guard suppresses new fast-mover alerts', async () => {
  const { detector, deps } = makeDetector({ realtimeShock: { blocked: () => true } });
  const result = feedHistory(detector, { pump: PUMP });
  assert.equal(result.suppressed, 'shock');
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.metrics.suppressed.shock, 1);
});

test('paused engine suppresses new fast-mover alerts', async () => {
  const { detector, deps } = makeDetector({ isPaused: () => true });
  const result = feedHistory(detector, { pump: PUMP });
  assert.equal(result.suppressed, 'paused');
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.metrics.suppressed.paused, 1);
});

test('weak taker flow on closed 1m klines stays silent and counts confirmRejected', async () => {
  const { detector, deps } = makeDetector({ klines: risingKlines(0.4) });
  const result = feedHistory(detector, { pump: PUMP });
  assert.equal(result.triggered, true);
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(deps.events.length, 0);
  assert.equal(detector.metrics.confirmRejected, 1);
  assert.equal(detector.metrics.alerts, 0);
});

test('a wide confirmed spread stays silent and counts confirmRejected', async () => {
  const { detector, deps } = makeDetector({ depth: wideBook });
  feedHistory(detector, { pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.metrics.confirmRejected, 1);
});

test('a database failure never silences the alert', async () => {
  const { detector, deps } = makeDetector({ storeThrow: true });
  feedHistory(detector, { pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.events.length, 0);
  assert.equal(detector.metrics.alerts, 1);
});

test('a 409 dedup hit (insertEvent false) suppresses the duplicate alert', async () => {
  // Restart case: in-memory cooldowns were wiped but the cooldown-bucket event
  // row already exists, so the store dedups it — no second Telegram alert.
  const { detector, deps } = makeDetector({ storeDedup: true });
  const result = feedHistory(detector, { pump: PUMP });
  assert.equal(result.triggered, true);
  await flush();
  assert.equal(deps.events.length, 1, 'persistence was attempted first');
  assert.equal(deps.sent.length, 0, 'no duplicate telegram alert');
  assert.equal(detector.metrics.dedupSkipped, 1);
  assert.equal(detector.metrics.alerts, 0);
});

test('a failed confirm throttles retries: two triggers 5s apart start one confirm flight', async () => {
  const { detector, deps } = makeDetector({ klines: risingKlines(0.4) }); // confirm always rejects
  let klineCalls = 0;
  const klines = deps.binance.klines;
  deps.binance.klines = async (...args) => { klineCalls++; return klines(...args); };

  const first = feedHistory(detector, { pump: PUMP });
  assert.equal(first.triggered, true);
  await flush();
  assert.equal(klineCalls, 1);
  assert.equal(detector.metrics.confirmRejected, 1);

  // 5s later the move is still violent; without a confirm throttle this tick
  // would start a second full REST confirm flight.
  const second = detector.ingestTick(tick(BASE + 605_000, 'PUMPUSDT', 101, Q0 + 605 * 200 + 60_000));
  assert.equal(second.triggered, true);
  assert.equal(second.suppressed, 'cooldown');
  await flush();
  assert.equal(klineCalls, 1, 'no second confirm flight inside the 60s throttle');
  assert.equal(detector.metrics.confirmRejected, 1);
  assert.equal(detector.metrics.suppressed.cooldown, 1);
});

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = {};
    FakeWebSocket.instances.push(this);
  }

  on(event, fn) { this.handlers[event] = fn; return this; }
  emit(event, ...args) { this.handlers[event]?.(...args); }
  close() { this.handlers.close?.(); }
  terminate() { this.terminated = true; this.handlers.close?.(); }
}

test('combined-stream websocket lifecycle: connect, message, alert, reconnect on close', async () => {
  FakeWebSocket.instances = [];
  const { detector, deps } = makeDetector({ WebSocketImpl: FakeWebSocket });
  detector.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.match(socket.url, /fstream\.binance\.com\/stream\?streams=!miniTicker@arr/);
  socket.emit('open');
  assert.equal(detector.health().connected, true);

  const ticks = [];
  for (let s = 0; s <= 600; s += 5) {
    ticks.push(tick(BASE + s * 1_000, 'PUMPUSDT', s === 600 ? 101 : 100, Q0 + s * 200 + (s === 600 ? 30_000 : 0)));
  }
  socket.emit('message', JSON.stringify({ stream: '!miniTicker@arr', data: ticks.slice(0, -1) }));
  assert.equal(detector.buffers.get('PUMPUSDT').length, 120);
  socket.emit('message', JSON.stringify({ stream: '!miniTicker@arr', data: [ticks.at(-1)] }));
  await flush();
  assert.equal(deps.sent.length, 1);

  socket.emit('close');
  assert.equal(detector.health().connected, false);
  assert.equal(detector.reconnectAttempts, 1);
  assert.ok(detector.reconnectTimer, 'reconnect scheduled after close');
  detector.stop();
  assert.equal(detector.reconnectTimer, null);
  assert.equal(detector.health().connected, false);
});

test('reconnect backoff doubles to a 30s ceiling and stop() cancels it', () => {
  const { detector } = makeDetector();
  assert.equal(detector.scheduleReconnect(), 1_000);
  clearTimeout(detector.reconnectTimer); detector.reconnectTimer = null;
  assert.equal(detector.scheduleReconnect(), 2_000);
  clearTimeout(detector.reconnectTimer); detector.reconnectTimer = null;
  detector.reconnectAttempts = 6;
  assert.equal(detector.scheduleReconnect(), 30_000);
  detector.stop();
  assert.equal(detector.reconnectTimer, null);
  assert.equal(detector.scheduleReconnect(), null, 'no reconnect while stopping');
});

test('a stale connected stream is terminated so reconnect can take over', () => {
  let terminated = false;
  const { detector } = makeDetector();
  detector.connected = true;
  detector.connectedAt = NOW - 40_000;
  detector.socket = { terminate: () => { terminated = true; } };
  detector.checkLiveness();
  assert.equal(terminated, true);
  assert.match(detector.lastError, /stale/);
});

test('health reports enabled, connection, tracked symbols and metrics', () => {
  const { detector } = makeDetector();
  feedHistory(detector, { pump: PUMP });
  const health = detector.health();
  assert.equal(health.enabled, true);
  assert.equal(health.connected, false);
  assert.equal(health.trackedSymbols, 1);
  assert.equal(health.metrics.triggers, 1);
  assert.equal(health.lastMessageAt, new Date(NOW).toISOString());
  const disabled = makeDetector({ cfg: { enableFastMoverAlerts: false } }).detector;
  assert.equal(disabled.health().enabled, false);
});

// ── v6.9.4 Tier 2: TRENDING MOVER ───────────────────────────────────────────
// 70 minutes of 15-second ticks build the decimated slow buffer; a gentle price
// ramp trips a 15/30/60m window and a final-quote jump provides the 5-minute
// volume acceleration (constant 200 quote/s slope → 60_000 per 5m baseline).

const TRENDING_CFG = {
  enableTrendingMover: true,
  trendingMin15mPct: 2.0,
  trendingMin30mPct: 3.5,
  trendingMin60mPct: 5.0,
  trendingVolumeAccel: 2.0,
  trendingMinBuyRatio: 0.50,
  trendingMaxSpreadBps: 45,
  trendingCooldownMin: 120,
  trendingMaxAlertsPerHour: 4,
};

const RAMP_15M = s => (s <= 3300 ? 100 : 100 + ((s - 3300) / 900) * 2.2); // +2.2% over the last 15m
const RAMP_30M = s => (s <= 2400 ? 100 : 100 + ((s - 2400) / 1800) * 3.6); // +3.6% over the last 30m
const RAMP_60M = s => (s <= 600 ? 100 : 100 + ((s - 600) / 3600) * 5.5); // +5.5% over the last 60m

const feedTrending = (detector, {
  symbol = 'TRENDUSDT',
  minutes = 70,
  stepSec = 15,
  priceAt = () => 100,
  qBase = Q0,
  qSlope = 200,
  finalJump = 0,
} = {}) => {
  let result = null;
  const total = minutes * 60;
  for (let s = 0; s <= total; s += stepSec) {
    const q = qBase + s * qSlope + (s === total ? finalJump : 0);
    result = detector.ingestTick(tick(BASE + s * 1_000, symbol, priceAt(s), q));
  }
  return result;
};

test('slow buffer decimates to at most one point per 15s', () => {
  const { detector } = makeDetector();
  for (let s = 0; s <= 60; s += 5) {
    detector.ingestTick(tick(BASE + s * 1_000, 'CALMUSDT', 100, Q0 + s * 200));
  }
  assert.equal(detector.buffers.get('CALMUSDT').length, 13, 'fast buffer keeps every raw tick');
  assert.deepEqual(
    detector.slowBuffers.get('CALMUSDT').map(point => (point.t - BASE) / 1_000),
    [0, 15, 30, 45, 60],
  );
});

test('slow buffer prunes beyond the 70-minute horizon and stays capped at ~300 points', () => {
  const { detector } = makeDetector();
  feedTrending(detector, { minutes: 80 });
  const slow = detector.slowBuffers.get('TRENDUSDT');
  assert.equal(slow.at(-1).t, BASE + 80 * 60 * 1_000);
  assert.ok(slow.length <= 300, 'hard cap holds');
  assert.equal(slow.length, 281, '70 minutes at one point per 15s, inclusive');
  assert.ok(slow[0].t >= BASE + 80 * 60 * 1_000 - 70 * 60 * 1_000, 'old points pruned');
});

test('watchdog pass reaps dead symbols from the slow buffer too', () => {
  const { detector } = makeDetector();
  feedTrending(detector, { minutes: 20 });
  detector.slowBuffers.set('DEADUSDT', [{ t: NOW - 71 * 60_000, price: 1, q: 1 }]);
  assert.equal(detector.slowBuffers.size, 2);
  detector.checkLiveness();
  assert.equal(detector.slowBuffers.has('DEADUSDT'), false);
  assert.equal(detector.slowBuffers.has('TRENDUSDT'), true);
});

test('tier-2 15m window: steady grind triggers, confirms, persists and alerts', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /\[FUTURES\] 📈 TRENDING MOVER/);
  assert.match(deps.sent[0], /\+2\.20% in 15m/);
  assert.match(deps.sent[0], /5m volume accel: 2\.5× baseline/);
  assert.match(deps.sent[0], /Steady mover — not a burst/);
  assert.match(deps.sent[0], /radar ping, not a gated entry/);
  assert.equal(deps.events.length, 1);
  assert.equal(deps.events[0].event_type, 'FUTURES_TRENDING_MOVER');
  assert.equal(deps.events[0].symbol, 'TRENDUSDT');
  assert.equal(deps.events[0].event_key, `trending-mover:TRENDUSDT:${Math.floor(NOW / (120 * 60_000))}`);
  assert.equal(detector.trendingMetrics.trendingTriggers, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
  assert.equal(detector.metrics.triggers, 0, 'no tier-1 burst fired during the slow grind');
});

test('tier-2 30m window fires when the 15m move stays below its threshold', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_30M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /\+3\.60% in 30m/);
  assert.equal(deps.events[0].payload.window, '30m');
});

test('tier-2 60m window fires when the 15m and 30m moves stay below their thresholds', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_60M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /\+5\.50% in 60m/);
  assert.equal(deps.events[0].payload.window, '60m');
});

test('tier-2 windows below threshold stay silent even with a volume jump', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  // +1.9% over 15m: below every window floor (2.0 / 3.5 / 5.0).
  feedTrending(detector, { priceAt: s => (s <= 3300 ? 100 : 100 + ((s - 3300) / 900) * 1.9), finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(deps.events.length, 0);
  assert.equal(detector.trendingMetrics.trendingTriggers, 0);
});

test('tier-2 volume-acceleration soft gate blocks a price grind without volume', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 0 }); // accel stays 1.0×
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.trendingMetrics.trendingTriggers, 0);
  assert.ok(detector.trendingSuppressed.volumeLow > 0);

  // A flat quote counter gives a zero baseline, which must also fail the gate.
  const quiet = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(quiet.detector, { priceAt: RAMP_15M, qSlope: 0, finalJump: 0 });
  await flush();
  assert.equal(quiet.deps.sent.length, 0);
  assert.ok(quiet.detector.trendingSuppressed.volumeLow > 0);
});

test('tier-2 quote gate counts quoteLow when a window triggers on an illiquid symbol', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_15M, qBase: 5_000_000, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.trendingMetrics.trendingTriggers, 0);
  assert.ok(detector.trendingSuppressed.quoteLow > 0);
  assert.equal(detector.lastSuppressedReason, 'quoteLow');
});

test('ENABLE_TRENDING_MOVER off disables tier 2 while tier 1 keeps working', async () => {
  const { detector, deps } = makeDetector({ cfg: { ...TRENDING_CFG, enableTrendingMover: false } });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 0);
  assert.equal(detector.trendingMetrics.trendingTriggers, 0);
  assert.equal(detector.health().trending.enabled, false);
  feedHistory(detector, { symbol: 'PUMPUSDT', pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /\[FUTURES\] FAST MOVER/);
});

test('health().trending.enabled is false when only the tier-1 master switch is off', () => {
  // Tier 2 shares the tier-1 WebSocket, so enableTrendingMover alone is not enough.
  const { detector } = makeDetector({ cfg: { ...TRENDING_CFG, enableFastMoverAlerts: false } });
  const health = detector.health();
  assert.equal(health.enabled, false);
  assert.equal(health.trending.enabled, false);
});

test('tier-2 confirm accepts 51% taker buy and a 40bps spread that tier 1 would reject', async () => {
  const book40 = { bids: [['100', '10']], asks: [['100.4', '10']] }; // ~39.9 bps
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG, klines: risingKlines(0.51), depth: book40 });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.match(deps.sent[0], /1m taker buy 51%/);
  assert.match(deps.sent[0], /Spread: 39\.9 bps/);
  // The same book with a 50bps spread (above the tier-2 45bps ceiling) rejects.
  const wide = makeDetector({ cfg: TRENDING_CFG, klines: risingKlines(0.51), depth: wideBook });
  feedTrending(wide.detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(wide.deps.sent.length, 0);
  assert.equal(wide.detector.trendingMetrics.trendingConfirmRejected, 1);
});

test('tier-2 confirm rejection is silent, counted, and throttled for at least 120s', async () => {
  let currentNow = NOW;
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG, klines: risingKlines(0.45), now: () => currentNow });
  let klineCalls = 0;
  const klines = deps.binance.klines;
  deps.binance.klines = async (...args) => { klineCalls++; return klines(...args); };

  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(klineCalls, 1);
  assert.equal(detector.trendingMetrics.trendingConfirmRejected, 1);
  assert.equal(detector.trendingSuppressed.confirmRejected, 1);
  assert.equal(deps.sent.length, 0);

  // 15s later the window still triggers with volume, but the separate 120s
  // tier-2 confirm throttle must prevent a second REST confirm flight.
  detector.ingestTick(tick(BASE + 4_215_000, 'TRENDUSDT', 102.2, Q0 + 4_215_000 * 0.2 + 90_000));
  await flush();
  assert.equal(klineCalls, 1, 'no second confirm flight inside the 120s throttle');
  assert.equal(detector.trendingSuppressed.cooldown, 1);

  // After 121s the throttle releases and the next trigger confirms again.
  currentNow = NOW + 121_000;
  detector.ingestTick(tick(BASE + 4_230_000, 'TRENDUSDT', 102.2, Q0 + 4_230_000 * 0.2 + 90_000));
  await flush();
  assert.equal(klineCalls, 2);
  assert.equal(detector.trendingMetrics.trendingConfirmRejected, 2);
  assert.equal(deps.sent.length, 0);
});

test('tier-2 cooldown suppresses a repeated trending trigger', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  // 15s later, still grinding with fresh volume: the 120-minute cooldown holds.
  detector.ingestTick(tick(BASE + 4_215_000, 'TRENDUSDT', 102.3, Q0 + 4_215_000 * 0.2 + 180_000));
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(detector.trendingSuppressed.cooldown, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
});

test('tier-2 hourly cap suppresses trending triggers on other symbols', async () => {
  const { detector, deps } = makeDetector({ cfg: { ...TRENDING_CFG, trendingMaxAlertsPerHour: 1 } });
  feedTrending(detector, { symbol: 'TRENDUSDT', priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  feedTrending(detector, { symbol: 'GRINDUSDT', priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(detector.trendingSuppressed.hourlyCap, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
});

test('a tier-1 alert consumes neither the tier-2 hourly cap nor its cooldown map', async () => {
  const { detector, deps } = makeDetector({ cfg: { ...TRENDING_CFG, fastMoverMaxAlertsPerHour: 1 } });
  // Tier-1 burst on a 10-minute feed: far too short for any tier-2 window.
  feedHistory(detector, { symbol: 'PUMPUSDT', pump: PUMP });
  await flush();
  assert.equal(detector.metrics.alerts, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 0);
  // The tier-1 hourly cap is now exhausted (1/1); the tier-2 cap (4) is untouched.
  feedTrending(detector, { symbol: 'TRENDUSDT', priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 2);
  assert.match(deps.sent[1], /TRENDING MOVER/);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
  assert.ok(detector.cooldowns.has('PUMPUSDT'));
  assert.equal(detector.trendingCooldowns.has('PUMPUSDT'), false, 'tier-1 cooldown never touches tier-2 maps');
  assert.ok(detector.trendingCooldowns.has('TRENDUSDT'));
  assert.equal(detector.cooldowns.has('TRENDUSDT'), false);
});

test('a tier-2 alert consumes neither the tier-1 hourly cap nor its cooldown map', async () => {
  const { detector, deps } = makeDetector({ cfg: { ...TRENDING_CFG, trendingMaxAlertsPerHour: 1 } });
  feedTrending(detector, { symbol: 'TRENDUSDT', priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
  // Tier-2 cap exhausted (1/1); the tier-1 cap (6) and cooldowns are untouched.
  feedHistory(detector, { symbol: 'PUMPUSDT', pump: PUMP });
  await flush();
  assert.equal(deps.sent.length, 2);
  assert.match(deps.sent[1], /\[FUTURES\] FAST MOVER/);
  assert.equal(detector.metrics.alerts, 1);
  assert.ok(detector.trendingCooldowns.has('TRENDUSDT'));
  assert.equal(detector.cooldowns.has('TRENDUSDT'), false);
});

test('tier-2 dedup hit (insertEvent false) suppresses the duplicate alert', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG, storeDedup: true });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.events.length, 1, 'persistence was attempted first');
  assert.equal(deps.sent.length, 0, 'no duplicate telegram alert');
  assert.equal(detector.trendingMetrics.trendingDedupSkipped, 1);
  assert.equal(detector.trendingSuppressed.dedupSkipped, 1);
  assert.equal(detector.trendingMetrics.trendingAlerts, 0);
});

test('a tier-2 database failure never silences the alert', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG, storeThrow: true });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.events.length, 0);
  assert.equal(detector.trendingMetrics.trendingAlerts, 1);
});

test('tier-2 shock guard and paused engine suppress trending alerts', async () => {
  const shocked = makeDetector({ cfg: TRENDING_CFG, realtimeShock: { blocked: () => true } });
  feedTrending(shocked.detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(shocked.deps.sent.length, 0);
  assert.ok(shocked.detector.trendingSuppressed.shock > 0);
  assert.equal(shocked.detector.trendingMetrics.trendingTriggers, 0);

  const paused = makeDetector({ cfg: TRENDING_CFG, isPaused: () => true });
  feedTrending(paused.detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(paused.deps.sent.length, 0);
  assert.ok(paused.detector.trendingSuppressed.paused > 0);
});

test('health exposes tier-2 metrics, suppression breakdown and radar timestamps', async () => {
  const { detector, deps } = makeDetector({ cfg: TRENDING_CFG });
  feedTrending(detector, { priceAt: RAMP_15M, finalJump: 90_000 });
  await flush();
  assert.equal(deps.sent.length, 1);
  const health = detector.health();
  assert.equal(health.trending.enabled, true);
  assert.equal(health.trending.trackedSymbols, 1);
  assert.equal(health.trending.metrics.trendingTriggers, 1);
  assert.equal(health.trending.metrics.trendingAlerts, 1);
  assert.ok(health.trending.suppressed.volumeLow > 0, 'pre-jump evaluations were volume-suppressed');
  assert.equal(health.lastTriggerAt, new Date(NOW).toISOString());
  assert.equal(health.lastAlertAt, new Date(NOW).toISOString());
  assert.equal(typeof health.suppressed.cooldown, 'number');
  assert.equal(typeof health.suppressed.volumeLow, 'number');
  assert.equal(health.lastSuppressedReason, 'volumeLow', 'last pre-trigger gate miss');
});
