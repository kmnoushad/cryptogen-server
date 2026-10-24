import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeRiskDecision, gstDayStart } from '../src/fade-risk.js';
import { formatRiskStatus, newerRiskStatus } from '../src/risk-status.js';

const now = Date.parse('2026-10-13T14:52:00Z');
const row = (incomeType,income,time,symbol='AAAUSDT') => ({asset:'USDT',incomeType,income:String(income),time,symbol});

test('daily giveback includes check timestamp, amounts and next GST reset without changing decision',()=>{
  const result=fadeRiskDecision({equity:100,now,jobs:[],rows:[row('REALIZED_PNL',4,now-60000),row('REALIZED_PNL',-2.2,now-1000)]});
  assert.equal(result.allowed,false);assert.match(result.reason,/giveback/);
  assert.equal(result.checkedAt,now);assert.equal(result.resetAt,gstDayStart(now)+86400000);
  assert.equal(result.dailyPeak,4);assert.ok(Math.abs(result.dailyNet-1.8)<1e-9);
  const output=formatRiskStatus(result,now);
  assert.match(output,/BLOCKED/);assert.match(output,/14\/10\/2026, 00:00 GST/);assert.match(output,/giveback \$2.20/);
});

test('loss cooldown expiry comes from latest verified loss and configured duration',()=>{
  const jobs=Array.from({length:3},(_,i)=>({phase:'CLOSED',filledQty:1,symbol:`A${i}USDT`,createdAt:now-(12-i*3)*60000,closedAt:now-(10-i*3)*60000}));
  const rows=jobs.flatMap(j=>[row('REALIZED_PNL',-.1,j.closedAt,j.symbol),row('COMMISSION',-.01,j.closedAt,j.symbol)]);
  const result=fadeRiskDecision({equity:100,now,jobs,rows,cooldownMs:2*3600000});
  assert.equal(result.allowed,false);assert.equal(result.cooldownUntil,jobs[2].closedAt+2*3600000);
  assert.match(formatRiskStatus(result,now),/116 min remaining/);
  const before=structuredClone(result);
  const expired=formatRiskStatus(result,result.cooldownUntil+1);
  assert.match(expired,/PREVIOUSLY BLOCKED/);assert.match(expired,/eligibility needs rechecking/);
  assert.deepEqual(result,before); // Formatting must never clear a risk lock.
});

test('old clear snapshots are explicitly historical, and unavailable data is unverified',()=>{
  assert.match(formatRiskStatus({allowed:true,reason:'clear',checkedAt:now-180000},now),/PREVIOUSLY CLEAR/);
  assert.match(formatRiskStatus({allowed:false,reason:'Risk income unavailable',checkedAt:now},now),/UNVERIFIED/);
  assert.match(formatRiskStatus(null,now),/awaiting/);
  assert.match(formatRiskStatus({allowed:true,checkedAt:now+1,reason:'clear'},now),/awaiting/);
});

test('reason strings are escaped for Telegram HTML',()=>{
  assert.match(formatRiskStatus({allowed:false,reason:'<bad>',checkedAt:now},now),/&lt;bad&gt;/);
});

test('a slow background completion cannot replace a newer signal-time risk check',()=>{
  const fresh={allowed:true,reason:'clear',checkedAt:now};
  const old={allowed:false,reason:'old block',checkedAt:now-60000};
  assert.equal(newerRiskStatus(fresh,old),fresh);
  assert.equal(newerRiskStatus(old,fresh),fresh);
});
