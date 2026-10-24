import test from 'node:test';import assert from 'node:assert/strict';
import {momentumSignal,validMomentum,momentumReentry,volatilityStop,MOMENTUM_VERSION,shortRetest} from '../src/momentum-live-policy.js';
import {MomentumRanker,MomentumLiveWorker} from '../src/momentum-live-worker.js';
import {momentumFixture,clock} from './fixtures/momentum-live.js';
test('compressed rise and real volume can enter LONG without FVG/sweep',()=>{const s=momentumSignal(momentumFixture());assert.equal(s.allowed,true,s.reason);assert.equal(s.direction,'LONG');assert.ok(validMomentum(s,s.entry,clock));});
test('tiny slope, weak buying, no compression, stale data and one vertical candle are rejected',()=>{
 for(const mutate of [x=>x.m1.forEach(r=>{r[10]=r[7]*.49;}),x=>x.m1.forEach(r=>{r[4]=100;r[1]=99.99;r[2]=100.1;r[3]=99.9;}),x=>{x.m1[420][2]=120;},x=>{x.now+=120000;},x=>{x.m1.at(-1)[4]=110;x.m1.at(-1)[2]=110.1;}]){const x=momentumFixture();mutate(x);assert.equal(momentumSignal(x).allowed,false);}
});
test('unreclaimed recent climax blocks dead-cat LONG',()=>{const x=momentumFixture(),b=x.m15.at(-3);b[1]=100;b[2]=104;b[3]=99.7;b[4]=100.3;b[5]=1000;assert.match(momentumSignal(x).reason,/climax/);});
test('ordinary pullback is not a SHORT; climax plus closed HTF breakdown is required',()=>{
 const x=momentumFixture();x.m1=x.m1.map(r=>{const q=[...r];q[1]=200-r[1];q[2]=200-r[3];q[3]=200-r[2];q[4]=200-r[4];q[10]=r[7]-r[10];return q;});
 assert.equal(momentumSignal(x).allowed,false);
 const b=x.m15.at(-4);Object.assign(b,{1:100,2:104,3:99.7,4:100.3,5:1000});
 Object.assign(x.m15.at(-1),{1:99.8,2:99.9,3:99.4,4:99.5});
 const s=momentumSignal(x);assert.equal(s.allowed,true,s.reason);assert.equal(s.direction,'SHORT');
 Object.assign(x.m1[496],{1:99.85,2:99.90,3:99.50,4:99.60});
 Object.assign(x.m1[497],{1:99.60,2:99.68,3:99.55,4:99.60});
 Object.assign(x.m1[498],{1:99.65,2:99.70,3:99.25,4:99.30});
 const rearm=momentumSignal(x);assert.equal(rearm.kind,'SHORT_RETEST_RESUMPTION');assert.equal(rearm.pullbackStart,x.m1[496][0]);
});
test('price band, timestamp and stop side are enforced',()=>{const s=momentumSignal(momentumFixture());assert.equal(validMomentum(s,s.entryMax+1,clock),false);assert.equal(validMomentum(s,s.entry,clock+100000),false);assert.equal(validMomentum({...s,stop:110},s.entry,clock),false);});
test('verified empty attempts do not erase a filled campaign or consume its attempts',()=>{
 const empty={symbol:'AAAUSDT',phase:'CLOSED',policyVersion:MOMENTUM_VERSION,filledQty:0,noFillVerified:true,createdAt:clock-1000,closedAt:clock-500};
 const s={direction:'LONG',kind:'PULLBACK_RESUMPTION',pullbackStart:clock-10000};
 assert.equal(momentumReentry([empty],'AAAUSDT',s,clock).attempt,0);
 const filled={...empty,noFillVerified:false,filledQty:1,createdAt:clock-1200000,closedAt:clock-660000,momentumExitVerified:true,verifiedNet:-1,direction:'LONG',reentryAttempt:0,campaignRiskBudget:1};
 assert.equal(momentumReentry([filled,empty],'AAAUSDT',s,clock).riskScale,.5);
 assert.equal(momentumReentry([{...empty,noFillVerified:false}],'AAAUSDT',s,clock).allowed,false);
 assert.equal(momentumReentry([{...filled,momentumExitVerified:false,closedAt:clock-7*3600000}],'AAAUSDT',s,clock).allowed,false);
});
test('SHORT re-entry needs a new post-exit failed retest and keeps loss/campaign limits',()=>{
 const p={symbol:'AAAUSDT',phase:'CLOSED',direction:'SHORT',policyVersion:MOMENTUM_VERSION,filledQty:1,createdAt:clock-1200000,closedAt:clock-660000,momentumExitVerified:true,verifiedNet:-1,reentryAttempt:0,campaignRiskBudget:1};
 const s={direction:'SHORT',kind:'SHORT_RETEST_RESUMPTION',pullbackStart:clock-60000};
 assert.equal(momentumReentry([p],'AAAUSDT',s,clock).riskScale,.5);
 for(const change of [{kind:'CLIMAX_BREAKDOWN'},{pullbackStart:p.closedAt},{direction:'LONG'}])assert.equal(momentumReentry([p],'AAAUSDT',{...s,...change},clock).allowed,false);
 for(const change of [{closedAt:clock-1000},{reentryAttempt:2},{momentumExitVerified:false}])assert.equal(momentumReentry([{...p,...change}],'AAAUSDT',s,clock).allowed,false);
});
test('closed-bar SHORT retest requires a distinct support break and renewed breakdown',()=>{
 const a=Array.from({length:25},(_,i)=>({time:clock-(25-i)*60000,end:clock-(24-i)*60000-1,open:101,high:101.2,low:100,close:100.5,quote:100,buy:35}));
 Object.assign(a[22],{open:100.5,high:100.6,low:99.5,close:99.6});
 Object.assign(a[23],{open:99.6,high:100.05,low:99.55,close:99.7});
 Object.assign(a[24],{open:99.7,high:99.8,low:99.2,close:99.3});
 assert.equal(shortRetest(a,1).start,a[22].time);
 const bad=structuredClone(a);bad[23].close=100.4;assert.equal(shortRetest(bad,1),null);
 bad[23].close=99.7;bad[24].close=99.6;assert.equal(shortRetest(bad,1),null);
});
test('ranker sees early movers outside top gainers, without treating rolling-volume delta as flow',()=>{
 const r=new MomentumRanker(),symbols=Array.from({length:100},(_,i)=>({symbol:`C${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',onboardDate:clock-30*86400000}));
 const rows=symbols.map(s=>({symbol:s.symbol,lastPrice:'100',quoteVolume:'6000000',count:'2000',priceChangePercent:'0'}));
 r.select({symbols},rows,clock);const moved=rows.map(x=>x.symbol==='C99USDT'?{...x,lastPrice:'103',quoteVolume:'5000001'}:x);
 const selected=r.select({symbols},moved,clock+300000);assert.ok(selected.symbols.includes('C99USDT'));assert.equal(selected.eligible.length,100);assert.equal(selected.warm,100);assert.equal(selected.symbols.length,24);
});
test('listing age and contract eligibility retained; 59% daily gain no longer blocks long quality',()=>{
 const ranker=new MomentumRanker(),s={symbol:'AAAUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',onboardDate:clock-30*86400000},t={symbol:s.symbol,lastPrice:'1',quoteVolume:'6000000',count:'10000',priceChangePercent:'59'};
 assert.equal(ranker.select({symbols:[s]},[t],clock).quality.get(s.symbol).longAllowed,true);
 assert.equal(ranker.select({symbols:[{...s,onboardDate:clock-86400000}]},[t],clock).symbols.length,0);
});
test('profit re-entry requires fresh pullback, loss cooldown and campaign caps survive restart',()=>{
 const signal={direction:'LONG',kind:'PULLBACK_RESUMPTION',pullbackStart:clock-60000};
 const p={symbol:'AAAUSDT',phase:'CLOSED',direction:'LONG',policyVersion:MOMENTUM_VERSION,createdAt:clock-1200000,closedAt:clock-120000,momentumExitVerified:true,verifiedNet:1,reentryAttempt:0,campaignStartedAt:clock-1200000,campaignRiskBudget:1};
 assert.equal(momentumReentry([p],'AAAUSDT',signal,clock).riskScale,1);
 assert.equal(momentumReentry([{...p,verifiedNet:-1}],'AAAUSDT',signal,clock).allowed,false);
 assert.equal(momentumReentry([{...p,verifiedNet:-1,closedAt:clock-660000}],'AAAUSDT',signal,clock).riskScale,.5);
 for(const change of [{momentumExitVerified:false},{phase:'SUBMITTING'},{reentryAttempt:2},{direction:'SHORT'}])assert.equal(momentumReentry(JSON.parse(JSON.stringify([{...p,...change}])),'AAAUSDT',signal,clock).allowed,false);
 assert.equal(momentumReentry([p],'AAAUSDT',{...signal,kind:'BASE_BREAKOUT'},clock).allowed,false);
});
for(const direction of ['LONG','SHORT'])test(`${direction}: volatility trailing never widens; BE arms at 1R`,()=>{
 const long=direction==='LONG',j={direction,filters:{tick:.01},plan:{entry:100,stop:long?98:102,breakEven:long?100.16:99.84,plannedLossUsd:2}};
 const stop=volatilityStop(j,long?103:97,3,1);assert.ok(long?stop>=100.16:stop<=99.84);j.plan.stop=stop;
 assert.equal(volatilityStop(j,long?102.5:97.5,2,3),stop);
});
for(const direction of ['LONG','SHORT'])test(`${direction}: structural stop stays until 1R net; trail latch survives restart`,()=>{
 const long=direction==='LONG';
 let j={direction,filters:{tick:.01},plan:{entry:100,stop:long?98:102,breakEven:long?100.16:99.84,plannedLossUsd:2}};
 const initial=j.plan.stop;
 // Tiny ATR would previously tighten the stop immediately, even at a loss.
 for(const net of [-.1,0,1,1.999999]){
  assert.equal(volatilityStop(j,long?101:99,net,.1),initial);
  assert.notEqual(j.momentumTrailArmed,true);
 }
 const armed=volatilityStop(j,long?103:97,2,1);assert.equal(j.momentumTrailArmed,true);
 assert.ok(long?armed>=j.plan.breakEven:armed<=j.plan.breakEven);j.plan.stop=armed;
 j=JSON.parse(JSON.stringify(j));
 const next=volatilityStop(j,long?102.8:97.2,1.5,.5);
 assert.ok(long?next>armed:next<armed,'trail remains enabled below 1R after arming');j.plan.stop=next;
 assert.equal(volatilityStop(j,long?102.5:97.5,1,3),next,'ATR expansion never widens protection');
});
test('missing R inputs cannot arm trailing or widen a previously tightened stop',()=>{
 const j={direction:'LONG',filters:{tick:.01},plan:{entry:100,stop:100.2,breakEven:100.16,plannedLossUsd:2}};
 assert.equal(volatilityStop(j,100.5,NaN,.1),100.2);
 assert.equal(volatilityStop(j,100.5,.1,.1),100.2,'migrated stop remains intact before latch arms');
 assert.notEqual(j.momentumTrailArmed,true);
});
test('live worker does not scan before :03; snapshots and decisions captured without live orders',async()=>{
 let now=clock-2000;const calls=[],x=momentumFixture(clock);
 const executor={scope:'live:directional',cfg:{enabled:true,momentumStrategy:true},row:{state:{jobs:[],paused:false}},lastError:null,
  run:async()=>{},status:()=>'',failed:async e=>{throw e;},stop:()=>{},
  exchange:{info:async()=>({symbols:[{symbol:'ETHUSDT',status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',onboardDate:clock-30*86400000}]}),ticker24h:async()=>[{symbol:'ETHUSDT',lastPrice:'100.44',quoteVolume:'30000000',count:'10000',priceChangePercent:'45'}],candles:async(s,i)=>i==='1m'?x.m1:x.m15},
  onSignal:async(s,signal)=>{calls.push(signal);executor.reason='mock accepted';}};
 const events=[],worker=new MomentumLiveWorker({executor,store:{control:async()=>({paused:false}),heartbeat:async()=>{}},now:()=>now,log:async(k,v)=>events.push([k,v])});
 await worker.tick();assert.equal(events.length,0);now=clock;await worker.tick();assert.equal(calls.length,1);assert.ok(events.some(([k])=>k==='snapshot'));assert.ok(events.some(([k])=>k==='execution'));
 await worker.tick();assert.equal(calls.length,1);
});
