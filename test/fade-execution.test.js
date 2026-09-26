import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FadeExecutor } from '../src/fade-executor.js';
import { ExchangeError, FadeExchange, entryPlan, exitPlan, fadeFilters } from '../src/fade-orders.js';

const now = Date.parse('2026-09-15T13:00:00Z');
const symbolInfo = symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', filters: [
  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'PRICE_FILTER', tickSize: '0.001', minPrice: '0.001', maxPrice: '100000' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
] });
const signal = { price: 100, resistance: 100.8, barCloseTime: now - 1000, peakTime: now - 300000 };
const clone = x => structuredClone(x);

test('remote pause arriving after sizing prevents the entry POST', async () => {
  const h = harness(); let reads = 0;
  h.executor.authorizeEntry = async () => ++reads === 1;
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});
test('remote control outage before POST closes the unsent intent', async () => {
  const h = harness(); let reads = 0;
  h.executor.authorizeEntry = async () => { if (++reads > 1) throw Error('offline'); return true; };
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});

function harness(options = {}) {
  options.algoQueries ??= 0;
  let clock = now;
  let db = { revision: 0, state: { jobs: [], paused: false } };
  const messages = [], calls = [], positions = new Map(), orders = new Map(), algos = new Map();
  let owner = null;
  const store = {
    fadeLease: async (scope, who) => { if (options.leaseLost) throw Error('lease lost'); owner ??= who; if (owner !== who) throw Error('another owner'); return clone(db); },
    fadeSave: async (scope, who, revision, state) => {
      if (options.saveFails) throw Error('database offline');
      assert.equal(who, owner); assert.equal(revision, db.revision);
      assert.ok(state.jobs.filter(j => j.phase !== 'CLOSED').length <= 3);
      db = { revision: revision + 1, state: clone(state) }; return clone(db);
    },
  };
  const exchange = {
    syncTime: async () => {},
    btcCandles: async () => Array.from({ length: 120 }, (_, i) => {
      const t = clock - (120 - i) * 60000, c = 60000 - i * 10;
      return [t, String(c), String(c + 1), String(c - 1), String(c), '1', t + 59999];
    }),
    mode: async () => ({ dualSidePosition: !!options.hedge }),
    assetsMode: async () => ({ multiAssetsMargin: false }),
    accountPermissions: async () => ({ canTrade: options.canTrade !== false }),
    account: async () => ({ totalWalletBalance: String(options.wallet ?? 100),
      totalUnrealizedProfit: String(options.unrealized ?? 0),
      totalMarginBalance: String((options.wallet ?? 100) + (options.unrealized ?? 0)),
      availableBalance: String(options.available ?? 100), totalInitialMargin: String(options.initialMargin ?? 0),
      assets: [{ asset: 'USDT', walletBalance: String(options.wallet ?? 100),
        unrealizedProfit: String(options.unrealized ?? 0), marginBalance: String((options.wallet ?? 100) + (options.unrealized ?? 0)),
        availableBalance: String(options.available ?? 100), initialMargin: String(options.initialMargin ?? 0) }] }),
    income: async () => options.incomePending ? new Promise(() => {}) : options.income ?? [],
    openInterestHistory: async symbol => Array.from({ length: 5 }, (_, i) =>
      ({ symbol, timestamp: clock - (4 - i) * 300000, sumOpenInterestValue: '1000000' })),
    funding: async symbol => ({ symbol, lastFundingRate: '0.0001', nextFundingTime: clock + 3600000, time: clock }),
    positions: async () => [...positions].map(([symbol, qty]) => ({ symbol, positionAmt: String(-qty), notional: String(qty * 100), positionSide: 'BOTH' })),
    orders: async () => [...orders.values()].filter(o => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).map(clone),
    algos: async () => [...algos.values()].filter(o => o.algoStatus === 'NEW').map(clone),
    info: async () => ({ symbols: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'].map(symbolInfo) }),
    fees: async () => ({ takerCommissionRate: '0.0005', makerCommissionRate: '0.0002' }),
    isolate: async symbol => { calls.push(['isolate', symbol]); },
    book: async symbol => symbol === 'BTCUSDT' ? { bidPrice: '58809', askPrice: '58810' } : ({ bidPrice: String(options.price ?? 100), askPrice: String((options.price ?? 100) + 0.01) }),
    order: async (symbol, id) => { const o = orders.get(id); if (!o) throw Error('order status unknown'); return clone(o); },
    algo: async id => {
      options.algoQueries = (options.algoQueries ?? 0) + 1;
      if ((options.algoMissingReads ?? 0) > 0) {
        options.algoMissingReads--; throw new ExchangeError(400, -2013);
      }
      const o = algos.get(id); if (!o) throw Error('algo status unknown'); return clone(o);
    },
    place: async params => {
      calls.push(['place', clone(params)]);
      const job = db.state.jobs.find(j => j.symbol === params.symbol);
      assert.ok(job && (Object.values(job.actions).some(a => a.id === params.newClientOrderId)
        || (params.newClientOrderId.startsWith(`nf-${job.id}-z`) && params.side === 'BUY' && params.reduceOnly === 'true')), 'entry intent must be durable before send');
      if (params.side === 'SELL' && options.entryUnknown) throw Error('timeout with unknown acceptance');
      if (params.type === 'LIMIT' && options.tpFails) throw Error('TP rejected');
      const qty = Number(params.quantity), market = params.type === 'MARKET';
      const o = { ...params, clientOrderId: params.newClientOrderId, orderId: orders.size + 1,
        origQty: String(qty), executedQty: market ? String(qty) : '0', avgPrice: params.side === 'SELL'
          ? String(options.entryAvgPrice ?? 100) : '100', status: market ? 'FILLED' : 'NEW' };
      orders.set(o.clientOrderId, o);
      if (params.side === 'SELL') positions.set(params.symbol, qty);
      if (params.side === 'SELL' && options.saveFailsAfterEntry) options.saveFails = true;
      if (params.side === 'BUY' && market) {
        assert.equal(params.reduceOnly, 'true'); const remaining = (positions.get(params.symbol) ?? 0) - qty;
        if (remaining > 1e-8) positions.set(params.symbol, remaining); else positions.delete(params.symbol);
      }
      if (params.side === 'SELL' && options.timeoutAfterEntry) throw Error('timeout after acceptance');
      return clone(o);
    },
    placeStop: async (symbol, id, price) => {
      calls.push(['stop', id, price]);
      if (options.stopFails) throw Error('SL rejected');
      if (options.stopRejected) throw new ExchangeError(400, -2021);
      const o = { symbol, clientAlgoId: id, algoStatus: 'NEW', orderType: 'STOP_MARKET', side: 'BUY', closePosition: true, triggerPrice: String(price) };
      algos.set(id, o); return clone(o);
    },
    cancel: async (symbol, id) => { calls.push(['cancel', id]); orders.get(id).status = 'CANCELED'; },
    cancelStop: async id => { calls.push(['cancelStop', id]); algos.get(id).algoStatus = 'CANCELED'; },
  };
  const cfg = { enableFadeExecution: true, fadeEnvironment: 'testnet' };
  const make = () => new FadeExecutor({ cfg, exchange, store, now: () => clock, wait: async () => {},
    eventGate: options.eventGate ?? { check: async () => ({ allowed: true, reason: 'Test event feed clear' }) },
    telegram: { send: async text => messages.push(text) } });
  return { executor: make(), make, cfg, exchange, store, calls, positions, orders, algos, messages,
    db: () => clone(db), advance: ms => { clock += ms; }, releaseOwner: () => { owner = null; }, options };
}

test('size cap preserves invalidation, 0.5% equity risk, and >=1.5R net partial', () => {
  const p = entryPlan({ signal, bid: 100, ask: 100.01, info: symbolInfo('AAAUSDT'), fee: 0.0005, available: 250, equity: 100, now });
  assert.ok(p.qty * p.entry <= 150);
  const net = p.partial * (p.entry - p.target) - p.qty * p.entry * p.fee - p.partial * p.target * p.fee;
  assert.ok(net >= 1.5 * p.riskDollars - 1e-6);
  const loss = p.qty * (p.stop - p.entry) + p.qty * p.entry * p.fee + p.qty * p.stop * (p.fee + 0.0005);
  assert.ok(loss <= 0.5 + 1e-6);
  assert.ok(p.stop < signal.resistance && p.stop > 100.01);
  assert.ok(p.runner > 0);
  assert.throws(() => exitPlan(100, 0.01, 0.0005, fadeFilters(symbolInfo('AAAUSDT'))));
});
test('stale and widened spread entries are refused', () => {
  const input = { signal, bid: 100, ask: 100.01, info: symbolInfo('AAAUSDT'), fee: 0.0005, available: 250, equity: 100, now };
  assert.throws(() => entryPlan({ ...input, now: now + 90001 }));
  assert.throws(() => entryPlan({ ...input, ask: 101 }));
});
test('verified account snapshot reports equity progress and seven-day net flows', async () => {
  const h = harness({ wallet: 98.5, unrealized: 0.75, available: 70, initialMargin: 28.5,
    income: [
      { asset: 'USDT', incomeType: 'REALIZED_PNL', income: '2.00' },
      { asset: 'USDT', incomeType: 'COMMISSION', income: '-0.40' },
      { asset: 'USDT', incomeType: 'FUNDING_FEE', income: '-0.10' },
      { asset: 'USDT', incomeType: 'TRANSFER', income: '100.00' },
    ] });
  await h.executor.run(); await h.executor.incomeInFlight;
  const report = h.executor.balanceReport();
  assert.match(report, /Wallet \$98\.50 · Open PnL \+\$0\.75 · Equity \$99\.25/);
  assert.match(report, /Progress vs \$100\.00: -\$0\.75 \(-0\.75%\)/);
  assert.match(report, /realized \+\$2\.00 · commission -\$0\.40 · funding -\$0\.10 · net \+\$1\.50/);
  assert.doesNotMatch(report, /100\.00.*net/);
});
test('worker warns once when a profitable day gives back gains without blocking position reconciliation', async () => {
  const h = harness({ income: [
    { asset: 'USDT', symbol: 'AAAUSDT', incomeType: 'REALIZED_PNL', income: '4.00', time: now - 60000 },
    { asset: 'USDT', symbol: 'AAAUSDT', incomeType: 'COMMISSION', income: '-0.20', time: now - 60000 },
    { asset: 'USDT', symbol: 'BBBUSDT', incomeType: 'REALIZED_PNL', income: '-1.70', time: now - 30000 },
    { asset: 'USDT', symbol: 'BBBUSDT', incomeType: 'COMMISSION', income: '-0.40', time: now - 30000 },
  ] });
  await h.executor.run(); await h.executor.incomeInFlight;
  assert.match(h.executor.entrySafety.reason, /profit giveback/);
  assert.equal(h.messages.filter(m => m.includes('profit giveback')).length, 1);
  h.advance(300001); await h.executor.run(); await h.executor.incomeInFlight;
  assert.equal(h.messages.filter(m => m.includes('profit giveback')).length, 1);
  assert.equal(h.executor.lastError, null);
});
test('a stuck optional income request cannot block reconciliation or balance updates', async () => {
  const h = harness({ incomePending: true, wallet: 99 });
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  assert.match(h.executor.balanceReport(), /Wallet \$99\.00/);
  assert.ok(h.executor.incomeInFlight);
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
});
test('fresh fade entry gets native stop before 75% reduce-only limit; restart creates no duplicate', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.executor.lastError, null);
  assert.equal(h.db().state.jobs[0].phase, 'OPEN');
  const stopIndex = h.calls.findIndex(c => c[0] === 'stop');
  const tpIndex = h.calls.findIndex(c => c[0] === 'place' && c[1].type === 'LIMIT');
  assert.ok(stopIndex > 0 && tpIndex > stopIndex);
  h.releaseOwner(); const restarted = h.make(); await restarted.run();
  assert.equal(restarted.lastError, null);
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
});
test('accepted entry with lost response is reconciled by ID, never duplicated', async () => {
  const h = harness({ timeoutAfterEntry: true }); await h.executor.onSignal('AAAUSDT', signal); await h.executor.run();
  assert.equal(h.executor.lastError, null); assert.equal(h.positions.size, 1);
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
});
test('accepted stop response avoids immediate query and recent -2013 visibility races are retried', async () => {
  const h = harness({ algoMissingReads: 2 }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.executor.lastError, null); assert.equal(h.options.algoQueries, 0);
  await h.executor.run();
  assert.equal(h.executor.lastError, null); assert.equal(h.options.algoQueries, 3);
  assert.equal(h.positions.size, 1);
});
test('definite conditional-order rejection preserves the original Binance code and flattens', async () => {
  const h = harness({ stopRejected: true }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 0); assert.match(h.executor.lastError, /-2021/);
});
test('adverse fill exceeding original equity risk budget requests a reduce-only flatten', async () => {
  const h = harness({ entryAvgPrice: 99.5 }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 0);
  assert.match(h.executor.lastError, /exceeded equity risk budget/);
  assert.ok(h.calls.some(c => c[0] === 'place' && c[1].side === 'BUY' && c[1].reduceOnly === 'true'));
});
test('unknown entry acceptance reserves slot and blocks all further entries without retries', async () => {
  const h = harness({ entryUnknown: true }); await h.executor.onSignal('AAAUSDT', signal);
  await h.executor.run(); await h.executor.onSignal('BBBUSDT', signal);
  assert.match(h.executor.lastError, /unknown/);
  assert.equal(h.db().state.jobs[0].phase, 'SUBMITTING');
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
});
for (const failure of ['stopFails', 'tpFails']) test(`${failure} requests immediate reduce-only flatten`, async () => {
  const h = harness({ [failure]: true }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 0);
  assert.ok(h.calls.some(c => c[0] === 'place' && c[1].side === 'BUY' && c[1].type === 'MARKET' && c[1].reduceOnly === 'true'));
  await h.executor.run(); assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});
test('three active positions maximum and repeated pattern cannot reenter', async () => {
  const h = harness(); for (const s of ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'AAAUSDT']) await h.executor.onSignal(s, signal);
  assert.equal(h.positions.size, 3); assert.equal(h.db().state.jobs.filter(j => j.phase !== 'CLOSED').length, 3);
});
test('database outage after entry fill still permits emergency reduce-only flatten', async () => {
  const h = harness({ saveFailsAfterEntry: true }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 0);
  assert.ok(h.calls.some(c => c[0] === 'place' && c[1].newClientOrderId.includes('-z') && c[1].reduceOnly === 'true'));
});
test('full partial exit transitions to runner; stop only tightens and old stop is canceled afterward', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  const job = h.db().state.jobs[0]; const tp = h.orders.get(job.actions.tp.id);
  tp.executedQty = tp.origQty; tp.status = 'FILLED'; h.positions.set(job.symbol, job.plan.runner); h.options.price = 97;
  await h.executor.run(); assert.equal(h.executor.lastError, null);
  const updated = h.db().state.jobs[0]; assert.equal(updated.phase, 'RUNNER');
  assert.ok(updated.plan.stop <= updated.plan.breakEven);
  assert.ok(h.calls.findIndex(c => c[0] === 'cancelStop' && c[1] === job.stopId)
    > h.calls.findIndex(c => c[0] === 'stop' && c[1] === updated.stopId));
  h.options.price = 97.1; await h.executor.run(); assert.ok(h.db().state.jobs[0].plan.stop <= updated.plan.stop);
});
test('profit locks before the 75% limit fills; native replacement is installed first', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  const before = h.db().state.jobs[0];
  h.options.price = 99;
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  const after = h.db().state.jobs[0];
  assert.equal(after.phase, 'OPEN');
  assert.ok(after.peakOpenNet > 0);
  assert.ok(after.plan.stop < before.plan.stop && after.plan.stop <= after.plan.breakEven);
  assert.ok(h.calls.findIndex(c => c[0] === 'cancelStop' && c[1] === before.stopId)
    > h.calls.findIndex(c => c[0] === 'stop' && c[1] === after.stopId));
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT').length, 1);
});
test('event, OI and funding feed failures block entry but do not disable existing protection', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  h.options.eventGate = { check: async () => ({ allowed: false, reason: 'High-impact event window' }) };
  h.executor.eventGate = h.options.eventGate;
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1);
  assert.match(h.executor.entrySafety.reason, /event window/);
  h.executor.eventGate = { check: async () => ({ allowed: true }) };
  h.exchange.openInterestHistory = async () => [];
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1);
  assert.match(h.executor.entrySafety.reason, /OI\/funding/);
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  assert.equal((await h.exchange.algos()).length, 1);
});
test('explicit untested-live acknowledgement permits new entries without falsely claiming demo testing', async () => {
  const h = harness(); h.cfg.fadeEnvironment = 'live';
  h.cfg.fadeLiveAcknowledgement = 'I_ACCEPT_LIVE_FADE_ORDERS';
  h.cfg.fadeUntestedLiveAcknowledgement = 'I_ACCEPT_UNTESTED_FADE_V2_LIVE';
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.executor.lastError, null);
  assert.equal(h.positions.size, 1);
});
test('new live code refuses fresh orders without demo or untested-live acceptance, but protects old jobs', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  h.cfg.fadeEnvironment = 'live'; h.cfg.fadeLiveAcknowledgement = 'I_ACCEPT_LIVE_FADE_ORDERS';
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1);
  assert.match(h.executor.entrySafety.reason, /untested-live acknowledgement/);
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  assert.equal((await h.exchange.algos()).length, 1);
});
test('partially filled 75% order is not booked twice', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal); const job = h.db().state.jobs[0];
  const tp = h.orders.get(job.actions.tp.id); tp.executedQty = String(job.plan.partial / 2); tp.status = 'PARTIALLY_FILLED';
  h.positions.set(job.symbol, job.plan.qty - job.plan.partial / 2); await h.executor.run();
  assert.equal(h.executor.lastError, null); assert.equal(h.db().state.jobs[0].phase, 'OPEN');
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT').length, 1);
});
test('native flat position cancels residual orders and releases slot', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal); h.positions.clear(); await h.executor.run();
  assert.equal(h.db().state.jobs[0].phase, 'CLOSED'); assert.equal((await h.exchange.orders()).length, 0);
  assert.equal((await h.exchange.algos()).length, 0);
});
test('manual positions, hedge mode, missing database and lease loss prevent entries', async () => {
  const manual = harness(); manual.positions.set('MANUALUSDT', 1); await manual.executor.onSignal('AAAUSDT', signal);
  assert.equal(manual.calls.length, 0);
  for (const opt of ['hedge', 'saveFails', 'leaseLost']) {
    const h = harness({ [opt]: true }); await h.executor.onSignal('AAAUSDT', signal);
    assert.equal(h.calls.filter(c => c[0] === 'place').length, 0);
  }
});
test('V2 trading permission is required while V3 account may omit canTrade', async () => {
  const allowed = harness(); await allowed.executor.onSignal('AAAUSDT', signal);
  assert.equal(allowed.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
  const blocked = harness({ canTrade: false }); await blocked.executor.onSignal('AAAUSDT', signal);
  assert.equal(blocked.calls.filter(c => c[0] === 'place').length, 0);
  assert.match(blocked.executor.lastError, /trading is unavailable/);
});
test('pause persists and still manages existing protection; explicit close only closes owned positions', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal); await h.executor.control('pause');
  await h.executor.onSignal('BBBUSDT', signal); assert.equal(h.positions.size, 1);
  await h.executor.run(); assert.equal(h.executor.lastError, null);
  await h.executor.control('close'); assert.equal(h.positions.size, 0); await h.executor.run();
  assert.equal(h.db().state.paused, true);
});
test('live mode requires separate acknowledgement; disabled execution sends nothing', async () => {
  const h = harness(); h.cfg.fadeEnvironment = 'live'; await h.executor.onSignal('AAAUSDT', signal); assert.equal(h.calls.length, 0);
  h.cfg.enableFadeExecution = false; await h.executor.run(); assert.equal(h.calls.length, 0);
});
test('signed client sends correct HMAC and never retries uncertain mutations or exposes secret response bodies', async () => {
  let calls = 0, url;
  const c = new FadeExchange({ key: 'test-key', secret: 'test-secret', now: () => now, fetcher: async u => {
    calls++; url = new URL(u); return { ok: false, status: 400, json: async () => ({ code: -1, msg: 'test-secret' }) };
  } });
  await assert.rejects(c.place({ symbol: 'AAAUSDT', side: 'SELL', type: 'MARKET', quantity: '1' }), e => !e.message.includes('test-secret'));
  const signature = url.searchParams.get('signature'); url.searchParams.delete('signature');
  assert.equal(signature, createHmac('sha256', 'test-secret').update(url.searchParams.toString()).digest('hex'));
  assert.equal(url.host, 'demo-fapi.binance.com'); assert.equal(calls, 1);
});

test('BTC bullish gate refuses entry without changing existing position protection', async () => {
  const h = harness();
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 1);
  h.exchange.btcCandles = async () => [];
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1);
  assert.equal(h.executor.btcGate.allowed, false);
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  assert.ok(h.algos.size > 0);
});
test('BTC gate changing during preparation prevents the SELL order', async () => {
  const h = harness(); const candles = h.exchange.btcCandles; let reads = 0;
  h.exchange.btcCandles = () => ++reads === 1 ? candles() : [];
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.calls.filter(c => c[0] === 'place').length, 0);
  assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});
