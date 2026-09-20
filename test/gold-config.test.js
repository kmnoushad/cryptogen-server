import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGoldConfig } from '../src/gold/config.js';

const base = {
  GOLD_TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  GOLD_TELEGRAM_CHAT_ID: '-1001234567890',
  GOLD_MODE: 'paper',
  LIVE_TRADING_ENABLED: 'false',
  MT5_TRADING_ENABLED: 'false',
};

test('paper-only configuration loads with safe defaults', () => {
  const config = loadGoldConfig(base);
  assert.equal(config.mode, 'paper');
  assert.equal(config.paperStartBalance, 100);
  assert.equal(config.paperAutoEntries, false);
  assert.equal(config.liveTradingEnabled, false);
});

test('live trading flag is a hard startup failure', () => {
  assert.throws(() => loadGoldConfig({ ...base, LIVE_TRADING_ENABLED: 'true' }), /safety lock/i);
});

test('MT5 flag is a hard startup failure', () => {
  assert.throws(() => loadGoldConfig({ ...base, MT5_TRADING_ENABLED: 'true' }), /safety lock/i);
});

test('non-paper mode is a hard startup failure', () => {
  assert.throws(() => loadGoldConfig({ ...base, GOLD_MODE: 'live' }), /safety lock/i);
});

