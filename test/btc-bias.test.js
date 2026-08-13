import test from 'node:test';
import assert from 'node:assert/strict';
import { BtcFeed } from '../src/btc-feed.js';
import { BtcBiasEngine, biasLabel, labelDirection } from '../src/btc-bias.js';

const NOW = 1_700_000_000_000;
const cfg = { enableBtcFeed: true, enableBtcBiasAlerts: true, btcBiasFlipCooldownMin: 10, btcBiasBlockLongs: false };

const makeCloses = (start, step, count = 240) => Array.from({ length: count }, (_, i) => ({
  t: NOW - (count - i) * 60_000,
  closeTime: NOW - (count - i) * 60_000 + 59_999,
  open: start + i * step,
  high: start + (i + 1) * step + 0.02,
  low: start + i * step - 0.02,
  close: start + (i + 1) * step,
  qv: 1_000,
}));

const makeBook = (mid, { bidWall = 0, askWall = 0, bidQty = 1, askQty = 1 } = {}) => {
  const bids = Array.from({ length: 20 }, (_, i) => [mid - 0.1 - i * 0.05, i === 0 && bidWall ? bidWall : bidQty]);
  const asks = Array.from({ length: 20 }, (_, i) => [mid + 0.1 + i * 0.05, i === 0 && askWall ? askWall : askQty]);
  return { bids, asks, at: NOW };
};

// A fully wired feed stub (real BtcFeed, no socket): trending closes, dominant
// taker side and a one-sided book with a nearby wall.
const makeFeed = ({ direction = 'up' } = {}) => {
  const feed = new BtcFeed({ cfg, now: () => NOW });
  const up = direction === 'up';
  feed.closes = makeCloses(up ? 100 : 112, up ? 0.05 : -0.05);
  feed.lastPrice = feed.closes.at(-1).close;
  feed.lastKlineAt = NOW;
  feed.lastBookAt = NOW;
  const mid = feed.lastPrice;
  feed.book = up
    ? makeBook(mid, { bidWall: 30, bidQty: 2, askQty: 1 })
    : makeBook(mid, { askWall: 30, bidQty: 1, askQty: 2 });
  for (let i = 0; i < 10; i++) feed.ingestAggTrade({ p: String(mid), q: '10', m: !up, T: NOW - i * 1_000 });
  for (let i = 0; i < 2; i++) feed.ingestAggTrade({ p: String(mid), q: '1', m: up, T: NOW - i * 500 });
  return feed;
};

const makeEngine = (overrides = {}) => new BtcBiasEngine({ cfg, feed: makeFeed(overrides), now: () => NOW, ...overrides });

test('labels follow the |score| >= 60 / 25 thresholds', () => {
  assert.equal(biasLabel(85), 'STRONG_UP');
  assert.equal(biasLabel(-60), 'STRONG_DOWN');
  assert.equal(biasLabel(25), 'UP');
  assert.equal(biasLabel(-25), 'DOWN');
  assert.equal(biasLabel(0), 'NEUTRAL');
  assert.equal(labelDirection('STRONG_UP'), 1);
  assert.equal(labelDirection('DOWN'), -1);
  assert.equal(labelDirection('NEUTRAL'), 0);
});

test('synthetic uptrend with buy flow and a nearby bid wall scores STRONG_UP', () => {
  const snapshot = makeEngine({ direction: 'up' }).evaluate();
  assert.equal(snapshot.h15.label, 'STRONG_UP');
  assert.equal(snapshot.h30.label, 'STRONG_UP');
  assert.ok(snapshot.h15.score >= 60, `score ${snapshot.h15.score}`);
  assert.equal(snapshot.stale, false);
  assert.ok(snapshot.components.emaTrend > 0.9);
  assert.ok(snapshot.components.takerFlow > 0.9);
  assert.ok(snapshot.components.bookImbalance > 0.9);
  assert.ok(snapshot.components.walls > 0.9);
  assert.ok(snapshot.components.cvdSlope > 0.9);
  assert.equal(snapshot.h15.drivers.length, 3);
  assert.ok(snapshot.book.bidWallBps <= 15);
  assert.ok(snapshot.book.bidWallX >= 3);
  assert.ok(snapshot.indicators.buyRatio15m > 0.9);
  assert.ok(snapshot.indicators.ema21 > 0);
});

test('heavy sell flow plus a nearby ask wall in a downtrend scores STRONG_DOWN', () => {
  const snapshot = makeEngine({ direction: 'down' }).evaluate();
  assert.equal(snapshot.h15.label, 'STRONG_DOWN');
  assert.ok(snapshot.h15.score <= -60, `score ${snapshot.h15.score}`);
  assert.ok(snapshot.h15.drivers.some(d => /taker sells \d+%/.test(d)));
  assert.ok(snapshot.book.askWallBps <= 15);
});

test('stale book caps confidence at 40 and marks the snapshot stale', () => {
  const engine = makeEngine({ direction: 'up' });
  engine.feed.lastBookAt = NOW - 10_000; // depth20@1000ms should update every second
  const snapshot = engine.evaluate();
  assert.equal(snapshot.stale, true);
  assert.ok(snapshot.h15.confidence <= 40);
  assert.equal(engine.btcTag(), '₿ BTC bias: data stale — treat with caution');
});

test('missing OI/funding data still produces a score (components degrade to 0)', () => {
  const engine = makeEngine({ direction: 'up' });
  const snapshot = engine.evaluate();
  assert.equal(snapshot.components.oiContext, 0);
  assert.equal(snapshot.components.funding, 0);
  assert.ok(snapshot.h15.score > 0);
  assert.equal(snapshot.indicators.oiChgPct, null);
  assert.equal(snapshot.indicators.fundingPct, null);
});

test('btcTag flags a long alert when the 15m bias is DOWN', () => {
  const down = makeEngine({ direction: 'down' });
  down.evaluate();
  const tag = down.btcTag({ long: true });
  assert.match(tag, /^₿ BTC 15m: <b>STRONG_DOWN<\/b> \(\d+%\) · 30m: STRONG_DOWN · ⚠️ against this long$/);
  const up = makeEngine({ direction: 'up' });
  up.evaluate();
  const upTag = up.btcTag({ long: true });
  assert.match(upTag, /₿ BTC 15m: <b>STRONG_UP<\/b>/);
  assert.ok(!upTag.includes('⚠️'));
});

test('low-rate REST context is throttled and feeds the OI/funding components', async () => {
  let now = NOW;
  let oiCalls = 0;
  let fundingCalls = 0;
  const binance = {
    openInterestHistory: async () => { oiCalls++; return [{ sumOpenInterest: '100' }, { sumOpenInterest: '101' }]; },
    premiumIndex: async () => { fundingCalls++; return { lastFundingRate: '0.0004' }; },
  };
  const engine = new BtcBiasEngine({ cfg, feed: makeFeed({ direction: 'up' }), binance, now: () => now });
  engine.evaluate();
  engine.evaluate(); // throttled: still one flight
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oiCalls, 1);
  assert.equal(fundingCalls, 1);
  assert.equal(engine.oiCache.changePct, 1);
  assert.equal(engine.fundingCache.ratePct, 0.04);
  const snapshot = engine.evaluate();
  assert.ok(snapshot.components.oiContext > 0); // OI up + price up
  assert.ok(snapshot.components.funding < 0); // +0.04% funding is contrarian-bearish
  now += 61_000;
  engine.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fundingCalls, 2); // funding refreshes after a minute
  assert.equal(oiCalls, 1); // OI still inside its 5-minute window
});

test('REST context failure degrades to 0 and never throws', async () => {
  let calls = 0;
  const binance = {
    openInterestHistory: async () => { calls++; throw new Error('HTTP 500'); },
    premiumIndex: async () => { throw new Error('HTTP 500'); },
  };
  const engine = new BtcBiasEngine({ cfg, feed: makeFeed({}), binance, now: () => NOW });
  const snapshot = engine.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshot.components.oiContext, 0);
  assert.equal(snapshot.components.funding, 0);
  engine.evaluate(); // failed polls are also rate-limited (ban safety)
  assert.equal(calls, 1);
});

test('outcome tracker scores directional predictions against later closes', () => {
  const engine = makeEngine({});
  const snap = (label15, label30 = label15) => ({ h15: { label: label15 }, h30: { label: label30 } });
  engine.trackOutcome({ close: 100 }, snap('UP', 'DOWN')); // idx 1: h15 UP, h30 DOWN
  for (let i = 0; i < 14; i++) engine.trackOutcome({ close: 101 }, snap('NEUTRAL'));
  engine.trackOutcome({ close: 110 }, snap('NEUTRAL')); // idx 16 scores idx 1 for h15
  assert.deepEqual(engine.outcomes.h15, { hits: 1, total: 1 }); // UP and price rose
  assert.deepEqual(engine.outcomes.h30, { hits: 0, total: 0 });
  for (let i = 0; i < 15; i++) engine.trackOutcome({ close: 101 }, snap('NEUTRAL')); // idx 31 scores idx 1 for h30
  assert.deepEqual(engine.outcomes.h30, { hits: 0, total: 1 }); // DOWN but price rose
  assert.equal(engine.health().outcomes.h15.total, 1);
});

test('bias flips alert once and respect the cooldown', async () => {
  let now = NOW;
  const messages = [];
  const engine = new BtcBiasEngine({
    cfg,
    feed: makeFeed({}),
    telegram: { send: async text => { messages.push(text); } },
    now: () => now,
  });
  const snap = (label, score) => ({
    h15: { label, score, confidence: 71, drivers: ['taker sells 61%', 'ask wall 12bps above'] },
    h30: { label, score: score + 14 },
  });
  await engine.maybeFlip(snap('UP', 40)); // first direction: no alert
  assert.equal(messages.length, 0);
  await engine.maybeFlip(snap('DOWN', -52)); // flip!
  assert.equal(messages.length, 1);
  assert.match(messages[0], /₿ <b>BTC BIAS FLIP: UP → DOWN<\/b>/);
  assert.match(messages[0], /15m: DOWN \(score −52, conf 71%\) · 30m: DOWN \(−38\)/);
  assert.match(messages[0], /Drivers: taker sells 61% · ask wall 12bps above/);
  assert.match(messages[0], /not a standalone trade signal/);
  await engine.maybeFlip(snap('UP', 30)); // flip inside cooldown: no alert
  assert.equal(messages.length, 1);
  now += 11 * 60_000;
  await engine.maybeFlip(snap('DOWN', -30)); // cooldown elapsed: alert again
  assert.equal(messages.length, 2);
  assert.match(messages[1], /BTC BIAS FLIP: UP → DOWN/);
  // NEUTRAL transitions never alert and never reset the direction memory.
  await engine.maybeFlip(snap('NEUTRAL', 0));
  assert.equal(messages.length, 2);
});

test('flip driver strings are HTML-escaped', async () => {
  const messages = [];
  const engine = new BtcBiasEngine({
    cfg,
    feed: makeFeed({}),
    telegram: { send: async text => { messages.push(text); } },
    now: () => NOW,
  });
  const snap = label => ({ h15: { label, score: 30, confidence: 50, drivers: ['taker <sells> 61%'] }, h30: { label, score: 20 } });
  await engine.maybeFlip(snap('UP'));
  await engine.maybeFlip(snap('DOWN'));
  assert.match(messages[0], /taker &lt;sells&gt; 61%/);
  assert.ok(!messages[0].includes('taker <sells>'));
});

test('blocksLongs only fires on a fresh STRONG_DOWN snapshot with the opt-in gate on', () => {
  const engine = makeEngine({});
  engine.lastSnapshot = { stale: false, h15: { label: 'STRONG_DOWN' } };
  assert.equal(engine.blocksLongs(), false); // cfg.btcBiasBlockLongs default false
  const gated = new BtcBiasEngine({ cfg: { ...cfg, btcBiasBlockLongs: true }, feed: makeFeed({}) });
  gated.lastSnapshot = { stale: false, h15: { label: 'STRONG_DOWN' } };
  assert.equal(gated.blocksLongs(), true);
  gated.lastSnapshot = { stale: true, h15: { label: 'STRONG_DOWN' } };
  assert.equal(gated.blocksLongs(), false); // stale data never gates
  gated.lastSnapshot = { stale: false, h15: { label: 'DOWN' } };
  assert.equal(gated.blocksLongs(), false); // only STRONG_DOWN gates
});

test('a snapshot older than 180s is stale for btcTag/blocksLongs regardless of its captured flag', () => {
  let now = NOW;
  const engine = new BtcBiasEngine({
    cfg: { ...cfg, btcBiasBlockLongs: true },
    feed: makeFeed({ direction: 'down' }),
    now: () => now,
  });
  const snapshot = engine.evaluate();
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.h15.label, 'STRONG_DOWN');
  assert.equal(engine.blocksLongs(), true);
  assert.match(engine.btcTag(), /STRONG_DOWN/);
  now += 200_000; // feed dies: no new evaluate(), the snapshot simply ages out
  assert.equal(engine.btcTag(), '₿ BTC bias: data stale — treat with caution');
  assert.equal(engine.blocksLongs(), false); // fail open: a dead feed never blocks longs
});

test('a stale book zeroes the bookImbalance and walls components', () => {
  const engine = makeEngine({ direction: 'up' });
  const fresh = engine.evaluate();
  assert.ok(fresh.components.bookImbalance > 0);
  assert.ok(fresh.components.walls > 0);
  engine.feed.lastBookAt = NOW - 6_000; // depth20@1000ms should update every second
  const stale = engine.evaluate();
  assert.equal(stale.components.bookImbalance, 0);
  assert.equal(stale.components.walls, 0);
  assert.equal(engine.bookImbalance(engine.feed.book).ok, false);
  assert.equal(engine.walls(engine.feed.book).ok, false);
  assert.ok(stale.h15.score < fresh.h15.score, `${stale.h15.score} < ${fresh.h15.score}`);
});

test('handleCandle evaluates, tracks outcomes and swallows errors', async () => {
  const engine = makeEngine({});
  const candle = engine.feed.closes.at(-1);
  await engine.handleCandle(candle);
  assert.equal(engine.candleCount, 1);
  assert.ok(engine.lastSnapshot);
  const broken = new BtcBiasEngine({ cfg, feed: { get closes() { throw new Error('corrupt'); } } });
  await broken.handleCandle({ close: 1 }); // must not reject
  assert.match(broken.lastError, /handleCandle/);
});

test('health exposes snapshot, outcomes and flip state', () => {
  const engine = makeEngine({});
  engine.evaluate();
  const health = engine.health();
  assert.equal(health.enabled, true);
  assert.equal(health.snapshot.h15.label, 'STRONG_UP');
  assert.deepEqual(health.outcomes, { h15: { hits: 0, total: 0 }, h30: { hits: 0, total: 0 } });
  assert.equal(health.flips, 0);
  assert.equal(health.blockLongs, false);
});
