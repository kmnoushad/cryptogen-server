import test from 'node:test';
import assert from 'node:assert/strict';
import { earlyFadeWatch, earlyFuturesWatch } from '../src/early-setup-watch.js';
import { detectPumpFade } from '../src/pump-fade.js';
import { directionalSignal } from '../src/futures-auto-strategy.js';
const now=Date.parse('2026-09-30T12:07:20Z');
function rows(interval,count,price) {
  const end=Math.floor(now/interval)*interval-1;
  return Array.from({length:count},(_,i)=>{const close=price(i), t=end-(count-i)*interval+1;
    return [t,close-.02,close+.04,close-.04,close,100,t+interval-1,10000,0,0,6000];});
}
test('earlier fade watch appears before the full weak-flow warning; never executable',()=>{
  const c=rows(60000,90,i=>i<70?100+i*.12:108);
  c[76][2]=110;c[76][4]=109;
  c[84][2]=109.8;c[84][4]=109;
  const earlier=c.slice(0,87), at=now-3*60000;
  const w=earlyFadeWatch(earlier,at);
  assert.equal(w.phase,'WATCH');assert.equal(w.executable,false);
  assert.equal(detectPumpFade(earlier,at),null);
  assert.equal(earlyFadeWatch(earlier,at+120000),null);
});
test('micro breakout watch precedes 15m breakout confirmation and ignores open bars',()=>{
  const m1=rows(60000,121,()=>96.01),m15=rows(900000,121,i=>90+i*.05),h1=rows(3600000,121,i=>90+i*.05);
  Object.assign(m1.at(-1),{1:96.05,2:96.22,3:96,4:96.2,5:150});
  const input={symbol:'ETHUSDT',m1,m15,h1,btc15:m15,btc1h:h1,now};
  const watch=earlyFuturesWatch(input);assert.equal(watch.phase,'WATCH');assert.equal(watch.direction,'LONG');
  assert.equal(watch.executable,false);assert.equal(directionalSignal(input).allowed,false);
  const neutralBtc15=rows(900000,121,()=>100);
  assert.equal(earlyFuturesWatch({...input,btc15:neutralBtc15}).direction,'LONG');
  const oppositeBtc15=rows(900000,121,i=>110-i*.05);
  assert.equal(earlyFuturesWatch({...input,btc15:oppositeBtc15}),null);
  const live=[Math.floor(now/60000)*60000,96.2,100,90,99,200,Math.floor(now/60000)*60000+59999,10000,0,0,6000];
  assert.deepEqual(earlyFuturesWatch({...input,m1:[...m1,live]}),watch);
  assert.equal(earlyFuturesWatch({...input,now:now+120000}),null);
});
