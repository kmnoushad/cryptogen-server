import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadLagPaper } from '../src/gold/leadlag-paper.js';

const start=1_793_690_000_000;
const tick=(venue,mid,ms,exchangeMs=ms)=>({
  venue,bid:mid-0.1,ask:mid+0.1,receivedTs:start+ms,exchangeTs:start+exchangeMs
});

test('diagnostics classify invalid quotes, out-of-order ticks, and absent peer',()=>{
  const p=new LeadLagPaper();
  assert.equal(p.ingest({venue:'MT5',bid:5,ask:4,receivedTs:start,exchangeTs:start}),false);
  assert.equal(p.ingest(tick('MT5',4000,100)),true);
  assert.equal(p.ingest(tick('MT5',4000,99)),false);
  assert.deepEqual({invalid:p.summary().diagnostics.invalidQuote,
    ordered:p.summary().diagnostics.outOfOrder,peer:p.summary().diagnostics.missingPeer},
    {invalid:1,ordered:1,peer:1});
});

test('diagnostics distinguish stale pair and stale exchange clocks',()=>{
  const p=new LeadLagPaper();
  p.ingest(tick('MT5',4000,0));
  p.ingest(tick('BINANCE',4000,2000));
  p.ingest(tick('MT5',4000,2001,0));
  assert.equal(p.summary().diagnostics.stalePair,1);
  assert.equal(p.summary().diagnostics.staleExchange,1);
});

test('diagnostics count weak impulse, follower reaction, and uncalibrated signals without paper orders',()=>{
  const p=new LeadLagPaper({spikeUsd:2});
  p.ingest(tick('MT5',4000,0));
  p.ingest(tick('BINANCE',4000,0));
  p.ingest(tick('BINANCE',4000,100));
  p.ingest(tick('MT5',4001,200));
  assert.ok(p.summary().diagnostics.weakImpulse>=1);
  p.ingest(tick('BINANCE',4003,300));
  p.ingest(tick('MT5',4004,400));
  assert.ok(p.summary().diagnostics.followerAlreadyMoved>=1);
  const q=new LeadLagPaper({spikeUsd:2});
  q.ingest(tick('MT5',4000,0));
  q.ingest(tick('BINANCE',4010,0));
  q.ingest(tick('BINANCE',4010,100));
  q.ingest(tick('MT5',4004,200));
  assert.equal(q.summary().diagnostics.signals,1);
  assert.equal(q.summary().diagnostics.calibrationMissing,1);
  assert.equal(q.summary().trades,0);
  assert.equal(q.open,null);
});

test('diagnostics keep original calibrated paper-entry behavior',()=>{
  const p=new LeadLagPaper({spikeUsd:1,minHistory:1,minNetEdgeUsd:0.1});
  p.setCalibration('MT5','BINANCE','LONG',[{lagMs:100,netEdgeUsd:1}]);
  p.ingest(tick('MT5',4000,0));
  p.ingest(tick('BINANCE',4010,0));
  p.ingest(tick('BINANCE',4010,100));
  p.ingest(tick('MT5',4004,200));
  assert.equal(p.summary().diagnostics.paperEntryEligible,1);
  assert.ok(p.open);
});
