// Entry-only risk accounting. Times are Dubai (GST) calendar days; Binance
// income is the source of realized PnL, commissions and funding, not deposits.
export const gstDayStart = now => Math.floor((now + 4 * 3600000) / 86400000) * 86400000 - 4 * 3600000;
const KINDS = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

export function fadeRiskDecision({ rows, jobs, equity, now, dayLossPct = 0.02, cooldownMs = 4 * 3600000 }) {
  const blocked = reason => ({ allowed: false, reason });
  if (!(equity > 0) || !Array.isArray(rows) || !Array.isArray(jobs)) return blocked('Risk data unavailable');
  const dayStart = gstDayStart(now);
  const weekStart = now - 7 * 86400000;
  let dailyNet = 0, dailyPeak = 0, weeklyNet = 0, weeklyPeak = 0;
  const byTime = new Map(), weeklyByTime = new Map();
  for (const row of rows) {
    if (!KINDS.has(row.incomeType)) continue;
    const amount = Number(row.income), time = Number(row.time);
    if (row.asset !== 'USDT' || !Number.isFinite(amount) || !Number.isFinite(time)) return blocked('Risk income incomplete or not USDT');
    if (time >= dayStart && time <= now) byTime.set(time, (byTime.get(time) ?? 0) + amount);
    if (time >= weekStart && time <= now) weeklyByTime.set(time, (weeklyByTime.get(time) ?? 0) + amount);
  }
  // Group same-timestamp realized PnL and commission to avoid treating a
  // gross fill as a profit peak before its simultaneously posted fee.
  for (const [, amount] of [...byTime].sort((a, b) => a[0] - b[0])) {
    dailyNet += amount;
    dailyPeak = Math.max(dailyPeak, dailyNet);
  }
  for (const [, amount] of [...weeklyByTime].sort((a, b) => a[0] - b[0])) {
    weeklyNet += amount;
    weeklyPeak = Math.max(weeklyPeak, weeklyNet);
  }
  if (dailyNet <= -equity * dayLossPct) return blocked('Daily net loss limit reached');
  // New entries stop after a real, fee-adjusted profitable day gives back
  // meaningful gains. This does not liquidate open positions or guarantee PnL.
  if (dailyPeak >= Math.max(3, equity * 0.02)
    && dailyPeak - dailyNet >= Math.max(2, equity * 0.01)) {
    return blocked('Daily realized profit giveback limit reached');
  }
  // A good week must not silently turn into a large multi-day loss. A negative
  // seven-day net also stops continuous reload-and-retry behavior. Both limits
  // gate fresh entries only; 7-day history expires on a rolling basis.
  if (weeklyPeak >= Math.max(10, equity * 0.05)
    && weeklyPeak - weeklyNet >= Math.max(5, equity * 0.03)) {
    return blocked('Rolling seven-day realized profit giveback limit reached');
  }
  if (weeklyNet <= -Math.max(10, equity * 0.05)) {
    return blocked('Rolling seven-day realized loss limit reached');
  }
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
  return { allowed: true, reason: 'Daily and seven-day realized risk clear', dailyNet, dailyPeak, weeklyNet, weeklyPeak };
}

export async function readFadeIncome(exchange, startTime, now, maxPages = 5) {
  if (!Number.isFinite(startTime) || !Number.isFinite(now) || startTime > now || maxPages < 1) throw Error('Invalid fade income window');
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await exchange.income({ startTime, endTime: now, page, limit: 1000 });
    if (!Array.isArray(batch) || batch.length > 1000) throw Error('Risk income response invalid');
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
  throw Error('Risk income pagination exceeded');
}

export async function readFadeRisk(exchange, jobs, equity, now) {
  const lastClosed = jobs.filter(j => j.phase === 'CLOSED' && Number(j.filledQty) > 0)
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, 2);
  if (lastClosed.some(j => !Number.isFinite(j.closedAt))) return { allowed: false, reason: 'Closed-trade accounting unavailable' };
  const recent = now - lastClosed[0]?.closedAt <= 4 * 3600000
    ? lastClosed.filter(j => Number.isFinite(j.closedAt) && now - j.closedAt <= 7 * 86400000) : [];
  const startTime = Math.min(now - 7 * 86400000, ...recent.map(j => j.createdAt));
  if (!Number.isFinite(startTime) || startTime < now - 7 * 86400000) return { allowed: false, reason: 'Risk history older than seven days' };
  // Page until strictly fewer than 1000 rows; a truncated window is never safe.
  try { return fadeRiskDecision({ rows: await readFadeIncome(exchange, startTime, now), jobs, equity, now }); }
  catch { return { allowed: false, reason: 'Risk income unavailable or incomplete' }; }
}
