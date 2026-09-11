import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrade, closeTradeAtMarket, EXECUTION_MODEL } from '../src/trade-evaluator.js';

const t = Date.parse('2026-09-06T11:35:00Z');
const cfg = { exitSlippageBps: 3, takerFeeBps: 5, breakevenAtR: 0.75, tradeTimeoutMin: 120, fadeMinNetR: 0.1 };
const trade = (extra = {}) => ({ entry: 100, active_sl: 99, initial_sl: 99, tp1: 102,
  risk_per_unit: 1, fee_bps: 5, created_at: new Date(t + 10_000).toISOString(),
  entry_bar_close: t - 1, ...extra });
const bar = (offset, extra = {}) => ({ openTime: t + offset * 60_000,
  closeTime: t + (offset + 1) * 60_000 - 1, open: 100, high: 100.1, low: 99.9, close: 100, ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('ignores entirely pre-entry candles even when the signal bar is older', () => {
  const result = evaluateTrade(trade({ entry_bar_close: t - 180_000 }), [bar(-1, { low: 98, high: 103 })], cfg);
  assert.equal(result.patch, null);
});
test('partial entry candle does not reuse pre-entry stop or target extremes', () => {
  const result = evaluateTrade(trade(), [bar(0, { open: 98, low: 98, high: 103, close: 100.1 })], cfg);
  assert.equal(result.closed, false);
  near(result.patch.mfe_pct, 0.1);
  near(result.patch.mae_pct, 0);
});
test('partial entry candle still exits at an observed close below the stop', () => {
  const result = evaluateTrade(trade(), [bar(0, { open: 100, low: 98, high: 100, close: 98.5 })], cfg);
  assert.equal(result.patch.exit_reason, 'STOP');
  near(result.patch.exit_price, 98.5 * 0.9997);
});
test('entry on a candle boundary permits that entire candle', () => {
  const result = evaluateTrade(trade({ created_at: new Date(t).toISOString() }), [bar(0, { low: 98.9 })], cfg);
  assert.equal(result.patch.exit_reason, 'STOP');
});
test('full-bar stop wins when both stop and target touched; excursions end at exit', () => {
  const result = evaluateTrade(trade(), [bar(1, { low: 95, high: 104 })], cfg);
  assert.equal(result.patch.exit_reason, 'STOP');
  near(result.patch.exit_price, 99 * 0.9997);
  near(result.patch.mae_pct, -1);
  near(result.patch.mfe_pct, 0);
});
test('gap below stop fills at the opening price plus adverse slippage', () => {
  const result = evaluateTrade(trade(), [bar(1, { open: 98, high: 98.2, low: 97.8, close: 98.1 })], cfg);
  near(result.patch.exit_price, 98 * 0.9997);
  assert.ok(result.patch.exit_price < 98.2);
});
test('TP1 closes the entire paper trade and caps its recorded favorable excursion', () => {
  const result = evaluateTrade(trade(), [bar(1, { high: 104, low: 100, close: 103 })], cfg);
  assert.equal(result.closed, true);
  assert.equal(result.patch.exit_reason, 'TP1');
  near(result.patch.mfe_pct, 2);
  near(result.patch.net_pnl_pct, 1.8694);
  assert.equal(result.patch.setup.exitExecutionModel, EXECUTION_MODEL);
});
test('tight stop does not arm breakeven above the current market', () => {
  const result = evaluateTrade(trade({ active_sl: 99.88, risk_per_unit: 0.12 }),
    [bar(1, { high: 100.105, low: 99.99, close: 100.10 })], cfg);
  assert.equal(result.patch.breakeven_armed, false);
  assert.equal(result.patch.active_sl, 99.88);
});
test('breakeven uses the stored fee and exact slippage formula; gap losses remain possible', () => {
  const original = trade({ active_sl: 99.88, risk_per_unit: 0.12, fee_bps: 7 });
  const result = evaluateTrade(original, [bar(1, { high: 100.21, low: 100, close: 100.2 })], cfg);
  assert.equal(result.patch.breakeven_armed, true);
  const stop = result.patch.active_sl;
  near(stop, 100 * 1.0014 / 0.9997);
  const filled = evaluateTrade({ ...original, ...result.patch }, [bar(2, { open: 100.2, high: 100.2, low: 100.15, close: 100.16 })], cfg);
  assert.equal(filled.patch.exit_reason, 'BREAKEVEN_STOP');
  near(filled.patch.net_pnl_pct, 0);
  const gap = evaluateTrade({ ...original, ...result.patch }, [bar(2, { open: 99.8, high: 99.9, low: 99.7, close: 99.8 })], cfg);
  assert.equal(gap.patch.outcome, 'LOSS');
});
test('never lowers an existing stop when arming breakeven', () => {
  const result = evaluateTrade(trade({ active_sl: 100.5 }), [bar(1, { open: 100.6, low: 100.6, high: 101, close: 100.9 })], cfg);
  assert.equal(result.patch.active_sl, 100.5);
});
test('momentum fade requires positive net return after costs', () => {
  const original = trade({ active_sl: 99.84, risk_per_unit: 0.16, mfe_pct: 0.2 });
  const result = evaluateTrade(original, [bar(1, { high: 100.05, low: 100, close: 100.02 })], cfg);
  assert.equal(result.closed, false);
  const profitable = evaluateTrade(trade({ mfe_pct: 1.2 }), [bar(1, { high: 100.6, low: 100.4, close: 100.5 })], cfg);
  assert.equal(profitable.patch.exit_reason, 'MOMENTUM_FADE');
  assert.ok(profitable.patch.r_multiple > 0.1);
});
test('timeout closes at the observed close; replay ignores already checked bars', () => {
  const original = trade();
  const result = evaluateTrade(original, [bar(121)], cfg);
  assert.equal(result.patch.exit_reason, 'TIMEOUT');
  assert.equal(evaluateTrade({ ...original, last_checked_bar_close: bar(1).closeTime }, [bar(1)], cfg).patch, null);
});
test('market exits use saved fees and preserve setup metadata', () => {
  const result = closeTradeAtMarket(trade({ fee_bps: 7, setup: { setupType: 'LIQUID_TREND' } }), 101, t + 120_000, 'MANIPULATION_EXIT', cfg);
  near(result.patch.net_pnl_pct, 0.8297);
  assert.equal(result.patch.setup.setupType, 'LIQUID_TREND');
});
