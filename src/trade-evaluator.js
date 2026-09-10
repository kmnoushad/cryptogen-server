export const EXECUTION_MODEL = 'closed-bar-v2';

const executionPrice = (level, exitSlippageBps) => level * (1 - exitSlippageBps / 10_000);

const closeResult = (trade, rawExit, reason, candle, cfg, mfePct, maePct) => {
  const exitPrice = executionPrice(rawExit, cfg.exitSlippageBps);
  const grossPnlPct = (exitPrice - Number(trade.entry)) / Number(trade.entry) * 100;
  const feePct = 2 * Number(trade.fee_bps ?? cfg.takerFeeBps) / 100;
  const netPnlPct = grossPnlPct - feePct;
  const initialRiskPct = Number(trade.risk_per_unit) / Number(trade.entry) * 100 + feePct;
  const rMultiple = initialRiskPct > 0 ? netPnlPct / initialRiskPct : 0;
  const outcome = reason === 'TP1' ? 'WIN' : netPnlPct > 0.03 ? 'WIN' : netPnlPct < -0.03 ? 'LOSS' : 'SCRATCH';
  return {
    closed: true,
    patch: {
      status: 'CLOSED',
      setup: { ...trade.setup, exitExecutionModel: EXECUTION_MODEL },
      outcome,
      exit_price: exitPrice,
      exit_reason: reason,
      gross_pnl_pct: grossPnlPct,
      net_pnl_pct: netPnlPct,
      r_multiple: rMultiple,
      mfe_pct: mfePct,
      mae_pct: maePct,
      exit_alert_sent: false,
      last_checked_bar_close: candle.closeTime,
      closed_at: new Date(candle.closeTime).toISOString(),
    },
  };
};

// v6.9.9 FIX (Option A — discussed and approved after the 2026-09-04 TAO
// MOMENTUM_FADE incident): mirrors closeResult's exact PnL math WITHOUT
// closing the trade, so the fade gate can check "would this exit actually be
// net-profitable" using the SAME formula that ends up in the report. Before
// this, the gate compared raw candle.close against a flat 0.10 floor with no
// fee/slippage applied — on a tight stop (TAO: 0.156%), that 0.10R of raw
// cushion was worth less than the ~0.13% round-trip cost, so the gate could
// fire believing it was locking a profit while the recorded outcome was a
// net loss (observed: raw currentR ~0.13, reported r_multiple -0.42R).
const estimateNetRMultiple = (trade, rawPrice, cfg) => {
  const entry = Number(trade.entry);
  const exitPrice = executionPrice(rawPrice, cfg.exitSlippageBps);
  const grossPnlPct = (exitPrice - entry) / entry * 100;
  const feePct = 2 * Number(trade.fee_bps ?? cfg.takerFeeBps) / 100;
  const netPnlPct = grossPnlPct - feePct;
  const initialRiskPct = Number(trade.risk_per_unit) / entry * 100 + feePct;
  return initialRiskPct > 0 ? netPnlPct / initialRiskPct : 0;
};

export const evaluateTrade = (trade, closedCandles, cfg) => {
  const entry = Number(trade.entry);
  const tp1 = Number(trade.tp1);
  const initialRisk = Number(trade.risk_per_unit);
  let activeSl = Number(trade.active_sl);
  let breakevenArmed = Boolean(trade.breakeven_armed);
  let mfePct = Number(trade.mfe_pct ?? 0);
  let maePct = Number(trade.mae_pct ?? 0);
  let lastChecked = Number(trade.last_checked_bar_close ?? trade.entry_bar_close ?? 0);
  const createdAt = new Date(trade.created_at).getTime();
  // The first candle can start before the paper entry. Its extremes cannot
  // be attributed to the position. Use only its observed close; tick-level
  // data would be required to reconstruct the missing intraminute path.
  const bars = closedCandles.filter(c => c.closeTime > lastChecked && c.closeTime >= createdAt)
    .sort((a, b) => a.closeTime - b.closeTime)
    .map(c => Number(c.openTime ?? c.closeTime - 59_999) < createdAt
      ? { ...c, open: c.close, high: c.close, low: c.close }
      : c);
  if (!bars.length) return { closed: false, patch: null };

  for (const candle of bars) {
    const stopHit = candle.low <= activeSl;
    const targetHit = candle.high >= tp1;
    // Conservative ordering: if both levels print in the same one-minute bar,
    // assume the stop happened first. Tick data would be needed to know otherwise.
    if (stopHit) {
      // A sell stop gapped through cannot fill at the old trigger level.
      const rawExit = Math.min(activeSl, Number(candle.open ?? candle.close));
      maePct = Math.min(maePct, (rawExit - entry) / entry * 100);
      return closeResult(trade, rawExit, breakevenArmed ? 'BREAKEVEN_STOP' : 'STOP', candle, cfg, mfePct, maePct);
    }
    if (targetHit) {
      // Do not count price excursions beyond an already executed target.
      mfePct = Math.max(mfePct, (tp1 - entry) / entry * 100);
      maePct = Math.min(maePct, (Number(candle.open ?? entry) - entry) / entry * 100);
      return closeResult(trade, tp1, 'TP1', candle, cfg, mfePct, maePct);
    }
    mfePct = Math.max(mfePct, (candle.high - entry) / entry * 100);
    maePct = Math.min(maePct, (candle.low - entry) / entry * 100);

    // Deterministic closed-bar fade exit: once a trade reached +0.75R, close
    // at the candle close if it gives back at least 0.50R while still green.
    // The database outcome and the Telegram instruction therefore stay aligned.
    const peakR = initialRisk > 0 ? (mfePct / 100 * entry) / initialRisk : 0;
    const currentR = initialRisk > 0 ? (candle.close - entry) / initialRisk : 0;
    // v6.9.9: this clause now asks "is exiting HERE still worth it after
    // real costs" instead of "is raw price still above a raw floor" — see
    // estimateNetRMultiple above for why that distinction matters.
    const netCurrentR = estimateNetRMultiple(trade, candle.close, cfg);
    if (peakR >= 0.75 && peakR - currentR >= 0.50 && netCurrentR > (cfg.fadeMinNetR ?? 0.10)) {
      return closeResult(trade, candle.close, 'MOMENTUM_FADE', candle, cfg, mfePct, maePct);
    }

    if (!breakevenArmed && candle.close >= entry + cfg.breakevenAtR * initialRisk) {
      const feeFraction = 2 * Number(trade.fee_bps ?? cfg.takerFeeBps) / 10_000;
      const breakevenStop = entry * (1 + feeFraction) / (1 - cfg.exitSlippageBps / 10_000);
      // Never put a long sell stop above the market or lower an existing stop.
      if (breakevenStop < candle.close && breakevenStop > activeSl) {
        activeSl = breakevenStop;
        breakevenArmed = true;
      }
    }

    if (candle.closeTime - createdAt >= cfg.tradeTimeoutMin * 60_000) {
      return closeResult(trade, candle.close, 'TIMEOUT', candle, cfg, mfePct, maePct);
    }
    lastChecked = candle.closeTime;
  }

  return {
    closed: false,
    patch: {
      active_sl: activeSl,
      breakeven_armed: breakevenArmed,
      mfe_pct: mfePct,
      mae_pct: maePct,
      last_checked_bar_close: lastChecked,
    },
  };
};

export const closeTradeAtMarket = (trade, rawExit, closeTime, reason, cfg, { mfePct, maePct } = {}) => {
  const candle = { closeTime };
  return closeResult(
    trade,
    rawExit,
    reason,
    candle,
    cfg,
    Number(mfePct ?? trade.mfe_pct ?? 0),
    Number(maePct ?? trade.mae_pct ?? 0),
  );
};


