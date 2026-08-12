import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  BOT_TOKEN: 'x', OWNER_CHAT_ID: '1', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'y',
};

test('Alpha entry mode defaults to guarded GoPlus screening', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.enableAlphaSignals, true);
  assert.equal(cfg.onchainRiskApiUrl, 'https://api.gopluslabs.io');
  assert.equal(cfg.alphaMaxPossibleRugScore, 2);
});

test('paper mode is the default', () => {
  assert.equal(loadConfig(base).paperMode, true);
});

test('economic calendar is optional, enabled by default, and does not require a key to start', () => {
  const withoutKey = loadConfig(base);
  assert.equal(withoutKey.enableEconomicCalendar, true);
  assert.equal(withoutKey.finnhubKey, '');
  const withKey = loadConfig({ ...base, FINNHUB_KEY: 'calendar-key' });
  assert.equal(withKey.finnhubKey, 'calendar-key');
});

test('v6.9 Futures execution and realtime-shock defaults remain bounded', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.maxUniverse, 60);
  assert.equal(cfg.futuresCandidateTtlMin, 24);
  assert.equal(cfg.universeMomentumSlotsPct, 30);
  assert.equal(cfg.btcEma50RetestBufferPct, 0.35);
  assert.equal(cfg.btcMinEma50Slope6hPct, -0.05);
  assert.equal(cfg.minStopPctFloor, 0.12);
  assert.equal(cfg.maxStopPct, 1.60);
  assert.equal(cfg.assumedOrderNotionalUsd, 1_000);
  assert.equal(cfg.minEntryDepthImbalance, 0.60);
  assert.equal(cfg.minDepthEachSideUsd, 50_000);
  assert.equal(cfg.minBidDepthRetention, 0.65);
  assert.equal(cfg.enableRealtimeShock, true);
  assert.equal(cfg.realtimeShockDropPct, 0.35);
  assert.equal(cfg.realtimeShockWindowMs, 10_000);
});

test('v6.9 reclaim flow thresholds default sanely and stay in range', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.futuresReclaimMinBuyRatio, 0.55);
  assert.equal(cfg.futuresReclaimMinDeltaRatio, 0.10);
  const tuned = loadConfig({
    ...base,
    FUTURES_RECLAIM_MIN_BUY_RATIO: '0.62',
    FUTURES_RECLAIM_MIN_DELTA_RATIO: '0.2',
    MIN_ENTRY_DEPTH_IMBALANCE: '0.45',
  });
  assert.equal(tuned.futuresReclaimMinBuyRatio, 0.62);
  assert.equal(tuned.futuresReclaimMinDeltaRatio, 0.2);
  assert.equal(tuned.minEntryDepthImbalance, 0.45);
  assert.throws(() => loadConfig({ ...base, FUTURES_RECLAIM_MIN_BUY_RATIO: '0.49' }), /FUTURES_RECLAIM_MIN_BUY_RATIO/);
  assert.throws(() => loadConfig({ ...base, FUTURES_RECLAIM_MIN_DELTA_RATIO: '0.31' }), /FUTURES_RECLAIM_MIN_DELTA_RATIO/);
  assert.throws(() => loadConfig({ ...base, MIN_ENTRY_DEPTH_IMBALANCE: '0.39' }), /MIN_ENTRY_DEPTH_IMBALANCE/);
});

test('v6.9 BTC-block heartbeat and fast-mover defaults', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.btcBlockHeartbeatMin, 120);
  assert.equal(cfg.enableFastMoverAlerts, true);
  assert.equal(cfg.fastMoverMin1mPct, 0.8);
  assert.equal(cfg.fastMoverMin3mPct, 1.5);
  assert.equal(cfg.fastMoverVolumeAccel, 3.0);
  assert.equal(cfg.fastMoverMinQuoteUsd, 10_000_000);
  assert.equal(cfg.fastMoverCooldownMin, 30);
  assert.equal(cfg.fastMoverMaxAlertsPerHour, 6);
  assert.equal(cfg.fastMoverMaxSpreadBps, 30);
  assert.equal(loadConfig({ ...base, BTC_BLOCK_HEARTBEAT_MIN: '0' }).btcBlockHeartbeatMin, 0);
  assert.equal(loadConfig({ ...base, ENABLE_FAST_MOVER_ALERTS: 'off' }).enableFastMoverAlerts, false);
  assert.throws(() => loadConfig({ ...base, BTC_BLOCK_HEARTBEAT_MIN: '-5' }), /BTC_BLOCK_HEARTBEAT_MIN/);
});
