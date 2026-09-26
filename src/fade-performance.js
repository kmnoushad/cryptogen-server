// Read-only accounting: Binance income is the source of realized cash flows;
// Supabase jobs supply bot ownership, exit reasons and sampled opportunity.
const TYPES = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'];
const amount = row => {
  const value = Number(row.income), time = Number(row.time);
  if (row.asset !== 'USDT' || !Number.isFinite(value) || !Number.isFinite(time)) throw Error('Incomplete USDT income history');
  return value;
};
const key = row => row.tranId == null ? null : `${row.incomeType}:${row.tranId}`;

export function summarizeFadePerformance(rows, jobs, since, now) {
  if (!Array.isArray(rows) || !Array.isArray(jobs) || !(since < now)) throw Error('Performance history unavailable');
  const seen = new Set();
  const flows = rows.filter(row => {
    if (!TYPES.includes(row.incomeType)) return false;
    amount(row);
    const id = key(row);
    if (id != null) { if (seen.has(id)) return false; seen.add(id); }
    return Number(row.time) >= since && Number(row.time) <= now;
  }).sort((a, b) => Number(a.time) - Number(b.time));
  const totals = Object.fromEntries(TYPES.map(type => [type, 0]));
  let running = 0, peak = 0, peakAt = since, drawdown = 0;
  const grouped = new Map();
  for (const row of flows) {
    totals[row.incomeType] += amount(row);
    const t = Number(row.time);
    grouped.set(t, (grouped.get(t) ?? 0) + amount(row));
  }
  for (const [time, delta] of grouped) {
    running += delta;
    if (running > peak) { peak = running; peakAt = time; }
    drawdown = Math.max(drawdown, peak - running);
  }
  const closed = jobs.filter(j => j.phase === 'CLOSED' && Number(j.filledQty) > 0
    && Number.isFinite(j.createdAt) && Number.isFinite(j.closedAt) && j.createdAt >= since && j.closedAt <= now);
  const classified = closed.map(job => {
    const matching = flows.filter(row => row.symbol === job.symbol && Number(row.time) >= job.createdAt
      && Number(row.time) <= job.closedAt + 300000);
    const verified = matching.some(row => row.incomeType === 'REALIZED_PNL')
      && matching.some(row => row.incomeType === 'COMMISSION');
    return { symbol: job.symbol, exit: job.closeReason ?? 'EXCHANGE_EXIT',
      closedAt: job.closedAt, net: matching.reduce((sum, row) => sum + amount(row), 0),
      fees: matching.filter(row => row.incomeType === 'COMMISSION').reduce((sum, row) => sum + amount(row), 0),
      peakSampledNet: Number.isFinite(job.peakOpenNet) ? job.peakOpenNet : null,
      verified, matched: matching };
  });
  const verified = classified.filter(j => j.verified);
  const matches = new Set(verified.flatMap(j => j.matched));
  return { totals, net: running, peak, peakAt, maxRealizedDrawdown: drawdown,
    currentGiveback: peak - running, count: verified.length,
    wins: verified.filter(j => j.net > 0).length, losses: verified.filter(j => j.net < 0).length,
    trades: classified.map(({ matched, ...rest }) => rest),
    otherOrOpenNet: flows.filter(row => !matches.has(row)).reduce((sum, row) => sum + amount(row), 0) };
}
