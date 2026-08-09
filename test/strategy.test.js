import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCandidate, armCandidate } from '../src/strategy.js';

const cfg = {
  maxEntrySlippageBps: 8,
  takerFeeBps: 5,
  exitSlippageBps: 3,
  maxSpreadBps: 10,
  minDepthEachSideUsd: 100_000,
  minNetRR: 1.35,
  futuresCandidateTtlMin: 24,
  minStopPctFloor: 0.12,
  maxStopPct: 1.60,
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

test('armed candidate uses configurable 24-minute lifetime', () => {
  const features = { last: { closeTime: 60_000, high: 101 }, breakoutLevel: 100, atr: 1, setupScore: 7 };
  const candles = Array.from({ length: 4 }, () => ({ low: 99, quoteVolume: 1_000 }));
  const candidate = armCandidate('TESTUSDT', candles, features, context, cfg);
  assert.equal(candidate.expiresBarClose, 60_000 + 24 * 60_000);
});

test('controlled shallow consolidation can become the retest', () => {
  const candidate = {
    symbol: 'TESTUSDT', state: 'ARMED', detectedBarClose: 60_000, expiresBarClose: 1_500_000,
    breakoutLevel: 100.8, peakPrice: 102, impulseAvgQuoteVolume: 1_000,
    atrAtDetection: 1, setupScore: 8, retested: false, retestLow: null, retestBarClose: null, barsObserved: 2,
  };
  const consolidation = {
    last: { closeTime: 240_000, low: 101.85, high: 101.98, close: 101.9, quoteVolume: 1_000 },
    previous: { high: 102 }, atr: 1, ret1m: -0.05, green: false, bodyPct: 30, upperWickPct: 20,
    buyRatio1: 0.50, deltaRatio1: 0, quoteVolumeRatio: 0.9, extensionAtr: 1,
  };
  const result = advanceCandidate(candidate, consolidation, context, cfg);
  assert.equal(result.action, 'HOLD');
  assert.equal(result.candidate.retested, true);
  assert.equal(result.candidate.retestType, 'SHALLOW_CONSOLIDATION');
});

test('quiet liquid contract gets a volatility-based minimum stop instead of rejection', () => {
  const quietContext = { ...context, depth: { ...context.depth, bestAsk: 100 } };
  const candidate = {
    symbol: 'QUIETUSDT', state: 'RETESTED', detectedBarClose: 60_000, expiresBarClose: 1_500_000,
    breakoutLevel: 100.04, peakPrice: 100.12, impulseAvgQuoteVolume: 1_000, atrAtDetection: 0.1,
    setupScore: 8, retested: true, retestLow: 100.05, retestBarClose: 120_000, retestType: 'STANDARD', barsObserved: 3,
  };
  const reclaim = {
    last: { closeTime: 180_000, low: 100.05, high: 100.12, close: 100.1, quoteVolume: 1_000 },
    previous: { high: 100.05 }, atr: 0.1, ret1m: 0.05, ret3m: 0.8, green: true, bodyPct: 70,
    upperWickPct: 10, buyRatio1: 0.60, buyRatio3: 0.59, deltaRatio1: 0.20,
    quoteVolumeRatio: 1, extensionAtr: 0.8,
  };
  const result = advanceCandidate(candidate, reclaim, quietContext, cfg);
  assert.equal(result.action, 'SIGNAL');
  const stopPct = (result.trade.entry - result.trade.initial_sl) / result.trade.entry * 100;
  assert.ok(stopPct >= cfg.minStopPctFloor - 1e-9);
});

test('liquid trend candidate anchors its retest near EMA20 instead of the old high', () => {
  const features = {
    last: { closeTime: 60_000, close: 100.8, high: 101 },
    breakoutLevel: 101.1,
    ema20: 100.4,
    atr: 1,
    setupScore: 7,
    setupType: 'LIQUID_TREND',
  };
  const candles = Array.from({ length: 4 }, () => ({ low: 100, quoteVolume: 1_000 }));
  const candidate = armCandidate('LIQUIDUSDT', candles, features, context, cfg);
  assert.equal(candidate.breakoutLevel, 100.5);
  assert.equal(candidate.structureLevel, 101.1);
  assert.equal(candidate.setupType, 'LIQUID_TREND');
});

test('liquid trend reclaim uses its controlled continuation thresholds', () => {
  const liquidContext = { ...context, depth: { ...context.depth, bestAsk: 100.9 } };
  const candidate = {
    symbol: 'LIQUIDUSDT', state: 'RETESTED', detectedBarClose: 60_000, expiresBarClose: 1_500_000,
    breakoutLevel: 100.5, structureLevel: 101.1, peakPrice: 101.2, impulseAvgQuoteVolume: 1_000,
    atrAtDetection: 1, setupScore: 7, setupType: 'LIQUID_TREND', retested: true,
    retestLow: 100.35, retestBarClose: 120_000, retestType: 'STANDARD', barsObserved: 3,
  };
  const reclaim = {
    last: { closeTime: 180_000, low: 100.45, high: 101.0, close: 100.9, quoteVolume: 900 },
    previous: { high: 100.8 }, atr: 1, ret1m: 0.2, ret3m: 0.6, green: true, bodyPct: 36,
    upperWickPct: 18, buyRatio1: 0.545, buyRatio3: 0.54, deltaRatio1: 0.09,
    buyRatio15: 0.53, ret15m: 0.30, ret30m: 0.60, ema20Slope5Pct: 0.04,
    ema20: 100.5, quoteVolumeRatio: 0.70, extensionAtr: 1.2,
  };
  const result = advanceCandidate(candidate, reclaim, liquidContext, cfg);
  assert.equal(result.action, 'SIGNAL');
  assert.equal(result.trade.setup.setupType, 'LIQUID_TREND');
  assert.equal(result.trade.setup.structureLevel, 101.1);
});

test('liquid trend does not signal after its multi-minute momentum has faded', () => {
  const candidate = {
    symbol: 'FADEUSDT', state: 'RETESTED', detectedBarClose: 60_000, expiresBarClose: 1_500_000,
    breakoutLevel: 100.5, structureLevel: 101.1, peakPrice: 101.2, impulseAvgQuoteVolume: 1_000,
    atrAtDetection: 1, setupScore: 7, setupType: 'LIQUID_TREND', retested: true,
    retestLow: 100.35, retestBarClose: 120_000, retestType: 'STANDARD', barsObserved: 3,
  };
  const faded = {
    last: { closeTime: 180_000, low: 100.45, high: 101, close: 100.9, quoteVolume: 900 },
    previous: { high: 100.8 }, atr: 1, ret1m: 0.2, ret3m: 0.3, ret15m: 0.08, ret30m: 0.35,
    green: true, bodyPct: 60, upperWickPct: 10, buyRatio1: 0.70, buyRatio3: 0.60,
    buyRatio15: 0.58, deltaRatio1: 0.40, ema20Slope5Pct: 0.04, ema20: 100.5,
    quoteVolumeRatio: 1.2, extensionAtr: 1.0,
  };
  const result = advanceCandidate(candidate, faded, context, cfg);
  assert.equal(result.action, 'HOLD');
  assert.match(result.reason, /trend momentum faded/);
});
