import test from 'node:test';
import assert from 'node:assert/strict';
import { GoldV8Research } from '../src/gold/v8-signal-research.js';
const base=1800000000000;
const feed=(engine,venue,move=0)=>{
 for(let i=0;i<15;i++){const t=base+i*500;const mid=4200+(venue==='GC'?move*i:0);engine.ingest({venue,bid:mid-0.1,ask:mid+0.1,exchangeTs:t,receivedTs:t});}
};
test('no GC feed means no signal',()=>{const e=new GoldV8Research();feed(e,'MT5');assert.equal(e.evaluate(base+7000).reason,'MISSING_FEED');});
test('stale feed cannot signal',()=>{const e=new GoldV8Research();feed(e,'MT5');feed(e,'GC',0.5);assert.equal(e.evaluate(base+9000).reason,'STALE_FEED');});
test('wide spread blocks signals',()=>{const e=new GoldV8Research();feed(e,'MT5');feed(e,'GC',0.5);const t=base+7500;e.ingest({venue:'MT5',bid:4200,ask:4202,exchangeTs:t,receivedTs:t});assert.equal(e.evaluate(t).reason,'SPREAD');});
test('GC impulse is only a research candidate, never an order',()=>{const e=new GoldV8Research();feed(e,'MT5');feed(e,'GC',0.5);const r=e.evaluate(base+7000);assert.equal(r.status,'CANDIDATE');assert.equal(r.side,'BUY');assert.equal(r.executionEnabled,false);});
test('out-of-order quote rejected',()=>{const e=new GoldV8Research();e.ingest({venue:'MT5',bid:4200,ask:4200.2,exchangeTs:base+1000,receivedTs:base+1000});assert.equal(e.ingest({venue:'MT5',bid:4200,ask:4200.2,exchangeTs:base,receivedTs:base}).status,'OUT_OF_ORDER');});
