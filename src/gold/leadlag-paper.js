// NEXIO isolated lead-lag research engine. No broker/order API imports.
import { EventEmitter } from 'node:events';

const finite = (x) => Number.isFinite(x);
const median = (values) => {
  const a = [...values].sort((x,y)=>x-y);
  return a.length ? (a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2) : 0;
};
export class LeadLagPaper extends EventEmitter {
  constructor({ balance=1000, riskUsd=5, maxAgeMs=1000, spikeUsd=2, maxLagMs=3000,
    stopUsd=2, targetUsd=3, maxHoldMs=10000, feeRate=0.0005, slippageUsd=0.15,
    minHistory=30, minNetEdgeUsd=0.5 }={}) {
    super();
    this.config={riskUsd,maxAgeMs,spikeUsd,maxLagMs,stopUsd,targetUsd,maxHoldMs,feeRate,slippageUsd,minHistory,minNetEdgeUsd};
    this.balance=balance; this.initialBalance=balance; this.highWatermark=balance;
    this.quotes=new Map(); this.history=new Map([['MT5',[]],['BINANCE',[]]]);
    this.trades=[]; this.open=null; this.events=[]; this.calibration=new Map();
  }
  ingest({venue,bid,ask,exchangeTs,receivedTs=Date.now()}) {
    if(!['MT5','BINANCE'].includes(venue) || !finite(bid)||!finite(ask)||bid<=0||ask<bid ||
       !finite(exchangeTs)||!finite(receivedTs)||exchangeTs>receivedTs+1000) return false;
    const prior=this.quotes.get(venue);
    if(prior && (exchangeTs<prior.exchangeTs || receivedTs<prior.receivedTs)) return false;
    const q={venue,bid,ask,mid:(bid+ask)/2,exchangeTs,receivedTs};
    this.quotes.set(venue,q);
    const h=this.history.get(venue); h.push(q); if(h.length>2000) h.shift();
    this.manage(receivedTs);
    const other=this.quotes.get(venue==='MT5'?'BINANCE':'MT5');
    if(!other || Math.abs(q.receivedTs-other.receivedTs)>this.config.maxAgeMs ||
       receivedTs-exchangeTs>this.config.maxAgeMs || receivedTs-other.exchangeTs>this.config.maxAgeMs) return true;
    // Compare each venue's own recent move: absolute price levels are not interchangeable.
    const windowStart=receivedTs-1000;
    const old=h.find(x=>x.receivedTs>=windowStart);
    const otherHistory=this.history.get(other.venue);
    const oldOther=otherHistory.find(x=>x.receivedTs>=windowStart);
    if(!old||!oldOther||old===q||oldOther===other) return true;
    const move=q.mid-old.mid, followerMove=other.mid-oldOther.mid;
    const direction=Math.sign(move);
    if(Math.abs(move)<this.config.spikeUsd || Math.sign(followerMove)===direction &&
       Math.abs(followerMove)>Math.abs(move)*0.4) return true;
    const key=venue+'>'+other.venue;
    const observation={at:receivedTs,leader:venue,follower:other.venue,move,followerMove,
      direction:direction>0?'LONG':'SHORT',basis:q.mid-other.mid};
    this.events.push(observation); if(this.events.length>10000)this.events.shift();
    this.emit('signal',observation);
    // No entries until the direction-specific historical catch-up evidence is calibrated.
    const calibration=this.calibration.get(key+':'+observation.direction);
    if(!calibration || calibration.count<this.config.minHistory ||
       calibration.medianNetEdgeUsd<this.config.minNetEdgeUsd || this.open) return true;
    this.enter(observation,other);
    return true;
  }
  setCalibration(leader,follower,direction,verifiedSamples) {
    // Calibration must be produced from timestamped OUT-OF-SAMPLE executable-price replay.
    if(!['MT5','BINANCE'].includes(leader)||!['MT5','BINANCE'].includes(follower)||
       leader===follower||!['LONG','SHORT'].includes(direction)||!Array.isArray(verifiedSamples)) throw Error('Invalid calibration');
    const valid=verifiedSamples.filter(x=>finite(x.netEdgeUsd)&&finite(x.lagMs)&&x.lagMs>=0&&x.lagMs<=this.config.maxLagMs);
    this.calibration.set(leader+'>'+follower+':'+direction,{count:valid.length,medianNetEdgeUsd:median(valid.map(x=>x.netEdgeUsd))});
  }
  enter(signal,q) {
    const direction=signal.direction, entry=direction==='LONG'?q.ask+this.config.slippageUsd:q.bid-this.config.slippageUsd;
    const units=Math.min(this.config.riskUsd/(this.config.stopUsd+2*this.config.slippageUsd),this.balance/entry);
    if(units<=0)return;
    const fee=entry*units*this.config.feeRate;
    this.open={...signal,entry,units,fee,openedAt:q.receivedTs,venue:q.venue};
    this.emit('open',this.open);
  }
  manage(now) {
    const t=this.open;if(!t)return;
    const q=this.quotes.get(t.venue);if(!q||now-q.receivedTs>this.config.maxAgeMs)return;
    const mark=t.direction==='LONG'?q.bid-this.config.slippageUsd:q.ask+this.config.slippageUsd;
    const movement=(mark-t.entry)*(t.direction==='LONG'?1:-1);
    if(movement<=-this.config.stopUsd||movement>=this.config.targetUsd||now-t.openedAt>=this.config.maxHoldMs) {
      const fees=t.fee+mark*t.units*this.config.feeRate;
      const pnl=movement*t.units-fees;
      this.balance+=pnl;this.highWatermark=Math.max(this.highWatermark,this.balance);
      const closed={...t,exit:mark,closedAt:now,pnl,fees,reason:movement<=-this.config.stopUsd?'STOP':movement>=this.config.targetUsd?'TARGET':'TIME'};
      this.trades.push(closed);this.open=null;this.emit('close',closed);
    }
  }
  summary() {
    const wins=this.trades.filter(t=>t.pnl>0).length;
    return {balance:this.balance,netPnl:this.balance-this.initialBalance,trades:this.trades.length,wins,
      winRate:this.trades.length?wins/this.trades.length:0,drawdown:this.highWatermark-this.balance,
      open:this.open,signals:this.events.length,calibration:Object.fromEntries(this.calibration)};
  }
}
