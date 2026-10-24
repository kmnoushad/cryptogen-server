import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationTracker } from '../src/worker-operation-tracker.js';
import { Store } from '../src/store.js';
test('tracker records operation age without retaining arguments and removes settled calls', async () => {
  let now = 100, resolve;
  const tracker = new OperationTracker(() => now);
  const target = { value: 7, read() { assert.equal(this.value, 7); return new Promise(r => { resolve = r; }); }, fail() { throw Error('fault'); } };
  const proxy = tracker.wrap(target, 'exchange');
  const pending = proxy.read('secret credential'); now += 30;
  assert.deepEqual(tracker.snapshot(), [{ operation: 'exchange.read', elapsedMs: 30 }]);
  assert.ok(!JSON.stringify(tracker.snapshot()).includes('secret'));
  resolve('unchanged'); assert.equal(await pending, 'unchanged'); assert.deepEqual(tracker.snapshot(), []);
  assert.throws(() => proxy.fail(), /fault/); assert.deepEqual(tracker.snapshot(), []);
});
test('execution database reads fail once without hidden retries', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('network offline'); };
  try {
    const store = new Store({ supabaseUrl: 'https://example.invalid', supabaseKey: 'test', enableFadeExecution: true });
    await assert.rejects(store.get('nexio_fade_control'), /network offline/); assert.equal(calls, 1);
    assert.equal(new Store({ supabaseUrl: 'https://example.invalid', supabaseKey: 'test' }).executionReads, false);
  } finally { globalThis.fetch = previous; }
});
