import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  BOT_TOKEN: 'x', OWNER_CHAT_ID: '1', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'y',
};

test('Alpha entry mode fails closed without an on-chain risk service', () => {
  assert.throws(() => loadConfig({ ...base, ENABLE_ALPHA_SIGNALS: 'true' }), /intentionally disabled/);
});

test('paper mode is the default', () => {
  assert.equal(loadConfig(base).paperMode, true);
});
