import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../src/telegram.js';

const telegram = new Telegram({ botToken: 'test', ownerChatId: '1', paperMode: true });

test('Futures FIRE keeps the visual entry, stop, target and setup score UI', () => {
  const message = telegram.signalMessage({
    symbol: 'TESTUSDT', entry: 1, initial_sl: 0.99, tp1: 1.02, tp2: 1.04,
    setup_score: 8,
    setup: {
      entryMin: 0.999, entryMax: 1.001, entryExpiresAt: Date.parse('2026-09-10T12:00:30Z'),
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
  assert.match(message, /Setup score/);
  assert.match(message, /Close 100% at TP1/);
  assert.doesNotMatch(message, /TP2:/);
  assert.match(message, /Entry zone:/);
  assert.match(message, /Entry expires: 16:00:30 GST/);
  assert.match(message, /Skip if expired/);
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

test('stop update tells manual traders how to handle a level already crossed', () => {
  const message = telegram.stopUpdateMessage({ symbol: 'TESTUSDT', active_sl: 1.0013 });
  assert.match(message, /STOP UPDATE/);
  assert.match(message, /already at\/below/);
  assert.match(message, /never lower/);
  assert.match(message, /your actual result may differ/);
});
