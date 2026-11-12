// NEXIO V8: research-only signal evaluator. No broker/exchange order calls.
// All timestamps must be synchronized UTC milliseconds. Quotes are executable bid/ask.
const WINDOWS = [500, 1000, 3000, 5000];
const median = a => { const b=[...a].sort((x,y)=>x-y); return b.length ? b[Math.floor(b.length/2)] : 0; };
export class GoldV8Research {
  constructor({maxAgeMs=500,maxSpreadUsd=0.5,minMoveUsd=0.25,maxLeadMs=3000,minSamples=10,historyMs=12000}={}) {
    Object.assign(this,{maxAgeMs,maxSpreadUsd,minMoveUsd,maxLeadMs,minSamples,historyMs});
    this.quotes=new Map(); this.events=[]; this.lastEventAt=-Infinity;
  }
  ingest(q) {
    if (!['MT5','GC','BINANCE'].includes(q?.venue) || ![q.bid,q.ask,q.exchangeTs,q.receivedTs].every(Number.isFinite) || q.ask<q.bid || q.bid<=0 || q.receivedTs<q.exchangeTs-1000) throw Error('invalid quote');
    const arr=this.quotes.get(q.venue)||[];
    if (arr.length && q.exchangeTs<arr[arr.length-1].exchangeTs) return {status:'OUT_OF_ORDER'};
    arr.push({...q,mid:(q.bid+q.ask)/2});
    this.quotes.set(q.venue,arr.filter(x=>x.exchangeTs>=q.exchangeTs-this.historyMs));
    return {status:'RECORDED'};
  }
  evaluate(now) {
    const mt=this.quotes.get('MT5')||[], gc=this.quotes.get('GC')||[];
    const m=mt.at(-1), g=gc.at(-1);
    if (!m || !g) return {status:'WAIT',reason:'MISSING_FEED'};
    if (now-m.receivedTs>this.maxAgeMs || now-g.receivedTs>this.maxAgeMs || m.receivedTs>now+100 || g.receivedTs>now+100) return {status:'WAIT',reason:'STALE_FEED'};
    if (m.ask-m.bid>this.maxSpreadUsd) return {status:'WAIT',reason:'SPREAD'};
    if (mt.length<this.minSamples || gc.length<this.minSamples) return {status:'WAIT',reason:'WARMUP'};
    const change=(arr,ms)=>{const end=arr.at(-1);const start=[...arr].reverse().find(x=>x.exchangeTs<=end.exchangeTs-ms);return start?end.mid-start.mid:null;};
    const mtMoves=WINDOWS.map(w=>change(mt,w)),gcMoves=WINDOWS.map(w=>change(gc,w));
    if ([...mtMoves,...gcMoves].some(x=>x===null)) return {status:'WAIT',reason:'INSUFFICIENT_HISTORY'};
    const direction=Math.sign(gcMoves[1]);
    if (!direction || Math.abs(gcMoves[1])<this.minMoveUsd) return {status:'WAIT',reason:'NO_IMPULSE'};
    if (Math.sign(gcMoves[0])!==direction || Math.sign(gcMoves[2])!==direction) return {status:'WAIT',reason:'UNSTABLE_IMPULSE'};
    // Different GC and spot price levels: compare changes, never absolute prices.
    // This is a candidate only, NOT proof of predictive lead/lag.
    const residual=direction*(gcMoves[1]-mtMoves[1]);
    if (residual<=this.minMoveUsd) return {status:'WAIT',reason:'NO_RESIDUAL'};
    const lag=Math.abs(m.exchangeTs-g.exchangeTs);
    if (lag>this.maxLeadMs) return {status:'WAIT',reason:'TIMESTAMP_GAP'};
    const candidate={status:'CANDIDATE',side:direction>0?'BUY':'SELL',residualUsd:residual,quoteGapMs:lag,mtMoves,gcMoves,at:now,executionEnabled:false};
    this.events.push(candidate);
    return candidate;
  }
}
