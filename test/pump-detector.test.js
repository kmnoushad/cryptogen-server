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
