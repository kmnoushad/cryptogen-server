import { mean } from './indicators.js';

export const armCandidate = (symbol, candles, features, context, cfg) => {
  // LIQUID_TREND is a continuation setup and may be detected just below the
  // older 21-minute high. Retest the level that was actually reclaimed at
  // detection; otherwise a normal pullback is falsely labelled a failed
  // breakout before the continuation can complete.
  const referenceLevel = features.setupType === 'LIQUID_TREND'
    ? Math.max(
      features.ema20,
      Math.min(features.breakoutLevel, features.last.close) - 0.30 * features.atr,
    )
    : features.breakoutLevel;
  const waveLookback = features.setupType === 'FAST_BREAKOUT' ? 6
    : features.setupType === 'STEADY_MOMENTUM' ? 16
    : 31;
  return {
    symbol,
    state: 'ARMED',
    detectedBarClose: features.last.closeTime,
    expiresBarClose: features.last.closeTime + cfg.futuresCandidateTtlMin * 60_000,
    breakoutLevel: referenceLevel,
    structureLevel: features.breakoutLevel,
    impulseLow: Math.min(...candles.slice(-waveLookback).map(c => c.low)),
    peakPrice: features.last.high,
    impulseAvgQuoteVolume: mean(candles.slice(-3).map(c => c.quoteVolume)),
    atrAtDetection: features.atr,
    setupScore: features.setupScore,
    setupType: features.setupType,
    retested: false,
    retestLow: null,
    retestBarClose: null,
    retestType: null,
    barsObserved: 0,
    detectedRisk: context.risk,
  };
};

const reject = (candidate, reason) => ({ action: 'REJECT', candidate: { ...candidate, state: 'REJECTED' }, reason });

export const advanceCandidate = (candidate, features, context, cfg) => {
  const last = features.last;
  const next = {
    ...candidate,
    peakPrice: Math.max(candidate.peakPrice, last.high),
    barsObserved: Number(candidate.barsObserved ?? 0) + 1,
  };
  if (last.closeTime <= candidate.detectedBarClose) return { action: 'HOLD', candidate: next, reason: 'waiting for next closed bar' };
  if (last.closeTime > candidate.expiresBarClose) return reject(next, 'candidate expired without a valid retest');
  if (context.risk.hardBlock) return reject(next, `manipulation risk: ${context.risk.reasons.join('; ')}`);
  const impulseWave = next.peakPrice - candidate.impulseLow;
  const waveRetrace = impulseWave > 0 ? (next.peakPrice - last.low) / impulseWave : 0;
  if (waveRetrace > 0.50) return reject(next, `impulse wave retraced ${(waveRetrace * 100).toFixed(0)}%`);
  if (last.close < candidate.breakoutLevel - 0.45 * features.atr) return reject(next, 'breakout level failed');
  if (features.ret1m <= -1.2) return reject(next, 'fast downside reversal');

  const pullbackFromPeak = next.peakPrice - last.low;
  const levelHeld = last.low >= candidate.breakoutLevel - 0.25 * features.atr
    && last.close >= candidate.breakoutLevel - 0.10 * features.atr;
  const standardRetest = pullbackFromPeak >= 0.25 * features.atr
    && levelHeld
    && last.quoteVolume <= candidate.impulseAvgQuoteVolume * 0.90;
  const shallowConsolidation = next.barsObserved >= 3
    && pullbackFromPeak >= 0.10 * features.atr
    && levelHeld
    && last.quoteVolume <= candidate.impulseAvgQuoteVolume * 1.05;
  const healthyRetest = standardRetest || shallowConsolidation;

  if (!next.retested && healthyRetest) {
    next.retested = true;
    next.retestLow = last.low;
    next.retestBarClose = last.closeTime;
    next.retestType = standardRetest ? 'STANDARD' : 'SHALLOW_CONSOLIDATION';
    next.state = 'RETESTED';
    return { action: 'HOLD', candidate: next, reason: 'healthy retest recorded; waiting for reclaim' };
  }

  if (next.retested) next.retestLow = Math.min(next.retestLow, last.low);
  if (!next.retested || last.closeTime <= next.retestBarClose) {
    return { action: 'HOLD', candidate: next, reason: 'waiting for a post-retest reclaim bar' };
  }

  const liquidTrend = candidate.setupType === 'LIQUID_TREND';
  const reclaim = features.green
    && features.bodyPct >= (liquidTrend ? 35 : 40)
    && features.upperWickPct <= (liquidTrend ? 35 : 30)
    && last.close > features.previous.high
    && last.close >= candidate.breakoutLevel + (liquidTrend ? 0.03 : 0.05) * features.atr;
  const flowConfirmed = features.buyRatio1 >= (liquidTrend ? 0.54 : 0.57)
    && features.deltaRatio1 >= (liquidTrend ? 0.08 : 0.14)
    && (!liquidTrend || (features.buyRatio3 >= 0.52 && features.buyRatio15 >= 0.50));
  // A one-minute green candle is not enough for the slower liquid path. The
  // 24h replay showed deep contracts fading when the original 15–30m trend had
  // already disappeared before the reclaim. Require that trend to remain live.
  const momentumConfirmed = !liquidTrend || (
    features.ret15m >= 0.20
    && features.ret30m >= 0.45
    && features.ema20Slope5Pct >= 0.02
    && last.close > features.ema20
  );
  const volumeHealthy = features.quoteVolumeRatio >= (liquidTrend ? 0.65 : 0.80)
    && features.quoteVolumeRatio <= 3.5;
  const notExtended = features.extensionAtr <= (liquidTrend ? 1.50 : 1.60)
    && last.close <= candidate.peakPrice + 0.35 * features.atr;
  const oiConfirmed = context.oi.changePct >= -0.5;
  const depthImbalance = Number(context.depth.imbalance ?? 1);
  const entryImpactBps = context.depth.entryImpactBps === null || context.depth.entryImpactBps === undefined
    ? cfg.maxEntrySlippageBps
    : Number(context.depth.entryImpactBps);
  const bidRetention = context.depth.bidRetention;
  const spreadExpansion = context.depth.spreadExpansion;
  const depthStable = (bidRetention === null || bidRetention === undefined || bidRetention >= (cfg.minBidDepthRetention ?? 0.65))
    && (spreadExpansion === null || spreadExpansion === undefined || spreadExpansion <= (cfg.maxEntrySpreadExpansion ?? 1.75));
  const executionHealthy = context.depth.spreadBps <= cfg.maxSpreadBps
    && context.depth.bidNotional05 >= cfg.minDepthEachSideUsd
    && context.depth.askNotional05 >= cfg.minDepthEachSideUsd
    && depthImbalance >= (cfg.minEntryDepthImbalance ?? 0.75)
    && entryImpactBps <= cfg.maxEntrySlippageBps
    && depthStable;

  if (!(reclaim && flowConfirmed && momentumConfirmed && volumeHealthy && notExtended && oiConfirmed && executionHealthy)) {
    return {
      action: 'HOLD',
      candidate: next,
      reason: [
        !reclaim && 'no closed-bar reclaim',
        !flowConfirmed && 'taker flow weak',
        !momentumConfirmed && 'trend momentum faded',
        !volumeHealthy && 'volume unhealthy',
        !notExtended && 'entry extended',
        !oiConfirmed && 'OI contracting',
        !executionHealthy && 'spread/depth/impact stability failed',
      ].filter(Boolean).join(', '),
    };
  }

  const entry = Number.isFinite(context.depth.estimatedBuyPrice)
    ? context.depth.estimatedBuyPrice
    : context.depth.bestAsk * (1 + cfg.maxEntrySlippageBps / 10_000);
  let stop = Math.min(next.retestLow - 0.10 * features.atr, candidate.breakoutLevel - 0.20 * features.atr);
  if (entry - stop < 0.60 * features.atr) stop = entry - 0.60 * features.atr;
  let riskPerUnit = entry - stop;
  let riskPct = riskPerUnit / entry * 100;
  const atrPct = features.atr / entry * 100;
  const dynamicMinStopPct = Math.min(0.30, Math.max(cfg.minStopPctFloor, atrPct * 0.75));
  if (riskPct < dynamicMinStopPct) {
    stop = entry * (1 - dynamicMinStopPct / 100);
    riskPerUnit = entry - stop;
    riskPct = dynamicMinStopPct;
  }
  if (riskPct > cfg.maxStopPct) return reject(next, `structural stop is ${riskPct.toFixed(2)}% away`);

  const costPct = (2 * cfg.takerFeeBps + cfg.exitSlippageBps) / 100;
  const minimumRewardPct = (cfg.minNetRR + 0.05) * (riskPct + costPct) + costPct;
  const rewardPct = Math.max(1.60 * riskPct, minimumRewardPct);
  const tp1 = entry * (1 + rewardPct / 100);
  const tp2 = entry + Math.max(2.60 * riskPerUnit, (tp1 - entry) + riskPerUnit);
  const netRR = (rewardPct - costPct) / (riskPct + costPct);
  if (netRR < cfg.minNetRR) return reject(next, `net R:R ${netRR.toFixed(2)} below ${cfg.minNetRR}`);

  return {
    action: 'SIGNAL',
    candidate: { ...next, state: 'SIGNALED' },
    trade: {
      symbol: candidate.symbol,
      direction: 'LONG',
      signal_type: 'RETEST_RECLAIM',
      entry,
      initial_sl: stop,
      active_sl: stop,
      tp1,
      tp2,
      risk_per_unit: riskPerUnit,
      entry_bar_close: last.closeTime,
      setup_score: Math.min(10, candidate.setupScore + 1),
      fee_bps: cfg.takerFeeBps,
      entry_slippage_bps: entryImpactBps,
      setup: {
        breakoutLevel: candidate.breakoutLevel,
        structureLevel: candidate.structureLevel,
        setupType: candidate.setupType,
        retestLow: next.retestLow,
        retestType: next.retestType,
        ret3m: features.ret3m,
        buyRatio1: features.buyRatio1,
        buyRatio3: features.buyRatio3,
        deltaRatio1: features.deltaRatio1,
        oiChangePct: context.oi.changePct,
        spreadBps: context.depth.spreadBps,
        bidDepthUsd: context.depth.bidNotional05,
        askDepthUsd: context.depth.askNotional05,
        depthImbalance,
        top3Imbalance: context.depth.top3Imbalance,
        bidRetention,
        spreadExpansion,
        assumedOrderNotionalUsd: context.depth.assumedOrderNotionalUsd,
        entryImpactBps,
        manipulationScore: context.risk.score,
        netRR,
      },
    },
  };
};
