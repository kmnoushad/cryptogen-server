import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrade } from '../src/trade-evaluator.js';

const cfg = {
  takerFeeBps: 5,
  exitSlippageBps: 3,
  breakevenAtR: 0.75,
  tradeTimeoutMin: 120,
};

const trade = {
  entry: 100,
  initial_sl: 99,
  active_sl: 99,
  tp1: 101.6,
  risk_per_unit: 1,
  entry_bar_close: 60_000,
  last_checked_bar_close: 60_000,
  breakeven_armed: false,
  mfe_pct: 0,
  mae_pct: 0,
  fee_bps: 5,
  created_at: new Date(0).toISOString(),
};

test('same one-minute candle touching TP and SL is scored stop-first', () => {
  const result = evaluateTrade(trade, [{
    openTime: 60_001, closeTime: 119_999, open: 100, high: 102, low: 98.5, close: 101,
  }], cfg);
  assert.equal(result.closed, true);
  assert.equal(result.patch.exit_reason, 'STOP');
  assert.equal(result.patch.outcome, 'LOSS');
});

test('breakeven is armed only after a completed bar and applies to a later bar', () => {
  const first = evaluateTrade(trade, [{
    openTime: 60_001, closeTime: 119_999, open: 100, high: 100.9, low: 99.5, close: 100.8,
  }], cfg);
  assert.equal(first.closed, false);
  assert.equal(first.patch.breakeven_armed, true);
  assert.ok(first.patch.active_sl > 100);

  const updatedTrade = { ...trade, ...first.patch };
  const second = evaluateTrade(updatedTrade, [{
    openTime: 120_000, closeTime: 179_999, open: 100.8, high: 101, low: 99.9, close: 100,
  }], cfg);
  assert.equal(second.closed, true);
  assert.equal(second.patch.exit_reason, 'BREAKEVEN_STOP');
  assert.equal(second.patch.outcome, 'SCRATCH');
});
