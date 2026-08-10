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

test('v6.8.1 Futures execution and realtime-shock defaults remain bounded', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.maxUniverse, 60);
  assert.equal(cfg.futuresCandidateTtlMin, 24);
  assert.equal(cfg.universeMomentumSlotsPct, 30);
  assert.equal(cfg.btcEma50RetestBufferPct, 0.35);
  assert.equal(cfg.btcMinEma50Slope6hPct, -0.05);
  assert.equal(cfg.minStopPctFloor, 0.12);
  assert.equal(cfg.maxStopPct, 1.60);
  assert.equal(cfg.assumedOrderNotionalUsd, 1_000);
  assert.equal(cfg.minEntryDepthImbalance, 0.75);
  assert.equal(cfg.minBidDepthRetention, 0.65);
  assert.equal(cfg.enableRealtimeShock, true);
  assert.equal(cfg.realtimeShockDropPct, 0.35);
  assert.equal(cfg.realtimeShockWindowMs, 10_000);
});
