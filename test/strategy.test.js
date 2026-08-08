import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCandidate } from '../src/strategy.js';

const cfg = {
  maxEntrySlippageBps: 8,
  takerFeeBps: 5,
  exitSlippageBps: 3,
  maxSpreadBps: 10,
  minDepthEachSideUsd: 100_000,
  minNetRR: 1.35,
};

const context = {
  risk: { hardBlock: false, score: 0, reasons: [] },
  oi: { changePct: 0.4 },
  depth: {
    bestAsk: 101.5,
    spreadBps: 4,
    bidNotional05: 300_000,
    askNotional05: 250_000,
  },
};

test('impulse is not signalled; retest then later reclaim is signalled', () => {
  const candidate = {
    symbol: 'TESTUSDT', state: 'ARMED', detectedBarClose: 60_000, expiresBarClose: 780_000,
    breakoutLevel: 100.8, peakPrice: 102, impulseAvgQuoteVolume: 1_000,
    atrAtDetection: 1, setupScore: 8, retested: false, retestLow: null, retestBarClose: null,
  };
  const retestFeatures = {
    last: { closeTime: 120_000, low: 101, high: 101.6, close: 101.1, quoteVolume: 800 },
    previous: { high: 102 },
    atr: 1,
    ret1m: -0.6,
    green: false,
    bodyPct: 50,
    upperWickPct: 15,
    buyRatio1: 0.45,
    deltaRatio1: -0.1,
    quoteVolumeRatio: 0.8,
    extensionAtr: 0.8,
  };
  const afterRetest = advanceCandidate(candidate, retestFeatures, context, cfg);
  assert.equal(afterRetest.action, 'HOLD');
  assert.equal(afterRetest.candidate.retested, true);

  const reclaimFeatures = {
    last: { closeTime: 180_000, low: 101.1, high: 101.8, close: 101.7, quoteVolume: 1_200 },
    previous: { high: 101.55 },
    atr: 1,
    ret1m: 0.55,
    ret3m: 1.2,
    green: true,
    bodyPct: 70,
    upperWickPct: 14,
    buyRatio1: 0.63,
    buyRatio3: 0.60,
    deltaRatio1: 0.26,
    quoteVolumeRatio: 1.2,
    extensionAtr: 1.1,
  };
  const signal = advanceCandidate(afterRetest.candidate, reclaimFeatures, context, cfg);
  assert.equal(signal.action, 'SIGNAL');
  assert.ok(signal.trade.entry > context.depth.bestAsk);
  assert.ok(signal.trade.initial_sl < signal.trade.entry);
  assert.ok(signal.trade.tp1 > signal.trade.entry);
  assert.ok(signal.trade.setup.netRR >= cfg.minNetRR);
});
