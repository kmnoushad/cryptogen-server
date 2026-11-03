import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadLagPaper } from '../src/gold/leadlag-paper.js';

const base=1_793_690_000_000;
const quote=(venue,mid,ts)=>({venue,bid:mid-0.1,ask:mid+0.1,exchangeTs:ts,receivedTs:ts});

test('invalid crossed or nonpositive quotes rejected',()=>{
  const p=new LeadLagPaper();
  assert.equal(p.ingest({venue:'MT5',bid:4001,ask:4000,exchangeTs:base,receivedTs:base}),false);
  assert.equal(p.ingest({venue:'MT5',bid:-1,ask:1,exchangeTs:base,receivedTs:base}),false);
  assert.equal(p.ingest({venue:'UNKNOWN',bid:4000,ask:4001,exchangeTs:base,receivedTs:base}),false);
});
test('out of order venue ticks rejected',()=>{
  const p=new LeadLagPaper();
  assert.equal(p.ingest(quote('MT5',4000,base+100)),true);
  assert.equal(p.ingest(quote('MT5',4001,base+99)),false);
});
test('no paper entry without independently verified calibration',()=>{
  const p=new LeadLagPaper({spikeUsd:1});
  p.ingest(quote('MT5',4000,base));
  p.ingest(quote('BINANCE',4010,base));
  p.ingest(quote('MT5',4004,base+200));
  assert.equal(p.open,null);
  assert.equal(p.summary().trades,0);
});
test('calibration requires matching direction and enough samples',()=>{
  const p=new LeadLagPaper({minHistory:30,minNetEdgeUsd:0.5});
  assert.throws(()=>p.setCalibration('MT5','MT5','LONG',[]));
  p.setCalibration('MT5','BINANCE','LONG',Array.from({length:29},()=>({netEdgeUsd:1,lagMs:100})));
  assert.equal(p.summary().calibration['MT5>BINANCE:LONG'].count,29);
});
test('paper close applies costs and preserves a trade record',()=>{
  const p=new LeadLagPaper({minHistory:1,minNetEdgeUsd:0.1,spikeUsd:1});
  p.setCalibration('MT5','BINANCE','LONG',[{netEdgeUsd:2,lagMs:200}]);
  p.ingest(quote('MT5',4000,base));
  p.ingest(quote('BINANCE',4010,base));
  p.ingest(quote('MT5',4004,base+200));
  assert.ok(p.open);
  p.ingest(quote('BINANCE',4015,base+300));
  assert.equal(p.open,null);
  assert.equal(p.summary().trades,1);
  assert.ok(p.trades[0].fees>0);
  assert.equal(p.trades[0].reason,'TARGET');
});
