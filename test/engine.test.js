import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, FUTURES_EXCLUDED } from '../src/engine.js';

test('deep non-meme Binance Futures contracts remain eligible', () => {
  for (const symbol of ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT']) {
    assert.equal(FUTURES_EXCLUDED.has(symbol), false, `${symbol} must stay in the Futures universe`);
  }
  assert.equal(FUTURES_EXCLUDED.has('BTCUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('DOGEUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('1000PEPEUSDT'), true);
});

test('realtime BTC shock clears every pending Futures candidate immediately', async () => {
  const messages = [];
  const events = [];
  const engine = new Engine({
    cfg: { realtimeShockWindowMs: 10_000, realtimeShockCooldownMs: 120_000 },
    binance: {},
    store: { insertEvent: async event => { events.push(event); return true; } },
    telegram: { send: async message => { messages.push(message); } },
  });
  engine.candidates.set('ETHUSDT', { state: 'ARMED' });
  engine.candidates.set('SOLUSDT', { state: 'RETESTED' });

  await engine.handleRealtimeShock({ dropPct: -0.42, price: 99_580, peak: 100_000, eventTime: 10_000 });

  assert.equal(engine.candidates.size, 0);
  assert.equal(engine.metrics.rejected, 2);
  assert.equal(events[0].event_type, 'FUTURES_REALTIME_SHOCK');
  assert.match(messages[0], /Cancelled pending Futures candidates: 2/);
});
