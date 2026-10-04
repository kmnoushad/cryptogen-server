import test from 'node:test';
import assert from 'node:assert/strict';
import { researchEntry, REBUILD_MODELS } from '../src/research-entry-models.js';
import { aggregate, readSeries } from '../scripts/replay-entry-rebuild.js';
const now = 1800000000000;
function trend(interval) {
  const end = Math.floor(now / interval) * interval;
  return Array.from({ length: 80 }, (_, i) => {
    const p = 100 + i * .04, t = end - (80 - i) * interval;
    return [t, p - .02, p + .1, p - .1, p, 100, t + interval - 1, 10000, 0, 0, 6000];
  });
}
function fixture() {
  const m5 = trend(300000), m15 = trend(900000);
  for (const row of m5) { row[2] = row[4] + .5; row[3] = row[4] - .5; }
  // Pullback into EMA20 followed by a separate recovery candle.
  m5[78].splice(1, 4, 103.05, 103.1, 102.65, 102.85);
  m5[79].splice(1, 4, 102.86, 103.22, 102.8, 103.18);
  return { model: 'pullback5', symbol: 'ETHUSDT', m5, m15, btc15: m15, now };
}
test('research recovery uses closed bars and cannot authorize a live order', () => {
  const input = fixture(), result = researchEntry(input);
  assert.equal(result.allowed, true, result.reason);
  assert.equal(result.executable, false); assert.equal(result.direction, 'LONG');
  const future = [...input.m5.at(-1)]; future[0] += 300000; future[6] += 300000;
  future[4] = 90; future[3] = 89;
  assert.deepEqual(researchEntry({ ...input, m5: [...input.m5, future] }), result);
  assert.equal(researchEntry({ ...input, now: now + 600000 }).allowed, false);
  assert.equal(researchEntry({ ...input, model: 'unknown' }).allowed, false);
});
test('SHORT is a mirrored recovery with the same cost and no-widening rules', () => {
  const input = fixture();
  const mirror = xs => xs.map(r => { const x = [...r];
    x[1] = 200-r[1]; x[2] = 200-r[3]; x[3] = 200-r[2]; x[4] = 200-r[4]; x[10] = x[7]-r[10]; return x; });
  const result = researchEntry({ ...input, m5: mirror(input.m5), m15: mirror(input.m15), btc15: mirror(input.btc15) });
  assert.equal(result.allowed, true, result.reason); assert.equal(result.direction, 'SHORT');
  assert.ok(result.stop > result.entry); assert.equal(result.executable, false);
});
test('pump absence is explicit, incomplete files fail and aggregation excludes partial bars', () => {
  const input = fixture();
  assert.match(researchEntry({ ...input, model: 'auctionFade5', gain24h: 2, quote24h: 100000000 }).reason, /pump/);
  assert.throws(() => readSeries(Buffer.alloc(0), 0, 60000), /Incomplete/);
  const rows = Array.from({ length: 6 }, (_, i) => [i*60000, 100, 101, 99, 100, 10, 1000, 600]);
  const a = aggregate(rows, 5); assert.equal(a.length, 1); assert.equal(a[0][6], 299999); assert.equal(a[0][7], 5000);
  assert.equal(REBUILD_MODELS.length, 3);
});
test('failed auction can qualify at resistance, while a bullish relative-strength veto survives', () => {
  const m5 = trend(300000);
  for (let i = 0; i < m5.length; i++) {
    const p = 100 + i * .26; m5[i].splice(1, 4, p - .02, p + .1, p - .1, p);
  }
  m5[79].splice(1, 4, 120.4, 121, 119.9, 120.3); m5[79][5] = 150; m5[79][10] = 4000;
  const bullish = trend(900000), bearish = bullish.map(r => { const x = [...r];
    x[1] = 200-r[1]; x[2] = 200-r[3]; x[3] = 200-r[2]; x[4] = 200-r[4]; return x; });
  const args = { model: 'auctionFade5', symbol: 'ETHUSDT', m5, m15: bullish, btc15: bearish, now, gain24h: 20, quote24h: 20000000 };
  const result = researchEntry(args);
  assert.equal(result.allowed, true, result.reason); assert.equal(result.executable, false);
  assert.ok(result.stop > 121);
  assert.match(researchEntry({ ...args, btc15: bullish }).reason, /relative weakness/);
});
test('aggregates and signals at a timestamp do not change when future data is appended', () => {
  const rows = Array.from({ length: 10 }, (_, i) => [i*60000, 100, 101, 99, 100, 10, 1000, 500]);
  const past = aggregate(rows.slice(0, 5), 5);
  const all = aggregate(rows, 5).filter(r => r[6] < 300000);
  assert.deepEqual(all, past);
});
