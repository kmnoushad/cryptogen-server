import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBars, m15Bias, priorBars, hasPullback, hasCompression, evaluate, summarize } from '../scripts/gold-v82-replay.js';
const M5=300000, M15=900000;
function q(t,mid){return {t,bid:mid-0.05,ask:mid+0.05,mid};}
function barTicks(k,period,open,close){
  return [q(k*period+1000,open),q((k+1)*period-1000,close)];
}
test('only completed historical bars inform bias; current candle cannot leak',()=>{
  const ticks=[
    ...barTicks(0,M15,4000,4000),...barTicks(1,M15,4000,4001),
    ...barTicks(2,M15,4001,4003),...barTicks(3,M15,4003,3900)
  ];
  const bars=buildBars(ticks,M15);
  assert.equal(m15Bias(bars,3*M15+5000),1);
  assert.equal(m15Bias(bars,2*M15+5000),0);
  assert.equal(priorBars(bars,4*M15, M15,3).length,3);
});
test('pullback reads only two closed candles',()=>{
  const ticks=[...barTicks(0,M5,4010,4009),...barTicks(1,M5,4009,4010),
    ...barTicks(2,M5,4010,4020)];
  const bars=buildBars(ticks,M5);
  assert.equal(hasPullback(bars,2*M5+1000,1),true);
  assert.equal(hasPullback(bars,1*M5+1000,1),false);
});
test('compression uses six completed bars, not current-bar high/low',()=>{
  const ticks=[];
  [3,3,3,1,1,1,80].forEach((width,k)=>ticks.push(...barTicks(k,M5,4000,4000+width)));
  const bars=buildBars(ticks,M5);
  assert.equal(hasCompression(bars,6*M5+1000),true);
  assert.equal(hasCompression(bars,5*M5+1000),false);
});
test('independent model cooldown and no results without enough quote coverage',()=>{
  const qts=[q(0,4000),q(300,4000),q(550,4001),q(800,4001.1),q(1100,4001.2)];
  const out=evaluate(qts,{lookback:250,threshold:0.25});
  assert.ok(out.stats.impulse.qualifying>=1);
  assert.equal(out.stats.trend.qualifying,0);
  assert.equal(summarize(out).models.impulse.outcomes['10000'].n,0);
});
