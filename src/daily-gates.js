import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml } from './util.js';
// Metrics never authorize orders. Existing journal saves and a coalesced local
// checkpoint preserve counters without adding Binance or database requests.
const dayStart = now => Math.floor((now + 14400000) / 86400000) * 86400000 - 14400000;
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const auditDir = () => process.env.NEXIO_GATE_AUDIT_DIR || '/var/lib/nexio-binance/gate-audit';
const auditFile = owner => join(auditDir(), hash(String(owner.scope)) + '.json');
export async function loadDailyGates(owner) {
  if (owner.gateAuditLoaded || !owner.scope) return;
  owner.gateAuditLoaded = true;
  try {
    const saved = JSON.parse(await readFile(auditFile(owner), 'utf8'));
    if (saved.day === dayStart(owner.now()) && Array.isArray(saved.buckets) && saved.buckets.length <= 64 &&
        Array.isArray(saved.seen) && saved.seen.length <= 1024 && Array.isArray(saved.scanned) && saved.scanned.length <= 1024 &&
        Number(saved.serial) > Number(owner.dailyGates?.serial ?? -1)) owner.dailyGates = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Daily gate checkpoint unavailable; metrics start from journal or memory');
  }
}
export async function writeDailyGateCheckpoint(owner) {
  const file = auditFile(owner), temp = file + '.' + process.pid + '.tmp';
  await mkdir(auditDir(), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify(dailyGateState(owner)), { mode: 0o600 });
  await rename(temp, file);
}
export function checkpointDailyGates(owner) {
  if (!owner.scope || owner.gateAuditTimer || owner.gateAuditWriting) return;
  owner.gateAuditTimer = setTimeout(() => {
    owner.gateAuditTimer = null; owner.gateAuditWriting = true;
    writeDailyGateCheckpoint(owner).catch(() => console.error('Daily gate checkpoint failed; worker continues'))
      .finally(() => { owner.gateAuditWriting = false; });
  }, 30000);
  owner.gateAuditTimer.unref?.();
}
export function dailyGateState(owner) {
  const day = dayStart(owner.now());
  const saved = owner.row?.state?.dailyGates;
  let state = owner.dailyGates;
  if (saved?.day === day && Number(saved.serial) > Number(state?.serial ?? -1)) state = saved;
  if (state?.day !== day || !Array.isArray(state.buckets) || !Array.isArray(state.seen) || !Array.isArray(state.scanned))
    state = { day, serial: 0, buckets: [], seen: [], scanned: [], evaluations: 0 };
  owner.dailyGates = state;
  if (owner.row?.state) owner.row.state.dailyGates = state;
  return state;
}
export function recordDailyGate(owner, stage, reason, symbol = '', { id, outcome = 'blocked' } = {}) {
  try {
    const state = dailyGateState(owner);
    stage = String(stage).slice(0, 24); reason = String(reason || 'Unspecified').slice(0, 120);
    if (/Modeled fees\/slippage consume/.test(reason)) reason = 'Modeled fees/slippage exceed 25% of stop risk';
    symbol = String(symbol).slice(0, 40);
    // Once per candidate/watch/reason; scans once per symbol/minute.
    const event = id == null ? null : hash(`${stage}:${symbol}:${id}:${reason}:${outcome}`);
    if (event && state.seen.includes(event)) return;
    if (event) { state.seen.push(event); if (state.seen.length > 1024) state.seen.shift(); }
    const key = hash(`${stage}:${reason}:${outcome}`);
    let bucket = state.buckets.find(x => x.key === key);
    if (!bucket) {
      if (state.buckets.length >= 63) {
        bucket = state.buckets.find(x => x.key === 'other');
        if (!bucket) { bucket = { key: 'other', stage: 'other', reason: 'Additional gate reasons', outcome: 'blocked', count: 0 }; state.buckets.push(bucket); }
      } else { bucket = { key, stage, reason, outcome, count: 0 }; state.buckets.push(bucket); }
    }
    bucket.count++; state.serial++; checkpointDailyGates(owner);
  } catch { /* Reporting must never interfere with protection or entry controls. */ }
}
export function recordScanCoverage(owner, symbol) {
  try {
    const state = dailyGateState(owner); state.evaluations++; state.serial++;
    if (!state.scanned.includes(symbol) && state.scanned.length < 1024) state.scanned.push(symbol);
    checkpointDailyGates(owner);
  } catch { /* best-effort metrics */ }
}
export function formatDailyGates(owner) {
  try {
    const state = dailyGateState(owner);
    const blocks = state.buckets.filter(x => x.outcome === 'blocked' || x.outcome === 'error');
    const render = rows => rows.sort((a,b) => b.count-a.count).slice(0,5)
      .map(x => `${x.count}× ${x.stage}: ${x.reason.slice(0,48)}`).join('\n');
    const scan = render(blocks.filter(x => x.stage === 'scan' || x.stage === 'scan data'));
    const entry = render(blocks.filter(x => x.stage !== 'scan' && x.stage !== 'scan data'));
    let text = 'Daily gate evaluations (GST; not trades):\n' +
      (scan ? `Scan blockers:\n${scan}\n` : '') + (entry ? `Entry/worker blockers:\n${entry}\n` : '') +
      (!scan && !entry ? 'none recorded\n' : '');
    const produced = state.buckets.find(x => x.stage === 'candidate' && x.reason === 'Produced')?.count ?? 0;
    const dropped = state.buckets.find(x => x.stage === 'candidate drop')?.count ?? 0;
    if (produced || dropped) text += `Candidates produced ${produced} · overwritten ${dropped}\n`;
    if (state.evaluations) text += `Daily coverage: ${state.scanned.length} distinct symbols checked · ${state.evaluations} evaluations\n`;
    return escapeHtml(text);
  } catch { return 'Daily gate metrics unavailable\n'; }
}
export function futuresFundingBlock(funding, symbol, now) {
  const rate = Number(funding.lastFundingRate), time = Number(funding.time), next = Number(funding.nextFundingTime);
  if (funding.symbol !== symbol || !Number.isFinite(rate) || !Number.isFinite(time) || now-time > 90000 || time > now || !Number.isFinite(next))
    return 'Funding context stale or invalid';
  if (Math.abs(rate) >= .0008) return 'Extreme funding; crowding risk';
  if (next-now < 900000) return 'Funding settlement within 15 minutes';
  return null;
}
