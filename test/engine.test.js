import test from 'node:test';
import assert from 'node:assert/strict';
import { FUTURES_EXCLUDED } from '../src/engine.js';

test('deep non-meme Binance Futures contracts remain eligible', () => {
  for (const symbol of ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT']) {
    assert.equal(FUTURES_EXCLUDED.has(symbol), false, `${symbol} must stay in the Futures universe`);
  }
  assert.equal(FUTURES_EXCLUDED.has('BTCUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('DOGEUSDT'), true);
  assert.equal(FUTURES_EXCLUDED.has('1000PEPEUSDT'), true);
});
