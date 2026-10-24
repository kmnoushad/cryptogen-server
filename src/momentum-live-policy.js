import {closedSeries} from './futures-auto-strategy.js';
export const MOMENTUM_VERSION='momentum-live-v1';
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
export const atr=a=>avg(a.slice(-14).map((b,i,v)=>Math.max(b.high-b.low,Math.abs(b.high-(v[i-1]?.close??b.open)),Math.abs(b.low-(v[i-1]?.close??b.open)))));
export function fiveMinute(a,now){
 const groups=new Map();for(const b of a){const t=Math.floor(b.time/300000)*300000;if(!groups.has(t))groups.set(t,[]);groups.get(t).push(b);}
 return [...groups].filter(([t,v])=>v.length===5&&v[0].time===t&&v.at(-1).end===t+299999&&t+299999<now).map(([time,v])=>({time,end:time+299999,open:v[0].open,close:v.at(-1).close,high:Math.max(...v.map(b=>b.high)),low:Math.min(...v.map(b=>b.low)),volume:v.reduce((s,b)=>s+b.volume,0),quote:v.reduce((s,b)=>s+b.quote,0),buy:v.reduce((s,b)=>s+b.buy,0)}));
}
// Closed-bar support break, failed retest and renewed selling. The break and
// retest must be distinct bars; the trigger cannot retroactively define support.
export function shortRetest(a, atr1) {
 if (!(atr1 > 0) || a.length < 25) return null;
 const last=a.at(-1);
 for(let i=a.length-3;i>=Math.max(20,a.length-10);i--){
  const level=Math.min(...a.slice(i-10,i).map(b=>b.low)), broken=a[i];
  if(!(broken.close<level&&broken.close<broken.open))continue;
  const after=a.slice(i+1,-1);
  if(after.some(b=>b.close>level+.2*atr1))continue;
  const retest=after.find(b=>b.high>=level-.2*atr1&&b.high<=level+atr1&&b.close<level);
  if(retest&&last.close<retest.low&&last.close<broken.low&&last.close<last.open&&last.buy/last.quote<=.45)
   return {start:broken.time,level,retestTime:retest.end};
 }
 return null;
}
export function momentumSignal({symbol,m1,m15,now}){
 const reject=(reason,watch=false)=>({allowed:false,reason,watch});let a,h;
 try{a=closedSeries(m1,60000,now);h=closedSeries(m15,900000,now);}catch(e){return reject(e.message);}
 if(a.length<240)return reject('Momentum history needs 240 closed minutes');
 const f=fiveMinute(a,now);if(f.length<40)return reject('5m history incomplete');
 const last=a.at(-1),atr1=atr(a.slice(0,-1)),atr5=atr(f.slice(0,-1)),atr15=atr(h.slice(0,-1));
 if(![atr1,atr5,atr15].every(n=>n>0&&Number.isFinite(n)))return reject('Volatility unavailable');
 const recent=a.slice(-5),baseline=a.slice(-35,-5),flow=recent.reduce((s,b)=>s+b.buy,0)/recent.reduce((s,b)=>s+b.quote,0);
 const rvol=avg(recent.map(b=>b.quote))/avg(baseline.map(b=>b.quote));
 const climax=h.map((b,i)=>({b,i})).filter(({b,i})=>i>=20&&i>=h.length-8&&b.volume>=avg(h.slice(i-20,i).map(x=>x.volume))*5&&b.high-b.low>=2*atr(h.slice(0,i))&&(b.high-Math.max(b.open,b.close))/(b.high-b.low)>=.25).at(-1)?.b;
 const base=a.slice(-100,-20),compression=(Math.max(...base.map(b=>b.high))-Math.min(...base.map(b=>b.low)))<=6*atr5;
 const rise=avg(a.slice(-10).map(b=>b.close))-avg(a.slice(-30,-20).map(b=>b.close));
 const higherLow=Math.min(...a.slice(-5).map(b=>b.low))>Math.min(...a.slice(-20,-5).map(b=>b.low));
 const bodyOK=last.high-last.low<=3*atr1,oneFlow=last.buy/last.quote;
 const pull=a.slice(-5,-1),pullback=pull.some(b=>b.close<b.open)&&avg(pull.map(b=>b.quote))<avg(a.slice(-15,-5).map(b=>b.quote));
 const resume=last.close>Math.max(...a.slice(-3,-1).map(b=>b.high))&&last.close>last.open&&oneFlow>=.55;
 const breakout=last.close>Math.max(...a.slice(-11,-1).map(b=>b.high));
 const localMean=avg(f.slice(-12).map(b=>b.close));
 const longOK=compression&&rise>=.5*atr1&&higherLow&&rvol>=1.4&&flow>=.55&&resume&&(breakout||pullback)&&last.close-localMean<=2*atr5;
 const result=(direction,stop,kind)=>({allowed:true,symbol,direction,entry:last.close,stop,atr:atr1,atr5,barCloseTime:last.end,breakoutTime:last.end,
  strategy:MOMENTUM_VERSION,kind,pullbackStart:pull[0].time,entryMin:last.close-Math.min(last.close*.0015,atr1*.25),entryMax:last.close+Math.min(last.close*.0015,atr1*.25),score:rvol+Math.abs(rise)/atr1,reason:kind});
 if(longOK&&bodyOK){
  if(climax&&last.close<(climax.high+climax.low)/2)return reject('Unreclaimed climax midpoint blocks LONG');
  const stop=Math.min(...f.slice(-3).map(b=>b.low))-.3*atr5;
  if(stop>0&&(last.close-stop)/last.close<=.04)return result('LONG',stop,pullback?'PULLBACK_RESUMPTION':'BASE_BREAKOUT');
 }
 // SHORT requires a real climax plus a closed 15m breakdown, not 24h gain alone.
 if(climax&&bodyOK&&last.close<(climax.high+climax.low)/2&&flow<=.45&&rvol>=1.4&&oneFlow<=.45
  &&h.at(-1).close<Math.min(...h.slice(-4,-1).map(b=>b.low))
  &&Math.max(...a.slice(-5).map(b=>b.high))<Math.max(...a.slice(-20,-5).map(b=>b.high))
  &&last.close<Math.min(...a.slice(-11,-1).map(b=>b.low))&&last.close<last.open){
  const stop=Math.max(...f.slice(-3).map(b=>b.high))+.3*atr5;
  if((stop-last.close)/last.close<=.04){
   const retest=shortRetest(a,atr1);
   return retest?{...result('SHORT',stop,'SHORT_RETEST_RESUMPTION'),pullbackStart:retest.start,retestTime:retest.retestTime,retestLevel:retest.level}:result('SHORT',stop,'CLIMAX_BREAKDOWN');
  }
 }
 return reject('Waiting for compressed base / meaningful rise / pullback or confirmed climax breakdown',compression&&rise>=.5*atr1&&higherLow&&rvol>=1.15);
}
export function validMomentum(s,price,now){return s?.strategy===MOMENTUM_VERSION&&['LONG','SHORT'].includes(s.direction)&&[s.entry,s.stop,s.atr5,s.entryMin,s.entryMax,s.barCloseTime,s.pullbackStart].every(Number.isFinite)&&s.entryMin>0&&s.entryMax>=s.entryMin&&s.atr5>0&&s.barCloseTime<now&&now-s.barCloseTime<=90000&&price>=s.entryMin&&price<=s.entryMax&&(s.direction==='LONG'?s.stop<price:s.stop>price);}
export function momentumReentry(jobs,symbol,signal,now){
 const no=reason=>({allowed:false,reason});const same=jobs.filter(j=>j.symbol===symbol);
 if(same.some(j=>j.phase!=='CLOSED'))return no('Symbol already reserved');
 // Unknown outcomes cannot become eligible merely by waiting six hours. A
 // verified zero-fill attempt is not a trade and does not consume a campaign.
 if(same.some(j=>j.policyVersion===MOMENTUM_VERSION&&!j.noFillVerified&&(!j.momentumExitVerified||!Number.isFinite(j.verifiedNet))))return no('Previous exit and net income unverified');
 const previous=same.filter(j=>!j.noFillVerified&&now-j.closedAt<6*3600000).sort((a,b)=>b.createdAt-a.createdAt)[0];
 if(!previous)return {allowed:true,attempt:0,riskScale:1,rootAt:now};
 if(previous.policyVersion!==MOMENTUM_VERSION)return now-previous.closedAt>=1800000?{allowed:true,attempt:0,riskScale:1,rootAt:now}:no('Legacy symbol cooldown');
 if(!previous.momentumExitVerified||!Number.isFinite(previous.verifiedNet))return no('Previous exit and net income unverified');
 if(previous.direction!==signal.direction)return no('No automatic campaign reversal');
 const attempt=(previous.reentryAttempt??0)+1;if(attempt>2)return no('Three-attempt campaign cap');
 const losing=previous.verifiedNet<=0;
 if(now-previous.closedAt<(losing?600000:60000))return no(losing?'Ten-minute stop-out cooldown':'Profit exit settling');
 const kind=signal.direction==='SHORT'?'SHORT_RETEST_RESUMPTION':'PULLBACK_RESUMPTION';
 if(signal.kind!==kind||!Number.isFinite(signal.pullbackStart)||signal.pullbackStart<=previous.closedAt)return no('Fresh post-exit pullback/retest required');
 return {allowed:true,attempt,riskScale:losing?.5:1,rootAt:previous.campaignStartedAt??previous.createdAt,rootBudget:previous.campaignRiskBudget};
}
export function volatilityStop(job,price,net,atr5){
 const long=job.direction==='LONG',p=job.plan,tick=job.filters.tick;
 job.peakPrice=long?Math.max(job.peakPrice??p.entry,price):Math.min(job.peakPrice??p.entry,price);
 if(!(atr5>0&&Number.isFinite(atr5)))return p.stop;
 // Retain the structural stop until a full modeled net R is observed. The
 // durable latch survives pullbacks/restarts; existing stops never widen.
 if(!Number.isFinite(net)||!Number.isFinite(p.plannedLossUsd)||!(p.plannedLossUsd>0))return p.stop;
 if(job.momentumTrailArmed!==true&&net<p.plannedLossUsd)return p.stop;
 job.momentumTrailArmed=true;
 let candidate=long?job.peakPrice-2*atr5:job.peakPrice+2*atr5;
 // Once armed, keep the cost-adjusted break-even floor on later pullbacks.
 candidate=long?Math.max(candidate,p.breakEven):Math.min(candidate,p.breakEven);
 const next=Number(((long?Math.floor(candidate/tick):Math.ceil(candidate/tick))*tick).toFixed(12));
 return long?(next>p.stop&&next<price-tick?next:p.stop):(next<p.stop&&next>price+tick?next:p.stop);
}
