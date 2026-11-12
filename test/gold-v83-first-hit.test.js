import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBars } from '../scripts/gold-v82-replay.js';
import { firstHitReplay, runV83, setupForBar, summarizeV83 } from '../scripts/gold-v83-first-hit.js';
const M5=300000, M15=900000;
function q(t,mid,spread=0.10){return {t,bid:mid-spread/2,ask:mid+spread/2,mid};}
function bar(k,period,o,c){return [q(k*period+1000,o),q((k+1)*period-1000,c)];}
test('uses only a completed countertrend M5 bar and completed M15 bias',()=>{
  const m15=buildBars([
    ...bar(0,M15,4000,4000),...bar(1,M15,4000,4001),
    ...bar(2,M15,4001,4003),
    ...bar(3,M15,4003,3900)
  ],M15);
  const m5=buildBars([
    ...bar(8,M5,4005,4004),
    ...bar(9,M5,4004,4100)
  ],M5);
  const s=setupForBar(m5,m15,9);
  assert.equal(s.direction,1);
  assert.equal(s.key,9);
  assert.equal(s.invalidation,4004);
  assert.equal(setupForBar(m5,m15,8),null);
});
test('first hit target precedes later stop and marks executable bid/ask with costs',()=>{
  const ticks=[q(0,100),q(200,100.4),q(400,99.0)];
  const out=firstHitReplay(ticks,0,1,{
    targetUsd:0.2,stopUsd:0.5,horizonMs:1000,slippagePerSide:0,
  });
  assert.equal(out.status,'target');
  assert.ok(out.pnl>=0.2);
  assert.equal(out.exitTs,200);
});
test('stop is hit before later target and reports worse than stop on a jump',()=>{
  const ticks=[q(0,100),q(200,99.2),q(400,101.0)];
  const out=firstHitReplay(ticks,0,1,{
    targetUsd:0.2,stopUsd:0.5,horizonMs:1000,slippagePerSide:0,
  });
  assert.equal(out.status,'stop');
  assert.ok(out.pnl<-0.5);
  assert.equal(out.exitTs,200);
});
test('gaps invalidate an outcome rather than silently filling it',()=>{
  const ticks=[q(0,100),q(3000,100.5)];
  const out=firstHitReplay(ticks,0,1,{
    targetUsd:10,stopUsd:10,horizonMs:3000,maxQuoteGapMs:2000,
  });
  assert.equal(out.status,'quote-gap');
});
test('one signal per setup, and no trade activation for incomplete history',()=>{
  const ticks=[
    ...bar(0,M15,4000,4000),
    ...bar(1,M15,4000,4001),
    ...bar(2,M15,4001,4003),
    ...bar(8,M5,4005,4004),
    q(9*M5+100,4005),
    q(9*M5+350,4005.5),
    q(9*M5+600,4005.9),
    q(9*M5+900,4006.2),
    q(9*M5+1200,4006.3),
  ].sort((a,b)=>a.t-b.t);
  const r=runV83(ticks);
  assert.equal(r.setupsFound,1);
  assert.equal(r.signals,1);
  assert.equal(r.signalTimes.length,1);
  const summary=summarizeV83(r);
  assert.equal(summary.signals,1);
  assert.equal(summary.grid['10000ms_target0.3_stop0.5'].evaluated,0);
});
