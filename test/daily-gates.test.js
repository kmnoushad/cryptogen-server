import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyGateState, recordDailyGate, recordScanCoverage, formatDailyGates, futuresFundingBlock } from '../src/daily-gates.js';
const fixture = () => { let now = Date.parse('2026-10-13T19:59:59Z'); return { now: () => now, advance: ms => now += ms, row: { state: {} } }; };
test('GST midnight resets daily counts, coverage and deduplication', () => {
 const h=fixture(); recordDailyGate(h,'execution','Funding', 'AAA', {id:1});recordScanCoverage(h,'AAA');
 assert.equal(dailyGateState(h).buckets[0].count,1);h.advance(1000);
 assert.deepEqual(dailyGateState(h).buckets,[]);assert.deepEqual(h.dailyGates.scanned,[]);
 recordDailyGate(h,'execution','Funding','AAA',{id:1});assert.equal(h.dailyGates.buckets[0].count,1);
});
test('repeated authorization checks count once per candidate and reason', () => {
 const h=fixture();for(let i=0;i<5;i++)recordDailyGate(h,'authorization','Book stale','AAA',{id:7});
 recordDailyGate(h,'authorization','Book stale','AAA',{id:8});assert.equal(h.dailyGates.buckets[0].count,2);
});
test('daily audit is restored from existing journal state and reattached after lease reload', () => {
 const h=fixture();recordDailyGate(h,'execution','Funding','AAA',{id:1});const restored={now:h.now,row:JSON.parse(JSON.stringify(h.row))};
 assert.equal(dailyGateState(restored).buckets[0].count,1);
 restored.row={state:{}};dailyGateState(restored);assert.equal(restored.row.state.dailyGates.buckets[0].count,1);
});
test('scan coverage counts checked symbols, independently from rejected reasons', () => {
 const h=fixture();recordScanCoverage(h,'AAA');recordScanCoverage(h,'AAA');recordScanCoverage(h,'BBB');
 assert.equal(h.dailyGates.evaluations,3);assert.deepEqual(h.dailyGates.scanned,['AAA','BBB']);assert.equal(h.dailyGates.buckets.length,0);
});
test('all audit arrays stay bounded under many different events', () => {
 const h=fixture();for(let i=0;i<3000;i++){recordDailyGate(h,'execution','reason '+i,'AAA',{id:i});recordScanCoverage(h,'X'+i);}
 assert.ok(h.dailyGates.buckets.length<=64);assert.ok(h.dailyGates.seen.length<=1024);assert.ok(h.dailyGates.scanned.length<=1024);
});
test('execution reasons remain visible despite thousands of routine scan rejections', () => {
 const h=fixture();for(let i=0;i<100;i++)recordDailyGate(h,'scan','No setup','AAA',{id:i});recordDailyGate(h,'execution','Funding settlement within 15 minutes','AAA',{id:1});
 assert.match(formatDailyGates(h),/Funding settlement/);assert.match(formatDailyGates(h),/not trades/);
});
test('Telegram reasons are escaped and dynamic cost percentages share a bucket', () => {
 const h=fixture();recordDailyGate(h,'execution','<bad & data>');assert.match(formatDailyGates(h),/&lt;bad &amp; data&gt;/);
 for(const v of [30,71])recordDailyGate(h,'execution',`Modeled fees/slippage consume ${v}% of stop risk; maximum 25%`,'AAA',{id:v});
 assert.equal(h.dailyGates.buckets.find(x=>x.reason.startsWith('Modeled')).count,2);
});
test('funding reasons are distinct and exactly retain previous allowed/blocked predicates', () => {
 const now=1000000;const valid={symbol:'AAA',lastFundingRate:'.0001',time:now,nextFundingTime:now+900000};
 assert.equal(futuresFundingBlock(valid,'AAA',now),null);
 assert.match(futuresFundingBlock({...valid,time:now-90001},'AAA',now),/stale/);
 assert.match(futuresFundingBlock({...valid,lastFundingRate:'.0008'},'AAA',now),/Extreme/);
 assert.match(futuresFundingBlock({...valid,nextFundingTime:now+899999},'AAA',now),/15 minutes/);
 for(const rate of [NaN,-.001,-.0008,-.00079,0,.00079,.0008,.001])for(const time of [NaN,now-90001,now-90000,now,now+1])for(const next of [NaN,now-1,now+899999,now+900000]){
  const f={symbol:'AAA',lastFundingRate:rate,time,nextFundingTime:next};
  const old=!Number.isFinite(rate)||Math.abs(rate)>=.0008||!Number.isFinite(time)||now-time>90000||time>now||!Number.isFinite(next)||next-now<900000;
  assert.equal(Boolean(futuresFundingBlock(f,'AAA',now)),old);
 }
});
import { FadeSpikeSource } from '../src/fade-spike-source.js';
import { selectFuturesUniverse } from '../src/futures-auto-strategy.js';
test('source replacement and repeated authorization rejection are auditable without changing latest-only dispatch',()=>{
 const h=fixture(), source=new FadeSpikeSource({now:h.now,environment:'live',isPaused:()=>false});
 source.onGate=(...args)=>recordDailyGate(h,...args);source.connected.add('market:0');
 source.symbolStreams.set('AAA',{market:'market:0'});let seq=0;
 source.detector={symbols:new Set(['AAA']),states:new Map(),ingest:()=>({candidate:true,symbol:'AAA',entry:1,detectedAt:++seq})};
 source.ingest({e:'aggTrade',s:'AAA',T:h.now(),p:'1',q:'1',a:1},'market:0');
 source.ingest({e:'aggTrade',s:'AAA',T:h.now(),p:'1',q:'1',a:2},'market:0');
 assert.equal(source.pending.length,1);assert.equal(source.pending[0].detectedAt,2);
 assert.equal(h.dailyGates.buckets.find(x=>x.stage==='candidate drop').count,1);
 source.rejectCandidate('AAA',source.pending[0],'Book stale');source.rejectCandidate('AAA',source.pending[0],'Book stale');
 assert.equal(h.dailyGates.buckets.find(x=>x.stage==='authorization').count,1);
});
test('selector group counts reflect distinct selected coins and exclude outside-scan coins',()=>{
 const now=Date.now();const symbols=Array.from({length:140},(_,i)=>i===0?'BTCUSDT':`A${i}USDT`);
 const result=selectFuturesUniverse({now,maxSymbols:60,cursor:0,
 exchangeInfo:{symbols:symbols.map(symbol=>({symbol,baseAsset:symbol.slice(0,-4),status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',onboardDate:now-90*86400000}))},
 tickers:symbols.map((symbol,i)=>({symbol,quoteVolume:String(1e8-i*1e5),count:'10000',lastPrice:'1',priceChangePercent:String(i%20-10)}))});
 assert.equal(result.symbols.length,60);assert.equal(Object.values(result.selectionGroups).reduce((a,b)=>a+b),60);
 assert.equal(result.selectionGroups.rotation,10);assert.equal(result.notSelected,80);
});

import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDailyGates, writeDailyGateCheckpoint } from '../src/daily-gates.js';
test('local checkpoints survive restart, remain separate per account scope and ignore yesterday',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nexio-audit-'));const previous=process.env.NEXIO_GATE_AUDIT_DIR;
 process.env.NEXIO_GATE_AUDIT_DIR=dir;const h=fixture(),f=fixture();h.scope='fade:live';f.scope='futures:live';
 try {
  recordDailyGate(h,'execution','Funding');recordDailyGate(f,'execution','Cooldown');
  await writeDailyGateCheckpoint(h);await writeDailyGateCheckpoint(f);
  assert.equal((await readdir(dir)).length,2);
  const restored={now:h.now,scope:h.scope};await loadDailyGates(restored);
  assert.equal(dailyGateState(restored).buckets[0].reason,'Funding');
  const newer={now:()=>h.now()+1000,scope:h.scope};await loadDailyGates(newer);assert.equal(dailyGateState(newer).buckets.length,0);
 } finally {
  clearTimeout(h.gateAuditTimer);clearTimeout(f.gateAuditTimer);
  if(previous===undefined)delete process.env.NEXIO_GATE_AUDIT_DIR;else process.env.NEXIO_GATE_AUDIT_DIR=previous;
  await rm(dir,{recursive:true,force:true});
 }
});
