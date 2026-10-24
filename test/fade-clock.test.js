import test from 'node:test';
import assert from 'node:assert/strict';
import { FadeExchange } from '../src/fade-orders.js';
const response = body => ({ ok: true, json: async () => body });

test('sequential clock samples discard slow cold request, stop at first timely read, and cache', async()=>{
 let time=10000,reads=0,active=0,maximum=0;const pending=[];
 const exchange=new FadeExchange({now:()=>time,fetcher:()=>{reads++;maximum=Math.max(maximum,++active);return new Promise(resolve=>pending.push(body=>{active--;resolve(response(body));}));}});
 const sync=exchange.syncTime();assert.equal(reads,1);
 time=12003;pending[0]({serverTime:11675});await new Promise(setImmediate);assert.equal(reads,2);
 time=12412;pending[1]({serverTime:12311});await sync;
 assert.equal(maximum,1);assert.equal(reads,2);assert.equal(exchange.timeSample.roundTripMs,409);assert.equal(exchange.offset,3.5);
 await exchange.syncTime();assert.equal(reads,2);assert.equal(exchange.clockSamples.length,2);
});

test('all delayed or malformed clock samples fail without replacing a good offset', async () => {
  let time = 10000;
  const exchange = new FadeExchange({ now: () => time, fetcher: async () => {
    time += 1600; return response({ serverTime: time });
  }});
  exchange.offset = 37;
  await assert.rejects(exchange.syncTime(), /No reliable Binance clock sample/);
  assert.equal(exchange.offset, 37);
  assert.equal(exchange.timeSyncedAt, null);
});

test('timestamp rejection invalidates the estimate and never retries a leverage write', async () => {
  let calls = 0, timeReads = 0, time = 10000;
  const exchange = new FadeExchange({ key: 'fake', secret: 'fake', now: () => time,
    fetcher: async (url, options) => {
      if (url.includes('/time')) { timeReads++; return response({ serverTime: time }); }
      calls++; assert.equal(options.method, 'POST');
      return { ok: false, status: 400, json: async () => ({ code: -1021, msg: "Timestamp for this request was 1000ms ahead of the server's time." }) };
    } });
  exchange.timeSyncedAt = time;
  await assert.rejects(exchange.request('POST', '/fapi/v1/leverage', { symbol: 'BTCUSDT', leverage: 2 }), /timestamp ahead/);
  assert.equal(calls, 1); assert.equal(exchange.timeSyncedAt, null);
  await exchange.syncTime();
  assert.equal(timeReads, 1); assert.equal(calls, 1);
});

test('clock refresh coalesces concurrent callers and refreshes after cache expiry', async () => {
  let time = 10000, reads = 0;
  const exchange = new FadeExchange({ now: () => time, fetcher: async () => { reads++; return response({ serverTime: time }); } });
  await Promise.all([exchange.syncTime(), exchange.syncTime()]);
  assert.equal(reads, 1);
  time += 60000;
  await exchange.syncTime(); assert.equal(reads, 2);
});


test('clock sampling stops immediately on rate limit instead of issuing more probes', async()=>{
 let reads=0;const exchange=new FadeExchange({fetcher:async()=>{reads++;return {ok:false,status:429,headers:new Headers({'retry-after':'60'}),json:async()=>({code:-1003})};}});
 await assert.rejects(exchange.syncTime(),e=>e.status===429);assert.equal(reads,1);assert.equal(exchange.timeSyncedAt,null);
});
test('clock failure reports observed RTTs without weakening the timing ceiling', async()=>{
 let time=0;const exchange=new FadeExchange({now:()=>time,fetcher:async()=>{time+=1501;return response({serverTime:time});}});
 await assert.rejects(exchange.syncTime(),/samples 1501ms, 1501ms, 1501ms/);
 assert.equal(exchange.timeSyncedAt,null);assert.equal(exchange.clockSamples.length,3);
});
