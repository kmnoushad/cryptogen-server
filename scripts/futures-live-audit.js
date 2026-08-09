import { BinanceClient, classifyBtcRegime, selectUniverse } from '../src/binance.js';
import { buildFeatures, closedCandles, impulseBlockers, parseKlines } from '../src/indicators.js';
import { assessManipulationRisk, depthMetrics, historyRisk } from '../src/risk.js';
import { advanceCandidate, armCandidate } from '../src/strategy.js';
import { mapLimit } from '../src/util.js';

const cfg = {
  min24hQuoteVolumeUsd: 15_000_000,
  maxUniverse24hGainPct: 15,
  maxUniverse: 60,
  universeMomentumSlotsPct: 30,
  futuresCandidateTtlMin: 24,
  maxSpreadBps: 10,
  minDepthEachSideUsd: 100_000,
  maxEntrySlippageBps: 8,
  minStopPctFloor: 0.12,
  maxStopPct: 1.6,
  takerFeeBps: 5,
  exitSlippageBps: 3,
  minNetRR: 1.35,
};
const replayMinutes = Math.max(360, Math.min(1_440, Number(process.env.AUDIT_REPLAY_MINUTES ?? 360)));

const excluded = new Set([
  'BTCUSDT',
  'DOGEUSDT', 'SHIBUSDT', '1000SHIBUSDT', 'PEPEUSDT', '1000PEPEUSDT',
  'BONKUSDT', '1000BONKUSDT', 'WIFUSDT', 'FLOKIUSDT', '1000FLOKIUSDT',
  'TRUMPUSDT', 'MELANIAUSDT', 'BOMEUSDT', 'POPCATUSDT', 'PNUTUSDT',
  'USDCUSDT', 'BTCDOMUSDT', 'DEFIUSDT', 'PAXGUSDT', 'XAUTUSDT',
  'XAUUSDT', 'XAGUSDT',
]);

const benignContext = features => ({
  risk: { hardBlock: false, score: 0, reasons: [] },
  oi: { changePct: 0 },
  depth: {
    bestBid: features.last.close,
    bestAsk: features.last.close,
    spreadBps: 0,
    bidNotional05: 1_000_000,
    askNotional05: 1_000_000,
  },
});

const increment = (object, key) => { object[key] = Number(object[key] ?? 0) + 1; };

const replay = (symbol, candles, btcAt = null) => {
  const start = Math.max(45, candles.length - replayMinutes);
  let candidate = null;
  let armed = 0;
  let retested = 0;
  let signaled = 0;
  let rejected = 0;
  let btcBlockedImpulses = 0;
  let btcCandidateRejected = 0;
  const signalEvents = [];
  const holds = {};
  const rejections = {};
  const setupTypes = {};

  for (let index = start; index < candles.length; index++) {
    const window = candles.slice(Math.max(0, index - 89), index + 1);
    const features = buildFeatures(window);
    if (!features) continue;
    const context = benignContext(features);
    if (!candidate) {
      if (!features.impulse) continue;
      if (btcAt && !btcAt(features.last.closeTime).allowed) {
        btcBlockedImpulses++;
        continue;
      }
      candidate = armCandidate(symbol, window, features, context, cfg);
      armed++;
      increment(setupTypes, features.setupType);
      continue;
    }
    if (btcAt && !btcAt(features.last.closeTime).allowed) {
      btcCandidateRejected++;
      candidate = null;
      continue;
    }
    const decision = advanceCandidate(candidate, features, context, cfg);
    if (decision.action === 'HOLD') {
      if (!candidate.retested && decision.candidate.retested) retested++;
      candidate = decision.candidate;
      increment(holds, decision.reason || 'waiting');
    } else if (decision.action === 'SIGNAL') {
      signaled++;
      const future = candles.slice(index + 1, Math.min(candles.length, index + 121));
      let outcome = 'TIMEOUT';
      let exitBars = future.length;
      for (let futureIndex = 0; futureIndex < future.length; futureIndex++) {
        const candle = future[futureIndex];
        if (candle.low <= decision.trade.initial_sl && candle.high >= decision.trade.tp1) {
          outcome = 'AMBIGUOUS_SAME_BAR'; exitBars = futureIndex + 1; break;
        }
        if (candle.low <= decision.trade.initial_sl) {
          outcome = 'STOP'; exitBars = futureIndex + 1; break;
        }
        if (candle.high >= decision.trade.tp1) {
          outcome = 'TP1'; exitBars = futureIndex + 1; break;
        }
      }
      signalEvents.push({
        barClose: new Date(features.last.closeTime).toISOString(),
        setupType: decision.trade.setup.setupType,
        entry: decision.trade.entry,
        stop: decision.trade.initial_sl,
        tp1: decision.trade.tp1,
        outcome,
        exitBars,
        btc: btcAt ? btcAt(features.last.closeTime) : null,
        features: {
          ret1m: features.ret1m,
          ret3m: features.ret3m,
          ret5m: features.ret5m,
          ret15m: features.ret15m,
          ret30m: features.ret30m,
          buyRatio1: features.buyRatio1,
          buyRatio3: features.buyRatio3,
          buyRatio15: features.buyRatio15,
          deltaRatio1: features.deltaRatio1,
          quoteVolumeRatio: features.quoteVolumeRatio,
          impulseVolumeRatio: features.impulseVolumeRatio,
          bodyPct: features.bodyPct,
          upperWickPct: features.upperWickPct,
          extensionAtr: features.extensionAtr,
          ema20Slope5Pct: features.ema20Slope5Pct,
          rsi: features.rsi,
        },
        setup: decision.trade.setup,
      });
      candidate = null;
    } else if (decision.action === 'REJECT') {
      rejected++;
      increment(rejections, decision.reason || 'rejected');
      candidate = null;
    }
  }
  return { armed, retested, signaled, rejected, btcBlockedImpulses, btcCandidateRejected, holds, rejections, setupTypes, signalEvents };
};

const historicalBtcClassifier = (hourly, five) => time => {
  const h = hourly.filter(candle => candle.closeTime <= time);
  const f = five.filter(candle => candle.closeTime <= time);
  if (h.length < 205 || f.length < 40) return { allowed: false, regime: 'DATA_BLOCK' };
  return classifyBtcRegime(h, f);
};

const binance = new BinanceClient();
const [exchangeInfo, tickers, btc, btcHourRows, btcFiveRows] = await Promise.all([
  binance.exchangeInfo(),
  binance.ticker24h(),
  binance.btcRegime(),
  binance.klines('BTCUSDT', '1h', 500),
  binance.klines('BTCUSDT', '5m', 500),
]);
const btcAt = historicalBtcClassifier(
  closedCandles(parseKlines(btcHourRows)),
  closedCandles(parseKlines(btcFiveRows)),
);
const universe = selectUniverse(exchangeInfo, tickers, cfg, excluded);
const currentFeatures = new Map();
const rows = await mapLimit(universe, 6, async item => {
  const candleLimit = Math.min(1_500, replayMinutes + 90);
  const candles = closedCandles(parseKlines(await binance.klines(item.symbol, '1m', candleLimit)));
  const features = buildFeatures(candles.slice(-90));
  if (!features) return { symbol: item.symbol, error: 'features incomplete' };
  currentFeatures.set(item.symbol, features);
  let liveContext = null;
  if (features.impulse) {
    const [book, oi, premium, historyRows] = await Promise.all([
      binance.depth(item.symbol, 100),
      binance.oiContext(item.symbol),
      binance.premiumIndex(item.symbol),
      binance.klines(item.symbol, '5m', 300),
    ]);
    const depth = depthMetrics(book, features.last.close);
    const history = historyRisk(closedCandles(parseKlines(historyRows)));
    const fundingPct = Number(premium.lastFundingRate) * 100;
    const risk = assessManipulationRisk({
      features, oi, depth, previousDepth: null, history, fundingPct, cfg,
    });
    liveContext = {
      hardBlock: risk.hardBlock,
      riskScore: risk.score,
      riskReasons: risk.reasons,
      oiChangePct: oi.changePct,
      fundingPct,
      spreadBps: depth.spreadBps,
      bidDepthUsd: depth.bidNotional05,
      askDepthUsd: depth.askNotional05,
    };
  }
  return {
    symbol: item.symbol,
    current: {
      impulse: features.impulse,
      setupType: features.setupType,
      score: features.setupScore,
      ret3m: features.ret3m,
      ret15m: features.ret15m,
      ret30m: features.ret30m,
      buyRatio3: features.buyRatio3,
      buyRatio15: features.buyRatio15,
      volume: features.impulseVolumeRatio,
      breakoutGapAtr: features.breakoutGapAtr,
      extensionAtr: features.extensionAtr,
      blockers: impulseBlockers(features),
      liveContext,
    },
    replay: replay(item.symbol, candles),
    btcGatedReplay: replay(item.symbol, candles, btcAt),
  };
});

const valid = rows.filter(row => !row.error);
const depthRows = await mapLimit(universe, 6, async item => {
  const depth = depthMetrics(await binance.depth(item.symbol, 100), item.lastPrice);
  return {
    symbol: item.symbol,
    bid: depth.bidNotional05,
    ask: depth.askNotional05,
    spreadBps: depth.spreadBps,
    pass100k: depth.bidNotional05 >= 100_000 && depth.askNotional05 >= 100_000 && depth.spreadBps <= 10,
    pass50k: depth.bidNotional05 >= 50_000 && depth.askNotional05 >= 50_000 && depth.spreadBps <= 12,
  };
});
const sortedDepth = [...depthRows].sort((a, b) => Math.min(b.bid, b.ask) - Math.min(a.bid, a.ask));
const depthCoverage = {
  measured: depthRows.length,
  passConfigured100k: depthRows.filter(row => row.pass100k).length,
  passCandidate50k: depthRows.filter(row => row.pass50k).length,
  top: sortedDepth.slice(0, 12).map(row => ({
    symbol: row.symbol,
    bidUsd: Math.round(row.bid),
    askUsd: Math.round(row.ask),
    spreadBps: Number(row.spreadBps.toFixed(2)),
  })),
};
const aggregate = { armed: 0, retested: 0, signaled: 0, rejected: 0, holds: {}, rejections: {}, setupTypes: {} };
const btcGatedPriceFlowAggregate = {
  armed: 0, retested: 0, signaled: 0, rejected: 0,
  btcBlockedImpulses: 0, btcCandidateRejected: 0, holds: {}, rejections: {}, setupTypes: {},
};
for (const row of valid) {
  for (const key of ['armed', 'retested', 'signaled', 'rejected']) aggregate[key] += row.replay[key];
  for (const [key, count] of Object.entries(row.replay.holds)) aggregate.holds[key] = Number(aggregate.holds[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.replay.rejections)) aggregate.rejections[key] = Number(aggregate.rejections[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.replay.setupTypes)) aggregate.setupTypes[key] = Number(aggregate.setupTypes[key] ?? 0) + count;
  for (const key of ['armed', 'retested', 'signaled', 'rejected', 'btcBlockedImpulses', 'btcCandidateRejected']) {
    btcGatedPriceFlowAggregate[key] += row.btcGatedReplay[key];
  }
  for (const [key, count] of Object.entries(row.btcGatedReplay.holds)) btcGatedPriceFlowAggregate.holds[key] = Number(btcGatedPriceFlowAggregate.holds[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.btcGatedReplay.rejections)) btcGatedPriceFlowAggregate.rejections[key] = Number(btcGatedPriceFlowAggregate.rejections[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.btcGatedReplay.setupTypes)) btcGatedPriceFlowAggregate.setupTypes[key] = Number(btcGatedPriceFlowAggregate.setupTypes[key] ?? 0) + count;
}

const currentImpulses = valid.filter(row => row.current.impulse);
const topMomentum = [...valid].sort((a, b) => b.current.ret30m - a.current.ret30m).slice(0, 12);
const replaySignals = valid.filter(row => row.replay.signaled > 0)
  .sort((a, b) => b.replay.signaled - a.replay.signaled || b.replay.retested - a.replay.retested);
const replaySignalRiskNow = await mapLimit(replaySignals, 4, async row => {
  const features = currentFeatures.get(row.symbol);
  const [book, oi, premium, historyRows] = await Promise.all([
    binance.depth(row.symbol, 100),
    binance.oiContext(row.symbol),
    binance.premiumIndex(row.symbol),
    binance.klines(row.symbol, '5m', 300),
  ]);
  const depth = depthMetrics(book, features.last.close);
  const history = historyRisk(closedCandles(parseKlines(historyRows)));
  const fundingPct = Number(premium.lastFundingRate) * 100;
  const risk = assessManipulationRisk({
    features, oi, depth, previousDepth: null, history, fundingPct, cfg,
  });
  return {
    symbol: row.symbol,
    hardBlock: risk.hardBlock,
    score: risk.score,
    reasons: risk.reasons,
    fundingPct,
    oiChangePct: oi.changePct,
  };
});
const replaySignalDepthNow = replaySignals.map(row => {
  const depth = depthRows.find(item => item.symbol === row.symbol);
  return {
    symbol: row.symbol,
    replaySignals: row.replay.signaled,
    bidUsd: Math.round(depth?.bid ?? 0),
    askUsd: Math.round(depth?.ask ?? 0),
    spreadBps: Number((depth?.spreadBps ?? 0).toFixed(2)),
    passesConfiguredDepthNow: Boolean(depth?.pass100k),
  };
});
const configuredDepthCohort = valid
  .filter(row => depthRows.find(item => item.symbol === row.symbol)?.pass100k)
  .map(row => ({
    symbol: row.symbol,
    armed: row.btcGatedReplay.armed,
    retested: row.btcGatedReplay.retested,
    signaled: row.btcGatedReplay.signaled,
    rejected: row.btcGatedReplay.rejected,
    holds: row.btcGatedReplay.holds,
    rejections: row.btcGatedReplay.rejections,
    setupTypes: row.btcGatedReplay.setupTypes,
  }))
  .sort((a, b) => b.signaled - a.signaled || b.retested - a.retested || b.armed - a.armed);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  btc,
  universe: universe.length,
  depthCoverage,
  currentImpulses: currentImpulses.map(row => ({ symbol: row.symbol, ...row.current, blockers: undefined })),
  replayHours: replayMinutes / 60,
  rawPriceFlowReplay: aggregate,
  btcGatedPriceFlowReplay: btcGatedPriceFlowAggregate,
  configuredDepthCohort,
  replaySignalDepthNow,
  replaySignalRiskNow,
  replaySignals: replaySignals.map(row => ({ symbol: row.symbol, ...row.replay })).slice(0, 15),
  topMomentum: topMomentum.map(row => ({
    symbol: row.symbol,
    ret3m: Number(row.current.ret3m.toFixed(3)),
    ret15m: Number(row.current.ret15m.toFixed(3)),
    ret30m: Number(row.current.ret30m.toFixed(3)),
    buy15: Number((row.current.buyRatio15 * 100).toFixed(1)),
    volume: Number(row.current.volume.toFixed(2)),
    gapAtr: Number(row.current.breakoutGapAtr.toFixed(2)),
    setup: row.current.setupType,
  })),
}, null, 2));
