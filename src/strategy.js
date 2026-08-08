import { mean } from './indicators.js';

export const armCandidate = (symbol, candles, features, context) => ({
  symbol,
  state: 'ARMED',
  detectedBarClose: features.last.closeTime,
  expiresBarClose: features.last.closeTime + 12 * 60_000,
  breakoutLevel: features.breakoutLevel,
  impulseLow: Math.min(...candles.slice(-4).map(c => c.low)),
  peakPrice: features.last.high,
  impulseAvgQuoteVolume: mean(candles.slice(-3).map(c => c.quoteVolume)),
  atrAtDetection: features.atr,
  setupScore: features.setupScore,
  retested: false,
  retestLow: null,
  retestBarClose: null,
  detectedRisk: context.risk,
});

const reject = (candidate, reason) => ({ action: 'REJECT', candidate: { ...candidate, state: 'REJECTED' }, reason });

export const advanceCandidate = (candidate, features, context, cfg) => {
  const last = features.last;
  const next = { ...candidate, peakPrice: Math.max(candidate.peakPrice, last.high) };
  if (last.closeTime <= candidate.detectedBarClose) return { action: 'HOLD', candidate: next, reason: 'waiting for next closed bar' };
  if (last.closeTime > candidate.expiresBarClose) return reject(next, 'candidate expired without a valid retest');
  if (context.risk.hardBlock || context.risk.score >= 4) return reject(next, `manipulation risk: ${context.risk.reasons.join('; ')}`);
  if (last.close < candidate.breakoutLevel - 0.45 * features.atr) return reject(next, 'breakout level failed');
  if (features.ret1m <= -1.2) return reject(next, 'fast downside reversal');

  const pullbackFromPeak = next.peakPrice - last.low;
  const levelHeld = last.low >= candidate.breakoutLevel - 0.25 * features.atr
    && last.close >= candidate.breakoutLevel - 0.10 * features.atr;
  const volumeContracted = last.quoteVolume <= candidate.impulseAvgQuoteVolume * 0.90;
  const healthyRetest = pullbackFromPeak >= 0.25 * features.atr && levelHeld && volumeContracted;

  if (!next.retested && healthyRetest) {
    next.retested = true;
    next.retestLow = last.low;
    next.retestBarClose = last.closeTime;
    next.state = 'RETESTED';
    return { action: 'HOLD', candidate: next, reason: 'healthy retest recorded; waiting for reclaim' };
  }

  if (next.retested) next.retestLow = Math.min(next.retestLow, last.low);
  if (!next.retested || last.closeTime <= next.retestBarClose) {
    return { action: 'HOLD', candidate: next, reason: 'waiting for a post-retest reclaim bar' };
  }

  const reclaim = features.green
    && features.bodyPct >= 45
    && features.upperWickPct <= 25
    && last.close > features.previous.high
    && last.close >= candidate.breakoutLevel + 0.10 * features.atr;
  const flowConfirmed = features.buyRatio1 >= 0.58 && features.deltaRatio1 >= 0.16;
  const volumeHealthy = features.quoteVolumeRatio >= 0.80 && features.quoteVolumeRatio <= 3.5;
  const notExtended = features.extensionAtr <= 1.6 && last.close <= candidate.peakPrice + 0.35 * features.atr;
  const oiConfirmed = context.oi.changePct >= -0.5;
  const executionHealthy = context.depth.spreadBps <= cfg.maxSpreadBps
    && context.depth.bidNotional05 >= cfg.minDepthEachSideUsd
    && context.depth.askNotional05 >= cfg.minDepthEachSideUsd;

  if (!(reclaim && flowConfirmed && volumeHealthy && notExtended && oiConfirmed && executionHealthy)) {
    return {
      action: 'HOLD',
      candidate: next,
      reason: [
        !reclaim && 'no closed-bar reclaim',
        !flowConfirmed && 'taker flow weak',
        !volumeHealthy && 'volume unhealthy',
        !notExtended && 'entry extended',
        !oiConfirmed && 'OI contracting',
        !executionHealthy && 'spread/depth failed',
      ].filter(Boolean).join(', '),
    };
  }

  const entry = context.depth.bestAsk * (1 + cfg.maxEntrySlippageBps / 10_000);
  let stop = Math.min(next.retestLow - 0.10 * features.atr, candidate.breakoutLevel - 0.20 * features.atr);
  if (entry - stop < 0.60 * features.atr) stop = entry - 0.60 * features.atr;
  const riskPerUnit = entry - stop;
  const riskPct = riskPerUnit / entry * 100;
  if (riskPct < 0.30 || riskPct > 1.60) return reject(next, `structural stop is ${riskPct.toFixed(2)}% away`);

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
      entry_slippage_bps: cfg.maxEntrySlippageBps,
      setup: {
        breakoutLevel: candidate.breakoutLevel,
        retestLow: next.retestLow,
        ret3m: features.ret3m,
        buyRatio1: features.buyRatio1,
        buyRatio3: features.buyRatio3,
        deltaRatio1: features.deltaRatio1,
        oiChangePct: context.oi.changePct,
        spreadBps: context.depth.spreadBps,
        bidDepthUsd: context.depth.bidNotional05,
        askDepthUsd: context.depth.askNotional05,
        manipulationScore: context.risk.score,
        netRR,
      },
    },
  };
};
