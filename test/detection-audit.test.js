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
  const calls=[];let pending=0,maximum=0;
  const ex={scope:'live:directional',cfg:{enabled:true},row:{state:{paused:false,jobs:[]}},
    scanReasons:{},lastError:null,run:async()=>calls.push('protect'),
    exchange:{candles:async()=>{calls.push('read');maximum=Math.max(maximum,++pending);
      await new Promise(resolve=>setTimeout(resolve,1));pending--;return []; }},
    status:()=>'',failed:async e=>{throw e;},stop:()=>{}};
  const store={control:async()=>({paused:false}),heartbeat:async()=>{}};
  await new FuturesAutoWorkerLoop({executor:ex,store,now:()=>100000}).tick();
  assert.equal(calls[0],'protect');assert.ok(maximum>3 && maximum<=9);
  assert.equal(Object.keys(ex.scanReasons).length,9);
});
