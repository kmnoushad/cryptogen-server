import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../scripts/futures-backtest.js';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';
import { futuresExitPlan } from '../src/futures-auto-executor.js';

const start = Date.parse('2026-09-01T00:00:00Z');
const f = {step:.001,min:.001,notional:5,tick:.01};
function fixture() {
  const floats = () => new Float64Array(Array.from({length:150},(_,i)=>[start+i*60000,100,100.1,99.9,100,10,1000,600]).flat());
  const data = {BTCUSDT:{m1:floats()},ETHUSDT:{m1:floats()}};
  const events = {ETHUSDT:[{k:130,current:{allowed:true,symbol:'ETHUSDT',direction:'LONG',entry:100,stop:99,breakoutTime:start+120*60000,score:1}}]};
  return {data,events,filters:{BTCUSDT:f,ETHUSDT:f},symbols:['ETHUSDT']};
}
const setBar=(a,k,{open=100,high=100.1,low=99.9,close=100})=>a.set([a[k*8],open,high,low,close,10,1000,600],k*8);
const fill=100.02; // entry fills at next bar open with 0.02% slippage
const qty=planFuturesAutoTrade({direction:'LONG',entry:100,stop:99,equity:180,available:180,feeRate:.0005,qtyStep:f.step,minQty:f.min,minNotional:f.notional}).qty;
const R=n=>futuresExitPlan('LONG',fill,qty,99,.0005,.01,n).target; // net-R price levels
const run=(x,mode)=>simulate(x.data,x.events,'current',180,x.symbols,mode,{filters:x.filters});

test('ratchet: runs to +3R then reverses -> exits at the +2R ratchet stop, not at a target', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:100.5,high:R(2)+.05,low:100.4,close:R(2)});
  setBar(a,133,{open:R(2),high:R(3)+.05,low:R(2),close:R(3)});
  setBar(a,134,{open:R(2.6),high:R(2.7),low:R(1.5),close:R(1.5)}); // falls through the +2R stop inside the bar
  for (let k=135;k<150;k++) setBar(a,k,{open:R(1.5),high:R(1.6),low:R(1.4),close:R(1.5)});
  const t=run(x,'ratchet').trades[0];
  assert.equal(t.reason,'RATCHET_STOP');
  assert.ok(t.R>1.85 && t.R<2.1, `R=${t.R}`); // about +2R net (stop exits are modeled as market orders)
  const live=run(x,'live').trades[0];
  assert.equal(live.reason,'TARGET'); assert.ok(t.pnl>live.pnl);
});
test('ratchet: +1R then reversal behaves like the live break-even exit', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:100.5,high:R(1.3),low:100.4,close:R(1.2)});
  for (let k=133;k<150;k++) setBar(a,k,{open:99.95,high:100,low:99.9,close:99.95});
  assert.equal(run(x,'ratchet').trades[0].reason,'BREAK_EVEN');
});
test('ratchet: never reaching +1R ends at the original stop', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  setBar(a,132,{open:99.5,high:99.6,low:98.9,close:99});
  assert.equal(run(x,'ratchet').trades[0].reason,'STOP');
});
test('ratchet: has no profit target - a +5R move stays open while it holds', () => {
  const x=fixture(), a=x.data.ETHUSDT.m1;
  for (let k=132;k<150;k++) setBar(a,k,{open:R(5),high:R(5.1),low:R(4.9),close:R(5)});
  const res=run(x,'ratchet');
  assert.equal(res.trades.length,0); assert.equal(res.stillOpen,1);
});
