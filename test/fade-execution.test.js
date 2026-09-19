import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FadeExecutor } from '../src/fade-executor.js';
import { FadeExchange, entryPlan, exitPlan, fadeFilters } from '../src/fade-orders.js';

const now = Date.parse('2026-09-15T13:00:00Z');
const symbolInfo = symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', filters: [
  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'PRICE_FILTER', tickSize: '0.001', minPrice: '0.001', maxPrice: '100000' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
] });
const signal = { price: 100, resistance: 102, barCloseTime: now - 1000, peakTime: now - 300000 };
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
    mode: async () => ({ dualSidePosition: !!options.hedge }),
    assetsMode: async () => ({ multiAssetsMargin: false }),
    account: async () => ({ canTrade: true, assets: [{ asset: 'USDT', availableBalance: '250' }] }),
    positions: async () => [...positions].map(([symbol, qty]) => ({ symbol, positionAmt: String(-qty), notional: String(qty * 100), positionSide: 'BOTH' })),
    orders: async () => [...orders.values()].filter(o => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).map(clone),
    algos: async () => [...algos.values()].filter(o => o.algoStatus === 'NEW').map(clone),
    info: async () => ({ symbols: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'].map(symbolInfo) }),
    fees: async () => ({ takerCommissionRate: '0.0005', makerCommissionRate: '0.0002' }),
    isolate: async symbol => { calls.push(['isolate', symbol]); },
    book: async () => ({ bidPrice: String(options.price ?? 100), askPrice: String((options.price ?? 100) + 0.01) }),
    order: async (symbol, id) => { const o = orders.get(id); if (!o) throw Error('order status unknown'); return clone(o); },
    algo: async id => { const o = algos.get(id); if (!o) throw Error('algo status unknown'); return clone(o); },
    place: async params => {
      calls.push(['place', clone(params)]);
      const job = db.state.jobs.find(j => j.symbol === params.symbol);
      assert.ok(job && (Object.values(job.actions).some(a => a.id === params.newClientOrderId)
        || (params.newClientOrderId.startsWith(`nf-${job.id}-z`) && params.side === 'BUY' && params.reduceOnly === 'true')), 'entry intent must be durable before send');
      if (params.side === 'SELL' && options.entryUnknown) throw Error('timeout with unknown acceptance');
      if (params.type === 'LIMIT' && options.tpFails) throw Error('TP rejected');
      const qty = Number(params.quantity), market = params.type === 'MARKET';
      const o = { ...params, clientOrderId: params.newClientOrderId, orderId: orders.size + 1,
        origQty: String(qty), executedQty: market ? String(qty) : '0', avgPrice: '100', status: market ? 'FILLED' : 'NEW' };
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
      const o = { symbol, clientAlgoId: id, algoStatus: 'NEW', orderType: 'STOP_MARKET', side: 'BUY', closePosition: true, triggerPrice: String(price) };
      algos.set(id, o); return clone(o);
    },
    cancel: async (symbol, id) => { calls.push(['cancel', id]); orders.get(id).status = 'CANCELED'; },
    cancelStop: async id => { calls.push(['cancelStop', id]); algos.get(id).algoStatus = 'CANCELED'; },
  };
  const cfg = { enableFadeExecution: true, fadeEnvironment: 'testnet' };
  const make = () => new FadeExecutor({ cfg, exchange, store, now: () => clock, telegram: { send: async text => messages.push(text) } });
  return { executor: make(), make, cfg, exchange, store, calls, positions, orders, algos, messages,
    db: () => clone(db), advance: ms => { clock += ms; }, releaseOwner: () => { owner = null; }, options };
}

test('size cap, rounded partial, $3 net after full entry fees and $5 modeled stop', () => {
  const p = entryPlan({ signal, bid: 100, ask: 100.01, info: symbolInfo('AAAUSDT'), fee: 0.0005, available: 250, now });
  assert.ok(p.qty * p.entry <= 150);
  const net = p.partial * (p.entry - p.target) - p.qty * p.entry * p.fee - p.partial * p.target * p.fee;
  assert.ok(net >= 3 && net < 3.01);
  const loss = p.qty * (p.stop - p.entry) + p.qty * p.entry * p.fee + p.qty * p.stop * (p.fee + 0.0005);
  assert.ok(loss <= 5 && loss > 4.99);
  assert.ok(p.runner > 0);
  assert.throws(() => exitPlan(100, 0.01, 0.0005, fadeFilters(symbolInfo('AAAUSDT'))));
});
test('stale and widened spread entries are refused', () => {
  const input = { signal, bid: 100, ask: 100.01, info: symbolInfo('AAAUSDT'), fee: 0.0005, available: 250, now };
  assert.throws(() => entryPlan({ ...input, now: now + 90001 }));
  assert.throws(() => entryPlan({ ...input, ask: 101 }));
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
