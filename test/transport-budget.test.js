import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { requestJson } from '../src/http.js';
import { FadeExchange } from '../src/fade-orders.js';
import { BinanceRequestBudget, protectionRequest } from '../src/binance-request-budget.js';
import { FuturesAutoWorkerLoop } from '../src/futures-auto-worker-loop.js';
const hang=()=>new Promise(()=>{});
const response=(status=200,body={},headers={})=>({status,ok:status<400,headers:new Headers(headers),json:async()=>body});
const temporary=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nexio-budget-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};

test('database header timeout settles even when fetch ignores AbortSignal',async()=>{
 const original=global.fetch;let calls=0,signal;
 global.fetch=async(_url,o)=>{calls++;signal=o.signal;return hang();};
 try {await assert.rejects(requestJson('https://example.invalid',{method:'POST',timeoutMs:20}),/deadline/);assert.equal(calls,1);assert.equal(signal.aborted,true);}
 finally {global.fetch=original;}
});
test('database body timeout settles without replaying a save',async()=>{
 const original=global.fetch;let calls=0;
 global.fetch=async()=>{calls++;return {ok:true,text:hang};};
 try {await assert.rejects(requestJson('https://example.invalid',{method:'POST',timeoutMs:20}),/deadline/);assert.equal(calls,1);}
 finally {global.fetch=original;}
});
test('generic HTTP never retries a 429 or 418 read',async()=>{
 const original=global.fetch;let calls=0;
 try {for(const status of [429,418]){global.fetch=async()=>{calls++;return {ok:false,status,headers:new Headers({'retry-after':'90'}),text:async()=>''};};await assert.rejects(requestJson('https://example.invalid'),e=>e.status===status);}assert.equal(calls,2);}
 finally {global.fetch=original;}
});
test('Binance hung body is unknown and never automatically replays an entry',async()=>{
 let calls=0;const ex=new FadeExchange({key:'fake',secret:'fake',timeoutMs:20,fetcher:async()=>{calls++;return {ok:true,json:hang};}});
 await assert.rejects(ex.place({symbol:'XUSDT',side:'SELL',type:'LIMIT'}),/response unknown/);assert.equal(calls,1);
});
test('429 cooldown prevents all subsequent network calls, including protective writes',async()=>{
 let now=10000,calls=0;
 const ex=new FadeExchange({key:'fake',secret:'fake',now:()=>now,fetcher:async()=>{calls++;return response(429,{code:-1003},{'retry-after':'120'});}});
 await assert.rejects(ex.info(),e=>e.status===429);
 now+=61000;await assert.rejects(ex.placeStop('XUSDT','id',2),e=>e.requestSent===false);assert.equal(calls,1);
});
test('a malformed/hung 429 body still establishes cooldown from response headers',async()=>{
 let now=1000,calls=0;const ex=new FadeExchange({now:()=>now,timeoutMs:20,fetcher:async()=>{calls++;return {...response(429,{}, {'retry-after':'120'}),json:hang};}});
 await assert.rejects(ex.info(),/response unknown/);now+=61000;await assert.rejects(ex.info(),e=>e.requestSent===false);assert.equal(calls,1);
});
test('two worker budgets share a cooldown across a minute boundary and restart',async t=>{
 const directory=await temporary(t);let now=50000;
 const a=new BinanceRequestBudget({directory,now:()=>now});const b=new BinanceRequestBudget({directory,now:()=>now});
 await a.before('GET','/fapi/v1/time',{});await a.observe(response(429,{},{'retry-after':'120'}),{code:-1003});
 now=121000;await assert.rejects(b.before('GET','/fapi/v3/account',{}),e=>e.retryAfterMs>0);
 const restarted=new BinanceRequestBudget({directory,now:()=>now});await assert.rejects(restarted.before('POST','/fapi/v1/order',{reduceOnly:'true'}));
 now=172000;await restarted.before('GET','/fapi/v3/account',{});
});
test('shared budget reserves headroom for protection but never prioritizes a new entry',async t=>{
 const directory=await temporary(t),now=10000;const budget=new BinanceRequestBudget({directory,now:()=>now});
 await fs.writeFile(path.join(directory,'live.json'),JSON.stringify({minute:0,used:1200}));
 await assert.rejects(budget.before('POST','/fapi/v1/order',{side:'SELL'}));
 await budget.before('POST','/fapi/v1/algoOrder',{closePosition:'true'});
 await budget.before('GET','/fapi/v3/positionRisk',{});
 assert.equal(protectionRequest('POST','/fapi/v1/order',{reduceOnly:'false'}),false);
});
test('authoritative IP weight and lower declared exchange limit constrain the budget',async t=>{
 const directory=await temporary(t);const budget=new BinanceRequestBudget({directory,now:()=>10000});
 await budget.observe(response(200,{}, {'x-mbx-used-weight-1m':'1900'}),{rateLimits:[{rateLimitType:'REQUEST_WEIGHT',interval:'MINUTE',intervalNum:1,limit:2000}]});
 await assert.rejects(budget.before('GET','/fapi/v3/account',{}));
});
test('independent processes cannot overspend the last shared budget unit',async t=>{
 const directory=await temporary(t);await fs.writeFile(path.join(directory,'live.json'),JSON.stringify({minute:0,used:1199}));
 const module=new URL('../src/binance-request-budget.js',import.meta.url).href;
 const code=`import {BinanceRequestBudget} from ${JSON.stringify(module)}; const b=new BinanceRequestBudget({directory:process.argv[1],now:()=>10000});try{await b.before('GET','/fapi/v1/exchangeInfo',{});console.log('sent')}catch{console.log('blocked')}`;
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,directory]);let out='';p.stdout.on('data',x=>out+=x);p.on('error',reject);p.on('exit',c=>c?reject(Error('child failed')):resolve(out.trim()));});
 const results=await Promise.all([run(),run(),run(),run()]);assert.equal(results.filter(x=>x==='sent').length,1);
});
test('missing or malformed shared state fails closed',async t=>{
 const directory=await temporary(t);const budget=new BinanceRequestBudget({directory,now:()=>10000});
 await fs.writeFile(path.join(directory,'live.json'),'broken');await assert.rejects(budget.before('GET','/fapi/v1/time',{}),/invalid/);
 const unavailable=new BinanceRequestBudget({directory:path.join(directory,'absent')});await assert.rejects(unavailable.before('GET','/fapi/v1/time',{}),/unavailable/);
});
test('closed-bar caches reuse HTF data and refresh immediately after the next close allowance',async()=>{
 let now=60000,calls=0;const executor={scope:'x',exchange:{candles:async()=>{calls++;return [['data',calls]];}}};
 const loop=new FuturesAutoWorkerLoop({executor,store:{},now:()=>now});
 const first=await loop.candles('ETHUSDT','15m');now+=60000;assert.equal(await loop.candles('ETHUSDT','15m'),first);assert.equal(calls,1);
 now=901500;await loop.candles('ETHUSDT','15m');assert.equal(calls,2);
 now=10000;await loop.candles('ETHUSDT','15m');assert.equal(calls,3);
});


test('live owner holding the lock past 500ms releases without a false budget-busy error',async t=>{
 const directory=await temporary(t);const budget=new BinanceRequestBudget({directory,now:()=>10000});
 const lock=path.join(directory,'live.json.lock');await fs.writeFile(lock,String(process.pid));
 const timer=setTimeout(()=>{void fs.unlink(lock);},750);t.after(()=>clearTimeout(timer));
 await budget.before('GET','/fapi/v1/time',{});
 const state=JSON.parse(await fs.readFile(path.join(directory,'live.json'),'utf8'));assert.equal(state.used,1);
});
test('sustained live lock remains bounded and is never force-deleted',async t=>{
 const directory=await temporary(t);const budget=new BinanceRequestBudget({directory});const lock=path.join(directory,'live.json.lock');
 await fs.writeFile(lock,String(process.pid));const before=Date.now();
 await assert.rejects(budget.before('GET','/fapi/v1/time',{}),/busy after 2s/);
 assert.ok(Date.now()-before<3500);assert.equal(await fs.readFile(lock,'utf8'),String(process.pid));
});
test('concurrent worker processes preserve hundreds of reservations without contention failures',async t=>{
 const directory=await temporary(t);const module=new URL('../src/binance-request-budget.js',import.meta.url).href;
 const code=`import {BinanceRequestBudget} from ${JSON.stringify(module)}; const b=new BinanceRequestBudget({directory:process.argv[1],now:()=>10000});for(let i=0;i<150;i++)await b.before('GET','/fapi/v1/time',{});`;
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,directory]);let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',c=>c?reject(Error(err)):resolve());});
 await Promise.all([run(),run(),run(),run()]);
 const state=JSON.parse(await fs.readFile(path.join(directory,'live.json'),'utf8'));assert.equal(state.used,600);
});
