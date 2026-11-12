// NEXIO Gold V8.3 — offline, read-only setup lifecycle and first-hit replay.
// No network I/O, broker access, order placement, or modification of source JSONL.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBars, loadTicks, lowerBound, m15Bias } from './gold-v82-replay.js';

const M5 = 300000;
const M15 = 900000;
const DEFAULTS = {
  impulseUsd: 0.25, impulseLookbackMs: 250,
  assumedSlippagePerSide: 0.15, entryDelayMs: 250,
  maxQuoteGapMs: 2000, fillToleranceMs: 500,
  horizonsMs: [10000, 30000, 60000],
  targetsUsd: [0.30, 0.60, 1.00],
  stopsUsd: [0.50, 1.00],
};

/** Completed candle filter: last M5 bar closed against bias; do not use current-bar data. */
export function setupForBar(m5, m15, barKey) {
  const start = barKey * M5;
  const direction = m15Bias(m15, start);
  if (!direction) return null;
  const prior = m5.get(barKey - 1);
  if (!prior?.covered || (prior.c-prior.o)*direction >= 0) return null;
  return {
    key: barKey, direction, start,
    end: start + M5,
    invalidation: direction > 0 ? prior.l : prior.h,
    fired: false, invalidated: false,
  };
}

/** Exits are evaluated in timestamp order on executable bid/ask sides. */
export function firstHitReplay(ticks, entryIndex, direction, {
  targetUsd, stopUsd, horizonMs, slippagePerSide=0.15,
  maxQuoteGapMs=2000, fillToleranceMs=500,
}){
  const entry = ticks[entryIndex];
  if (!entry) return {status:'missing-entry'};
  const priceIn = direction > 0 ? entry.ask + slippagePerSide : entry.bid - slippagePerSide;
  const deadline = entry.t + horizonMs;
  let lastTime = entry.t, mfe=-Infinity, mae=Infinity;
  let lastSeen = -1;
  for(let j=entryIndex;j<ticks.length;j++){
    const q=ticks[j];
    if (q.t > deadline) break;
    if (j>entryIndex && q.t-lastTime>maxQuoteGapMs) return {status:'quote-gap'};
    lastTime=q.t;
    lastSeen=j;
    const priceOut = direction > 0 ? q.bid - slippagePerSide : q.ask + slippagePerSide;
    const pnl = direction * (priceOut-priceIn);
    mfe=Math.max(mfe,pnl);mae=Math.min(mae,pnl);
    // Stop first if both would ever be simultaneously flagged (defensive ordering).
    if (pnl<=-stopUsd) return {status:'stop',pnl,mfe,mae,exitTs:q.t};
    if (pnl>=targetUsd) return {status:'target',pnl,mfe,mae,exitTs:q.t};
  }
  if (lastSeen<0 || Math.abs(ticks[lastSeen].t-deadline)>fillToleranceMs) return {status:'missing-exit'};
  const q=ticks[lastSeen];
  const priceOut=direction>0?q.bid-slippagePerSide:q.ask+slippagePerSide;
  return {status:'timeout',pnl:direction*(priceOut-priceIn),mfe,mae,exitTs:q.t};
}

function findAtOrAfter(ticks,t,tolerance){
  const i=lowerBound(ticks,t);
  return i<ticks.length && ticks[i].t-t<=tolerance ? i : -1;
}

/** One unique signal per bar-specific pullback setup. */
export function runV83(ticks, overrides={}) {
  const cfg={...DEFAULTS,...overrides};
  const m5=buildBars(ticks,M5);
  const m15=buildBars(ticks,M15);
  const params=[];
  for (const horizonMs of cfg.horizonsMs)
    for (const targetUsd of cfg.targetsUsd)
      for (const stopUsd of cfg.stopsUsd)
        params.push({horizonMs,targetUsd,stopUsd});

  const stats={
    quotes:ticks.length, setupsFound:0, setupsInvalidated:0,
    impulsesSeen:0, signals:0, missingEntry:0,
    signalTimes:[], grid:{}
  };
  for(const {horizonMs,targetUsd,stopUsd} of params)
    stats.grid[`${horizonMs}ms_target${targetUsd}_stop${stopUsd}`]=[];
  let active=null,lastBar=-1;
  for(let i=0;i<ticks.length;i++){
    const q=ticks[i],barKey=Math.floor(q.t/M5);
    if(barKey!==lastBar){
      active=setupForBar(m5,m15,barKey);
      if(active)stats.setupsFound++;
      lastBar=barKey;
    }
    if(!active || active.fired || active.invalidated) continue;
    // The current tick may invalidate the previous pullback's structural extreme.
    if ((active.direction>0 && q.mid<active.invalidation) ||
        (active.direction<0 && q.mid>active.invalidation)){
      active.invalidated=true;stats.setupsInvalidated++;continue;
    }
    const priorIndex=lowerBound(ticks,q.t-cfg.impulseLookbackMs+1)-1;
    if(priorIndex<0 || q.t-ticks[priorIndex].t>cfg.impulseLookbackMs+150) continue;
    const movement=q.mid-ticks[priorIndex].mid;
    if(Math.abs(movement)<cfg.impulseUsd) continue;
    stats.impulsesSeen++;
    if(Math.sign(movement)!==active.direction) continue;
    // One event consumes the setup even if the hypothetical entry is unavailable.
    active.fired=true;stats.signals++;
    stats.signalTimes.push(q.t);
    const ei=findAtOrAfter(ticks,q.t+cfg.entryDelayMs,cfg.fillToleranceMs);
    if(ei<0){stats.missingEntry++;continue;}
    for(const {horizonMs,targetUsd,stopUsd} of params){
      const key=`${horizonMs}ms_target${targetUsd}_stop${stopUsd}`;
      stats.grid[key].push(firstHitReplay(ticks,ei,active.direction,{
        horizonMs,targetUsd,stopUsd,
        slippagePerSide:cfg.assumedSlippagePerSide,
        maxQuoteGapMs:cfg.maxQuoteGapMs,
        fillToleranceMs:cfg.fillToleranceMs
      }));
    }
  }
  return stats;
}
export function summarizeV83(stats){
  const grid={};
  for(const [key,rows] of Object.entries(stats.grid)){
    const evaluated=rows.filter(x=>['target','stop','timeout'].includes(x.status));
    const statuses={};
    for(const r of rows)statuses[r.status]=(statuses[r.status]||0)+1;
    grid[key]={
      attempted:rows.length,evaluated:evaluated.length,
      targetHits:statuses.target||0,stopHits:statuses.stop||0,
      timeouts:statuses.timeout||0,quoteGaps:statuses['quote-gap']||0,
      missingExit:statuses['missing-exit']||0,
      meanPnlPerOz:evaluated.length?evaluated.reduce((s,x)=>s+x.pnl,0)/evaluated.length:null,
      winRate:evaluated.length?evaluated.filter(x=>x.pnl>0).length/evaluated.length:null
    };
  }
  return {quotes:stats.quotes,setupsFound:stats.setupsFound,
    setupsInvalidated:stats.setupsInvalidated,
    signals:stats.signals,missingEntry:stats.missingEntry,grid};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir=process.argv[2]||'/opt/nexio-leadlag/data';
  console.log('NEXIO V8.3 — read-only, chronological first-hit; commissions excluded');
  for(const day of ['2026-11-03','2026-11-12']){
    const ticks=loadTicks(dir,day);
    console.log('\nDAY',day);
    console.log(JSON.stringify(summarizeV83(runV83(ticks)),null,2));
  }
}
