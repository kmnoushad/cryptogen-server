import test from 'node:test';
import assert from 'node:assert/strict';
import { BtcFeed } from '../src/btc-feed.js';

const cfg = { enableBtcFeed: true };

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = {};
    this.terminated = false;
    FakeSocket.instances.push(this);
  }
  on(event, fn) { this.handlers[event] = fn; }
  emit(event, ...args) { this.handlers[event]?.(...args); }
  close() { this.handlers.close?.(); }
  terminate() { this.terminated = true; this.handlers.close?.(); }
}

const makeFeed = (nowValue = 1_700_000_000_000) => {
  let now = nowValue;
  const feed = new BtcFeed({ cfg, WebSocketImpl: FakeSocket, now: () => now });
  return { feed, setNow: value => { now = value; }, getNow: () => now };
};

const aggFrame = trade => JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', ...trade } });
const klineFrame = (k, closed) => JSON.stringify({
  stream: 'btcusdt@kline_1m',
  data: { e: 'kline', k: { t: 1_700_000_000_000, T: 1_700_000_059_999, o: '100', h: '101', l: '99', c: '100.5', v: '12', q: '1205', x: closed, ...k } },
});
const depthFrame = (bids, asks) => JSON.stringify({
  stream: 'btcusdt@depth20@1000ms',
  data: { b: bids, a: asks },
});

test('aggTrade frames bucket taker buy/sell quote volume per rolling window', () => {
  const { feed } = makeFeed();
  feed.handleMessage(aggFrame({ p: '100', q: '2', m: false, T: 1_700_000_000_000 })); // taker buy $200
  feed.handleMessage(aggFrame({ p: '100', q: '1', m: true, T: 1_700_000_001_000 })); // taker sell $100
  const w1 = feed.takerWindow(1);
  assert.equal(w1.buy, 200);
  assert.equal(w1.sell, 100);
  assert.equal(w1.buyRatio, 2 / 3);
  const cvd = feed.cvdWindow(15);
  assert.equal(cvd.delta, 100);
  assert.equal(cvd.volume, 300);
  assert.equal(feed.lastPrice, 100);
});

test('taker windows prune points older than the horizon', () => {
  const { feed, setNow } = makeFeed();
  feed.ingestAggTrade({ p: '100', q: '1', m: false, T: 1_700_000_000_000 });
  feed.ingestAggTrade({ p: '100', q: '1', m: true, T: 1_700_000_000_000 + 31 * 60_000 });
  setNow(1_700_000_000_000 + 31 * 60_000);
  const w30 = feed.takerWindow(30);
  assert.equal(w30.buy, 0); // first trade pruned from the 30m window
  assert.equal(w30.sell, 100);
  assert.equal(feed.takerWindow(31).buy, 100);
});

test('out-of-order aggTrade events are ignored', () => {
  const { feed } = makeFeed();
  feed.ingestAggTrade({ p: '100', q: '1', m: false, T: 5_000 });
  const stale = feed.ingestAggTrade({ p: '90', q: '9', m: true, T: 4_000 });
  assert.equal(stale.ignored, true);
  assert.equal(feed.lastPrice, 100);
  assert.equal(feed.trades.length, 1);
});

test('kline frames track the live candle and fire onCandle only on close', () => {
  const { feed } = makeFeed();
  const closed = [];
  feed.onCandle = candle => closed.push(candle);
  feed.handleMessage(klineFrame({ c: '100.2' }, false));
  assert.equal(feed.liveCandle.close, 100.2);
  assert.equal(feed.closes.length, 0);
  assert.equal(closed.length, 0);
  feed.handleMessage(klineFrame({ c: '100.5', q: '999' }, true));
  assert.equal(feed.closes.length, 1);
  assert.equal(feed.closes[0].close, 100.5);
  assert.equal(feed.closes[0].qv, 999);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].t, 1_700_000_000_000);
  // A re-delivered close for the same openTime replaces, never duplicates.
  feed.handleMessage(klineFrame({ c: '100.6' }, true));
  assert.equal(feed.closes.length, 1);
  assert.equal(feed.closes[0].close, 100.6);
});

test('a throwing onCandle callback never escapes the WS handler', () => {
  const { feed } = makeFeed();
  feed.onCandle = () => { throw new Error('boom'); };
  feed.handleMessage(klineFrame({}, true));
  assert.match(feed.lastError, /onCandle: boom/);
});

test('depth frames replace the book snapshot wholesale', () => {
  const { feed } = makeFeed();
  feed.handleMessage(depthFrame([['99', '5'], ['98', '3']], [['101', '2']]));
  assert.deepEqual(feed.book.bids, [[99, 5], [98, 3]]);
  assert.deepEqual(feed.book.asks, [[101, 2]]);
  feed.handleMessage(depthFrame([['97', '1']], [['102', '4'], ['103', '1']]));
  assert.deepEqual(feed.book.bids, [[97, 1]]); // replaced, not merged
  assert.deepEqual(feed.book.asks, [[102, 4], [103, 1]]);
});

test('boot seeding warms the close ring and never throws on failure', async () => {
  const rows = Array.from({ length: 240 }, (_, i) => [
    1_700_000_000_000 + i * 60_000, '100', '101', '99', String(100 + i * 0.1), '10',
    1_700_000_000_000 + i * 60_000 + 59_999, '1000', '5', '6', '600', '0',
  ]);
  const { feed } = makeFeed(1_700_000_000_000 + 240 * 60_000); // all 240 rows already closed
  feed.binance = { klines: async () => rows };
  assert.equal(await feed.seed(), true);
  assert.equal(feed.warmed, true);
  assert.equal(feed.closes.length, 240);
  assert.equal(feed.lastPrice, 100 + 239 * 0.1);

  const failing = new BtcFeed({ cfg, binance: { klines: async () => { throw new Error('HTTP 418'); } }, now: () => 0 });
  assert.equal(await failing.seed(), false);
  assert.equal(failing.warmed, false);
  assert.match(failing.lastError, /boot seed/);
});

test('boot seeding drops the final REST kline when it is the still-open candle', async () => {
  const now = 1_700_000_000_000 + 240 * 60_000;
  const rows = Array.from({ length: 240 }, (_, i) => [
    1_700_000_000_000 + i * 60_000, '100', '101', '99', String(100 + i * 0.1), '10',
    1_700_000_000_000 + i * 60_000 + 59_999, '1000', '5', '6', '600', '0',
  ]);
  rows.push([now, '100', '101', '99', '100.5', '10', now + 59_999, '1000', '5', '6', '600', '0']); // open candle
  const { feed } = makeFeed(now);
  feed.binance = { klines: async () => rows };
  assert.equal(await feed.seed(), true);
  assert.equal(feed.closes.length, 240); // the unclosed tail candle is excluded
  assert.ok(feed.closes.every(c => c.closeTime <= now));
  assert.equal(feed.lastPrice, 100 + 239 * 0.1);
});

test('connect lifecycle: open clears error, close schedules backoff reconnect', () => {
  FakeSocket.instances = [];
  const { feed } = makeFeed();
  feed.connect();
  const socket = FakeSocket.instances[0];
  // Binance split WS endpoints (/public, /market); legacy unrouted URLs were
  // decommissioned 2026-04-23. aggTrade + kline_1m now route via /market and
  // partial depth via /public, so connect() opens two sockets.
  assert.match(socket.url, /\/market\/stream\?streams=btcusdt@aggTrade\/btcusdt@kline_1m/);
  assert.match(FakeSocket.instances[1].url, /\/public\/stream\?streams=btcusdt@depth20@500ms/);
  socket.emit('open');
  assert.equal(feed.connected, true);
  socket.emit('close');
  assert.equal(feed.connected, false);
  assert.ok(feed.reconnectTimer); // close auto-schedules the first backoff step
  assert.equal(feed.reconnectAttempts, 1);
  feed.reconnectTimer = null;
  assert.equal(feed.scheduleReconnect(), 2_000); // next backoff step doubles
  feed.reconnectTimer = null;
  feed.reconnectAttempts = 6;
  assert.equal(feed.scheduleReconnect(), 30_000); // backoff capped
  feed.stop();
});

test('stale connected stream is terminated so reconnect can take over', () => {
  const { feed } = makeFeed(40_001);
  feed.connected = true;
  feed.connectedAt = 1;
  feed.socket = { terminate: () => { feed.terminated = true; } };
  feed.checkLiveness();
  assert.equal(feed.terminated, true);
  assert.match(feed.lastError, /stale/);
});

test('health reports connection, warm-up and staleness state', () => {
  const { feed } = makeFeed(40_001);
  const health = feed.health();
  assert.equal(health.enabled, true);
  assert.equal(health.connected, false);
  assert.equal(health.warmed, false);
  assert.equal(health.closes, 0);
  feed.connected = true;
  feed.connectedAt = 1;
  assert.equal(feed.health().stale, true); // >30s without any message since connect
  feed.lastMessageAt = 39_999;
  assert.equal(feed.health().stale, false);
});


