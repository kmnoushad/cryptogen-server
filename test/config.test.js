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
  assert.throws(() => loadConfig({ ...base, MIN_ENTRY_DEPTH_IMBALANCE: '0.39' }), /MIN_ENTRY_DEPTH_IMBALANCE/);
});

test('v6.9.2 invalid optional tuning vars warn and fall back instead of crashing boot', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    // The exact production failure: an out-of-range heartbeat must not kill startup.
    const crashed = { ...base, BTC_BLOCK_HEARTBEAT_MIN: '120000' };
    const cfg = loadConfig(crashed);
    assert.equal(cfg.btcBlockHeartbeatMin, 120);
    assert.ok(warnings.some(w => w.includes('BTC_BLOCK_HEARTBEAT_MIN')));
    // Every new v6.9 knob falls back to its safe default on garbage input.
    assert.equal(loadConfig({ ...base, FUTURES_RECLAIM_MIN_BUY_RATIO: '0.49' }).futuresReclaimMinBuyRatio, 0.55);
    assert.equal(loadConfig({ ...base, FUTURES_RECLAIM_MIN_DELTA_RATIO: '0.31' }).futuresReclaimMinDeltaRatio, 0.10);
    assert.equal(loadConfig({ ...base, BTC_BLOCK_HEARTBEAT_MIN: '-5' }).btcBlockHeartbeatMin, 120);
    assert.equal(loadConfig({ ...base, FAST_MOVER_MIN_1M_PCT: 'abc' }).fastMoverMin1mPct, 0.8);
    assert.equal(loadConfig({ ...base, FAST_MOVER_MIN_3M_PCT: '999' }).fastMoverMin3mPct, 1.5);
    assert.equal(loadConfig({ ...base, FAST_MOVER_VOLUME_ACCEL: '0' }).fastMoverVolumeAccel, 3.0);
    assert.equal(loadConfig({ ...base, FAST_MOVER_MIN_QUOTE_USD: '-1' }).fastMoverMinQuoteUsd, 10_000_000);
    assert.equal(loadConfig({ ...base, FAST_MOVER_COOLDOWN_MIN: '0' }).fastMoverCooldownMin, 30);
    assert.equal(loadConfig({ ...base, FAST_MOVER_MAX_ALERTS_PER_HOUR: '9999' }).fastMoverMaxAlertsPerHour, 6);
    assert.equal(loadConfig({ ...base, FAST_MOVER_MAX_SPREAD_BPS: '0' }).fastMoverMaxSpreadBps, 30);
    assert.equal(loadConfig({ ...base, ENABLE_FAST_MOVER_ALERTS: 'maybe' }).enableFastMoverAlerts, true);
    // Valid values still parse exactly.
    assert.equal(loadConfig({ ...base, FAST_MOVER_MIN_1M_PCT: '1.1' }).fastMoverMin1mPct, 1.1);
    assert.equal(loadConfig({ ...base, BTC_BLOCK_HEARTBEAT_MIN: '60' }).btcBlockHeartbeatMin, 60);
  } finally {
    console.warn = originalWarn;
  }
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
});

test('v6.9.3 Alpha fast-mover defaults', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.enableAlphaFastMover, true);
  assert.equal(cfg.alphaMoverPollMs, 90_000);
  assert.equal(cfg.alphaMoverMin10mPct, 3.0);
  assert.equal(cfg.alphaMoverMin30mPct, 6.0);
  assert.equal(cfg.alphaMoverMax24hChangePct, 60);
  assert.equal(cfg.alphaMoverCooldownMin, 60);
  assert.equal(cfg.alphaMoverMaxAlertsPerHour, 4);
  assert.equal(cfg.alphaMoverMaxRiskScore, 5);
  assert.equal(cfg.alphaMoverMinLiquidityUsd, 150_000);
  assert.equal(loadConfig({ ...base, ENABLE_ALPHA_FAST_MOVER: 'off' }).enableAlphaFastMover, false);
});

test('v6.9.3 Alpha fast-mover vars warn and fall back instead of throwing', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try {
    assert.equal(loadConfig({ ...base, ENABLE_ALPHA_FAST_MOVER: 'maybe' }).enableAlphaFastMover, true);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_POLL_MS: '10' }).alphaMoverPollMs, 90_000);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_POLL_MS: '99999999' }).alphaMoverPollMs, 90_000);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MIN_10M_PCT: 'abc' }).alphaMoverMin10mPct, 3.0);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MIN_30M_PCT: '0' }).alphaMoverMin30mPct, 6.0);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MAX_24H_CHANGE_PCT: '5' }).alphaMoverMax24hChangePct, 60);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_COOLDOWN_MIN: '1' }).alphaMoverCooldownMin, 60);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MAX_ALERTS_PER_HOUR: '99' }).alphaMoverMaxAlertsPerHour, 4);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MAX_RISK_SCORE: '-1' }).alphaMoverMaxRiskScore, 5);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MIN_LIQUIDITY_USD: '10' }).alphaMoverMinLiquidityUsd, 150_000);
    assert.ok(warnings.length >= 10);
    // Valid values still parse exactly.
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MIN_10M_PCT: '4.5' }).alphaMoverMin10mPct, 4.5);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_COOLDOWN_MIN: '120' }).alphaMoverCooldownMin, 120);
    assert.equal(loadConfig({ ...base, ALPHA_MOVER_MIN_LIQUIDITY_USD: '50000' }).alphaMoverMinLiquidityUsd, 50_000);
  } finally {
    console.warn = originalWarn;
  }
});

test('v6.9.4 Trending-mover (tier-2) defaults', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.enableTrendingMover, true);
  assert.equal(cfg.trendingMin15mPct, 2.0);
  assert.equal(cfg.trendingMin30mPct, 3.5);
  assert.equal(cfg.trendingMin60mPct, 5.0);
  assert.equal(cfg.trendingVolumeAccel, 2.0);
  assert.equal(cfg.trendingMinBuyRatio, 0.50);
  assert.equal(cfg.trendingMaxSpreadBps, 45);
  assert.equal(cfg.trendingCooldownMin, 120);
  assert.equal(cfg.trendingMaxAlertsPerHour, 4);
  assert.equal(loadConfig({ ...base, ENABLE_TRENDING_MOVER: 'off' }).enableTrendingMover, false);
  assert.equal(loadConfig({ ...base, TRENDING_MIN_15M_PCT: '3.2' }).trendingMin15mPct, 3.2);
  assert.equal(loadConfig({ ...base, TRENDING_COOLDOWN_MIN: '240' }).trendingCooldownMin, 240);
});

test('v6.9.4 Trending-mover vars warn and fall back instead of throwing', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(String(message));
  try {
    assert.equal(loadConfig({ ...base, ENABLE_TRENDING_MOVER: 'maybe' }).enableTrendingMover, true);
    assert.equal(loadConfig({ ...base, TRENDING_MIN_15M_PCT: '0.1' }).trendingMin15mPct, 2.0);
    assert.equal(loadConfig({ ...base, TRENDING_MIN_30M_PCT: 'abc' }).trendingMin30mPct, 3.5);
    assert.equal(loadConfig({ ...base, TRENDING_MIN_60M_PCT: '99' }).trendingMin60mPct, 5.0);
    assert.equal(loadConfig({ ...base, TRENDING_VOLUME_ACCEL: '0' }).trendingVolumeAccel, 2.0);
    assert.equal(loadConfig({ ...base, TRENDING_MIN_BUY_RATIO: '0.9' }).trendingMinBuyRatio, 0.50);
    assert.equal(loadConfig({ ...base, TRENDING_MAX_SPREAD_BPS: '1' }).trendingMaxSpreadBps, 45);
    assert.equal(loadConfig({ ...base, TRENDING_COOLDOWN_MIN: '5' }).trendingCooldownMin, 120);
    assert.equal(loadConfig({ ...base, TRENDING_MAX_ALERTS_PER_HOUR: '99' }).trendingMaxAlertsPerHour, 4);
    assert.ok(warnings.some(w => w.includes('ENABLE_TRENDING_MOVER')));
    assert.ok(warnings.some(w => w.includes('TRENDING_MIN_15M_PCT')));
    assert.ok(warnings.some(w => w.includes('TRENDING_MIN_BUY_RATIO')));
    assert.ok(warnings.some(w => w.includes('TRENDING_MAX_ALERTS_PER_HOUR')));
  } finally {
    console.warn = originalWarn;
  }
});
