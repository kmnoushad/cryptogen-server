import test from 'node:test';
import assert from 'node:assert/strict';
import { BtcRecorder } from '../src/btc-recorder.js';
import { Store, isBtcTableMissingError } from '../src/store.js';
import { HttpError } from '../src/http.js';

const cfg = { enableBtcRecorder: true };
const NOW = 1_700_000_000_000;

const candle = {
  t: NOW - 60_000,
  closeTime: NOW - 1,
  open: 100, high: 101, low: 99, close: 100.5, qv: 1_000,
};

const snapshot = {
  at: NOW,
  price: 100.5,
  h15: { score: -52, label: 'DOWN', confidence: 71, drivers: ['taker sells 61%'] },
  h30: { score: -38, label: 'DOWN', confidence: 60, drivers: [] },
  book: { imbalanceTop10: -0.2, bidWallBps: null, askWallBps: 12, bidWallX: null, askWallX: 4.1 },
  indicators: {
    ema9: 100.1, ema21: 100.4, ema50: 100.9,
    buyRatio1m: 0.4, buyRatio5m: 0.39, buyRatio15m: 0.38,
    cvd15m: -250, volVelocity: 2.3, oiChgPct: 0.12, fundingPct: 0.01,
  },
  stale: false,
};

test('isBtcTableMissingError recognizes PostgREST table-missing signatures', () => {
  assert.equal(isBtcTableMissingError(new HttpError('x', { status: 404 })), true);
  assert.equal(isBtcTableMissingError(new HttpError('x', { status: 400, body: '{"code":"PGRST205"}' })), true);
  assert.equal(isBtcTableMissingError(new HttpError('x', { status: 500, body: '42P01 relation does not exist' })), true);
  assert.equal(isBtcTableMissingError(new HttpError('x', { status: 500, body: 'timeout' })), false);
  assert.equal(isBtcTableMissingError(new Error('network down')), false);
});

test('store.insertBtcSnapshot posts the row and returns true (never throws)', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 201, text: async () => '', headers: { get: () => null } };
  };
  try {
    const store = new Store({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'key' });
    const ok = await store.insertBtcSnapshot({ ts: 'x', close: 1 });
    assert.equal(ok, true);
    assert.match(calls[0].url, /\/rest\/v1\/btc_snapshots$/);
    assert.equal(JSON.parse(calls[0].options.body).close, 1);
    assert.equal(store.btcSnapshotsTableMissing ?? false, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('store.insertBtcSnapshot flags table-missing and returns false', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '{"code":"PGRST205"}', headers: { get: () => null } });
  try {
    const store = new Store({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'key' });
    assert.equal(await store.insertBtcSnapshot({ ts: 'x' }), false);
    assert.equal(store.btcSnapshotsTableMissing, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('store.insertBtcSnapshot returns false (not missing) on a transient failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } });
  try {
    const store = new Store({ supabaseUrl: 'https://example.supabase.co', supabaseKey: 'key' });
    assert.equal(await store.insertBtcSnapshot({ ts: 'x' }), false);
    assert.equal(store.btcSnapshotsTableMissing ?? false, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recorder row shape covers every btc_snapshots column', () => {
  const recorder = new BtcRecorder({ cfg, store: {}, now: () => NOW });
  const row = recorder.buildRow(candle, snapshot);
  assert.deepEqual(Object.keys(row).sort(), [
    'ts', 'close', 'ema9', 'ema21', 'ema50',
    'buy_ratio_1m', 'buy_ratio_5m', 'buy_ratio_15m', 'cvd_15m',
    'book_imb_top10', 'bid_wall_bps', 'ask_wall_bps', 'bid_wall_x', 'ask_wall_x',
    'vol_velocity', 'oi_chg_pct', 'funding',
    'score15', 'label15', 'conf15', 'score30', 'label30', 'conf30',
  ].sort());
  assert.equal(row.ts, new Date(NOW - 1).toISOString());
  assert.equal(row.close, 100.5);
  assert.equal(row.ema21, 100.4);
  assert.equal(row.buy_ratio_15m, 0.38);
  assert.equal(row.cvd_15m, -250);
  assert.equal(row.book_imb_top10, -0.2);
  assert.equal(row.ask_wall_bps, 12);
  assert.equal(row.bid_wall_bps, null);
  assert.equal(row.score15, -52);
  assert.equal(row.label15, 'DOWN');
  assert.equal(row.conf30, 60);
});

test('recorder inserts one row per closed candle', async () => {
  const rows = [];
  const store = { insertBtcSnapshot: async row => { rows.push(row); return true; } };
  const bias = { lastSnapshot: snapshot };
  const recorder = new BtcRecorder({ cfg, store, bias, now: () => NOW });
  assert.equal(await recorder.onCandle(candle), true);
  assert.equal(rows.length, 1);
  assert.equal(recorder.metrics.inserted, 1);
  assert.equal(recorder.health().lastRowAt, new Date(NOW).toISOString());
});

test('table-missing reply warns once and disables the recorder without throwing', async () => {
  let calls = 0;
  const store = {
    btcSnapshotsTableMissing: false,
    insertBtcSnapshot: async () => { calls++; store.btcSnapshotsTableMissing = true; return false; },
  };
  const recorder = new BtcRecorder({ cfg, store, bias: { lastSnapshot: snapshot }, now: () => NOW });
  assert.equal(await recorder.onCandle(candle), false);
  assert.equal(recorder.disabled, true);
  assert.equal(recorder.warnedMissing, true);
  assert.equal(await recorder.onCandle(candle), false); // disabled: no further inserts
  assert.equal(calls, 1);
  assert.equal(recorder.health().tableMissing, true);
});

test('a plain insert failure counts but keeps recording; a throwing store is contained', async () => {
  const flaky = { insertBtcSnapshot: async () => false };
  const recorder = new BtcRecorder({ cfg, store: flaky, bias: { lastSnapshot: snapshot }, now: () => NOW });
  assert.equal(await recorder.onCandle(candle), false);
  assert.equal(recorder.disabled, false);
  assert.equal(recorder.metrics.failed, 1);

  const throwing = { insertBtcSnapshot: async () => { throw new Error('db on fire'); } };
  const contained = new BtcRecorder({ cfg, store: throwing, bias: { lastSnapshot: snapshot }, now: () => NOW });
  assert.equal(await contained.onCandle(candle), false); // never throws into the engine
  assert.equal(contained.metrics.errors, 1);
});

test('recorder stays off when disabled via config or missing bias', async () => {
  let calls = 0;
  const store = { insertBtcSnapshot: async () => { calls++; return true; } };
  const off = new BtcRecorder({ cfg: { enableBtcRecorder: false }, store, now: () => NOW });
  assert.equal(await off.onCandle(candle), false);
  const noBias = new BtcRecorder({ cfg, store, bias: null, now: () => NOW });
  assert.equal(await noBias.onCandle(candle), true); // nulls in indicator columns
  assert.equal(calls, 1);
});
