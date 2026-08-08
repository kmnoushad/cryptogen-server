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

test('v6.4 Futures coverage defaults remain bounded', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.maxUniverse, 60);
  assert.equal(cfg.futuresCandidateTtlMin, 24);
  assert.equal(cfg.universeMomentumSlotsPct, 30);
  assert.equal(cfg.minStopPctFloor, 0.12);
  assert.equal(cfg.maxStopPct, 1.60);
});
