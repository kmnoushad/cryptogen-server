// Planning only. No exchange calls or order submissions in this module.
export const FUTURES_AUTO_LIMITS = Object.freeze({ maxOpen: 5, maxStopUsd: 5,
  targetNetUsd: 5, perTradeEquityRisk: 0.01, aggregateEquityRisk: 0.03,
  maxNotionalUsd: 150, leverage: 2, maxMarginFraction: 0.5 });

const floorStep = (n, step) => Math.floor(n / step + 1e-9) * step;

export function planFuturesAutoTrade({ direction, entry, stop, equity, available,
  open = [], feeRate, qtyStep, minQty, minNotional, limits = FUTURES_AUTO_LIMITS }) {
  const reject = reason => ({ allowed: false, reason });
  if (!['LONG', 'SHORT'].includes(direction)) return reject('Unknown direction');
  if (![entry, stop, equity, available, feeRate, qtyStep, minQty, minNotional]
    .every(Number.isFinite) || !(entry > 0 && stop > 0 && equity > 0 && available > 0
      && feeRate >= 0 && feeRate <= 0.01 && qtyStep > 0 && minQty > 0 && minNotional > 0))
    return reject('Account, market or exchange filters unavailable');
  if (direction === 'LONG' ? stop >= entry : stop <= entry) return reject('Structural stop is on the wrong side');
  if (!Array.isArray(open) || open.some(j => !Number.isFinite(j.riskUsd) || j.riskUsd < 0
    || !Number.isFinite(j.marginUsd) || j.marginUsd < 0)) return reject('Open risk unknown');
  if (open.length >= limits.maxOpen) return reject('Five-position cap reached');
  const committedRisk = open.reduce((sum, j) => sum + j.riskUsd, 0);
  const committedMargin = open.reduce((sum, j) => sum + j.marginUsd, 0);
  const riskBudget = Math.min(limits.maxStopUsd, equity * limits.perTradeEquityRisk,
    equity * limits.aggregateEquityRisk - committedRisk);
  const marginBudget = Math.min(available, equity * limits.maxMarginFraction - committedMargin);
  if (!(riskBudget > 0 && marginBudget > 0)) return reject('Equity risk or margin budget exhausted');
  const exitSlip = 0.0005;
  const perUnitLoss = direction === 'LONG'
    ? entry * (1 + feeRate) - stop * (1 - feeRate - exitSlip)
    : stop * (1 + feeRate + exitSlip) - entry * (1 - feeRate);
  if (!(perUnitLoss > 0)) return reject('Invalid modeled stop loss');
  const qty = floorStep(Math.min(riskBudget / perUnitLoss,
    limits.maxNotionalUsd / entry, marginBudget * limits.leverage / entry), qtyStep);
  if (!(qty >= minQty && qty * entry >= minNotional)) return reject('Safe size below exchange minimum');
  const plannedLossUsd = qty * perUnitLoss;
  // The $5 target is on the whole position, after modeled entry/exit fees and
  // exit slippage. This is not a partial-fill or execution-price guarantee.
  const target = direction === 'LONG'
    ? (limits.targetNetUsd / qty + entry * (1 + feeRate)) / (1 - feeRate - exitSlip)
    : (entry * (1 - feeRate) - limits.targetNetUsd / qty) / (1 + feeRate + exitSlip);
  if (!(target > 0 && (direction === 'LONG' ? target > entry : target < entry))) return reject('Net $5 target not feasible');
  return { allowed: true, direction, qty, entry, stop, target,
    targetMovePct: Math.abs(target / entry - 1) * 100,
    plannedLossUsd, riskBudget, marginUsd: qty * entry / limits.leverage,
    notionalUsd: qty * entry, openSlotsLeft: limits.maxOpen - open.length - 1 };
}
