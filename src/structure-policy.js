// Pure closed-bar strategy. A swing sweep is a price proxy, not proof of a
// liquidation pool or institutional activity. No order-book history is invented.
export const STRUCTURE_VERSION = 'sweep-mss-fvg-v1';
export function detectStructure(bars, direction, now) {
  const reject = reason => ({ allowed: false, reason });
  if (!['LONG', 'SHORT'].includes(direction) || !Array.isArray(bars) || bars.length < 35)
    return reject('Structure data unavailable');
  if (bars.some((b,i) => !['time','end','open','high','low','close','volume','quote','buy'].every(k => Number.isFinite(b[k]))
    || b.end >= now || b.low <= 0 || b.high < Math.max(b.open,b.close) || b.low > Math.min(b.open,b.close)
    || b.volume <= 0 || b.quote <= 0 || b.buy < 0 || b.buy > b.quote
    || (i && b.time-bars[i-1].time !== 60000)) || now-bars.at(-1).end > 65000)
    return reject('Structure bars stale or invalid');
  const long = direction === 'LONG', last = bars.at(-1);
  for (let i=bars.length-4; i>=Math.max(20,bars.length-12); i--) {
    const prior=bars.slice(i-20,i), sweep=bars[i];
    const level=long?Math.min(...prior.map(b=>b.low)):Math.max(...prior.map(b=>b.high));
    if (!(long?sweep.low<level && sweep.close>level:sweep.high>level && sweep.close<level)) continue;
    const atr=prior.slice(-14).reduce((s,b,k,a)=>s+Math.max(b.high-b.low,Math.abs(b.high-(a[k-1]?.close??b.open)),Math.abs(b.low-(a[k-1]?.close??b.open))),0)/14;
    if (!(atr>0)) continue;
    const pivot=long?Math.max(...prior.slice(-3).map(b=>b.high)):Math.min(...prior.slice(-3).map(b=>b.low));
    for(let j=i+1;j<Math.min(i+5,bars.length-2);j++) {
      const m=bars[j], left=bars[j-1], right=bars[j+1];
      const avg=bars.slice(j-20,j).reduce((s,b)=>s+b.volume,0)/20;
      if (!(long?m.close>pivot && m.close>m.open:m.close<pivot && m.close<m.open)
        || Math.abs(m.close-m.open)<atr*.6 || m.volume<avg*1.3
        || (long?m.buy/m.quote<.55:m.buy/m.quote>.45)) continue;
      const low=long?left.high:right.high, high=long?right.low:left.low;
      if (!(high-low>=atr*.1)) continue;
      const after=bars.slice(j+2);
      if (!after.length || after.length>5 || after.some(b=>long?b.low<=sweep.low:b.high>=sweep.high)) continue;
      // A close through the far edge invalidates the gap. Entry must still be
      // inside the gap on the most recent closed bar, never chased afterwards.
      if (after.some(b=>long?b.close<low:b.close>high) || last.close<low || last.close>high
        || !(long?last.close>last.open:last.close<last.open)
        || (long?last.buy/last.quote<.55:last.buy/last.quote>.45)) continue;
      const stop=long?sweep.low-atr*.2:sweep.high+atr*.2;
      if (!(stop>0) || Math.abs(stop/last.close-1)>.015) continue;
      return { allowed:true, direction, entry:last.close, stop, atr, level,
        strategy:STRUCTURE_VERSION, sweepTime:sweep.end, mssTime:m.end, fvgTime:right.end,
        breakoutTime:sweep.end, barCloseTime:last.end, fvg:{low,high},
        score:Math.abs(m.close-m.open)/atr };
    }
  }
  return reject('No fresh sweep / volume-delta MSS / FVG retest');
}
export function insideGap(signal, price) {
  return signal?.strategy===STRUCTURE_VERSION && Number.isFinite(price)
    && Number.isFinite(signal.fvg?.low) && Number.isFinite(signal.fvg?.high)
    && signal.fvg.low>0 && signal.fvg.high>signal.fvg.low
    && price>=signal.fvg.low && price<=signal.fvg.high;
}
// Two reduced-risk attempts within a six-hour campaign. Reserved intents count,
// including an unknown or rejected dispatch, so retries cannot bypass the cap.
export function reentryDecision(jobs, symbol, direction, signal, now) {
  const reject=reason=>({allowed:false,reason});
  const same=jobs.filter(j=>j.symbol===symbol);
  if(same.some(j=>j.phase!=='CLOSED')) return reject('Symbol already reserved');
  const recent=same.filter(j=>Number.isFinite(j.closedAt) && now-j.closedAt<6*3600000)
    .sort((a,b)=>b.createdAt-a.createdAt);
  const previous=recent[0];
  if(!previous) return {allowed:true,attempt:0,riskScale:1,rootAt:now};
  if(previous.policyVersion!==STRUCTURE_VERSION) return now-previous.closedAt>=1800000
    ? {allowed:true,attempt:0,riskScale:1,rootAt:now}:reject('Legacy symbol cooldown');
  if(now-previous.closedAt<120000) return reject('Re-entry cooldown: two minutes');
  if(!previous.structuralStopExit || (previous.direction??'SHORT')!==direction)
    return reject('Re-entry requires verified structural stop-out in same direction');
  if(!(signal.sweepTime>previous.closedAt) || signal.strategy!==STRUCTURE_VERSION)
    return reject('Re-entry requires a new post-exit sweep');
  const attempt=(previous.reentryAttempt??0)+1;
  if(attempt>2) return reject('Re-entry campaign exhausted');
  const rootAt=previous.campaignStartedAt??previous.createdAt;
  if(now-rootAt>=6*3600000) return reject('Re-entry campaign expired');
  return {allowed:true,attempt,riskScale:attempt===1?.5:.25,rootAt,
    rootBudget:previous.campaignRiskBudget};
}
// Net-R ratchet: BE at .5R; from 1R lock .5R behind peak in .25R steps.
// Original risk remains immutable when the stop is tightened.
export function protectiveStop(job, price, net) {
  const p=job.plan, long=job.direction==='LONG', risk=p.plannedLossUsd??p.riskDollars;
  const previous=job.peakProtectionNet??0;
  if(![price,net,risk,p.qty,p.entry,job.fee,job.filters.tick,previous].every(Number.isFinite)
    || !(risk>0 && p.qty>0 && job.filters.tick>0)) return p.stop;
  job.peakProtectionNet=Math.max(previous,net);
  const peakR=job.peakProtectionNet/risk;
  if(peakR<.5) return p.stop;
  const lockR=peakR<1?0:Math.floor((peakR-.5)*4+1e-9)/4;
  const raw=long?(p.entry*(1+job.fee)+lockR*risk/p.qty)/(1-job.fee-.0005)
    :(p.entry*(1-job.fee)-lockR*risk/p.qty)/(1+job.fee+.0005);
  const tick=job.filters.tick;
  const next=Number(((long?Math.ceil(raw/tick-1e-9):Math.floor(raw/tick+1e-9))*tick).toFixed(12));
  // Never replace with a stop that has already been crossed.
  return long ? (next>p.stop && next<price-tick?next:p.stop)
    : (next<p.stop && next>price+tick?next:p.stop);
}
export async function classifyStructuralExit(exchange, job) {
  if(job.policyVersion!==STRUCTURE_VERSION || !(job.filledQty>0) || job.protectionFailure) return false;
  const tick=job.filters.tick, initial=job.structuralStop;
  if(!Number.isFinite(initial) || Math.abs(job.plan.stop-initial)>tick/2) return false;
  const side=job.direction==='LONG'?'SELL':'BUY';
  const valid=o=>o?.symbol===job.symbol && o.side===side && o.status==='FILLED'
    && Math.abs(Number(o.executedQty)-job.filledQty)<job.filters.step/2
    && (o.reduceOnly===true || o.reduceOnly==='true' || o.closePosition===true);
  try {
    if(job.closeReason==='STOP_PRICE_REACHED') {
      for(const [k,a] of Object.entries(job.actions).filter(([k])=>k.startsWith('x'))) {
        const o=await exchange.order(job.symbol,a.id);
        if(o.clientOrderId===a.id && valid(o)) return true;
      }
    }
    if(job.closeReason && job.closeReason!=='STOP_PRICE_REACHED') return false;
    const a=Object.values(job.actions).find(a=>a.id===job.stopId && a.kind==='stop');
    if(!a) return false;
    const algo=await exchange.algo(a.id);
    if(algo.clientAlgoId!==a.id || algo.symbol!==job.symbol || algo.side!==side
      || (algo.orderType??algo.type)!=='STOP_MARKET' || Math.abs(Number(algo.triggerPrice)-initial)>tick/2
      || !/^\d+$/.test(String(algo.actualOrderId??''))) return false;
    const o=await exchange.request('GET','/fapi/v1/order',{symbol:job.symbol,orderId:algo.actualOrderId});
    return String(o.orderId)===String(algo.actualOrderId) && valid(o);
  } catch { return false; } // Missing evidence never grants early re-entry.
}
