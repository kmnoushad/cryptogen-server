import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeBtcGate } from '../src/fade-btc-gate.js';
const now = 1800000000000;
const bars = (step = -10) => Array.from({length: 120}, (_, i) => {
  const t = now - (120-i)*60000, c = 60000+i*step;
  return [t, c, c+1, c-1, c, '1', t+59999];
});
const book = { bidPrice: '58809', askPrice: '58810' };
test('only confirmed bearish BTC permits shorts', () => {
  assert.equal(fadeBtcGate(bars(), book, now).allowed, true);
  assert.equal(fadeBtcGate(bars(10), {bidPrice:'61190',askPrice:'61191'}, now).allowed, false);
  assert.equal(fadeBtcGate(bars(0), {bidPrice:'60000',askPrice:'60001'}, now).allowed, false);
});
test('upward burst, missing, stale and discontinuous BTC data block shorts', () => {
  assert.equal(fadeBtcGate(bars(), {bidPrice:'59099',askPrice:'59100'}, now).allowed, false);
  assert.equal(fadeBtcGate([], book, now).allowed, false);
  assert.equal(fadeBtcGate(bars(), book, now+120000).allowed, false);
  const gap = bars(); gap.splice(50,1);
  assert.equal(fadeBtcGate(gap, book, now).allowed, false);
  const invalid = bars(); invalid[10][4] = 'NaN';
  assert.equal(fadeBtcGate(invalid, book, now).allowed, false);
});
test('unfinished BTC candle cannot authorize or block an entry', () => {
  const rows = bars(); rows.push([now,60000,70000,50000,70000,'1',now+59999]);
  assert.equal(fadeBtcGate(rows, book, now).allowed, true);
});
