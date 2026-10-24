import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidate, archiveJob, jobDigest } from '../src/fade-job-archive.js';
const now = 30 * 86400000;
const jobs = Array.from({length: 6}, (_,i) => ({id: String(i), symbol:'AAAUSDT', phase:'CLOSED', filledQty:1, closedAt:i*86400000}));
test('archive retains active jobs, risk lookback and last two real exits', () => {
  assert.equal(archiveCandidate(jobs,now).id, '0');
  assert.equal(archiveCandidate(jobs.slice(-2), now), undefined);
  assert.equal(archiveCandidate([{...jobs[0], phase:'OPEN'}, {...jobs[1], closedAt:now-1000}], now), undefined);
});
test('archive requires read-back matching complete job, not just insert success/conflict', async () => {
  let event;
  const store={insertEvent:async e=>{event=e;return false;},get:async()=>[{payload:event.payload}]};
  assert.deepEqual(await archiveJob(store,'live:primary',jobs[0]),{id:'0',digest:jobDigest(jobs[0])});
  store.get=async()=>[{payload:{...event.payload,job:{...jobs[0],filledQty:99}}}];
  await assert.rejects(archiveJob(store,'live:primary',jobs[0]),/verification failed/);
});
