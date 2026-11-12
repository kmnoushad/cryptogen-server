// Read-only XAUUSD historical study. No network calls, broker clients, or orders.
// Usage: node scripts/gold-v82-replay.js [data-directory]
import fs from 'node:fs';
import path from 'node:path';

const M5=300_000, M15=900_000;
export function lowerBound(arr, t) {
  let l=0,r=arr.length;
  while(l<r){const m=(l+r)>>1;if(arr[m].t<t)l=m+1;else r=m;}
  return l;
}
export function buildBars(ticks, period) {
  const bucket=new Map();
  for(const q of ticks) {
    const k=Math.floor(q.t/period);
    let b=bucket.get(k);
    if(!b){b={o:q.mid,h:q.mid,l:q.mid,c:q.mid,first:q.t,last:q.t,n:0};bucket.set(k,b);}
    b.h=Math.max(b.h,q.mid);b.l=Math.min(b.l,q.mid);
    b.c=q.mid;b.last=q.t;b.n++;
  }
  const out=new Map();
  for(const [k,b] of bucket) out.set(k,{
    ...b,covered:b.first-k*period<=15000 && b.last-k*period>=period-15000
  });
  return out;
}
export function priorBars(bars, t, period, count) {
  const k=Math.floor(t/period);
  const list=[];
  for(let j=count;j>=1;j--){
    const bar=bars.get(k-j);
    if(!bar?.covered)return null;
    list.push(bar);
  }
  return list;
}
export function m15Bias(bars,t) {
  const b=priorBars(bars,t,M15,3);
  if(!b)return 0;
  const change=b[2].c-b[0].c;
  return Math.abs(change)>=1 ? Math.sign(change) : 0;
}
export function hasPullback(bars,t,dir) {
  const b=priorBars(bars,t,M5,2);
  if(!b)return false;
  // One or two recently closed M5 candles counter to prevailing direction.
  return b.some(x=>(x.c-x.o)*dir<0);
}
export function hasCompression(bars,t) {
  const b=priorBars(bars,t,M5,6);
  if(!b)return false;
  const avg=a=>a.reduce((s,x)=>s+x.h-x.l,0)/a.length;
  return avg(b.slice(3))<avg(b.slice(0,3))*0.7;
}
export function loadTicks(dir,day) {
  const file=path.join(dir,day+'.jsonl');
  if(!fs.existsSync(file))return [];
  const ticks=[];
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line)continue;
    try {
      const q=JSON.parse(line);
      if(q.venue!=='MT5')continue;
      const t=q.receivedTs,bid=q.bid,ask=q.ask;
      if(![t,bid,ask].every(Number.isFinite)||bid<=0||ask<bid)continue;
      ticks.push({t,bid,ask,mid:(bid+ask)/2});
    }catch{ /* ignore malformed data */ }
  }
  return ticks.sort((a,b)=>a.t-b.t);
}
function nextIndex(ticks,t,tolerance=500){
  const i=lowerBound(ticks,t);
  return i<ticks.length && ticks[i].t-t<=tolerance ? i : -1;
}
export function evaluate(ticks, {threshold=0.25,lookback=250,cooldownMs=30000,slippage=0.15,horizons=[10000,30000,60000]}={}) {
  const times=ticks.map(x=>x.t);
  const m5=buildBars(ticks,M5),m15=buildBars(ticks,M15);
  const names=['impulse','trend','pullback','compression'];
  const last=Object.fromEntries(names.map(k=>[k,-Infinity]));
  const stats=Object.fromEntries(names.map(k=>[k,{candidates:0,qualifying:0,executed:{}}]));
  for(const key of names)for(const h of horizons)stats[key].executed[h]=[];
  let candidateCount=0;
  for(let i=0;i<ticks.length;i++){
    const q=ticks[i],oldIndex=lowerBound(ticks,q.t-lookback+1)-1;
    if(oldIndex<0 || q.t-ticks[oldIndex].t>lookback+150)continue;
    const move=q.mid-ticks[oldIndex].mid;
    if(Math.abs(move)<threshold)continue;
    candidateCount++;
    const dir=Math.sign(move),bias=m15Bias(m15,q.t);
    const eligibility={
      impulse:true,
      trend:bias===dir,
      pullback:bias===dir&&hasPullback(m5,q.t,dir),
      compression:bias===dir&&hasCompression(m5,q.t)
    };
    const eligible=names.filter(name=>eligibility[name] && q.t-last[name]>=cooldownMs);
    for(const name of eligible){
      last[name]=q.t;stats[name].qualifying++;
      const entryIndex=nextIndex(ticks,q.t+250);
      if(entryIndex<0)continue;
      const entry=ticks[entryIndex];
      for(const h of horizons) {
        const exitIndex=nextIndex(ticks,entry.t+h);
        if(exitIndex<0)continue;
        const exit=ticks[exitIndex];
        // Ignore outcomes that cross a long quote-recording outage.
        let worstGap=0;
        for(let j=entryIndex+1;j<=exitIndex;j++)worstGap=Math.max(worstGap,ticks[j].t-ticks[j-1].t);
        if(worstGap>2000)continue;
        const entryPrice=dir>0?entry.ask+slippage:entry.bid-slippage;
        const exitPrice=dir>0?exit.bid-slippage:exit.ask+slippage;
        const pnl=dir*(exitPrice-entryPrice);
        let mfe=-Infinity,mae=Infinity;
        for(let j=entryIndex;j<=exitIndex;j++){
          const mark=dir>0?ticks[j].bid-slippage:ticks[j].ask+slippage;
          const excursion=dir*(mark-entryPrice);
          mfe=Math.max(mfe,excursion);mae=Math.min(mae,excursion);
        }
        stats[name].executed[h].push({pnl,mfe,mae,entryTs:entry.t});
      }
    }
  }
  return {quotes:times.length,candidates:candidateCount,stats};
}
export function summarize(results) {
  const out={quotes:results.quotes,impulseComparisons:results.candidates,models:{}};
  for(const [name,s] of Object.entries(results.stats)){
    const outcomes={};
    for(const [h,rows] of Object.entries(s.executed)){
      const n=rows.length;
      outcomes[h]={n,winRate:n?rows.filter(x=>x.pnl>0).length/n:null,
        avgPnl:n?rows.reduce((a,x)=>a+x.pnl,0)/n:null,
        avgMfe:n?rows.reduce((a,x)=>a+x.mfe,0)/n:null,
        avgMae:n?rows.reduce((a,x)=>a+x.mae,0)/n:null};
    }
    out.models[name]={qualified:s.qualifying,outcomes};
  }
  return out;
}
if(process.argv[1] && path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const root=process.argv[2]||'/opt/nexio-leadlag/data';
  console.log('NEXIO V8.2 READ-ONLY REPLAY — commissions excluded, assumed 0.15/oz slippage each side');
  for(const day of ['2026-11-03','2026-11-12']){
    const ticks=loadTicks(root,day);
    console.log('\nDAY',day,JSON.stringify(summarize(evaluate(ticks)),null,2));
  }
}
