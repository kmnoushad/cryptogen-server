import test from 'node:test';
import assert from 'node:assert/strict';
import { detectionAudit, DetectionLedger } from '../src/detection-audit.js';
import { FuturesAutoWorkerLoop } from '../src/futures-auto-worker-loop.js';

test('timing and modeled cost diagnostic exposes a small stop', () => {
  const s={direction:'LONG',entry:100,stop:99.833,barCloseTime:1000,breakoutTime:0};
  const a=detectionAudit(s,21000);
  assert.equal(a.confirmationAgeMs,20000);
  assert.ok(Math.abs(a.stopDistancePct-.167)<1e-8);
  assert.ok(a.approximateCostShare>.47 && a.approximateCostShare<.48);
  assert.equal(detectionAudit({...s,barCloseTime:22000},21000),null);
  assert.equal(detectionAudit({...s,stop:101},21000),null);
});
test('ledger deduplicates closed-bar detections and remains bounded', () => {
  const l=new DetectionLedger({max:2});
  const s={direction:'SHORT',entry:100,stop:101,barCloseTime:1000};
  assert.ok(l.record('BTCUSDT',s,2000)); assert.equal(l.record('BTCUSDT',s,2000),null);
  l.record('ETHUSDT',s,2000); l.record('SOLUSDT',s,2000);
  assert.equal(l.rows.length,2);assert.equal(l.seen.size,2);
});
test('market-data reads overlap in bounded groups; protection still runs first', async () => {
  const now=Date.parse('2026-10-05T12:00:00Z');
  const symbols=Array.from({length:9},(_,i)=>({symbol:`C${i}USDT`,baseAsset:`C${i}`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',marginAsset:'USDT',onboardDate:now-30*86400000}));
  const tickers=symbols.map(s=>({symbol:s.symbol,quoteVolume:'6000000',count:'2000',lastPrice:'1',priceChangePercent:'0'}));
  const calls=[];let pending=0,maximum=0;
  const ex={scope:'live:directional',cfg:{enabled:true},row:{state:{paused:false,jobs:[]}},
    scanReasons:{},lastError:null,run:async()=>calls.push('protect'),
    exchange:{info:async()=>({symbols}),ticker24h:async()=>tickers,candles:async()=>{calls.push('read');maximum=Math.max(maximum,++pending);
      await new Promise(resolve=>setTimeout(resolve,1));pending--;return []; }},
    status:()=>'',failed:async e=>{throw e;},stop:()=>{}};
  const store={control:async()=>({paused:false}),heartbeat:async()=>{}};
  await new FuturesAutoWorkerLoop({executor:ex,store,now:()=>now+3000}).tick();
  assert.equal(calls[0],'protect');assert.ok(maximum>1 && maximum<=3);
  assert.equal(Object.keys(ex.scanReasons).length,9);
});

test('fresh candidates execute within their batch; long scans renew protection and heartbeat', async () => {
  let clock=Date.parse('2026-10-05T12:00:03Z');
  const started=clock, protections=[], heartbeats=[], attempts=[];
  const symbols=Array.from({length:120},(_,i)=>({symbol:`C${i}USDT`,baseAsset:`C${i}`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',onboardDate:clock-30*86400000}));
  const tickers=symbols.map(s=>({symbol:s.symbol,quoteVolume:'6000000',count:'2000',lastPrice:'1',priceChangePercent:'0'}));
  const ex={scope:'live:directional',cfg:{enabled:true},row:{state:{paused:false,jobs:[]}},lastError:null,
    run:async()=>protections.push(clock),status:()=>'',failed:async e=>{throw e;},stop:()=>{},
    exchange:{info:async()=>({symbols}),ticker24h:async()=>tickers,candles:async(s,interval)=>{if(interval==='1m')clock+=3000; return []; }},
    onSignal:async(s,signal)=>{attempts.push({symbol:s,at:clock,snapshot:signal.marketQuality.checkedAt});ex.reason='Funding stale, crowded or settlement near';}};
  const store={control:async()=>({paused:false}),heartbeat:async()=>heartbeats.push(clock)};
  const worker=new FuturesAutoWorkerLoop({executor:ex,store,now:()=>clock,detect:input=>input.symbol==='C0USDT'
    ? {allowed:true,symbol:input.symbol,direction:'SHORT',entry:100,stop:101,score:1,barCloseTime:clock-1000,breakoutTime:clock-120000}
    : {allowed:false,reason:'No confirmed test setup'}});
  await worker.tick();
  assert.equal(attempts.length,1);assert.ok(attempts[0].at-started<90000,'entry checks must precede rest of universe');
  assert.ok(clock-started>90000,'reproduces an otherwise-expiring whole scan');
  assert.ok(protections.length>10);assert.ok(heartbeats.length>10);
  assert.ok(protections.every((at,i)=>!i || at-protections[i-1]<=18000),'bounded maintenance between batches');
  assert.equal(ex.scanReasons.C0USDT,'Funding stale, crowded or settlement near');
  assert.equal(ex.scanStats.scanned,60);assert.equal(ex.scanStats.attempted,1);
});

test('remote pause during a long scan stops further candle batches', async () => {
  let clock=Date.parse('2026-10-05T12:00:03Z'),runs=0,reads=0;
  const symbols=Array.from({length:30},(_,i)=>({symbol:`C${i}USDT`,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT',onboardDate:clock-30*86400000}));
  const ex={scope:'live:directional',cfg:{enabled:true},row:{state:{paused:false,jobs:[]}},lastError:null,
    run:async()=>{runs++;},control:async action=>{ex.row.state.paused=action==='pause';},status:()=>'',stop:()=>{},failed:async e=>{throw e;},
    exchange:{info:async()=>({symbols}),ticker24h:async()=>symbols.map(s=>({symbol:s.symbol,quoteVolume:'6000000',count:'2000',lastPrice:'1',priceChangePercent:'0'})),
      candles:async(s,interval)=>{reads++;if(interval==='1m')clock+=4000;return [];}}};
  await new FuturesAutoWorkerLoop({executor:ex,now:()=>clock,store:{control:async()=>({paused:runs>=2}),heartbeat:async()=>{}},detect:()=>({allowed:false,reason:'test'})}).tick();
  assert.equal(ex.row.state.paused,true);assert.ok(reads<30*3);assert.equal(ex.scanStats.scanned,3);
});
