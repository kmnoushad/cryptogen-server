import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../scripts/futures-backtest.js';

const start = Date.parse('2026-09-01T00:00:00Z');
const f = {step:.001,min:.001,notional:5,tick:.01};
function fixture() {
  const floats = () => new Float64Array(Array.from({length:150},(_,i)=>[start+i*60000,100,100.1,99.9,100,10,1000,600]).flat());
  const data = {BTCUSDT:{m1:floats()},ETHUSDT:{m1:floats()}};
  const events = {ETHUSDT:[{k:130,current:{allowed:true,symbol:'ETHUSDT',direction:'LONG',entry:100,stop:99,breakoutTime:start+120*60000,score:1}}]};
  return {data,events,filters:{BTCUSDT:f,ETHUSDT:f},symbols:['ETHUSDT']};
}
const setBar=(a,k,{open=100,high=100.1,low=99.9,close=100})=>a.set([a[k*8],open,high,low,close,10,1000,600],k*8);
const run=(x,mode)=>simulate(x.data,x.events,'current',180,x.symbols,mode,{filters:x.filters});

test('inverse: a LONG signal that fails (falls to its stop) is a winning SHORT that exits at the original stop price', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:99.6,high:99.7,low:98.8,close:98.9});
  const live=run(x,'live').trades[0], inv=run(x,'inverse').trades[0];
  assert.equal(live.reason,'STOP'); assert.ok(live.pnl<0);
  assert.equal(inv.dir,'SHORT'); assert.equal(inv.reason,'TARGET'); assert.ok(inv.pnl>0);
});
test('inverse: a LONG signal that works (rises past 1.5R) is a losing SHORT stopped at entry + 1.5x distance', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:100.5,high:102.3,low:100.4,close:102.2});
  for (let k=133;k<150;k++) setBar(a,k,{open:102.2,high:102.3,low:102.1,close:102.2});
  const live=run(x,'live').trades[0], inv=run(x,'inverse').trades[0];
  assert.equal(live.reason,'TARGET'); assert.ok(live.pnl>0);
  assert.equal(inv.reason,'STOP'); assert.ok(inv.pnl<0);
});
test('inverse is a pure mirror: it never moves to break-even', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:99.6,high:99.7,low:99.2,close:99.3});      // SHORT is in profit, short of target
  for (let k=133;k<150;k++) setBar(a,k,{open:100.05,high:100.1,low:100,close:100.05}); // back above entry
  const res=run(x,'inverse');
  assert.ok(!res.trades.some(t=>t.reason==='BREAK_EVEN'));
});
