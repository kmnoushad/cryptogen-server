// Entry-only risk accounting. Times are Dubai (GST) calendar days; Binance
// income is the source of realized PnL, commissions and funding, not deposits.
export const gstDayStart = now => Math.floor((now + 4 * 3600000) / 86400000) * 86400000 - 4 * 3600000;
const KINDS = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

export function fadeRiskDecision({ rows, jobs, equity, now, dayLossPct = 0.02, cooldownMs = 4 * 3600000 }) {
  const blocked = reason => ({ allowed: false, reason });
  if (!(equity > 0) || !Array.isArray(rows) || !Array.isArray(jobs)) return blocked('Risk data unavailable');
  const dayStart = gstDayStart(now);
  let dailyNet = 0;
  for (const row of rows) {
    if (!KINDS.has(row.incomeType)) continue;
    const amount = Number(row.income), time = Number(row.time);
    if (row.asset !== 'USDT' || !Number.isFinite(amount) || !Number.isFinite(time)) return blocked('Risk income incomplete or not USDT');
    if (time >= dayStart && time <= now) dailyNet += amount;
  }
  if (dailyNet <= -equity * dayLossPct) return blocked('Daily net loss limit reached');
  const lastClosed = jobs.filter(j => j.phase === 'CLOSED' && Number(j.filledQty) > 0)
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, 2);
  if (lastClosed.some(j => !Number.isFinite(j.closedAt))) return blocked('Closed-trade accounting unavailable');
  const recent = now - lastClosed[0]?.closedAt <= cooldownMs
    ? lastClosed.filter(j => Number.isFinite(j.closedAt) && now - j.closedAt <= 7 * 86400000) : [];
  const outcomes = [];
  for (const j of recent) {
    if (!Number.isFinite(j.createdAt) || !Number.isFinite(j.closedAt) || j.closedAt > now) return blocked('Closed-trade accounting unavailable');
    const matching = rows.filter(r => r.asset === 'USDT' && r.symbol === j.symbol
      && Number(r.time) >= j.createdAt && Number(r.time) <= j.closedAt + 60000 && KINDS.has(r.incomeType));
    // Binance can post fees / PnL later. Unknown outcomes must not reset the streak.
    if (!matching.some(r => r.incomeType === 'REALIZED_PNL') || !matching.some(r => r.incomeType === 'COMMISSION')) {
      return blocked('Closed-trade fees or PnL unverified');
    }
    outcomes.push(matching.reduce((sum, r) => sum + Number(r.income), 0));
  }
  if (outcomes.length === 2 && outcomes.every(n => n < 0) && now - recent[0].closedAt < cooldownMs) {
    return blocked('Two consecutive losses; four-hour cooldown');
  }
  return { allowed: true, reason: 'Daily net and loss streak clear', dailyNet };
}

export async function readFadeRisk(exchange, jobs, equity, now) {
  const lastClosed = jobs.filter(j => j.phase === 'CLOSED' && Number(j.filledQty) > 0)
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, 2);
  if (lastClosed.some(j => !Number.isFinite(j.closedAt))) return { allowed: false, reason: 'Closed-trade accounting unavailable' };
  const recent = now - lastClosed[0]?.closedAt <= 4 * 3600000
    ? lastClosed.filter(j => Number.isFinite(j.closedAt) && now - j.closedAt <= 7 * 86400000) : [];
  const startTime = Math.min(gstDayStart(now), ...recent.map(j => j.createdAt));
  if (!Number.isFinite(startTime) || startTime < now - 7 * 86400000) return { allowed: false, reason: 'Risk history older than seven days' };
  const rows = [];
  // Page until strictly fewer than 1000 rows; a truncated window is never safe.
  for (let page = 1; page <= 5; page++) {
    const batch = await exchange.income({ startTime, endTime: now, page, limit: 1000 });
    if (!Array.isArray(batch)) return { allowed: false, reason: 'Risk income response invalid' };
    rows.push(...batch);
    if (batch.length < 1000) return fadeRiskDecision({ rows, jobs, equity, now });
  }
  return { allowed: false, reason: 'Risk income pagination exceeded' };
}
