import test from 'node:test';
import assert from 'node:assert/strict';
import { FadeEntryPreparation } from '../src/fade-entry-preparation.js';
test('warm reads coalesce, expire from request start, stay bounded and never read accounts or place orders', async () => {
 let time=1000,reads=0;const calls=[];
 const exchange={ info:async()=>{reads++;return {symbols:[]};},fees:async()=>({takerCommissionRate:'.0005'}),
   openInterestHistory:async()=>[],funding:async()=>({time}),btcCandles:async()=>[],
   account:async()=>{calls.push('account');},place:async()=>{calls.push('place');} };
 const prep=new FadeEntryPreparation({exchange,eventGate:{check:async()=>({allowed:true})},now:()=>time});
 prep.warm('AAAUSDT');await prep.info();await new Promise(setImmediate);
 await prep.info();assert.equal(reads,1);assert.deepEqual(calls,[]);
 time+=60000;await prep.info();assert.equal(reads,2);
 for(let i=0;i<70;i++)await prep.fees('COIN'+i);
 assert.ok(prep.cache.size<=64);
});
test('a failed refresh removes the old entry and cannot serve an expired good funding response',async()=>{
 let time=1000,fail=false;const prep=new FadeEntryPreparation({now:()=>time,exchange:{funding:async()=>{if(fail)throw Error('offline');return {time};}}});
 await prep.funding('AAA');time+=2000;fail=true;
 await assert.rejects(prep.funding('AAA'),/offline/);assert.equal(prep.cache.has('funding:AAA'),false);
});
test('calendar windows are rechecked after warming rather than caching permission to enter',async()=>{
 let blocked=false;const prep=new FadeEntryPreparation({now:()=>1000,exchange:{},eventGate:{check:async()=>({allowed:!blocked})}});
 await prep.event();blocked=true;assert.equal((await prep.event()).allowed,false);
});
