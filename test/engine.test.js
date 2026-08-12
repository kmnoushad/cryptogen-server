import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, FUTURES_EXCLUDED } from '../src/engine.js';

test('deep non-meme Binance Futures contracts remain eligible', () => {
  for (const symbol of ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT']) {
    assert.equal(FUTURES_EXCLUDED.has(symbol), false, `${symbol} must stay in the Futures universe`);
  }
  assert.equal(FUTURES_EXCLUDED.has('BTCUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('DOGEUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('1000PEPEUSDT'), true);
});

test('realtime BTC shock clears every pending Futures candidate immediately', async () => {
  const messages = [];
  const events = [];
  const engine = new Engine({
    cfg: { realtimeShockWindowMs: 10_000, realtimeShockCooldownMs: 120_000 },
    binance: {},
    store: { insertEvent: async event => { events.push(event); return true; } },
    telegram: { send: async message => { messages.push(message); } },
  });
  engine.candidates.set('ETHUSDT', { state: 'ARMED' });
  engine.candidates.set('SOLUSDT', { state: 'RETESTED' });

  await engine.handleRealtimeShock({ dropPct: -0.42, price: 99_580, peak: 100_000, eventTime: 10_000 });

  assert.equal(engine.candidates.size, 0);
  assert.equal(engine.metrics.rejected, 2);
  assert.equal(events[0].event_type, 'FUTURES_REALTIME_SHOCK');
  assert.match(messages[0], /Cancelled pending Futures candidates: 2/);
});

test('BTC block heartbeat fires once per window while the long gate stays closed', async () => {
  const messages = [];
  const events = [];
  const engine = new Engine({
    cfg: { btcBlockHeartbeatMin: 60 },
    binance: {},
    store: { insertEvent: async event => { events.push(event); return true; } },
    telegram: { send: async message => { messages.push(message); } },
  });
  const t0 = 1_700_000_000_000;
  engine.btc = { regime: 'NO_LONG_EDGE', allowed: false, distanceFromEma50Pct: -1.2, ema50Slope6hPct: -0.08 };

  await engine.maybeBtcBlockHeartbeat(t0); // starts tracking, below the window
  assert.equal(messages.length, 0);
  assert.equal(engine.btcBlockedSince, t0);

  const firedAt = t0 + 60 * 60_000;
  await engine.maybeBtcBlockHeartbeat(firedAt);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /BTC GATE BLOCKED 60 MIN/);
  assert.match(messages[0], /NO_LONG_EDGE/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'FUTURES_BTC_BLOCK_HEARTBEAT');
  // Dedup key is anchored to the block start plus the elapsed-window index, so
  // a restart mid-block never collides with a previous block's keys.
  assert.equal(
    events[0].event_key,
    `futures:btc-block-heartbeat:${Math.floor(t0 / 3_600_000)}:${Math.floor((firedAt - t0) / 3_600_000)}`,
  );
  assert.equal(events[0].payload.regime, 'NO_LONG_EDGE');
  assert.equal(events[0].payload.distanceFromEma50Pct, -1.2);
  assert.equal(events[0].payload.cancelledCandidates, 0);

  await engine.maybeBtcBlockHeartbeat(firedAt + 60_000); // inside the fire window: no repeat
  assert.equal(messages.length, 1);
  await engine.maybeBtcBlockHeartbeat(t0 + 2 * 60 * 60_000 + 60_000); // full second window: fire again
  assert.equal(messages.length, 2);
  assert.equal(events.length, 2);
  assert.equal(
    events[1].event_key,
    `futures:btc-block-heartbeat:${Math.floor(t0 / 3_600_000)}:2`,
  );

  engine.btc = { regime: 'BULLISH', allowed: true }; // gate reopens: state resets
  await engine.maybeBtcBlockHeartbeat(t0 + 2 * 60 * 60_000 + 120_000);
  assert.equal(engine.btcBlockedSince, null);
  assert.equal(engine.lastBtcBlockHeartbeatAt, null);
  assert.equal(engine.btcBlockCancelled, 0);

  // After the regime flip a new block starts a fresh window anchored at the
  // new block start, so its keys cannot collide with the previous block.
  engine.btc = { regime: 'NO_LONG_EDGE', allowed: false, distanceFromEma50Pct: -1.1, ema50Slope6hPct: -0.05 };
  const t1 = t0 + 3 * 60 * 60_000;
  await engine.maybeBtcBlockHeartbeat(t1);
  assert.equal(engine.btcBlockedSince, t1);
  await engine.maybeBtcBlockHeartbeat(t1 + 60 * 60_000);
  assert.equal(messages.length, 3);
  assert.equal(
    events[2].event_key,
    `futures:btc-block-heartbeat:${Math.floor(t1 / 3_600_000)}:1`,
  );
});

test('BTC block heartbeat never double-fires across an epoch bucket boundary', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { btcBlockHeartbeatMin: 60 },
    binance: {},
    store: { insertEvent: async () => true },
    telegram: { send: async message => { messages.push(message); } },
  });
  const windowMs = 3_600_000;
  // Block start chosen so the first fire lands 5s BEFORE an epoch bucket
  // boundary and the next scan lands 5s AFTER it. Epoch bucketing fired twice
  // here (~one scan apart); elapsed-time anchoring must not.
  const boundary = Math.ceil(1_700_000_000_000 / windowMs) * windowMs;
  const t0 = boundary - windowMs - 10_000;
  engine.btc = { regime: 'NO_LONG_EDGE', allowed: false, distanceFromEma50Pct: -1.2, ema50Slope6hPct: -0.08 };

  await engine.maybeBtcBlockHeartbeat(t0); // starts tracking
  assert.equal(messages.length, 0);
  const firstFire = boundary - 5_000; // windowMs + 5s after block start
  await engine.maybeBtcBlockHeartbeat(firstFire);
  assert.equal(messages.length, 1);
  await engine.maybeBtcBlockHeartbeat(boundary + 5_000); // next bucket, one scan later: no repeat
  assert.equal(messages.length, 1);
  await engine.maybeBtcBlockHeartbeat(firstFire + windowMs); // a full second window: fire again
  assert.equal(messages.length, 2);
});

test('BTC block heartbeat is disabled at 0 and tracks cancellations', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { btcBlockHeartbeatMin: 0 },
    binance: {},
    store: { insertEvent: async () => true },
    telegram: { send: async message => { messages.push(message); } },
  });
  const t0 = 1_700_000_000_000;
  engine.btc = { regime: 'SHOCK_BLOCK', allowed: false };
  await engine.maybeBtcBlockHeartbeat(t0);
  await engine.maybeBtcBlockHeartbeat(t0 + 5 * 60 * 60_000);
  assert.equal(messages.length, 0, '0 disables the heartbeat');
  assert.equal(engine.btcBlockedSince, t0, 'block tracking still runs for /why');
});

test('/why explains BTC gate, risk snapshot, blockers, candidates and fast mover', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', btcBlockHeartbeatMin: 0 },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: false, reasons: ['daily stop -1.50% hit'], openTrades: 0, tradesToday: 3, dailyPnlPct: -1.6, weeklyPnlPct: -2.1 }),
      insertEvent: async () => true,
    },
    telegram: { send: async message => { messages.push(message); } },
    fastMover: { health: () => ({ enabled: true, connected: true, stale: false, trackedSymbols: 42, metrics: { alerts: 1 } }) },
  });
  engine.btc = { regime: 'NO_LONG_EDGE', allowed: false, distanceFromEma50Pct: -1.1, ema50Slope6hPct: -0.07 };
  engine.btcBlockedSince = Date.now() - 45 * 60_000;
  engine.gateCounts = { 'IMPULSE: 3m taker buying below 56%': 12, BTC_BLOCK: 9 };
  engine.candidateHoldCounts = { 'taker flow weak': 4 };
  engine.candidateRejectCounts = { 'net R:R below minimum': 3 };
  engine.candidates.set('ETHUSDT', { symbol: 'ETHUSDT', state: 'ARMED' });

  await engine.command({ chat: { id: '1' }, text: '/why' });
  assert.equal(messages.length, 1);
  const reply = messages[0];
  assert.match(reply, /WHY IS NEXIO QUIET/);
  assert.match(reply, /NO_LONG_EDGE/);
  assert.match(reply, /LONG GATE CLOSED/);
  assert.match(reply, /blocked Futures entries for 45 min/);
  assert.match(reply, /daily stop -1\.50% hit/);
  assert.match(reply, /3m taker buying below 56% — 12/);
  assert.match(reply, /taker flow weak — 4/);
  assert.match(reply, /net R:R below minimum — 3/);
  assert.match(reply, /ETHUSDT — ARMED/);
  assert.match(reply, /Fast mover: ✅ connected · 42 tracked · 1 alerts/);
});

test('/why ignores non-owner chats', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1' },
    binance: {},
    store: { riskSnapshot: async () => ({ allowed: true, reasons: [] }), insertEvent: async () => true },
    telegram: { send: async message => { messages.push(message); } },
  });
  await engine.command({ chat: { id: '999' }, text: '/why' });
  assert.equal(messages.length, 0);
});

test('engine health exposes the fast-mover detector status', () => {
  const engine = new Engine({
    cfg: {},
    binance: {},
    store: {},
    telegram: {},
    fastMover: { health: () => ({ enabled: true, connected: true, trackedSymbols: 7 }) },
  });
  assert.deepEqual(engine.health().fastMover, { enabled: true, connected: true, trackedSymbols: 7 });
  const without = new Engine({ cfg: {}, binance: {}, store: {}, telegram: {} });
  assert.deepEqual(without.health().fastMover, { enabled: false });
});
