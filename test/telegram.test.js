import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../src/telegram.js';

const telegram = new Telegram({ botToken: 'test', ownerChatId: '1', paperMode: true });

test('Futures FIRE keeps the visual entry, stop, target and confidence UI', () => {
  const message = telegram.signalMessage({
    symbol: 'TESTUSDT', entry: 1, initial_sl: 0.99, tp1: 1.02, tp2: 1.04,
    setup_score: 8,
    setup: {
      setupType: 'STEADY_MOMENTUM', retestType: 'SHALLOW_CONSOLIDATION',
      buyRatio1: 0.62, oiChangePct: 0.4, bidDepthUsd: 250_000,
      askDepthUsd: 220_000, spreadBps: 3, netRR: 1.5, manipulationScore: 1,
    },
  }, { regime: 'BULLISH', oneHourReturn: 0.6 });
  assert.match(message, /\[FUTURES\] NEXIO FIRE/);
  assert.match(message, /STEADY MOMENTUM/);
  assert.match(message, /ENTRY:/);
  assert.match(message, /STOP:/);
  assert.match(message, /TP1:/);
  assert.match(message, /Confidence/);
});

test('Alpha IGNITION stays visually separate and includes guarded trade levels', () => {
  const message = telegram.alphaIgnitionMessage({
    symbol: 'TEST', chainName: 'Base', price: 1, liquidity: 400_000,
    volume24h: 800_000, holders: 2_000,
  }, { score: 8 }, { pricePct: 1.8, liquidityPct: 1 }, {
    rating: 'NO_CRITICAL_FLAGS', riskScore: 0, critical: [], warnings: [],
  });
  assert.match(message, /\[ALPHA\] IGNITION/);
  assert.match(message, /MANUAL ENTRY/);
  assert.match(message, /STOP:/);
  assert.match(message, /POSSIBLE RUG|Alpha remains high risk/);
});

test('outcome UI gives an explicit close instruction', () => {
  const message = telegram.outcomeMessage({
    symbol: 'TESTUSDT', exit_reason: 'MOMENTUM_FADE', outcome: 'WIN',
    net_pnl_pct: 0.4, r_multiple: 0.3, mfe_pct: 0.9, mae_pct: -0.1,
  });
  assert.match(message, /Momentum faded/);
  assert.match(message, /lock the remaining profit now/i);
});
