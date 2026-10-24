import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStructure, STRUCTURE_VERSION, insideGap, protectiveStop, reentryDecision, classifyStructuralExit } from '../src/structure-policy.js';
import { fixture } from './fixtures/structure-bars.js';
for(const direction of ['LONG','SHORT']) {
 test(`${direction}: ordered sweep, MSS, FVG retest accepted without future bars`,()=>{
   const s=detectStructure(fixture(direction),direction,3600001);
   assert.equal(s.allowed,true); assert.ok(s.sweepTime<s.mssTime && s.mssTime<s.fvgTime && s.fvgTime<s.barCloseTime);
   assert.ok(insideGap(s,s.entry)); assert.equal(insideGap(s,s.fvg.high+1),false);
 });
 test(`${direction}: missing sweep, weak delta, stale/gapped candles and broken FVG rejected`,()=>{
   for(const mutate of [b=>{b[56].low=99.9;b[56].high=100.1;b[56].close=100;},
     b=>{b[57].buy=5000;}, b=>{b[57].volume=10;}, b=>{b[59].time+=1;},
     b=>{b[59].end=3600001;}, b=>{b[59].close=direction==='LONG'?99.8:100.2;}]) {
     const b=fixture(direction); mutate(b); assert.equal(detectStructure(b,direction,3600001).allowed,false);
   }
   assert.equal(detectStructure(fixture(direction),direction,3700001).allowed,false);
 });
 test(`${direction}: .5R protects fees; .25R ratchet never widens after retrace`,()=>{
   const j={direction,fee:.0005,filters:{tick:.001},plan:{entry:100,qty:1,stop:direction==='LONG'?99:101,plannedLossUsd:1}};
   assert.equal(protectiveStop(j,direction==='LONG'?100.6:99.4,.49),j.plan.stop);
   const be=protectiveStop(j,direction==='LONG'?100.7:99.3,.5);
   assert.ok(direction==='LONG'?be>100:be<100);j.plan.stop=be;
   const next=protectiveStop(j,direction==='LONG'?102:98,1.3);
   assert.ok(direction==='LONG'?next>be:next<be);j.plan.stop=next;
   assert.equal(protectiveStop(j,direction==='LONG'?101:99,.8),next);
 });
}
test('re-entry reservations survive serialization and cap campaign at two attempts',()=>{
 const now=10_000_000,s={strategy:STRUCTURE_VERSION,sweepTime:now-1000};
 const first={id:'a',symbol:'ETHUSDT',direction:'LONG',phase:'CLOSED',policyVersion:STRUCTURE_VERSION,
  createdAt:now-600000,closedAt:now-180000,structuralStopExit:true,reentryAttempt:0,campaignRiskBudget:1,campaignStartedAt:now-600000};
 const jobs=[first];
 let r=reentryDecision(jobs,'ETHUSDT','LONG',s,now);assert.equal(r.riskScale,.5);
 jobs.push({...first,id:'b',createdAt:now-170000,reentryAttempt:1});
 r=reentryDecision(JSON.parse(JSON.stringify(jobs)),'ETHUSDT','LONG',s,now);assert.equal(r.riskScale,.25);
 jobs.push({...first,id:'c',createdAt:now-160000,reentryAttempt:2});
 assert.equal(reentryDecision(jobs,'ETHUSDT','LONG',s,now).allowed,false);
 for(const change of [{structuralStopExit:false},{closedAt:now-1000},{phase:'SUBMITTING'},{direction:'SHORT'}])
  assert.equal(reentryDecision([{...first,...change}],'ETHUSDT','LONG',s,now).allowed,false);
 assert.equal(reentryDecision([first],'ETHUSDT','LONG',{...s,sweepTime:first.closedAt-1},now).allowed,false);
});
test('native exit needs bound triggered order and full fill; failed read never grants re-entry',async()=>{
 const j={policyVersion:STRUCTURE_VERSION,symbol:'ETHUSDT',direction:'LONG',filledQty:1,structuralStop:99,plan:{stop:99},filters:{tick:.01,step:.01},stopId:'s',actions:{s:{id:'s',kind:'stop'}}};
 const algo={clientAlgoId:'s',symbol:'ETHUSDT',side:'SELL',orderType:'STOP_MARKET',triggerPrice:'99',actualOrderId:'123'};
 const order={orderId:123,symbol:'ETHUSDT',side:'SELL',status:'FILLED',executedQty:'1',reduceOnly:true};
 const ex={algo:async()=>algo,request:async()=>order};
 assert.equal(await classifyStructuralExit(ex,j),true);
 for(const patch of [{executedQty:'.5'},{side:'BUY'},{status:'NEW'},{orderId:999}]) {
  assert.equal(await classifyStructuralExit({...ex,request:async()=>({...order,...patch})},j),false);
 }
 assert.equal(await classifyStructuralExit(ex,{...j,plan:{stop:100.2}}),false);
 assert.equal(await classifyStructuralExit({...ex,algo:async()=>{throw Error('offline');}},j),false);
});
