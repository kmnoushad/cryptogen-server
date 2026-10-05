import { closedSeries, trendDirection } from './futures-auto-strategy.js';

// Earlier observations are deliberately distinct from executable signals.
// Closed candles only. These functions neither authorize nor submit orders.
export function earlyFadeWatch(rows, now) {
  let c; try { c = closedSeries(rows, 60000, now).slice(-90); } catch { return null; }
  const last=c.at(-1), recent=c.slice(-3), prior=c.slice(-30,-3);
  const ceiling=Math.max(...prior.map(x=>x.high)), base=Math.min(...c.slice(0,-3).map(x=>x.low));
  if (ceiling/base<1.05 || last.close>ceiling || last.close<ceiling*.98) return null;
  const rejected=recent.find(x=>x.high>=ceiling*.995 && x.high<=ceiling*1.002
    && x.close<=x.high*.998 && last.close<=x.close);
  if (!rejected) return null;
  return { phase:'WATCH', kind:'FADE_REJECTION', resistance:Math.max(ceiling,rejected.high),
    price:last.close, barCloseTime:last.end, rejectionTime:rejected.end,
    reason:'High rejected; waiting for full fade confirmation', executable:false };
}

export function earlyFuturesWatch({symbol,m1,m15,h1,btc15,btc1h,now}) {
  let a,b,c,d,e;
  try { a=closedSeries(m1,60000,now);b=closedSeries(m15,900000,now);c=closedSeries(h1,3600000,now);
    d=closedSeries(btc15,900000,now);e=closedSeries(btc1h,3600000,now); } catch { return null; }
  const direction=trendDirection(b), opposite=direction==='LONG'?'SHORT':'LONG', btc15Direction=trendDirection(d);
  if (!direction || (btc15Direction && btc15Direction!==direction)
    || trendDirection(c)===opposite || trendDirection(e)===opposite) return null;
  const last=a.at(-1), previous=a.slice(-21,-1), sign=direction==='LONG'?1:-1;
  const level=sign===1?Math.max(...previous.map(x=>x.high)):Math.min(...previous.map(x=>x.low));
  if (sign*(last.close-level)<=0 || sign*(last.close-last.open)<=0
    || last.volume<previous.reduce((s,x)=>s+x.volume,0)/previous.length*1.3) return null;
  return { phase:'WATCH',kind:'FUTURES_MICRO_BREAKOUT',symbol,direction,level,price:last.close,
    barCloseTime:last.end,reason:'1m breakout observed; awaiting executable confirmation',executable:false };
}
