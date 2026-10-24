import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNightBlock, fadeNightBlocked, configuredNightBlock, DEFAULT_NIGHT_BLOCK } from '../src/fade-night-block.js';
import { FadeExecutor } from '../src/fade-executor.js';
import { FuturesAutoExecutor } from '../src/futures-auto-executor.js';

const uae = (hh, mm = 0) => Date.parse(`2026-10-15T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+04:00`);
const def = parseNightBlock(undefined);

test('default blocks 00:00 to 07:59 UAE and allows 08:00 to 23:59 UAE', () => {
  assert.deepEqual({ start: def.start, end: def.end }, DEFAULT_NIGHT_BLOCK);
  for (const [h, m] of [[0, 0], [0, 1], [3, 30], [7, 59]]) assert.match(fadeNightBlocked(uae(h, m), def), /Night entry block 00:00-08:00 UAE/);
  for (const [h, m] of [[8, 0], [12, 0], [17, 0], [23, 0], [23, 59]]) assert.equal(fadeNightBlocked(uae(h, m), def), null);
});
test('setting can be turned off, moved, or wrap past midnight', () => {
  assert.equal(parseNightBlock('off'), null);
  assert.equal(fadeNightBlocked(uae(3), parseNightBlock('off')), null);
  const late = parseNightBlock('23-08');
  assert.ok(fadeNightBlocked(uae(23, 30), late)); assert.ok(fadeNightBlocked(uae(2), late)); assert.equal(fadeNightBlocked(uae(8), late), null);
  const short = parseNightBlock('01-06');
  assert.equal(fadeNightBlocked(uae(0, 30), short), null); assert.ok(fadeNightBlocked(uae(1), short)); assert.equal(fadeNightBlocked(uae(6), short), null);
});
test('invalid settings fall back to the default window and never block all day', () => {
  for (const bad of ['garbage', '25-08', '00-00', '0-24', '8', '-1-4']) {
    const b = parseNightBlock(bad);
    assert.equal(b.start, 0); assert.equal(b.end, 8);
    assert.equal(fadeNightBlocked(uae(12), b), null);
  }
  const b = configuredNightBlock({ FADE_NIGHT_BLOCK_UAE: 'nonsense' });
  assert.equal(b.start, 0); assert.equal(b.end, 8);
});

function fadeAt(time) {
  const touched = [];
  const spy = new Proxy({}, { get: (_, k) => (...a) => { touched.push(k); throw Error(`unexpected ${String(k)}`); } });
  const ex = new FadeExecutor({ cfg: { enableFadeExecution: true, fadeEnvironment: 'testnet', fadeEntrySource: 'spike' },
    exchange: spy, store: spy, telegram: spy, now: () => time });
  ex.spikeAuthorize = () => { touched.push('spikeAuthorize'); return false; };
  return { ex, touched };
}
test('Fade at 01:00 UAE records the night block and touches nothing (no exchange, store, telegram, authorization)', async () => {
  const { ex, touched } = fadeAt(uae(1));
  await ex.onSignal('AAAUSDT', { model: 'spike-fade-ticks-v1', barCloseTime: uae(1) - 500 });
  assert.match(ex.lastEntryAttempt.reason, /Night entry block 00:00-08:00 UAE/);
  assert.deepEqual(touched, []); assert.equal(ex.busy, false);
});
test('Fade at 09:00 UAE passes the night check and continues to the normal gates', async () => {
  const { ex, touched } = fadeAt(uae(9));
  await ex.onSignal('AAAUSDT', { model: 'spike-fade-ticks-v1', barCloseTime: uae(9) - 500 });
  assert.deepEqual(touched, ['spikeAuthorize']);
  assert.doesNotMatch(ex.lastEntryAttempt.reason, /Night entry block/);
});
test('Futures Auto keeps its own entry path: the Fade night block is not in it', () => {
  assert.notEqual(FuturesAutoExecutor.prototype.onSignal, FadeExecutor.prototype.onSignal);
  assert.doesNotMatch(FuturesAutoExecutor.prototype.onSignal.toString(), /fadeNightBlocked|Night entry block/);
});
