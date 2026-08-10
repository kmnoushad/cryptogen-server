import { mean } from './indicators.js';

const SETUP_PROFILES = Object.freeze({
  FAST_BREAKOUT: Object.freeze({
    failureAtr: 0.45, failureCloses: 1, retestLowAtr: 0.25, retestCloseAtr: 0.10,
    maxWaveRetrace: 0.50, minWaveAtr: 0, reclaimBodyPct: 40, reclaimWickPct: 30,
  }),
  STEADY_MOMENTUM: Object.freeze({
    failureAtr: 0.70, failureCloses: 2, retestLowAtr: 0.45, retestCloseAtr: 0.20,
    maxWaveRetrace: 0.60, minWaveAtr: 0.80, reclaimBodyPct: 40, reclaimWickPct: 30,
  }),
  LIQUID_TREND: Object.freeze({
    failureAtr: 0.90, failureCloses: 2, retestLowAtr: 0.70, retestCloseAtr: 0.30,
    maxWaveRetrace: 0.70, minWaveAtr: 1.00, reclaimBodyPct: 35, reclaimWickPct: 35,
  }),
});

const profileFor = setupType => SETUP_PROFILES[setupType] ?? SETUP_PROFILES.FAST_BREAKOUT;

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
  const profile = profileFor(features.setupType);
  const impulseLow = Math.min(...candles.slice(-waveLookback).map(c => c.low));
  const atrAtDetection = features.atr;
  return {
    symbol,
    state: 'ARMED',
    detectedBarClose: features.last.closeTime,
    expiresBarClose: features.last.closeTime + cfg.futuresCandidateTtlMin * 60_000,
    breakoutLevel: referenceLevel,
    structureLevel: features.breakoutLevel,
    impulseLow,
    impulseWaveAtArm: Math.max(0, features.last.high - impulseLow),
    peakPrice: features.last.high,
    impulseAvgQuoteVolume: mean(candles.slice(-3).map(c => c.quoteVolume)),
    atrAtDetection,
    invalidationLevel: referenceLevel - profile.failureAtr * atrAtDetection,
    setupScore: features.setupScore,
    setupType: features.setupType,
    retested: false,
    retestLow: null,
    retestBarClose: null,
    retestType: null,
    candidateLow: null,
    belowInvalidationBars: 0,
    beyondWaveRetraceBars: 0,
    reclaimed: false,
    reclaimBarClose: null,
    reclaimClose: null,
    reclaimLow: null,
    executionWaitUntil: null,
    barsObserved: 0,
    detectedRisk: context.risk,
  };
};

const reject = (candidate, reason) => ({ action: 'REJECT', candidate: { ...candidate, state: 'REJECTED' }, reason });

export const advanceCandidate = (candidate, features, context, cfg) => {
  const last = features.last;
  const profile = profileFor(candidate.setupType);
  const atrAtDetection = Number(candidate.atrAtDetection) > 0 ? Number(candidate.atrAtDetection) : features.atr;
  const next = {
    ...candidate,
    peakPrice: Math.max(candidate.peakPrice, last.high),
    barsObserved: Number(candidate.barsObserved ?? 0) + 1,
  };
  if (last.closeTime <= candidate.detectedBarClose) return { action: 'HOLD', candidate: next, reason: 'waiting for next closed bar' };
  const executionWaitUntil = Number(candidate.executionWaitUntil ?? ((candidate.reclaimBarClose ?? 0) + 3 * 60_000));
  if (candidate.reclaimed) {
    if (last.closeTime > executionWaitUntil) return reject(next, 'execution book did not recover after reclaim');
  } else if (last.closeTime > candidate.expiresBarClose) {
    return reject(next, 'candidate expired without a valid retest');
  }

  // Once armed, only an objectively terminal live event erases the setup.
  // Temporary thin depth, spread or accumulated caution still blocks entry,
  // but the candidate is allowed to recover before its TTL expires.
  if (context.risk?.terminalRisk) {
    return reject(next, `manipulation risk: ${context.risk.reasons.join('; ')}`);
  }

  next.candidateLow = candidate.candidateLow === null || candidate.candidateLow === undefined
    ? last.low
    : Math.min(candidate.candidateLow, last.low);

  // A wick into a small LIQUID_TREND wave is not enough to kill the setup.
  // Use closed price, normalize tiny waves to detection ATR, and require the
  // setup-specific support zone to be lost at the same time.
  const rawImpulseWave = Math.max(
    Number(candidate.impulseWaveAtArm ?? 0),
    Number.isFinite(candidate.impulseLow) ? next.peakPrice - candidate.impulseLow : 0,
  );
  const normalizedWave = Math.max(rawImpulseWave, profile.minWaveAtr * atrAtDetection);
  const waveRetrace = normalizedWave > 0 ? (next.peakPrice - last.close) / normalizedWave : 0;
  const waveSupportLost = last.close < candidate.breakoutLevel - profile.retestCloseAtr * atrAtDetection;
  next.beyondWaveRetraceBars = waveRetrace > profile.maxWaveRetrace && waveSupportLost
    ? Number(candidate.beyondWaveRetraceBars ?? 0) + 1
    : 0;
  if (next.beyondWaveRetraceBars >= profile.failureCloses) {
    return reject(next, `impulse wave retraced ${(waveRetrace * 100).toFixed(0)}%`);
  }

  const invalidationLevel = Number.isFinite(candidate.invalidationLevel)
    ? candidate.invalidationLevel
    : candidate.breakoutLevel - profile.failureAtr * atrAtDetection;
  next.invalidationLevel = invalidationLevel;
  next.belowInvalidationBars = last.close < invalidationLevel
    ? Number(candidate.belowInvalidationBars ?? 0) + 1
    : 0;
  if (next.belowInvalidationBars >= profile.failureCloses) {
    return reject(next, `breakout level failed (${profile.failureCloses} closed bar${profile.failureCloses === 1 ? '' : 's'})`);
  }
  if (features.ret1m <= -1.2) return reject(next, 'fast downside reversal');

  const pullbackFromPeak = next.peakPrice - last.low;
  const levelHeld = last.low >= candidate.breakoutLevel - profile.retestLowAtr * atrAtDetection
    && last.close >= candidate.breakoutLevel - profile.retestCloseAtr * atrAtDetection;
  const standardRetest = pullbackFromPeak >= 0.25 * atrAtDetection
    && levelHeld
    && last.quoteVolume <= candidate.impulseAvgQuoteVolume * 0.90;
  const shallowConsolidation = next.barsObserved >= 3
    && pullbackFromPeak >= 0.10 * atrAtDetection
    && levelHeld
    && last.quoteVolume <= candidate.impulseAvgQuoteVolume * 1.05;
  const healthyRetest = standardRetest || shallowConsolidation;

  if (!next.retested && healthyRetest) {
    next.retested = true;
    next.retestLow = Math.min(next.candidateLow ?? last.low, last.low);
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
    && features.bodyPct >= profile.reclaimBodyPct
    && features.upperWickPct <= profile.reclaimWickPct
    && last.close > features.previous.high
    && last.close >= candidate.breakoutLevel + (liquidTrend ? 0.03 : 0.05) * features.atr;
  const flowConfirmed = features.buyRatio1 >= (liquidTrend ? 0.54 : 0.57)
    && features.deltaRatio1 >= (liquidTrend ? 0.08 : 0.14)
    && (!liquidTrend || (features.buyRatio3 >= 0.52 && features.buyRatio15 >= 0.50));
  // For the slow liquid path, current recovery matters more than preserving the
  // full rolling 15m/30m heat that existed before the retest. Reclaim shape and
  // taker flow still confirm the current move; EMA structure prevents a dead
  // trend from entering merely because of one random green candle.
  const recentFiveMinuteMove = Number(features.ret5m ?? features.ret3m ?? -Infinity);
  const momentumConfirmed = !liquidTrend || (
    features.ema20Slope5Pct >= 0.01
    && last.close > features.ema20
    && recentFiveMinuteMove >= -0.05
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
    && depthStable
    && context.risk?.entryBlocked !== true;

  const reclaimSetupHealthy = reclaim && flowConfirmed && momentumConfirmed && volumeHealthy && notExtended && oiConfirmed;

  if (!next.reclaimed && !reclaimSetupHealthy) {
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
      ].filter(Boolean).join(', '),
    };
  }

  if (!next.reclaimed) {
    next.reclaimed = true;
    next.reclaimBarClose = last.closeTime;
    next.reclaimClose = last.close;
    next.reclaimLow = last.low;
    next.executionWaitUntil = last.closeTime + 3 * 60_000;
    next.state = 'RECLAIMED_WAIT_BOOK';
    if (!executionHealthy) {
      return {
        action: 'HOLD',
        candidate: next,
        reason: 'reclaim confirmed; spread/depth/impact stability waiting',
      };
    }
  } else {
    const waitPriceCeiling = candidate.reclaimClose + 0.25 * atrAtDetection;
    if (last.close < candidate.breakoutLevel - profile.retestCloseAtr * atrAtDetection) {
      return reject(next, 'reclaim structure failed while waiting for execution');
    }
    if (last.close > waitPriceCeiling) {
      return reject(next, 'execution recovery became extended after reclaim');
    }
    const flowStillPositive = features.buyRatio1 >= 0.50 && features.deltaRatio1 >= 0;
    if (!executionHealthy || !flowStillPositive) {
      return {
        action: 'HOLD',
        candidate: next,
        reason: [
          !flowStillPositive && 'post-reclaim taker flow weak',
          !executionHealthy && 'spread/depth/impact stability waiting',
        ].filter(Boolean).join(', '),
      };
    }
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
        executionWaitBars: next.reclaimed ? Math.max(0, Math.round((last.closeTime - next.reclaimBarClose) / 60_000)) : 0,
        assumedOrderNotionalUsd: context.depth.assumedOrderNotionalUsd,
        entryImpactBps,
        manipulationScore: context.risk.score,
        netRR,
      },
    },
  };
};
