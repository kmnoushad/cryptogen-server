import test from 'node:test';
import assert from 'node:assert/strict';
import { MoverPaperBook } from '../src/mover-paper.js';

const memoryStore = () => {
  const rows = [];
  return { rows, async moverPaperEvents() { return rows; }, async insertEvent(e) {
    if (rows.some(r => r.event_key === e.event_key)) return false;
    rows.push({ ...e, created_at: new Date().toISOString() }); return true;
  } };
};

test('separate cohorts open only simulated positions with capped modeled risk and recover from journal', async () => {
  const store = memoryStore(); let now = Date.parse('2026-10-05T12:00:00Z');
  const book = new MoverPaperBook({ store, now: () => now });
  assert.equal(await book.initialize(), true);
  const f = await book.open({ strategy: 'FUTURES_TRENDING_MOVER', eventKey: 'event-1', symbol: 'ABCUSDT', price: 10, stopPrice: 9.8 });
  const a = await book.open({ strategy: 'ALPHA_FAST_MOVER', eventKey: 'event-2', symbol: '56:0xabc', price: 1, stopPrice: 0.97 });
  assert.equal(f.opened, true); assert.equal(a.opened, true);
  assert.ok(f.position.riskUsd <= 10.01); assert.ok(a.position.riskUsd <= 10.01);
  assert.equal((await book.open({ strategy: 'FUTURES_TRENDING_MOVER', eventKey: 'event-1', symbol: 'ABCUSDT', price: 10, stopPrice: 9.8 })).reason, 'duplicate event');
  const recovered = new MoverPaperBook({ store, now: () => now });
  assert.equal(await recovered.initialize(), true);
  assert.equal(recovered.balance('FUTURES_TRENDING_MOVER').open, 1);
  assert.equal(recovered.balance('ALPHA_FAST_MOVER').open, 1);
});

test('mark closes at stop/target/timeout, includes costs, and loss lock reserves open risk', async () => {
  const store = memoryStore(); let now = Date.parse('2026-10-05T12:00:00Z');
  const book = new MoverPaperBook({ store, now: () => now, dailyLossUsd: 30 });
  await book.initialize();
  const p = await book.open({ strategy: 'FUTURES_TRENDING_MOVER', eventKey: 'target', symbol: 'ABCUSDT', price: 10, stopPrice: 9.8 });
  assert.ok(p.opened);
  await book.mark('FUTURES_TRENDING_MOVER', 'ABCUSDT', p.position.target + 0.1);
  const s = book.balance('FUTURES_TRENDING_MOVER');
  assert.equal(s.open, 0); assert.equal(book.closed[0].reason, 'TARGET');
  assert.ok(book.closed[0].netPnl > 0); assert.ok(book.closed[0].modeledCosts > 0);
  assert.equal(await book.open({ strategy: 'FUTURES_TRENDING_MOVER', eventKey: 'bad', symbol: 'BADUSDT', price: 10, stopPrice: 11 }).then(x => x.opened), false);

  const stop = await book.open({ strategy: 'ALPHA_FAST_MOVER', eventKey: 'stop', symbol: '56:0xdef', price: 1, stopPrice: 0.99 });
  assert.ok(stop.opened);
  await book.mark('ALPHA_FAST_MOVER', '56:0xdef', 0.97);
  assert.equal(book.closed.at(-1).reason, 'STOP');
  assert.ok(book.closed.at(-1).netPnl < 0);
  const timed = await book.open({ strategy: 'FUTURES_TRENDING_MOVER', eventKey: 'timeout', symbol: 'TIMEUSDT', price: 10, stopPrice: 9.8 });
  assert.ok(timed.opened);
  now += 24 * 60 * 60_000;
  await book.sweep();
  assert.equal(book.closed.at(-1).reason, 'TIME');
  assert.equal(book.balance('ALPHA_FAST_MOVER').open, 0);
});

test('failed event store remains fail-closed for simulated entries', async () => {
  const book = new MoverPaperBook({ store: { moverPaperEvents: async () => { throw Error('offline'); } } });
  assert.equal(await book.initialize(), false);
  assert.equal((await book.open({ strategy: 'ALPHA_FAST_MOVER', eventKey: 'x', symbol: 'x', price: 1, stopPrice: 0.9 })).reason, 'paper ledger unavailable');
});
