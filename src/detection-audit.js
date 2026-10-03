// Entry geometry and timing diagnostics. Never submits or authorizes an order.
export function detectionAudit(signal, now, fee = .0005, exitSlip = .0005) {
  if (!signal || ![signal.entry, signal.stop, signal.barCloseTime, now, fee, exitSlip].every(Number.isFinite)
    || signal.entry <= 0 || signal.stop <= 0 || fee < 0 || exitSlip < 0 || signal.barCloseTime > now
    || !['LONG', 'SHORT'].includes(signal.direction)
    || (signal.direction === 'LONG' ? signal.stop >= signal.entry : signal.stop <= signal.entry)) return null;
  const distance = Math.abs(signal.entry - signal.stop), costs = signal.entry * (2 * fee + exitSlip);
  return { detectedAt: now, confirmationAgeMs: now - signal.barCloseTime,
    stopDistancePct: distance / signal.entry * 100,
    approximateCostShare: costs / (distance + costs),
    breakoutAgeMs: Number.isFinite(signal.breakoutTime) ? now - signal.breakoutTime : null };
}

export class DetectionLedger {
  constructor({ max = 200 } = {}) { this.max = max; this.rows = []; this.seen = new Set(); }
  record(symbol, signal, now) {
    const key = `${symbol}:${signal.direction}:${signal.barCloseTime}`;
    if (this.seen.has(key)) return null;
    const audit = detectionAudit(signal, now); if (!audit) return null;
    const row = { key, symbol, direction: signal.direction, ...audit };
    this.rows.push(row); this.seen.add(key);
    while (this.rows.length > this.max) this.seen.delete(this.rows.shift().key);
    return row;
  }
}
