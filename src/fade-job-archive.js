import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const jobDigest = job => createHash('sha256').update(JSON.stringify(canonical(job))).digest('hex');

export function archiveCandidate(jobs, now) {
  // Preserve the complete risk lookback and the latest two real exits even
  // during long quiet periods. Never discard unresolved/active intents.
  const lastTwo = new Set(jobs.filter(j => j.phase === 'CLOSED' && j.filledQty > 0)
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, 2).map(j => j.id));
  return jobs.filter(j => j.phase === 'CLOSED' && Number.isFinite(j.closedAt)
    && now - j.closedAt > 8 * 86400000 && !lastTwo.has(j.id))
    .sort((a, b) => a.closedAt - b.closedAt)[0];
}

export async function archiveJob(store, scope, job) {
  const snapshot = structuredClone(job), digest = jobDigest(snapshot);
  const key = `fade-job-archive-v1:${scope}:${job.id}`;
  await store.insertEvent({ event_key: key, event_type: 'FADE_JOB_ARCHIVE_V1', symbol: job.symbol,
    payload: { scope, digest, job: snapshot } });
  // Verify durability, including a previous successful insert whose response
  // was lost. A duplicate/conflict alone is not proof of a matching archive.
  const rows = await store.get('nexio_events', [['event_key', `eq.${key}`], ['select', 'payload']]);
  const p = rows?.length === 1 ? rows[0].payload : null;
  if (p?.scope !== scope || p.digest !== digest || jobDigest(p.job) !== digest)
    throw Error('Fade archive verification failed; runtime job retained');
  return { id: snapshot.id, digest };
}
