// Execution quality only; these bounds do not establish a trading edge.
export const ENTRY_MAX_COST_SHARE = 0.25;
export function entryQuality({ direction, entry, stop, reference, fee, exitSlip = 0.0005 }) {
  const reject = reason => ({ allowed: false, reason });
  if (!['LONG', 'SHORT'].includes(direction) || ![entry, stop, reference, fee, exitSlip].every(Number.isFinite)
    || entry <= 0 || stop <= 0 || reference <= 0 || fee < 0 || fee > .01 || exitSlip < 0 || exitSlip > .01)
    return reject('Entry quality inputs unavailable');
  const sign = direction === 'LONG' ? 1 : -1;
  const distance = sign * (entry - stop);
  if (distance <= 0) return reject('Structural invalidation reached');
  const costs = entry * fee + stop * (fee + exitSlip);
  const costShare = costs / (distance + costs);
  const chase = sign * (entry - reference);
  const chaseLimit = Math.min(reference * .0015, distance * .25);
  if (chase > chaseLimit + 1e-10) return { ...reject('Price advanced beyond no-chase budget'), costShare, chase, chaseLimit };
  if (costShare > ENTRY_MAX_COST_SHARE + 1e-10)
    return { ...reject(`Modeled fees/slippage consume ${(costShare * 100).toFixed(1)}% of stop risk; maximum 25%`), costShare };
  return { allowed: true, costShare, chase, chaseLimit };
}

export function nextClosedMinuteDelay(now, grace = 1500) {
  if (!Number.isFinite(now) || !Number.isFinite(grace) || grace < 0 || grace >= 60000)
    throw Error('Invalid candle scheduler time');
  let next = Math.floor(now / 60000) * 60000 + grace;
  if (next <= now) next += 60000;
  return next - now;
}
