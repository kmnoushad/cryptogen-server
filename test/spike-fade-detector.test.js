import test from 'node:test';
import assert from 'node:assert/strict';
import { SpikeFadeDetector } from '../src/spike-fade-detector.js';
function fixture() {
  let time = 0, id = 0;
  const d = new SpikeFadeDetector({ symbols: ['TESTUSDT'], now: () => time });
  const feed = (price, qty=1, sell=false, ctx) => {
    time += 1000;
    return d.ingest('TESTUSDT', { a: ++id, T: time, p: String(price), q: String(qty), m: sell },
      ctx ?? { btc: { at: time, return30s: 0, return15m: -.001 }, book: { at: time, bid: price, ask: price * 1.0001 } });
  };
  for (let i=0;i<145;i++) feed(100);
  return { d, feed, spike: () => feed(103, 100) };
}
test('spike WATCH precedes selling/rejection candidate; never executable', () => {
  const {feed,spike}=fixture(); assert.equal(spike().watch,true);
  feed(103,100,true);feed(102.8,100,true);
  const r=feed(102.4,100,true);assert.equal(r.candidate,true);assert.equal(r.allowed,false);
  assert.equal(r.executable,false);assert.equal(r.maxModeledLossUsd,5);assert.ok(r.stop>103);
});
test('rising spike and already dumped spike never become short candidates', () => {
  const {feed,spike}=fixture();spike();assert.equal(feed(104,100).candidate,false);
  assert.match(feed(102,100,true).reason,/already faded/);
});
test('bullish BTC and missing BTC context withhold candidates', () => {
  for (const btc of [undefined,{at:149000,return30s:.002,return15m:.01}]) {
    const {feed,spike}=fixture();spike();feed(103,100,true);feed(102.8,100,true);
    const r=feed(102.4,100,true,{btc,book:{at:149000,bid:102.4,ask:102.41}});
    assert.equal(r.candidate,false);assert.match(r.reason,/BTC/);
  }
});
test('reset and invalid or duplicate input cannot create candidates', () => {
  const {d,feed,spike}=fixture();spike();d.reset();assert.equal(feed(102.4,100,true).reason,'Warming up');
  const t={a:999,T:147000,p:'NaN',q:'1',m:true};assert.equal(d.ingest('TESTUSDT',t).candidate,false);
});
