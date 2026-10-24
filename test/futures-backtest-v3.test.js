import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, validateSeries, fetchSeries, summarize } from '../scripts/futures-backtest.js';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';
import { futuresExitPlan } from '../src/futures-auto-executor.js';

const start = Date.parse('2026-09-01T00:00:00Z');
const f = {step:.001,min:.001,notional:5,tick:.01};
function fixture(symbols=['ETHUSDT']) {
  const floats = () => new Float64Array(Array.from({length:150},(_,i)=>[start+i*60000,100,100.1,99.9,100,10,1000,600]).flat());
  const data = Object.fromEntries(['BTCUSDT',...symbols].map(s=>[s,{m1:floats()}]));
  const sig = (symbol,score=1) => ({allowed:true,symbol,direction:'LONG',entry:100,stop:99,breakoutTime:start+120*60000,score});
  const events = Object.fromEntries(symbols.map(s=>[s,[{k:130,current:sig(s)}]]));
  const filters = Object.fromEntries(['BTCUSDT',...symbols].map(s=>[s,f]));
  return {data,events,filters,symbols};
}
const setBar = (a,k,{open=100,high=100.1,low=99.9,close=100}) => a.set([a[k*8],open,high,low,close,10,1000,600],k*8);
function levels() {
  const p=planFuturesAutoTrade({direction:'LONG',entry:100,stop:99,equity:180,available:180,feeRate:.0005,qtyStep:f.step,minQty:f.min,minNotional:f.notional});
  return {qty:p.qty,fill:100.02,be1:futuresExitPlan('LONG',100.02,p.qty,99,.0005,.01,1).target,
    plan:futuresExitPlan('LONG',100.02,p.qty,99,.0005,.01)};
}

test('entry fees are charged immediately and unfinished positions remain in equity',()=>{
  const x=fixture(),r=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters});
  assert.equal(r.stillOpen,1);assert.equal(r.trades.length,0);
  assert.ok(r.endingWallet<180);assert.ok(r.endingEquity<r.endingWallet);
  assert.ok(Math.abs(r.endingWallet-(180-levels().qty*100.02*.0005))<1e-8);
});

test('same-candle +1R then reversal executes the newly activated break-even stop',()=>{
  const x=fixture(),{be1,plan}=levels();
  setBar(x.data.ETHUSDT.m1,132,{high:be1+.01,low:99.9,close:100});
  const r=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters});
  assert.equal(r.trades[0].reason,'BREAK_EVEN');assert.equal(r.trades[0].exitTime,start+133*60000);
  assert.ok(plan.target>be1+.01);
});

test('two OHLC paths expose stop-versus-target ambiguity rather than assuming a winner',()=>{
  const x=fixture(),{plan}=levels();
  setBar(x.data.ETHUSDT.m1,132,{high:plan.target+.01,low:98.9,close:100});
  const af=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters,pathMode:'adverse-first'});
  const ff=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters,pathMode:'favorable-first'});
  assert.equal(af.trades[0].reason,'STOP');assert.equal(ff.trades[0].reason,'TARGET');
  assert.ok(af.trades[0].pnl<ff.trades[0].pnl);
});

test('partial cash is booked immediately and remaining margin is reduced without double counting',()=>{
  const x=fixture(),{be1}=levels();
  for(let k=132;k<150;k++)setBar(x.data.ETHUSDT.m1,k,{open:be1-.01,high:be1+.01,low:be1-.02,close:be1});
  const r=simulate(x.data,x.events,'current',180,x.symbols,'partial',{filters:x.filters});
  assert.equal(r.stillOpen,1);assert.equal(r.trades.length,0);assert.ok(r.endingWallet>180);
  const pos=r.unresolved[0];assert.ok(pos.remainingQty<levels().qty);
  assert.ok(Math.abs(pos.remainingMargin-pos.remainingQty*100.02/2)<1e-8);
  assert.ok(Math.abs(r.endingWallet-180-pos.realizedCash)<1e-8);
  assert.ok(Math.abs(r.endingEquity-r.endingWallet-pos.remainingQty*(be1-100.02))<1e-8);
});

test('partial quantities below minimum notional are refused',()=>{
  const x=fixture();x.filters.ETHUSDT={...f,notional:100};
  const r=simulate(x.data,x.events,'current',180,x.symbols,'partial',{filters:x.filters});
  assert.equal(r.stillOpen,0);assert.equal(r.skipped['partial exit below exchange minimum'],1);
});

test('live cost/no-chase gates reject non-executable entries',()=>{
  for(const mode of ['cost','chase']) {
    const x=fixture();if(mode==='cost')x.events.ETHUSDT[0].current.stop=99.95;
    else setBar(x.data.ETHUSDT.m1,131,{open:101,high:101.1,low:100.9,close:101});
    const r=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters});
    assert.equal(r.stillOpen,0);assert.equal(r.trades.length,0);
    assert.ok(Object.keys(r.skipped).some(k=>/cost|fees|no-chase/.test(k)));
  }
});

test('candidate score ordering makes simultaneous entry results independent of symbol input order',()=>{
  const symbols=['ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','LINKUSDT'];
  const x=fixture(symbols);symbols.forEach((s,i)=>x.events[s][0].current.score=i+1);
  const a=simulate(x.data,x.events,'current',180,symbols,'live',{filters:x.filters});
  const b=simulate(x.data,x.events,'current',180,[...symbols].reverse(),'live',{filters:x.filters});
  assert.deepEqual(a.unresolved,b.unresolved);assert.deepEqual(a.skipped,b.skipped);
  assert.equal(a.unresolved[0].symbol,'LINKUSDT');
});

test('gaps, corrupt buffers and unsupported symbols are refused',()=>{
  const x=fixture(),bad=x.data.ETHUSDT.m1.slice();bad[8]+=60000;
  assert.throws(()=>validateSeries(bad,60000),/gapped/);
  assert.throws(()=>validateSeries(new Float64Array(7),60000),/buffer/);
  assert.throws(()=>simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:{BTCUSDT:f}}),/Missing exchange filters/);
});

test('independent holdout starts flat and does not inherit training positions',()=>{
  const x=fixture();const r=simulate(x.data,x.events,'current',180,x.symbols,'live',{filters:x.filters,startMs:start+140*60000});
  assert.equal(r.stillOpen,0);assert.equal(r.endingWallet,180);
});

test('public historical reads are unsigned and rate-limit errors are never blindly retried',async()=>{
  let calls=0;const exchange={request:async(method,path,params,signed)=>{
    calls++;assert.equal(method,'GET');assert.equal(signed,false);assert.equal(params.limit,499);
    throw Object.assign(Error('ban'),{status:418});
  }};
  await assert.rejects(fetchSeries('ETHUSDT','1m',start,start+60000,0,exchange),/ban/);
  assert.equal(calls,1);
});

test('statistical intervals require multiple weekly blocks and remain descriptive',()=>{
  const few=summarize([{entryTime:start,pnl:1,R:1}]);assert.ok(Number.isNaN(few.lo));
  const many=summarize(Array.from({length:8},(_,i)=>({entryTime:start+i*7*86400000,pnl:i%2?-.5:1,R:i%2?-.5:1})));
  assert.equal(many.blocks,8);assert.ok(Number.isFinite(many.lo));assert.ok(many.hi>=many.lo);
});
