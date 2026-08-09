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
  const bars = closedCandles.filter(c => c.closeTime > lastChecked).sort((a, b) => a.closeTime - b.closeTime);
  if (!bars.length) return { closed: false, patch: null };

  for (const candle of bars) {
    const stopHit = candle.low <= activeSl;
    const targetHit = candle.high >= tp1;
    // Conservative ordering: if both levels print in the same one-minute bar,
    // assume the stop happened first. Tick data would be needed to know otherwise.
    if (stopHit) {
      maePct = Math.min(maePct, (candle.low - entry) / entry * 100);
      return closeResult(trade, activeSl, breakevenArmed ? 'BREAKEVEN_STOP' : 'STOP', candle, cfg, mfePct, maePct);
    }
    mfePct = Math.max(mfePct, (candle.high - entry) / entry * 100);
    maePct = Math.min(maePct, (candle.low - entry) / entry * 100);
    if (targetHit) return closeResult(trade, tp1, 'TP1', candle, cfg, mfePct, maePct);

    // Deterministic closed-bar fade exit: once a trade reached +0.75R, close
    // at the candle close if it gives back at least 0.50R while still green.
    // The database outcome and the Telegram instruction therefore stay aligned.
    const peakR = initialRisk > 0 ? (mfePct / 100 * entry) / initialRisk : 0;
    const currentR = initialRisk > 0 ? (candle.close - entry) / initialRisk : 0;
    if (peakR >= 0.75 && peakR - currentR >= 0.50 && currentR > 0.10) {
      return closeResult(trade, candle.close, 'MOMENTUM_FADE', candle, cfg, mfePct, maePct);
    }

    if (!breakevenArmed && candle.close >= entry + cfg.breakevenAtR * initialRisk) {
      const costsPct = (2 * cfg.takerFeeBps + cfg.exitSlippageBps) / 100;
      activeSl = entry * (1 + costsPct / 100);
      breakevenArmed = true;
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
