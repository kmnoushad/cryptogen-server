import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeShockGuard } from '../src/realtime-shock.js';

const cfg = {
  enableRealtimeShock: true,
  realtimeShockDropPct: 0.35,
  realtimeShockWindowMs: 10_000,
  realtimeShockCooldownMs: 120_000,
};

test('rolling BTC trade stream triggers once at a 0.35% ten-second fall', async () => {
  let now = 1_000;
  const events = [];
  const guard = new RealtimeShockGuard({ cfg, now: () => now, onShock: event => events.push(event) });
  guard.ingest(100, 0);
  const quiet = guard.ingest(99.70, 5_000);
  assert.equal(quiet.triggered, false);
  const shock = guard.ingest(99.64, 10_000);
  assert.equal(shock.triggered, true);
  assert.equal(guard.blocked(), true);
  await Promise.resolve();
  assert.equal(events.length, 1);

  now += 5_000;
  const extension = guard.ingest(99.30, 11_000);
  assert.equal(extension.triggered, false);
  assert.equal(extension.extended, true);
  assert.equal(events.length, 1);
});

test('realtime shock block expires after its cooldown', () => {
  let now = 1_000;
  const guard = new RealtimeShockGuard({ cfg, now: () => now });
  guard.ingest(100, 0);
  guard.ingest(99.6, 10_000);
  assert.equal(guard.blocked(), true);
  now = 122_000;
  assert.equal(guard.blocked(), false);
});

test('stale trade events cannot corrupt the rolling BTC peak queue', () => {
  const guard = new RealtimeShockGuard({ cfg, now: () => 1_000 });
  guard.ingest(100, 5_000);
  const stale = guard.ingest(90, 4_000);
  assert.equal(stale.ignored, true);
  const current = guard.ingest(99.9, 6_000);
  assert.equal(current.triggered, false);
});

test('stale connected stream is terminated so reconnect can take over', () => {
  let terminated = false;
  const guard = new RealtimeShockGuard({ cfg, now: () => 40_001 });
  guard.connected = true;
  guard.connectedAt = 1;
  guard.socket = { terminate: () => { terminated = true; } };
  guard.checkLiveness();
  assert.equal(terminated, true);
  assert.match(guard.lastError, /stale/);
});
