import test from 'node:test';
import assert from 'node:assert/strict';
import { entryQuality, nextClosedMinuteDelay } from '../src/entry-quality.js';
import { PumpFadeRadar } from '../src/pump-fade.js';
import { FuturesAutoWorkerLoop } from '../src/futures-auto-worker-loop.js';

test('cost guard uses verified fee rate and mirrors both directions', () => {
  for (const direction of ['LONG', 'SHORT']) {
    const sign = direction === 'LONG' ? 1 : -1;
    const args = { direction, entry: 100, reference: 100, stop: 100 - sign * .6, fee: .0005 };
    assert.equal(entryQuality(args).allowed, true);
    const tiny = entryQuality({ ...args, stop: 100 - sign * .1 });
    assert.equal(tiny.allowed, false); assert.ok(tiny.costShare > .59);
    assert.equal(entryQuality({ ...args, fee: .003 }).allowed, false);
    assert.equal(entryQuality({ ...args, fee: NaN }).allowed, false);
  }
});
test('no-chase budget uses a quarter of stop distance with an absolute 0.15% ceiling', () => {
  assert.equal(entryQuality({ direction: 'LONG', entry: 100.16, reference: 100, stop: 99, fee: .0005 }).allowed, false);
  assert.equal(entryQuality({ direction: 'SHORT', entry: 99.84, reference: 100, stop: 101, fee: .0005 }).allowed, false);
  assert.equal(entryQuality({ direction: 'LONG', entry: 100, reference: 100, stop: 101, fee: .0005 }).allowed, false);
  // Cheap fees allow a narrow structural stop, but never chasing most of it.
  const x = entryQuality({ direction: 'LONG', entry: 100.08, reference: 100, stop: 99.9, fee: .00001, exitSlip: 0 });
  assert.equal(x.allowed, false); assert.match(x.reason, /no-chase/);
});
test('close scheduler has no permanent startup offset, replay, or duplicate start', () => {
  let now = 39000, pending, delay, canceled, polls = 0;
  const radar = new PumpFadeRadar({ cfg: { enablePumpFadeAlerts: true }, now: () => now,
    schedule: (fn, ms) => { pending = fn; delay = ms; return 1; }, cancel: id => { canceled = id; } });
  radar.poll = async () => { polls++; };
  radar.start(); radar.start(); assert.equal(polls, 1); assert.equal(delay, 22500);
  now = 61500; pending(); assert.equal(polls, 2); assert.equal(delay, 60000);
  // A late callback skips missed intervals; never a burst of catch-up scans.
  now = 200000; pending(); assert.equal(delay, 41500);
  radar.stop(); assert.equal(canceled, 1); pending(); assert.equal(polls, 3);
  assert.equal(nextClosedMinuteDelay(60000), 1500);
});
test('minute keyed Futures scans remove drift while protection runs every tick', async () => {
  let now = 59000, reads = 0, protections = 0;
  const ex = { scope: 'live:directional', cfg: { enabled: true }, row: { state: { paused: false, jobs: [] } },
    scanReasons: {}, lastError: null, run: async () => { protections++; },
    exchange: { candles: async () => { reads++; return []; } }, status: () => '', failed: async e => { throw e; } };
  const store = { control: async () => ({ paused: false }), heartbeat: async () => {} };
  const worker = new FuturesAutoWorkerLoop({ executor: ex, store, now: () => now });
  await worker.tick(); const initial = reads;
  now = 60000; await worker.tick(); assert.equal(reads, initial);
  now = 62000; await worker.tick(); assert.equal(reads, initial * 2);
  now = 70000; await worker.tick(); assert.equal(reads, initial * 2);
  assert.equal(protections, 4);
});
