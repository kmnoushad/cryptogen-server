// A quote based warning for an owned short, never an order or a forecast.
export function fadeAdverseQuote(job, ask) {
  const entry = Number(job?.plan?.entry), stop = Number(job?.plan?.stop);
  if (job?.phase === 'RUNNER' || !(Number.isFinite(ask) && ask > 0
    && Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > entry)) return null;
  const used = (ask - entry) / (stop - entry);
  if (ask >= stop) return { used, state: 'STOP_REACHED' };
  if (used >= 0.75) return { used, state: 'NEAR_STOP' };
  return { used, state: 'CLEAR' };
}

export function fadeAdverseEntryBlocked(jobs, now) {
  return jobs.some(job => job.phase === 'OPEN' && job.adverseChecks >= 3
    && Number.isFinite(job.lastQuoteAt) && now - job.lastQuoteAt <= 60000 && now >= job.lastQuoteAt
    && fadeAdverseQuote(job, job.lastObservedAsk)?.state === 'NEAR_STOP');
}
