import test from 'node:test';
import assert from 'node:assert/strict';
import { assessManipulationRisk, depthMetrics } from '../src/risk.js';

const cfg = { maxSpreadBps: 10, minDepthEachSideUsd: 100_000 };
const baseFeatures = {
  ret1m: 0.5,
  ret3m: 1.2,
  ret5m: 1.5,
  extensionAtr: 1.2,
  volumeZ: 2,
  deltaRatio1: 0.2,
  upperWickPct: 15,
};
const oi = { changePct: 0.5 };
const history = { repeated: false, reason: 'clean' };

test('depth metrics are not based on one fixed wall size', () => {
  const book = {
    bids: [['99.95', '2000'], ['99.80', '1000']],
    asks: [['100.05', '1800'], ['100.20', '1200']],
  };
  const result = depthMetrics(book, 100);
  assert.ok(result.bidNotional05 > 250_000);
  assert.ok(result.askNotional05 > 250_000);
  assert.ok(result.spreadBps < 11);
  assert.ok(Number.isFinite(result.entryImpactBps));
  assert.ok(Number.isFinite(result.top3Imbalance));
});

test('entry impact walks the actual ask ladder for the assumed order size', () => {
  const book = {
    bids: [['99.9', '20']],
    asks: [['100', '1'], ['101', '20']],
  };
  const result = depthMetrics(book, 100, 1_000);
  assert.equal(result.assumedOrderNotionalUsd, 1_000);
  assert.ok(result.estimatedBuyPrice > 100.8);
  assert.ok(result.entryImpactBps > 80);
  assert.equal(result.unfilledOrderUsd, 0);
});

test('volume climax with genuine taker sell delta is a hard manipulation block', () => {
  const risk = assessManipulationRisk({
    features: { ...baseFeatures, volumeZ: 5, deltaRatio1: -0.25 },
    oi,
    depth: { spreadBps: 4, bidNotional05: 300_000, askNotional05: 300_000, imbalance: 1, measuredAt: Date.now() },
    previousDepth: null,
    history,
    fundingPct: 0,
    cfg,
  });
  assert.equal(risk.hardBlock, true);
  assert.match(risk.reasons.join(' '), /net taker selling/);
});

test('bid-depth collapse plus spread expansion is a hard block', () => {
  const risk = assessManipulationRisk({
    features: baseFeatures,
    oi,
    depth: { spreadBps: 8, bidNotional05: 120_000, askNotional05: 250_000, imbalance: 0.48, measuredAt: Date.now() },
    previousDepth: { spreadBps: 3, bidNotional05: 400_000, askNotional05: 260_000, measuredAt: Date.now() - 60_000 },
    history,
    fundingPct: 0,
    cfg,
  });
  assert.equal(risk.hardBlock, true);
  assert.match(risk.reasons.join(' '), /bid depth collapsed/);
});

test('repeated historical pump/retrace is caution, not a hard block by itself', () => {
  const risk = assessManipulationRisk({
    features: baseFeatures,
    oi,
    depth: { spreadBps: 4, bidNotional05: 300_000, askNotional05: 300_000, imbalance: 1, measuredAt: Date.now() },
    previousDepth: null,
    history: { repeated: true, reason: '3 non-overlapping pump/retrace episodes in history' },
    fundingPct: 0,
    cfg,
  });
  assert.equal(risk.score, 2);
  assert.equal(risk.hardBlock, false);
});
