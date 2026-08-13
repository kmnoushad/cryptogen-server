import { detectPumpDumpEpisodes } from './indicators.js';

const estimateBuyFill = (asks, orderNotionalUsd) => {
  let remaining = orderNotionalUsd;
  let quantity = 0;
  let spent = 0;
  for (const ask of asks) {
    if (remaining <= 0) break;
    const levelNotional = ask.price * ask.quantity;
    const levelSpend = Math.min(remaining, levelNotional);
    quantity += levelSpend / ask.price;
    spent += levelSpend;
    remaining -= levelSpend;
  }
  return {
    complete: remaining <= Math.max(0.01, orderNotionalUsd * 1e-9),
    averagePrice: quantity > 0 ? spent / quantity : Infinity,
    unfilledUsd: Math.max(0, remaining),
  };
};

export const depthMetrics = (book, referencePrice, orderNotionalUsd = 1_000) => {
  if (!Array.isArray(book?.bids) || !Array.isArray(book?.asks) || !book.bids.length || !book.asks.length) {
    throw new Error('Order book missing');
  }
  const bids = book.bids.map(([p, q]) => ({ price: Number(p), quantity: Number(q) }));
  const asks = book.asks.map(([p, q]) => ({ price: Number(p), quantity: Number(q) }));
  if (![...bids, ...asks].every(x => x.price > 0 && x.quantity >= 0)) throw new Error('Order book invalid');
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const ref = referencePrice > 0 ? referencePrice : mid;
  const bidNotional05 = bids.filter(x => x.price >= ref * 0.995)
    .reduce((sum, x) => sum + x.price * x.quantity, 0);
  const askNotional05 = asks.filter(x => x.price <= ref * 1.005)
    .reduce((sum, x) => sum + x.price * x.quantity, 0);
  const bidTop3 = bids.slice(0, 3).reduce((sum, x) => sum + x.price * x.quantity, 0);
  const askTop3 = asks.slice(0, 3).reduce((sum, x) => sum + x.price * x.quantity, 0);
  const buyFill = estimateBuyFill(asks, orderNotionalUsd);
  return {
    bestBid,
    bestAsk,
    mid,
    spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : Infinity,
    bidNotional05,
    askNotional05,
    imbalance: askNotional05 > 0 ? bidNotional05 / askNotional05 : Infinity,
    top3Imbalance: askTop3 > 0 ? bidTop3 / askTop3 : Infinity,
    assumedOrderNotionalUsd: orderNotionalUsd,
    estimatedBuyPrice: buyFill.averagePrice,
    entryImpactBps: buyFill.complete && bestAsk > 0
      ? ((buyFill.averagePrice - bestAsk) / bestAsk) * 10_000
      : Infinity,
    unfilledOrderUsd: buyFill.unfilledUsd,
    measuredAt: Date.now(),
  };
};

export const historyRisk = candles5m => {
  const events = detectPumpDumpEpisodes(candles5m, {
    lookbackBars: 6,
    pumpBars: 3,
    aftermathBars: 12,
    pumpPct: 5,
    minGiveback: 0.65,
  });
  return {
    events,
    repeated: events.length >= 2,
    reason: events.length ? `${events.length} non-overlapping pump/retrace episode(s) in history` : 'clean',
  };
};

export const assessManipulationRisk = ({
  features, oi, depth, previousDepth, history, fundingPct, cfg,
}) => {
  let score = 0;
  const reasons = [];
  let terminalRisk = false;
  let armBlock = false;
  const add = (points, reason, { terminal = false, blockArm = false } = {}) => {
    score += points;
    reasons.push(reason);
    terminalRisk ||= terminal;
    armBlock ||= blockArm || terminal;
  };

  if (features.ret1m >= 1.6 || features.ret5m >= 4) add(3, 'vertical price expansion', { terminal: true });
  if (features.extensionAtr > 2.2) add(2, `${features.extensionAtr.toFixed(1)} ATR above EMA20`);
  if (features.volumeZ >= 4 && features.deltaRatio1 <= 0) add(3, 'volume climax with net taker selling', { terminal: true });
  if (features.upperWickPct >= 40) add(2, `upper wick ${features.upperWickPct.toFixed(0)}%`);
  if (features.ret1m <= -1.2) add(4, `one-minute crash ${features.ret1m.toFixed(2)}%`, { terminal: true });
  if (oi.changePct < -1.5 && features.ret3m > 0) add(3, `price up while OI falls ${oi.changePct.toFixed(2)}%`, { terminal: true });
  if (fundingPct > 0.03) add(2, `crowded positive funding ${fundingPct.toFixed(3)}%`);
  // Repeated pump/retrace history is useful context, but it is not proof that
  // the current setup is manipulated. Keep it as a soft caution; live depth,
  // spread, crash, OI and sell-delta checks retain hard-block authority.
  if (history?.repeated) add(2, history.reason);

  if (depth.spreadBps > cfg.maxSpreadBps) {
    add(3, `spread ${depth.spreadBps.toFixed(1)} bps`, {
      blockArm: true,
      terminal: depth.spreadBps > cfg.maxSpreadBps * 2.5,
    });
  }
  if (depth.bidNotional05 < cfg.minDepthEachSideUsd) {
    add(3, `bid depth only $${Math.round(depth.bidNotional05).toLocaleString()}`, {
      blockArm: true,
      terminal: depth.bidNotional05 < cfg.minDepthEachSideUsd * 0.40,
    });
  }
  if (depth.askNotional05 < cfg.minDepthEachSideUsd) add(2, `ask depth only $${Math.round(depth.askNotional05).toLocaleString()}`);
  if (depth.imbalance < 0.55) add(2, `weak bid/ask depth ${depth.imbalance.toFixed(2)}x`);

  if (previousDepth && Date.now() - previousDepth.measuredAt < 10 * 60_000) {
    const bidRetention = previousDepth.bidNotional05 > 0 ? depth.bidNotional05 / previousDepth.bidNotional05 : 1;
    const spreadExpansion = previousDepth.spreadBps > 0 ? depth.spreadBps / previousDepth.spreadBps : 1;
    if (bidRetention < 0.55 && spreadExpansion > 1.5) {
      add(4, `bid depth collapsed ${((1 - bidRetention) * 100).toFixed(0)}% as spread widened`, { terminal: true });
    }
  }

  // `hardBlock` preserves the strict arm-time universe gate. Once a candidate
  // is already armed, strategy.js only terminally rejects `terminalRisk`.
  // Temporary depth/spread/caution failures remain `entryBlocked` and must
  // recover before FIRE, but no longer erase an otherwise intact retest.
  const hardBlock = terminalRisk || armBlock || score >= 5;
  return {
    score,
    hardBlock,
    terminalRisk,
    entryBlocked: hardBlock,
    reasons,
  };
};
