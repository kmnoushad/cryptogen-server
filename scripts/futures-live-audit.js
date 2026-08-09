import { BinanceClient, classifyBtcRegime, selectUniverse } from '../src/binance.js';
import { buildFeatures, closedCandles, impulseBlockers, parseKlines } from '../src/indicators.js';
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

const excluded = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT',
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
  const start = Math.max(45, candles.length - 360);
  let candidate = null;
  let armed = 0;
  let retested = 0;
  let signaled = 0;
  let rejected = 0;
  let btcBlockedImpulses = 0;
  let btcCandidateRejected = 0;
  const holds = {};
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
      candidate = null;
    } else if (decision.action === 'REJECT') {
      rejected++;
      candidate = null;
    }
  }
  return { armed, retested, signaled, rejected, btcBlockedImpulses, btcCandidateRejected, holds, setupTypes };
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
const rows = await mapLimit(universe, 6, async item => {
  const candles = closedCandles(parseKlines(await binance.klines(item.symbol, '1m', 500)));
  const features = buildFeatures(candles.slice(-90));
  if (!features) return { symbol: item.symbol, error: 'features incomplete' };
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
    },
    replay: replay(item.symbol, candles),
    btcGatedReplay: replay(item.symbol, candles, btcAt),
  };
});

const valid = rows.filter(row => !row.error);
const aggregate = { armed: 0, retested: 0, signaled: 0, rejected: 0, holds: {}, setupTypes: {} };
const btcGatedPriceFlowAggregate = {
  armed: 0, retested: 0, signaled: 0, rejected: 0,
  btcBlockedImpulses: 0, btcCandidateRejected: 0, holds: {}, setupTypes: {},
};
for (const row of valid) {
  for (const key of ['armed', 'retested', 'signaled', 'rejected']) aggregate[key] += row.replay[key];
  for (const [key, count] of Object.entries(row.replay.holds)) aggregate.holds[key] = Number(aggregate.holds[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.replay.setupTypes)) aggregate.setupTypes[key] = Number(aggregate.setupTypes[key] ?? 0) + count;
  for (const key of ['armed', 'retested', 'signaled', 'rejected', 'btcBlockedImpulses', 'btcCandidateRejected']) {
    btcGatedPriceFlowAggregate[key] += row.btcGatedReplay[key];
  }
  for (const [key, count] of Object.entries(row.btcGatedReplay.holds)) btcGatedPriceFlowAggregate.holds[key] = Number(btcGatedPriceFlowAggregate.holds[key] ?? 0) + count;
  for (const [key, count] of Object.entries(row.btcGatedReplay.setupTypes)) btcGatedPriceFlowAggregate.setupTypes[key] = Number(btcGatedPriceFlowAggregate.setupTypes[key] ?? 0) + count;
}

const currentImpulses = valid.filter(row => row.current.impulse);
const topMomentum = [...valid].sort((a, b) => b.current.ret30m - a.current.ret30m).slice(0, 12);
const replaySignals = valid.filter(row => row.replay.signaled > 0)
  .sort((a, b) => b.replay.signaled - a.replay.signaled || b.replay.retested - a.replay.retested);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  btc,
  universe: universe.length,
  currentImpulses: currentImpulses.map(row => ({ symbol: row.symbol, ...row.current, blockers: undefined })),
  replayHours: 6,
  rawPriceFlowReplay: aggregate,
  btcGatedPriceFlowReplay: btcGatedPriceFlowAggregate,
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
