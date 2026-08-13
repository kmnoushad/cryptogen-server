import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, FUTURES_EXCLUDED } from '../src/engine.js';
import { EventGuard } from '../src/event-guard.js';

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

test('/why shows both radar tiers and the top-2 merged suppression reasons', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', btcBlockHeartbeatMin: 0 },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }),
      insertEvent: async () => true,
    },
    telegram: { send: async message => { messages.push(message); } },
    fastMover: {
      health: () => ({
        enabled: true,
        connected: true,
        stale: false,
        trackedSymbols: 40,
        metrics: { alerts: 1, triggers: 3 },
        suppressed: { cooldown: 5, cap: 1, shock: 0, paused: 0, volumeLow: 2, quoteLow: 0, confirmRejected: 0, dedupSkipped: 0 },
        trending: {
          enabled: true,
          trackedSymbols: 38,
          metrics: { trendingAlerts: 2, trendingTriggers: 4 },
          suppressed: { cooldown: 1, hourlyCap: 2, volumeLow: 7 },
        },
      }),
    },
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };

  await engine.command({ chat: { id: '1' }, text: '/why' });
  assert.equal(messages.length, 1);
  const reply = messages[0];
  assert.match(reply, /Fast mover: ✅ connected · 40 tracked · 1 alerts\/3 triggers/);
  assert.match(reply, /Trending mover: 2 alerts\/4 triggers · 38 tracked/);
  // volumeLow 2+7=9 and cooldown 5+1=6 are the merged top-2; tier-1 'cap' merges into hourlyCap 3.
  assert.match(reply, /Radar suppressed: volumeLow 9 · cooldown 6/);

  await engine.command({ chat: { id: '1' }, text: '/status' });
  const status = messages[1];
  assert.match(status, /Fast mover: ✅ connected · 40 tracked · 1 alerts\/3 triggers/);
  assert.match(status, /Trending mover: 2 alerts\/4 triggers · 38 tracked/);
});

// ── v6.9.5 Event Window Guard ───────────────────────────────────────────────

const flatKlines = (count = 90, lastCloseTime = Date.now() - 60_000, { close = 100.2, range = 1, buyRatio = 0.6, quoteVolume = 10_000 } = {}) =>
  Array.from({ length: count }, (_, i) => {
    const closeTime = lastCloseTime - (count - 1 - i) * 60_000;
    return [
      closeTime - 60_000 + 1, String(close), String(close + range / 2), String(close - range / 2),
      String(close), '1000', String(closeTime - 1), String(quoteVolume), 100,
      String(1000 * buyRatio), String(quoteVolume * buyRatio),
    ];
  });

const GUARD_EVENT_TIME = Date.parse('2026-08-13T12:30:00Z');

const makeEventGuard = clock => new EventGuard({
  cfg: {
    enableEventGuard: true,
    eventGuardPreMin: 30,
    eventGuardPostMin: 15,
    eventGuardManual: `${new Date(GUARD_EVENT_TIME).toISOString()}=CPI`,
  },
  calendar: null, // no Finnhub data: manual events alone must drive the guard
  now: () => clock.t,
});

test('event guard blocks new arms during a window without burning context calls', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 }; // inside the pre-window
  let depthCalls = 0;
  const engine = new Engine({
    cfg: {},
    binance: {
      klines: async () => flatKlines(),
      depth: async () => { depthCalls++; return { bids: [], asks: [] }; },
    },
    store: { insertEvent: async () => true },
    telegram: { send: async () => {} },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };

  const blocked = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(blocked.action, 'EVENT_GUARD');
  assert.equal(engine.gateCounts.EVENT_GUARD_BLOCK, 1);
  assert.equal(engine.candidates.size, 0);
  assert.equal(engine.metrics.armed, 0);
  assert.equal(depthCalls, 0, 'no context burn while guarded');

  // When the window clears the same symbol is evaluated normally again.
  clock.t = GUARD_EVENT_TIME + 20 * 60_000;
  const clear = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(clear.action, 'NONE'); // flat candles: no impulse, normal gating
  assert.equal(engine.gateCounts.EVENT_GUARD_BLOCK, 1);
});

test('event guard holds a completed reclaim (no FIRE, no reject) and releases it after the window', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 };
  const created = [];
  const messages = [];
  const engine = new Engine({
    cfg: {
      maxEntrySlippageBps: 8,
      takerFeeBps: 5,
      exitSlippageBps: 3,
      maxSpreadBps: 10,
      minDepthEachSideUsd: 100_000,
      minNetRR: 1.35,
      futuresCandidateTtlMin: 24,
      minStopPctFloor: 0.12,
      maxStopPct: 1.60,
    },
    binance: { klines: async () => flatKlines(90, Date.now() - 60_000) },
    store: {
      insertEvent: async () => true,
      riskSnapshot: async () => ({ allowed: true, reasons: [] }),
      symbolCooldown: async () => ({ blocked: false }),
      createTrade: async trade => { created.push(trade); return { created: true, trade: { id: 7, ...trade } }; },
      updateTrade: async () => true,
    },
    telegram: { send: async m => { messages.push(m); }, signalMessage: () => 'SIG' },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  engine.context = async () => ({
    risk: { hardBlock: false, terminalRisk: false, entryBlocked: false, score: 0, reasons: [] },
    oi: { changePct: 0.4 },
    depth: {
      estimatedBuyPrice: 100.2,
      bestAsk: 100.21,
      spreadBps: 4,
      bidNotional05: 300_000,
      askNotional05: 250_000,
      imbalance: 1.0,
      entryImpactBps: null,
      bidRetention: null,
      spreadExpansion: null,
    },
  });
  const now = Date.now();
  engine.candidates.set('ETHUSDT', {
    symbol: 'ETHUSDT',
    state: 'RECLAIMED_WAIT_BOOK',
    detectedBarClose: now - 6 * 60_000,
    expiresBarClose: now + 24 * 60_000,
    breakoutLevel: 100.2,
    structureLevel: 100.2,
    impulseLow: 98,
    impulseWaveAtArm: 10,
    peakPrice: 100.7,
    impulseAvgQuoteVolume: 10_000,
    atrAtDetection: 1,
    invalidationLevel: 99.75,
    setupScore: 8,
    setupType: 'FAST_BREAKOUT',
    retested: true,
    retestLow: 99.8,
    retestBarClose: now - 3 * 60_000,
    retestType: 'STANDARD',
    candidateLow: 99.8,
    belowInvalidationBars: 0,
    beyondWaveRetraceBars: 0,
    reclaimed: true,
    reclaimBarClose: now - 60_000,
    reclaimClose: 100.2,
    reclaimLow: 99.9,
    executionWaitUntil: now + 3 * 60_000,
    barsObserved: 5,
    detectedRisk: { score: 0, reasons: [] },
  });

  // During the window the reclaim completes but must NOT fire and NOT reject.
  const held = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(held.action, 'EVENT_GUARD');
  assert.match(held.reason, /event window: CPI/);
  assert.equal(engine.gateCounts.EVENT_GUARD_HOLD, 1);
  assert.equal(created.length, 0, 'no trade created during the window');
  assert.equal(engine.metrics.signaled, 0);
  assert.equal(engine.metrics.rejected, 0);
  assert.equal(engine.candidates.has('ETHUSDT'), true, 'candidate stays in the map');
  assert.equal(engine.candidates.get('ETHUSDT').reclaimed, true);

  // After the window the still-valid candidate FIREs normally.
  clock.t = GUARD_EVENT_TIME + 20 * 60_000;
  const fired = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(fired.action, 'SIGNAL');
  assert.equal(created.length, 1);
  assert.equal(engine.metrics.signaled, 1);
  assert.equal(engine.candidates.has('ETHUSDT'), false);
});

const healthyGuardContext = () => ({
  risk: { hardBlock: false, terminalRisk: false, entryBlocked: false, score: 0, reasons: [] },
  oi: { changePct: 0.4 },
  depth: {
    estimatedBuyPrice: 100.2,
    bestAsk: 100.21,
    spreadBps: 4,
    bidNotional05: 300_000,
    askNotional05: 250_000,
    imbalance: 1.0,
    entryImpactBps: null,
    bidRetention: null,
    spreadExpansion: null,
  },
});

const guardFreezeCfg = {
  maxEntrySlippageBps: 8,
  takerFeeBps: 5,
  exitSlippageBps: 3,
  maxSpreadBps: 10,
  minDepthEachSideUsd: 100_000,
  minNetRR: 1.35,
  futuresCandidateTtlMin: 24,
  minStopPctFloor: 0.12,
  maxStopPct: 1.60,
};

test('event guard FREEZE: bars advancing ≥4 during the window never reject the held candidate; it FIREs after', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 }; // inside the pre-window
  const created = [];
  // Anchor the mock bar clock in the past so every "advanced" bar is a closed
  // candle (closedCandles drops bars whose closeTime is in the future).
  const t0 = Date.now() - 10 * 60_000;
  const bars = { lastClose: t0 - 60_000 }; // mutable mock bar clock, no real timers
  const engine = new Engine({
    cfg: { ...guardFreezeCfg },
    binance: { klines: async () => flatKlines(90, bars.lastClose) },
    store: {
      insertEvent: async () => true,
      riskSnapshot: async () => ({ allowed: true, reasons: [] }),
      symbolCooldown: async () => ({ blocked: false }),
      createTrade: async trade => { created.push(trade); return { created: true, trade: { id: 7, ...trade } }; },
      updateTrade: async () => true,
    },
    telegram: { send: async () => {}, signalMessage: () => 'SIG' },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  engine.context = async () => healthyGuardContext();
  const candidate = {
    symbol: 'ETHUSDT',
    state: 'RECLAIMED_WAIT_BOOK',
    detectedBarClose: t0 - 6 * 60_000,
    expiresBarClose: t0 + 24 * 60_000,
    breakoutLevel: 100.2,
    structureLevel: 100.2,
    impulseLow: 98,
    impulseWaveAtArm: 10,
    peakPrice: 100.7,
    impulseAvgQuoteVolume: 10_000,
    atrAtDetection: 1,
    invalidationLevel: 99.75,
    setupScore: 8,
    setupType: 'FAST_BREAKOUT',
    retested: true,
    retestLow: 99.8,
    retestBarClose: t0 - 3 * 60_000,
    retestType: 'STANDARD',
    candidateLow: 99.8,
    belowInvalidationBars: 0,
    beyondWaveRetraceBars: 0,
    reclaimed: true,
    reclaimBarClose: t0 - 60_000,
    reclaimClose: 100.2,
    reclaimLow: 99.9,
    // Execution wait anchored at reclaim time (as the strategy computes it).
    // The window below ends with the wait still open, so a correctly frozen
    // candidate FIREs on resume. (Pre-fix, advanceCandidate kept running under
    // the guard and the advancing bars walked last.closeTime past the wait —
    // see the companion default-wait test, which rejects at exactly bar 4.)
    executionWaitUntil: t0 + 10 * 60_000,
    barsObserved: 5,
    detectedRisk: { score: 0, reasons: [] },
  };
  engine.candidates.set('ETHUSDT', candidate);

  // Five new bars elapse while the guard is ACTIVE (≥4: the pre-fix mass-reject
  // point). The candidate must be frozen: no reject, no FIRE, fields untouched,
  // lastBarSeen NOT advanced.
  for (let bar = 1; bar <= 5; bar++) {
    bars.lastClose += 60_000;
    const held = await engine.scanSymbol({ symbol: 'ETHUSDT' });
    assert.equal(held.action, 'EVENT_GUARD', `bar ${bar}: frozen, not advanced`);
    assert.match(held.reason, /event window: CPI/);
    assert.equal(engine.metrics.rejected, 0, `bar ${bar}: no mid-window reject`);
    assert.equal(created.length, 0, `bar ${bar}: no FIRE inside the window`);
    assert.equal(engine.candidates.has('ETHUSDT'), true, `bar ${bar}: candidate not deleted`);
  }
  assert.equal(engine.gateCounts.EVENT_GUARD_HOLD, 5);
  assert.deepEqual(engine.candidates.get('ETHUSDT'), candidate, 'candidate fields untouched during the window');
  assert.equal(engine.lastBarSeen.has('ETHUSDT'), false, 'lastBarSeen stays frozen while the candidate is frozen');

  // The window ends: the still-valid candidate resumes and FIREs normally.
  clock.t = GUARD_EVENT_TIME + 20 * 60_000;
  bars.lastClose += 60_000;
  const fired = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(fired.action, 'SIGNAL');
  assert.equal(created.length, 1);
  assert.equal(engine.metrics.signaled, 1);
  assert.equal(engine.candidates.has('ETHUSDT'), false);
});

test('event guard freeze with the default 3-bar execution wait: strategy expiry applies only AFTER the window', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 };
  const created = [];
  const t0 = Date.now() - 10 * 60_000; // past anchor: every advanced bar is a closed candle
  const bars = { lastClose: t0 - 60_000 };
  const engine = new Engine({
    cfg: { ...guardFreezeCfg },
    binance: { klines: async () => flatKlines(90, bars.lastClose) },
    store: {
      insertEvent: async () => true,
      riskSnapshot: async () => ({ allowed: true, reasons: [] }),
      symbolCooldown: async () => ({ blocked: false }),
      createTrade: async trade => { created.push(trade); return { created: true, trade: { id: 7, ...trade } }; },
      updateTrade: async () => true,
    },
    telegram: { send: async () => {}, signalMessage: () => 'SIG' },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  engine.context = async () => healthyGuardContext();
  engine.candidates.set('ETHUSDT', {
    symbol: 'ETHUSDT',
    state: 'RECLAIMED_WAIT_BOOK',
    detectedBarClose: t0 - 6 * 60_000,
    expiresBarClose: t0 + 24 * 60_000,
    breakoutLevel: 100.2,
    structureLevel: 100.2,
    impulseLow: 98,
    impulseWaveAtArm: 10,
    peakPrice: 100.7,
    impulseAvgQuoteVolume: 10_000,
    atrAtDetection: 1,
    invalidationLevel: 99.75,
    setupScore: 8,
    setupType: 'FAST_BREAKOUT',
    retested: true,
    retestLow: 99.8,
    retestBarClose: t0 - 3 * 60_000,
    retestType: 'STANDARD',
    candidateLow: 99.8,
    belowInvalidationBars: 0,
    beyondWaveRetraceBars: 0,
    reclaimed: true,
    reclaimBarClose: t0 - 60_000,
    reclaimClose: 100.2,
    reclaimLow: 99.9,
    executionWaitUntil: null, // strategy default: reclaimBarClose + 3 bars
    barsObserved: 5,
    detectedRisk: { score: 0, reasons: [] },
  });

  // The 4th advancing bar is exactly where the unguarded lifecycle used to
  // reject ('execution book did not recover'). Under the freeze nothing rejects.
  for (let bar = 1; bar <= 4; bar++) {
    bars.lastClose += 60_000;
    const held = await engine.scanSymbol({ symbol: 'ETHUSDT' });
    assert.equal(held.action, 'EVENT_GUARD');
    assert.equal(engine.metrics.rejected, 0, `bar ${bar}: the guard itself never rejects`);
    assert.equal(engine.candidates.has('ETHUSDT'), true);
  }

  // After the window the candidate simply resumes normal strategy evaluation —
  // here the genuinely lapsed execution wait is the strategy's own rejection,
  // not a guard artifact.
  clock.t = GUARD_EVENT_TIME + 20 * 60_000;
  const resumed = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(resumed.action, 'REJECT');
  assert.match(resumed.reason, /execution book did not recover/);
  assert.equal(engine.candidates.has('ETHUSDT'), false);
  assert.equal(created.length, 0);
});

test('event guard freeze never gates terminal manipulation risk on a held candidate', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 };
  const t0 = Date.now();
  const engine = new Engine({
    cfg: { ...guardFreezeCfg },
    binance: { klines: async () => flatKlines(90, t0 - 60_000) },
    store: { insertEvent: async () => true },
    telegram: { send: async () => {} },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  engine.context = async () => ({
    ...healthyGuardContext(),
    risk: { hardBlock: true, terminalRisk: true, entryBlocked: true, score: 9, reasons: ['wash trading burst'] },
  });
  engine.candidates.set('ETHUSDT', {
    symbol: 'ETHUSDT',
    state: 'ARMED',
    detectedBarClose: t0 - 6 * 60_000,
    expiresBarClose: t0 + 24 * 60_000,
    breakoutLevel: 100.2,
    detectedRisk: { score: 0, reasons: [] },
  });

  const decision = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(decision.action, 'REJECT', 'terminal risk erases the setup even inside the window');
  assert.match(decision.reason, /manipulation risk: wash trading burst/);
  assert.equal(engine.candidates.has('ETHUSDT'), false);
  assert.equal(engine.metrics.rejected, 1);
});

const makeScanEngine = ({ insertThrows = false } = {}) => {
  const messages = [];
  const events = [];
  const seen = new Set();
  const alphaCalls = [];
  const state = { openTradeChecks: 0 };
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 };
  const engine = new Engine({
    cfg: { universeRefreshMs: 300_000, scanConcurrency: 2, eventGuardPreMin: 30, eventGuardPostMin: 15 },
    binance: { btcRegime: async () => ({ regime: 'TREND_UP', allowed: true }) },
    store: {
      insertEvent: async event => {
        if (insertThrows) throw new Error('db down');
        events.push(event);
        if (seen.has(event.event_key)) return false;
        seen.add(event.event_key);
        return true;
      },
      riskSnapshot: async () => ({ allowed: true, reasons: [] }),
      listOpenTrades: async () => { state.openTradeChecks++; return []; },
      pendingTradeOutcomeAlerts: async () => [],
    },
    telegram: { send: async m => { messages.push(m); } },
    alpha: { scan: async opts => { alphaCalls.push(opts ?? null); } },
    eventGuard: makeEventGuard(clock),
  });
  engine.lastUniverseRefresh = Date.now(); // skip the universe refresh in scanOnce
  return { engine, messages, events, alphaCalls, clock, state };
};

test('scanOnce sends the enter/exit guard lifecycle exactly once each, keeps monitoring, monitor-only alpha', async () => {
  const { engine, messages, events, alphaCalls, clock, state } = makeScanEngine();

  // ENTERING the window: one warning, deduped via nexio_events.
  await engine.scanOnce();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[GUARD\] HIGH-IMPACT EVENT WINDOW/);
  assert.match(messages[0], /CPI/);
  assert.match(messages[0], /in 10 min/);
  assert.match(messages[0], /−30m\/\+15m/);
  assert.match(messages[0], /New entries & radar alerts paused; open trades still monitored/);
  assert.equal(events[0].event_key, `event-guard:${new Date(GUARD_EVENT_TIME).toISOString()}:enter`);
  assert.equal(events[0].event_type, 'EVENT_GUARD');
  assert.deepEqual(alphaCalls[0], { monitorOnly: true }, 'alpha runs monitor-only during the window');
  assert.equal(state.openTradeChecks, 1, 'open-trade monitoring still runs');

  // Same window again: the dedup hit (insertEvent → false) suppresses the resend.
  await engine.scanOnce();
  assert.equal(messages.length, 1);
  assert.equal(state.openTradeChecks, 2);

  // EXITING the window: one all-clear, normal alpha scanning resumes.
  clock.t = GUARD_EVENT_TIME + 20 * 60_000;
  await engine.scanOnce();
  assert.equal(messages.length, 2);
  assert.match(messages[1], /\[GUARD\] EVENT WINDOW CLEAR/);
  assert.match(messages[1], /CPI/);
  assert.equal(events.at(-1).event_key, `event-guard:${new Date(GUARD_EVENT_TIME).toISOString()}:exit`);
  assert.deepEqual(alphaCalls.at(-1), {});
  assert.equal(state.openTradeChecks, 3);

  // Still clear: nothing more is sent.
  await engine.scanOnce();
  assert.equal(messages.length, 2);
});

test('guard lifecycle message is still sent when the dedup insert fails', async () => {
  const { engine, messages } = makeScanEngine({ insertThrows: true });
  await engine.scanOnce();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[GUARD\] HIGH-IMPACT EVENT WINDOW/);
});

test('overlapping windows: A→B switch sends no false all-clear; all-clear only when the last window ends', async () => {
  const A_TIME = GUARD_EVENT_TIME; // 2026-08-13T12:30:00Z
  const B_TIME = GUARD_EVENT_TIME + 20 * 60_000; // 12:50 — B's window overlaps A's tail
  const aIso = new Date(A_TIME).toISOString();
  const bIso = new Date(B_TIME).toISOString();
  const clock = { t: A_TIME - 20 * 60_000 }; // 12:10: inside A's window, before B's opens (12:20)
  const messages = [];
  const events = [];
  const seen = new Set();
  const store = {
    insertEvent: async event => {
      events.push(event);
      if (seen.has(event.event_key)) return false;
      seen.add(event.event_key);
      return true;
    },
    riskSnapshot: async () => ({ allowed: true, reasons: [] }),
    listOpenTrades: async () => [],
    pendingTradeOutcomeAlerts: async () => [],
  };
  const guard = new EventGuard({
    cfg: {
      enableEventGuard: true,
      eventGuardPreMin: 30,
      eventGuardPostMin: 15,
      eventGuardManual: `${aIso}=CPI, ${bIso}=FOMC`,
    },
    calendar: null,
    now: () => clock.t,
  });
  const makeEngine = () => {
    const engine = new Engine({
      cfg: { universeRefreshMs: 300_000, scanConcurrency: 2, eventGuardPreMin: 30, eventGuardPostMin: 15 },
      binance: { btcRegime: async () => ({ regime: 'TREND_UP', allowed: true }) },
      store,
      telegram: { send: async m => { messages.push(m); } },
      eventGuard: guard,
    });
    engine.lastUniverseRefresh = Date.now();
    return engine;
  };
  const engine = makeEngine();

  // ENTER A's window: the normal enter warning.
  await engine.scanOnce();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[GUARD\] HIGH-IMPACT EVENT WINDOW/);
  assert.match(messages[0], /CPI/);

  // A→B flip: at 12:42 both windows are active and B is nearer — the guard
  // switches events WITHOUT an all-clear; a single "continues" message goes
  // out, deduped through B's enter key.
  clock.t = A_TIME + 12 * 60_000;
  await engine.scanOnce();
  assert.equal(messages.length, 2);
  assert.match(messages[1], /EVENT GUARD continues — now guarding <b>FOMC<\/b>/);
  assert.match(messages[1], /window unchanged; entries still blocked/);
  assert.ok(!messages.some(m => m.includes('EVENT WINDOW CLEAR')), 'no all-clear while still guarded');
  assert.ok(events.some(e => e.event_key === `event-guard:${bIso}:enter`), "the switch reserves B's enter key");
  assert.ok(!events.some(e => e.event_key === `event-guard:${aIso}:exit`), 'no exit event for A on the switch');

  // Same B window again: nothing resent.
  await engine.scanOnce();
  assert.equal(messages.length, 2);

  // Simulated restart mid-B-window (fresh in-memory edge state, same store):
  // the dedup hit on B's enter key suppresses a resend of the switch message.
  const restarted = makeEngine();
  await restarted.scanOnce();
  assert.equal(messages.length, 2, 'restart mid-window does not resend the switch message');

  // When the LAST window ends the all-clear is sent exactly once (on the
  // instance that observed the window — the restarted one never saw it).
  clock.t = B_TIME + 16 * 60_000; // 13:06, past B's post boundary (13:05)
  await engine.scanOnce();
  assert.equal(messages.length, 3);
  assert.match(messages[2], /\[GUARD\] EVENT WINDOW CLEAR/);
  assert.match(messages[2], /FOMC/);
  assert.ok(events.some(e => e.event_key === `event-guard:${bIso}:exit`));
  assert.ok(!events.some(e => e.event_key === `event-guard:${aIso}:exit`), 'A never emitted an exit/all-clear');
});

test('/status and /why show the event guard line and the next event', async () => {
  const clock = { t: GUARD_EVENT_TIME - 10 * 60_000 };
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', btcBlockHeartbeatMin: 0 },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }),
      insertEvent: async () => true,
    },
    telegram: { send: async m => { messages.push(m); } },
    eventGuard: makeEventGuard(clock),
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };

  await engine.command({ chat: { id: '1' }, text: '/status' });
  assert.match(messages[0], /⏳ GUARD: CPI in 10m/);

  await engine.command({ chat: { id: '1' }, text: '/why' });
  assert.match(messages[1], /⏳ GUARD: CPI in 10m/);
  assert.match(messages[1], /next: CPI at 2026-08-13 12:30 UTC/);

  // Clear window ⇒ the clear line; no guard configured ⇒ disabled line.
  clock.t = GUARD_EVENT_TIME + 60 * 60_000;
  await engine.command({ chat: { id: '1' }, text: '/status' });
  assert.match(messages[2], /Event guard: clear ✅/);
  const unguarded = new Engine({
    cfg: { ownerChatId: '1' },
    binance: {},
    store: { riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }) },
    telegram: { send: async m => { messages.push(m); } },
  });
  unguarded.btc = { regime: 'TREND_UP', allowed: true };
  await unguarded.command({ chat: { id: '1' }, text: '/status' });
  assert.match(messages[3], /Event guard: disabled/);
});

// ── v6.9.6 BTC bias bundling + opt-in hard gate ─────────────────────────────

const v696Cfg = {
  maxEntrySlippageBps: 8,
  takerFeeBps: 5,
  exitSlippageBps: 3,
  maxSpreadBps: 10,
  minDepthEachSideUsd: 100_000,
  minNetRR: 1.35,
  futuresCandidateTtlMin: 24,
  minStopPctFloor: 0.12,
  maxStopPct: 1.60,
};

const v696Context = () => ({
  risk: { hardBlock: false, terminalRisk: false, entryBlocked: false, score: 0, reasons: [] },
  oi: { changePct: 0.4 },
  depth: {
    estimatedBuyPrice: 100.2,
    bestAsk: 100.21,
    spreadBps: 4,
    bidNotional05: 300_000,
    askNotional05: 250_000,
    imbalance: 1.0,
    entryImpactBps: null,
    bidRetention: null,
    spreadExpansion: null,
  },
});

const v696ReclaimedCandidate = now => ({
  symbol: 'ETHUSDT',
  state: 'RECLAIMED_WAIT_BOOK',
  detectedBarClose: now - 6 * 60_000,
  expiresBarClose: now + 24 * 60_000,
  breakoutLevel: 100.2,
  structureLevel: 100.2,
  impulseLow: 98,
  impulseWaveAtArm: 10,
  peakPrice: 100.7,
  impulseAvgQuoteVolume: 10_000,
  atrAtDetection: 1,
  invalidationLevel: 99.75,
  setupScore: 8,
  setupType: 'FAST_BREAKOUT',
  retested: true,
  retestLow: 99.8,
  retestBarClose: now - 3 * 60_000,
  retestType: 'STANDARD',
  candidateLow: 99.8,
  belowInvalidationBars: 0,
  beyondWaveRetraceBars: 0,
  reclaimed: true,
  reclaimBarClose: now - 60_000,
  reclaimClose: 100.2,
  reclaimLow: 99.9,
  executionWaitUntil: now + 3 * 60_000,
  barsObserved: 5,
  detectedRisk: { score: 0, reasons: [] },
});

const v696FireEngine = ({ btcBias = null, cfg = {} } = {}) => {
  const messages = [];
  const engine = new Engine({
    cfg: { ...v696Cfg, ...cfg },
    binance: { klines: async () => flatKlines(90, Date.now() - 60_000) },
    store: {
      insertEvent: async () => true,
      riskSnapshot: async () => ({ allowed: true, reasons: [] }),
      symbolCooldown: async () => ({ blocked: false }),
      createTrade: async trade => ({ created: true, trade: { id: 7, ...trade } }),
      updateTrade: async () => true,
    },
    telegram: { send: async m => { messages.push(m); }, signalMessage: () => 'SIG' },
    btcBias,
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  engine.context = async () => v696Context();
  return { engine, messages };
};

test('FIRE alert carries the BTC bias tag when a bias engine is injected', async () => {
  const btcBias = {
    btcTag: () => '₿ BTC 15m: <b>DOWN</b> (62%) · 30m: DOWN · ⚠️ against this long',
    blocksLongs: () => false,
  };
  const { engine, messages } = v696FireEngine({ btcBias });
  engine.candidates.set('ETHUSDT', v696ReclaimedCandidate(Date.now()));
  const fired = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(fired.action, 'SIGNAL');
  assert.match(messages[0], /^SIG\n₿ BTC 15m: <b>DOWN<\/b> \(62%\) · 30m: DOWN · ⚠️ against this long$/);
});

test('FIRE alert is unchanged with a null bias or the tag disabled', async () => {
  const { engine, messages } = v696FireEngine({ btcBias: null });
  engine.candidates.set('ETHUSDT', v696ReclaimedCandidate(Date.now()));
  assert.equal((await engine.scanSymbol({ symbol: 'ETHUSDT' })).action, 'SIGNAL');
  assert.equal(messages[0], 'SIG');

  const btcBias = { btcTag: () => '₿ BTC 15m: <b>UP</b> (70%)', blocksLongs: () => false };
  const off = v696FireEngine({ btcBias, cfg: { enableBtcBiasTag: false } });
  off.engine.candidates.set('ETHUSDT', v696ReclaimedCandidate(Date.now()));
  assert.equal((await off.engine.scanSymbol({ symbol: 'ETHUSDT' })).action, 'SIGNAL');
  assert.equal(off.messages[0], 'SIG');
});

test('BTC_BIAS_BLOCK_LONGS gate refuses NEW arms only while the bias blocks longs', async () => {
  let blocking = true;
  const btcBias = { btcTag: () => null, blocksLongs: () => blocking };
  const engine = new Engine({
    cfg: {},
    binance: { klines: async () => flatKlines() },
    store: { insertEvent: async () => true },
    telegram: { send: async () => {} },
    btcBias,
  });
  engine.btc = { regime: 'TREND_UP', allowed: true };
  let contextCalls = 0;
  engine.context = async () => { contextCalls++; return v696Context(); };

  const blocked = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(blocked.action, 'NONE');
  assert.equal(engine.gateCounts.BTC_BIAS_BLOCK, 1);
  assert.equal(engine.candidates.size, 0);
  assert.equal(contextCalls, 0, 'the bias gate refuses the arm before any context burn');

  // When the bias stops blocking, the same symbol flows to the normal gates.
  blocking = false;
  await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.equal(engine.gateCounts.BTC_BIAS_BLOCK, 1);

  // An EXISTING candidate is never gated by the bias (in-flight protection).
  blocking = true;
  engine.candidates.set('ETHUSDT', { symbol: 'ETHUSDT', state: 'ARMED' });
  const held = await engine.scanSymbol({ symbol: 'ETHUSDT' });
  assert.notEqual(held.action, 'NONE');
  assert.equal(engine.candidates.has('ETHUSDT'), true, 'in-flight candidate survives the bias gate');
});

test('/btc reports the full bias breakdown and /status carries one bias line', async () => {
  const snapshot = {
    at: 1_700_000_000_000,
    price: 97_654.32,
    h15: { score: -52, label: 'DOWN', confidence: 71, drivers: ['taker sells 61%', 'ask wall 12bps above'] },
    h30: { score: -38, label: 'DOWN', confidence: 60, drivers: ['EMA21 slope -0.10%'] },
    components: {},
    book: { imbalanceTop10: -0.2, bidWallBps: null, askWallBps: 12, bidWallX: null, askWallX: 4.1 },
    stale: false,
  };
  const btcBias = {
    lastSnapshot: snapshot,
    evaluate: () => snapshot,
    outcomes: { h15: { hits: 26, total: 41 }, h30: { hits: 22, total: 38 } },
    btcTag: () => '₿ BTC 15m: <b>DOWN</b> (71%)',
    blocksLongs: () => false,
  };
  const btcFeed = { health: () => ({ connected: true, stale: false, closes: 240, warmed: true }) };
  const btcRecorder = { health: () => ({ enabled: true, disabled: false, inserted: 144 }) };
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', maxTradesPerDay: 3 },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }),
    },
    telegram: { send: async m => { messages.push(m); } },
    btcBias,
    btcFeed,
    btcRecorder,
  });
  await engine.command({ chat: { id: '1' }, text: '/btc' });
  const report = messages[0];
  assert.match(report, /BTC BIAS — 15m\/30m gauge/);
  assert.match(report, /Price: \$97,654\.32/);
  assert.match(report, /<b>15m: DOWN<\/b> \(score −52, conf 71%\)/);
  assert.match(report, /▸ taker sells 61%/);
  assert.match(report, /ask wall 12bps above \(4\.1× median\)/);
  assert.match(report, /Hit rates: 15m: 63% \(n=41\) · 30m: 58% \(n=38\)/);
  assert.match(report, /Feed: ✅ live · 240 closes · warmed ✅/);
  assert.match(report, /Recorder: ✅ 144 rows/);
  assert.match(report, /not a standalone trade signal/);

  await engine.command({ chat: { id: '1' }, text: '/status' });
  assert.match(messages[1], /BTC bias 15m: DOWN \(−52, conf 71%\) · 30m: DOWN \(−38\) · recorder ✅ 144/);
});

test('/status shows a disabled bias line when no bias engine is wired', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', maxTradesPerDay: 3 },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }),
    },
    telegram: { send: async m => { messages.push(m); } },
  });
  await engine.command({ chat: { id: '1' }, text: '/status' });
  assert.match(messages[0], /BTC bias: disabled/);
  await engine.command({ chat: { id: '1' }, text: '/btc' });
  assert.match(messages[1], /BTC bias engine is disabled/);
});

test('/why surfaces the BTC bias gate while it is blocking new arms', async () => {
  const messages = [];
  const engine = new Engine({
    cfg: { ownerChatId: '1', maxTradesPerDay: 3, btcBiasBlockLongs: true },
    binance: {},
    store: {
      riskSnapshot: async () => ({ allowed: true, reasons: [], openTrades: 0, tradesToday: 0, dailyPnlPct: 0, weeklyPnlPct: 0 }),
      futuresGateSummaries: async () => [],
    },
    telegram: { send: async m => { messages.push(m); } },
    btcBias: { blocksLongs: () => true, btcTag: () => null },
  });
  engine.countGate('BTC_BIAS_BLOCK');
  engine.countGate('BTC_BIAS_BLOCK');
  await engine.command({ chat: { id: '1' }, text: '/why' });
  assert.match(messages[0], /BTC bias gate ACTIVE: 15m STRONG_DOWN — new arms\/seeds blocked \(2× BTC_BIAS_BLOCK\)/);
});
