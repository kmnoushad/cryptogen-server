import test from 'node:test';
import assert from 'node:assert/strict';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';

const input = { entry: 100, equity: 108.81, available: 108.81, open: [],
  feeRate: 0.0005, qtyStep: 0.001, minQty: 0.001, minNotional: 5 };
test('long and short plans target $5 net but stop risk is clamped to equity', () => {
  const long = planFuturesAutoTrade({ ...input, direction: 'LONG', stop: 99 });
  const short = planFuturesAutoTrade({ ...input, direction: 'SHORT', stop: 101 });
  for (const plan of [long, short]) {
    assert.equal(plan.allowed, true);
    assert.ok(plan.plannedLossUsd <= 1.0881 + 1e-8);
    assert.ok(plan.marginUsd <= 108.81 * 0.5);
    assert.ok(plan.notionalUsd <= 150);
    assert.ok(plan.targetMovePct > 0);
  }
  assert.ok(long.target > 100 && short.target < 100);
});
test('five slots, aggregate risk, wrong-side stops and exchange minimum fail closed', () => {
  const job = { riskUsd: 0.6, marginUsd: 5 };
  assert.match(planFuturesAutoTrade({ ...input, direction: 'SHORT', stop: 101, open: Array(5).fill(job) }).reason, /cap/);
  assert.match(planFuturesAutoTrade({ ...input, direction: 'SHORT', stop: 101,
    open: Array(4).fill({ riskUsd: 0.9, marginUsd: 5 }) }).reason, /risk or margin/);
  assert.match(planFuturesAutoTrade({ ...input, direction: 'SHORT', stop: 99 }).reason, /wrong side/);
  assert.match(planFuturesAutoTrade({ ...input, direction: 'LONG', stop: 99, minNotional: 200 }).reason, /minimum/);
});
