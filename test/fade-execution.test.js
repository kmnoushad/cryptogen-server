import test from 'node:test';
import { FadeEntryPreparation } from '../src/fade-entry-preparation.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FadeExecutor } from '../src/fade-executor.js';
import { ExchangeError, FadeExchange, entryPlan, fadeDepthGate, exitPlan, fadeFilters, structuralFadeStop } from '../src/fade-orders.js';

const now = Date.parse('2026-09-15T13:00:00Z');
const symbolInfo = symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', filters: [
  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100000' },
  { filterType: 'PRICE_FILTER', tickSize: '0.001', minPrice: '0.001', maxPrice: '100000' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
] });
const signal = { price: 100, resistance: 100.8, barCloseTime: now - 1000, peakTime: now - 300000 };
const clone = x => structuredClone(x);

test('spike entry requires configured source and live source authorization before send', async () => {
  const s = { ...signal, model: 'spike-fade-ticks-v1' };
  const h = harness(); await h.executor.onSignal('AAAUSDT', s);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  h.executor.cfg.fadeEntrySource = 'spike'; let checks = 0;
  h.executor.spikeAuthorize = () => ++checks === 1;
  await h.executor.onSignal('AAAUSDT', s);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  assert.equal(h.db().state.jobs[0].closeReason, 'ENTRY_EXPIRED_BEFORE_SEND');
});
test('spike entry planner expires at ten seconds and never risks above five dollars', () => {
  const input = { signal: { ...signal, model: 'spike-fade-ticks-v1' }, bid: 100, ask: 100.01,
    info: symbolInfo('AAAUSDT'), fee: .0005, available: 10000, equity: 10000, now };
  assert.ok(entryPlan(input).riskDollars <= 5);
  assert.throws(() => entryPlan({ ...input, now: now+10001 }), /10 seconds/);
});

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
      ({ symbol, timestamp: clock - (4 - i) * 300000, sumOpenInterest: '1000000', sumOpenInterestValue: '1000000' })),
    funding: async symbol => ({ symbol, lastFundingRate: '0.0001', nextFundingTime: clock + 3600000, time: clock }),
    positions: async () => [...positions].map(([symbol, qty]) => ({ symbol, positionAmt: String(-qty), notional: String(qty * 100), positionSide: 'BOTH' })),
    orders: async () => [...orders.values()].filter(o => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).map(clone),
    algos: async () => [...algos.values()].filter(o => o.algoStatus === 'NEW').map(clone),
    info: async () => ({ symbols: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'].map(symbolInfo) }),
    depth: async () => ({T:clock,bids:[['100','100']],asks:[['100.01','100']]}),
    allOrders: async () => [...orders.values()].map(clone),
    trades: async () => [],
    algoHistory: async () => [...algos.values()].map(clone),
    fees: async () => ({ takerCommissionRate: '0.0005', makerCommissionRate: '0.0002' }),
    isolate: async symbol => { calls.push(['isolate', symbol]); },
    book: async symbol => symbol === 'BTCUSDT' ? { bidPrice: '58809', askPrice: '58810' } : ({ bidPrice: String(options.price ?? 100), askPrice: String((options.price ?? 100) + 0.01) }),
    order: async (symbol, id) => { const o = orders.get(id); if (!o) throw new ExchangeError(400,-2013); return clone(o); },
    algo: async id => {
      options.algoQueries = (options.algoQueries ?? 0) + 1;
      if ((options.algoMissingReads ?? 0) > 0) {
        options.algoMissingReads--; throw new ExchangeError(400, -2013);
      }
      const o = algos.get(id); if (!o) throw new ExchangeError(400,-2013); return clone(o);
    },
    place: async params => {
      calls.push(['place', clone(params)]);
      const job = db.state.jobs.find(j => j.symbol === params.symbol &&
        (Object.values(j.actions).some(a => a.id === params.newClientOrderId) || params.newClientOrderId.startsWith(`nf-${j.id}-z`)));
      assert.ok(job && (Object.values(job.actions).some(a => a.id === params.newClientOrderId)
        || (params.newClientOrderId.startsWith(`nf-${job.id}-z`) && params.side === 'BUY' && params.reduceOnly === 'true')), 'entry intent must be durable before send');
      if (params.side === 'SELL' && options.entryUnknown) throw Error('timeout with unknown acceptance');
      if (params.type === 'LIMIT' && params.side === 'BUY' && options.tpFails) throw Error('TP rejected');
      const qty = Number(params.quantity), market = params.type === 'MARKET' || params.timeInForce === 'FOK';
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
    placeStop: async (symbol, id, price, quantity) => {
      calls.push(['stop', id, price]);
      if (options.stopFails) throw Error('SL rejected');
      if (quantity == null && [...algos.values()].some(o => o.symbol===symbol && o.algoStatus==='NEW' && o.closePosition)) throw new ExchangeError(400,-4130);
      if (options.stopRejected) throw new ExchangeError(400, -2021);
      const o = { symbol, clientAlgoId: id, algoStatus: 'NEW', orderType: 'STOP_MARKET', side: 'BUY', ...(quantity == null ? {closePosition:true} : {closePosition:false,reduceOnly:true,quantity:String(quantity)}), triggerPrice: String(price) };
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
  assert.ok(p.stop > signal.resistance && p.stop <= signal.resistance * 1.0031);
  assert.ok(p.runner > 0);
  assert.throws(() => exitPlan(100, 0.01, 0.0005, fadeFilters(symbolInfo('AAAUSDT'))));
});
test('stale and widened spread entries are refused', () => {
  const input = { signal, bid: 100, ask: 100.01, info: symbolInfo('AAAUSDT'), fee: 0.0005, available: 250, equity: 100, now };
  assert.throws(() => entryPlan({ ...input, now: now + 90001 }), /older than 90 seconds/);
  assert.throws(() => entryPlan({ ...input, ask: 100.2 }), /spread exceeds 10 bps/);
  assert.throws(() => entryPlan({ ...input, bid: 100.2, ask: 100.21 }), /price moved more than 0.15%/);
  const qnt = { ...signal, price: 288.12, resistance: 293.96, barCloseTime: now };
  assert.throws(() => entryPlan({ ...input, signal: qnt, bid: 288.12, ask: 288.13 }), /more than 1% below failed high/);
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
  const tpIndex = h.calls.findIndex(c => c[0] === 'place' && c[1].type === 'LIMIT' && c[1].side === 'BUY');
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
  assert.match(h.executor.lastError, /-2013|unknown/);
  assert.equal(h.db().state.jobs[0].phase, 'SUBMITTING');
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
});
for (const failure of ['stopFails']) test(`${failure} requests immediate reduce-only flatten`, async () => {
  const h = harness({ [failure]: true }); await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 0);
  assert.ok(h.calls.some(c => c[0] === 'place' && c[1].side === 'BUY' && c[1].type === 'MARKET' && c[1].reduceOnly === 'true'));
  await h.executor.run(); assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});
test('three active positions maximum and repeated pattern cannot reenter', async () => {
  const h = harness(); for (const s of ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'AAAUSDT']) await h.executor.onSignal(s, signal);
  assert.equal(h.positions.size, 3); assert.equal(h.db().state.jobs.filter(j => j.phase !== 'CLOSED').length, 3);
});
test('database outage after entry fill receives pre-journaled native stop without flatten', async () => {
  const h = harness({saveFailsAfterEntry:true}); await h.executor.onSignal('AAAUSDT',signal);
  assert.equal(h.positions.size,1);
  assert.ok([...h.algos.values()].some(a=>a.algoStatus==='NEW'));
  assert.equal(h.calls.filter(c=>c[0]==='place' && c[1].side==='BUY' && c[1].type==='MARKET').length,0);
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
  h.options.price = 98.4;
  await h.executor.run();
  assert.equal(h.executor.lastError, null);
  const after = h.db().state.jobs[0];
  assert.equal(after.phase, 'OPEN');
  assert.ok(after.peakOpenNet > 0);
  assert.ok(after.plan.stop < before.plan.stop && after.plan.stop <= after.plan.breakEven);
  assert.ok(h.calls.findIndex(c => c[0] === 'cancelStop' && c[1] === before.stopId)
    > h.calls.findIndex(c => c[0] === 'stop' && c[1] === after.stopId));
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT' && c[1].side === 'BUY').length, 1);
});
test('sustained approach to fade stop warns once and holds new entries until price recovers', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  h.options.price = 100.9; // >75% of the way to the (now 0.3% above resistance) stop
  for (let i = 0; i < 3; i++) await h.executor.run();
  assert.equal(h.executor.lastError, null);
  assert.equal(h.db().state.jobs[0].adverseChecks, 3);
  assert.equal(h.messages.filter(x => x.includes('close to its planned stop')).length, 1);
  await h.executor.run();
  assert.equal(h.messages.filter(x => x.includes('close to its planned stop')).length, 1);
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.calls.filter(x => x[0] === 'place' && x[1].side === 'SELL').length, 1);
  assert.equal(h.positions.size, 1);
  h.options.price = 100;
  await h.executor.run();
  assert.equal(h.db().state.jobs[0].adverseChecks, 0);
  await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.calls.filter(x => x[0] === 'place' && x[1].side === 'SELL').length, 2);
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
  await h.executor.onSignal('BBBUSDT', { ...signal, peakTime:signal.peakTime+1 });
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
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT' && c[1].side === 'BUY').length, 1);
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

test('v6.9.37: fade stop sits above the failed high with a buffer, never below it', () => {
  const f = fadeFilters(symbolInfo('AAAUSDT'));
  const stop = structuralFadeStop(100.8, f);
  assert.ok(stop > 100.8 && stop >= 100.8 * 1.003 - 1e-9 && stop <= 100.8 * 1.003 + f.tick);
  assert.throws(() => structuralFadeStop(0, f), /resistance missing/);
});

 test('expired fade candidate is a per-signal skip; the next fresh candidate can enter', async () => {
  const h = harness();
  await h.executor.onSignal('AAAUSDT', { ...signal, barCloseTime: now - 100000 });
  assert.equal(h.db().state.jobs.length, 0);
  assert.equal(h.executor.lastError, null);
  assert.match(h.executor.entrySafety.reason, /Entry skipped.*expired/);
  assert.equal(h.messages.length, 0);
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.positions.size, 1);
});

test('fade reports remote pause rejection rather than only source authorization',async()=>{
  const h=harness();h.executor.authorizeEntry=async()=>false;
  await h.executor.onSignal('AAAUSDT',signal);
  assert.equal(h.calls.filter(x=>x[0]==='place').length,0);
  assert.equal(h.executor.lastEntryAttempt.reason,'Remote pause/close request');
  assert.match(h.executor.status(),/Last execution check: AAAUSDT/);
});

function delayedEntryHarness(latency = 400) {
  const h = harness(), queue = []; let scheduled = false;
  const schedule = () => {
    if (scheduled) return; scheduled = true;
    setImmediate(() => {
      scheduled = false;
      const due = Math.min(...queue.map(x => x.at));
      h.advance(Math.max(0,due-h.executor.now()));
      const ready = queue.filter(x => x.at === due);
      for (const item of ready) queue.splice(queue.indexOf(item),1);
      for (const item of ready) item.resolve();
      if (queue.length) schedule();
    });
  };
  const delay = ms => new Promise(resolve => { queue.push({at:h.executor.now()+ms,resolve});schedule(); });
  const counts = {};
  for (const [name, original] of Object.entries(h.exchange)) {
    h.exchange[name] = async (...args) => {
      counts[name]=(counts[name]??0)+1;
      await delay(name === 'isolate' ? latency*3 : latency);
      return original(...args);
    };
  }
  for (const [name,original] of Object.entries(h.store)) {
    h.store[name]=async(...args)=>{await delay(latency);return original(...args);};
  }
  h.executor.eventGate={check:async()=>{await delay(latency);return {allowed:true};}};
  h.executor.authorizeEntry=async()=>{await delay(latency);return true;};
  h.cfg.fadeEntrySource='spike';
  h.executor.spikeAuthorize=(symbol,s)=>h.executor.now()-s.barCloseTime<=10000;
  return {...h,counts,delay};
}

test('400ms read latency: a fresh spike reaches SELL within 10s with audit snapshot reused',async()=>{
  const h=delayedEntryHarness(),s={...signal,model:'spike-fade-ticks-v1',barCloseTime:now};
  let sentAt;
  const place=h.exchange.place;
  h.exchange.place=async params=>{if(params.side==='SELL')sentAt=h.executor.now();return place(params);};
  await h.executor.onSignal('AAAUSDT',s);
  assert.ok(sentAt && sentAt-s.barCloseTime<10000,`entry sent age ${sentAt-s.barCloseTime}`);
  assert.equal(h.positions.size,1);assert.equal(h.executor.lastError,null);
  assert.equal(h.executor.lastEntryAttempt.sentSignalAgeMs,sentAt-s.barCloseTime);
  assert.equal(h.counts.account,2,'one audit snapshot plus fresh post-isolate account');
  assert.equal(h.counts.income,1,'risk is verified once at final authorization');
  assert.equal(h.counts.openInterestHistory,1);
  assert.equal(h.counts.btcCandles,2);
  assert.ok(h.executor.lastEntryAttempt.timings['safety/metadata']<=400);
  assert.ok(h.executor.lastEntryAttempt.timings['final safety']<=400);
});

test('slow preparation still expires unsent spike rather than extending the deadline',async()=>{
  const h=delayedEntryHarness(1200),s={...signal,model:'spike-fade-ticks-v1',barCloseTime:now};
  await h.executor.onSignal('AAAUSDT',s);
  assert.equal(h.positions.size,0);assert.equal(h.calls.filter(x=>x[0]==='place').length,0);
  assert.match(h.executor.lastEntryAttempt.reason,/10 seconds|expired/i);
  assert.ok(h.executor.lastEntryAttempt.elapsedMs>10000);
});

test('final parallel safety reads fail closed on funding outage without any order',async()=>{
  const h=harness();h.exchange.funding=async()=>{throw Error('funding unavailable');};
  await h.executor.onSignal('AAAUSDT',signal);
  assert.equal(h.positions.size,0);assert.equal(h.calls.filter(x=>x[0]==='place').length,0);
  assert.match(h.executor.lastEntryAttempt.reason,/source unavailable/);
});

test('WATCH warm-up keeps eleven-second cold metadata outside a fresh spike entry deadline',async()=>{
 const h=delayedEntryHarness(),info=h.exchange.info;
 h.exchange.info=async()=>{await h.delay(11000);return info();};
 h.executor.preparation=new FadeEntryPreparation({exchange:h.exchange,eventGate:h.executor.eventGate,now:h.executor.now});
 h.executor.preparation.warm('AAAUSDT');await h.executor.preparation.info();
 const s={...signal,model:'spike-fade-ticks-v1',barCloseTime:h.executor.now()};
 await h.executor.onSignal('AAAUSDT',s);
 assert.equal(h.positions.size,1);assert.equal(h.executor.lastError,null);
 assert.ok(h.executor.lastEntryAttempt.sentSignalAgeMs<10000);
 assert.equal(h.counts.info,1,'slow metadata was read once before the signal');
 assert.equal(h.counts.income,1,'one final risk income read from exchange');
});

test('prewarmed funding still uses current safety validation and blocks extreme rates',async()=>{
 const h=harness();h.cfg.fadeEntrySource='spike';h.executor.spikeAuthorize=()=>true;
 h.exchange.funding=async()=>({symbol:'AAAUSDT',time:h.executor.now(),nextFundingTime:h.executor.now()+3600000,lastFundingRate:'-.002'});
 h.executor.preparation=new FadeEntryPreparation({exchange:h.exchange,eventGate:h.executor.eventGate,now:h.executor.now});
 await h.executor.preparation.funding('AAAUSDT');
 await h.executor.onSignal('AAAUSDT',{...signal,model:'spike-fade-ticks-v1',barCloseTime:h.executor.now()});
 assert.equal(h.positions.size,0);assert.match(h.executor.entrySafety.reason,/Extreme funding/);
});

test('spike account/lease overlap still refuses wrong account modes before mutation',async()=>{
 const h=harness({hedge:true});h.cfg.fadeEntrySource='spike';h.executor.spikeAuthorize=()=>true;
 await h.executor.onSignal('AAAUSDT',{...signal,model:'spike-fade-ticks-v1',barCloseTime:h.executor.now()});
 assert.equal(h.positions.size,0);assert.equal(h.calls.filter(x=>x[0]==='isolate'||x[0]==='place').length,0);
 assert.match(h.executor.lastError,/One-way/);
});

test('Fade protection fault is durable even when Telegram never completes', async () => {
  const h = harness({ stopRejected: true });
  h.executor.telegram.send = () => new Promise(() => {});
  await h.executor.onSignal('AAAUSDT', signal);
  await h.executor.run();
  const job = h.db().state.jobs[0];
  assert.equal(job.phase, 'CLOSED'); assert.equal(job.closeReason, 'PROTECTION_FAILURE');
  assert.equal(job.protectionFailure.code, -2021); assert.equal(job.protectionFailure.status, 400);
  assert.equal(job.protectionFailure.operation, 'protection/reconciliation');
  assert.equal(h.positions.size, 0);
});

test('one to five bps adverse fills use reserved risk, keep stop and do not flatten', async () => {
  for (const entryAvgPrice of [99.99, 99.95]) {
    const h = harness({ entryAvgPrice }); await h.executor.onSignal('AAAUSDT', signal);
    assert.equal(h.executor.lastError, null); assert.equal(h.positions.size, 1);
    const job = h.db().state.jobs[0];
    assert.ok(job.plan.riskDollars <= job.riskBudget + 1e-7);
    assert.equal(job.plan.stop, structuralFadeStop(signal.resistance, job.filters));
    assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'BUY' && c[1].type === 'MARKET').length, 0);
  }
});

test('target fill between order and position reads preserves and protects the runner', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  const job = h.db().state.jobs[0], original = h.exchange.order;
  let raced = false;
  h.options.price = 97;
  h.exchange.order = async (symbol, id) => {
    const snapshot = await original(symbol, id);
    if (id === job.actions.tp.id && !raced) {
      raced = true;
      const tp = h.orders.get(id); tp.executedQty = tp.origQty; tp.status = 'FILLED';
      h.positions.set(symbol, job.plan.runner);
    }
    return snapshot;
  };
  await h.executor.run();
  assert.equal(h.executor.lastError, null); assert.equal(h.positions.size, 1);
  assert.equal(h.db().state.jobs[0].phase, 'RUNNER');
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT' && c[1].side === 'BUY').length, 1);
});

test('inconsistent target snapshots block entries without killing a verified protected position', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  const j = h.db().state.jobs[0]; h.positions.set(j.symbol, j.plan.runner);
  await h.executor.run(); await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1); assert.match(h.executor.lastError, /Monitoring deferred/);
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'SELL').length, 1);
});

for (const fault of ['quote', 'save', 'lease', 'target', 'stopRead']) test(`temporary ${fault} failure retains existing native protection`, async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  if (fault === 'quote') h.exchange.book = async () => { throw Error('quote timeout'); };
  if (fault === 'save') h.options.saveFails = true;
  if (fault === 'lease') h.options.leaseLost = true;
  if (fault === 'target') { const original = h.exchange.order; h.exchange.order = (s,id) => id.endsWith('-tp') ? Promise.reject(Error('target timeout')) : original(s,id); }
  if (fault === 'stopRead') h.exchange.algo = async () => { throw Error('stop read timeout'); };
  await h.executor.run();
  assert.ok(h.executor.lastError); assert.equal(h.positions.size, 1);
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].side === 'BUY' && c[1].type === 'MARKET').length, 0);
  assert.ok([...h.algos.values()].some(a => a.algoStatus === 'NEW'));
});

test('missing native stop still flattens; monitoring changes never suppress genuine protection failure', async () => {
  const h = harness(); await h.executor.onSignal('AAAUSDT', signal);
  h.algos.get(h.db().state.jobs[0].stopId).algoStatus = 'CANCELED';
  await h.executor.run(); assert.equal(h.positions.size, 0);
  assert.match(h.executor.lastError, /emergency close/);
});

test('ambiguous target submission keeps native stop and blocks entries without duplicate target', async () => {
  const h = harness({ tpFails: true }); await h.executor.onSignal('AAAUSDT', signal);
  await h.executor.run(); await h.executor.onSignal('BBBUSDT', signal);
  assert.equal(h.positions.size, 1); assert.match(h.executor.lastError, /Monitoring deferred/);
  assert.equal(h.calls.filter(c => c[0] === 'place' && c[1].type === 'LIMIT' && c[1].side === 'BUY').length, 1);
});

test('definite entry rejection retires slot and permits a different fresh pattern on same coin', async () => {
  const h = harness(), original = h.exchange.place;
  h.exchange.place = async params => { if (params.side === 'SELL') throw new ExchangeError(400, -2019); return original(params); };
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(h.db().state.jobs[0].closeReason, 'ENTRY_REJECTED');
  assert.equal(h.db().state.jobs[0].filledQty, 0);
  h.exchange.place = original; h.advance(5001);
  await h.executor.onSignal('AAAUSDT', { ...signal, peakTime: signal.peakTime + 1 });
  assert.equal(h.positions.size, 1);
});

test('unknown exchange response code never retires or retries uncertain entry', async () => {
  const h = harness(); let posts = 0;
  h.exchange.place = async () => { posts++; throw new ExchangeError(400, -1007); };
  await h.executor.onSignal('AAAUSDT', signal); await h.executor.run();
  assert.equal(posts, 1); assert.equal(h.db().state.jobs[0].phase, 'SUBMITTING');
  assert.equal(h.db().state.jobs[0].entryDispatch, 'SENDING');
});

test('restart before dispatch arming retires provably unsent intent', async () => {
  const h = harness(); const save = h.store.fadeSave;
  let prepared;
  h.store.fadeSave = async (...args) => {
    if (args[3].jobs.some(j => j.entryDispatch === 'SENDING')) throw Error('restart before dispatch persisted');
    const saved = await save(...args); prepared = saved; return saved;
  };
  await h.executor.onSignal('AAAUSDT', signal);
  assert.equal(prepared.state.jobs[0].entryDispatch, 'PREPARED');
  assert.equal(h.calls.filter(c => c[0] === 'place').length, 0);
  h.store.fadeSave = save; h.releaseOwner(); const restarted = h.make(); await restarted.run();
  assert.equal(h.db().state.jobs[0].closeReason, 'UNSENT_ENTRY_RECOVERED');
});

test('unsent expired attempt does not impose the filled-trade symbol cooldown', async () => {
  const h = harness(); let reads = 0; h.executor.authorizeEntry = async () => ++reads === 1;
  await h.executor.onSignal('AAAUSDT', signal);
  h.executor.authorizeEntry = async () => true;
  await h.executor.onSignal('AAAUSDT', { ...signal, peakTime: signal.peakTime + 1 });
  assert.equal(h.positions.size, 1);
});

for (const alreadySet of [true, false]) test(`isolated 2x verification uses fresh config; already set=${alreadySet}`, async () => {
  const exchange = new FadeExchange({key:'test',secret:'test'}), calls = [];
  let configured = alreadySet;
  exchange.request = async (method, path) => {
    calls.push([method,path]);
    if (method === 'GET') return [{symbol:'AAAUSDT',marginType:configured?'ISOLATED':'CROSSED',leverage:configured?2:10}];
    if (path.endsWith('/leverage')) { configured = true; return {leverage:2}; }
    return {};
  };
  await exchange.isolate('AAAUSDT');
  assert.equal(calls.filter(c=>c[0]==='POST').length, alreadySet ? 0 : 2);
  assert.equal(calls.filter(c=>c[0]==='GET').length, alreadySet ? 1 : 2);
});

test('archive failure never drops a closed job; verified archive prunes with fenced save', async () => {
  const h = harness(); await h.executor.ready();
  const old = {id:'old',symbol:'AAAUSDT',phase:'CLOSED',filledQty:0,closedAt:now-9*86400000,actions:{}};
  h.executor.row.state.jobs.push(old); await h.executor.save();
  let stored;
  h.store.insertEvent = async e => { stored=e; };
  h.store.get = async () => [];
  await h.executor.maintainArchive(); await h.executor.archiveInFlight;
  assert.equal(h.db().state.jobs.length,1);
  h.advance(60001);h.store.get=async()=>[{payload:stored.payload}];
  await h.executor.maintainArchive(); await h.executor.archiveInFlight;
  assert.equal(h.db().state.jobs.length,1,'durable archive alone never changes runtime');
  await h.executor.maintainArchive();
  assert.equal(h.db().state.jobs.length,0);assert.equal(stored.payload.job.id,'old');
});

test('archive prune save failure retains live journal and retries from durable archive', async () => {
  const h = harness(); await h.executor.ready();
  const old={id:'old',symbol:'AAAUSDT',phase:'CLOSED',filledQty:0,closedAt:now-9*86400000,actions:{}};
  h.executor.row.state.jobs.push(old); await h.executor.save();
  let stored;h.store.insertEvent=async e=>{stored=e;};h.store.get=async()=>[{payload:stored.payload}];
  await h.executor.maintainArchive();await h.executor.archiveInFlight;
  h.options.saveFails=true;
  await assert.rejects(h.executor.maintainArchive(),/database offline/);
  assert.equal(h.db().state.jobs.length,1);assert.equal(h.executor.row.state.jobs.length,1);
  h.options.saveFails=false;await h.executor.maintainArchive();assert.equal(h.db().state.jobs.length,0);
});

test('known stop cancellation is not downgraded to monitoring uncertainty', async () => {
  const h=harness();await h.executor.onSignal('AAAUSDT',signal);
  const original=h.exchange.algo;let queries=0;
  h.exchange.algo=async id=>{ if(++queries===1)return {...await original(id),algoStatus:'CANCELED'};throw Error('later lookup timeout'); };
  await h.executor.run();assert.equal(h.positions.size,0);
});

test('failed tightening preserves the earlier verified stop rather than flattening a winner', async () => {
  const h=harness();await h.executor.onSignal('AAAUSDT',signal);
  const old=h.db().state.jobs[0].stopId;h.options.price=98.4;h.options.stopRejected=true;
  await h.executor.run();assert.equal(h.positions.size,1);assert.match(h.executor.lastError,/Monitoring deferred/);
  assert.equal(h.algos.get(old).algoStatus,'NEW');
  assert.equal(h.calls.filter(c=>c[0]==='cancelStop'&&c[1]===old).length,0);
});

test('stop breach with failed persistence still requests emergency reduce-only close', async () => {
  const h=harness();await h.executor.onSignal('AAAUSDT',signal);
  h.options.price=102;h.options.saveFails=true;
  await h.executor.run();assert.equal(h.positions.size,0);
});

test('FOK entry cannot fill below capped price; no-fill expiration releases slot', async()=>{
 const h=harness(),original=h.exchange.place;let entry;
 h.exchange.place=async p=>{
  if(p.side!=='SELL')return original(p);
  entry=p; assert.equal(p.type,'LIMIT');assert.equal(p.timeInForce,'FOK');assert.equal(Number(p.price),99.95);
  const o={...p,clientOrderId:p.newClientOrderId,origQty:p.quantity,executedQty:'0',avgPrice:'0',status:'EXPIRED'};
  h.orders.set(o.clientOrderId,o);return o;
 };
 await h.executor.onSignal('AAAUSDT',signal);
 assert.ok(entry);assert.equal(h.positions.size,0);assert.equal(h.db().state.jobs[0].phase,'CLOSED');
 assert.equal(h.db().state.jobs[0].filledQty,0);assert.equal(h.algos.size,0);
});

test('thin, stale and malformed depth never submit a new entry',async()=>{
 for(const depth of [
  {T:now,bids:[['100','0.01']],asks:[['100.01','100']]},
  {T:now-3000,bids:[['100','100']],asks:[['100.01','100']]},
  {T:now,bids:[['NaN','100']],asks:[['100.01','100']]}
 ]){
  const h=harness();h.exchange.depth=async()=>depth;await h.executor.onSignal('AAAUSDT',signal);
  assert.equal(h.positions.size,0);assert.equal(h.calls.filter(c=>c[0]==='place').length,0);
  assert.match(h.executor.lastEntryAttempt.reason,/depth/i);
 }
});

test('initial native stop POST has no intervening database write or lease read after verified fill',async()=>{
 const h=harness();let filled=false,protectedFill=false,dbCalls=0;
 const place=h.exchange.place,stop=h.exchange.placeStop;
 h.exchange.place=async p=>{const r=await place(p);if(p.side==='SELL')filled=true;return r;};
 h.exchange.placeStop=async(...args)=>{assert.equal(dbCalls,0);const r=await stop(...args);protectedFill=true;return r;};
 for(const name of ['fadeLease','fadeSave']){const original=h.store[name];h.store[name]=(...args)=>{if(filled&&!protectedFill)dbCalls++;return original(...args);};}
 await h.executor.onSignal('AAAUSDT',signal);
 assert.equal(h.positions.size,1);assert.equal(protectedFill,true);assert.equal(h.executor.lastError,null);
});

for(const [code,status] of [[-4131,400],[-1003,429],[-1008,503],[-1111,400]])test(`explicit entry rejection ${code} releases slot and applies backoff`,async()=>{
 const h=harness();let calls=0;
 h.exchange.place=async()=>{calls++;throw new ExchangeError(status,code);};
 await h.executor.onSignal('AAAUSDT',signal);await h.executor.run();
 assert.equal(h.db().state.jobs[0].phase,'CLOSED');assert.equal(h.db().state.jobs[0].closeReason,'ENTRY_REJECTED');
 await h.executor.onSignal('BBBUSDT',signal);assert.equal(calls,1);assert.match(h.executor.lastEntryAttempt.reason,/backoff/);
});

test('definitely rejected target is replaced once after fresh checks and restart; runner remains protected',async()=>{
 const h=harness(),place=h.exchange.place;let rejected=false;
 h.exchange.place=async p=>{if(p.side==='BUY'&&p.type==='LIMIT'&&!rejected){rejected=true;throw new ExchangeError(400,-4131);}return place(p);};
 await h.executor.onSignal('AAAUSDT',signal);
 const first=h.db().state.jobs[0];assert.equal(first.actions.tp.state,'REJECTED');assert.equal(h.positions.size,1);
 h.advance(5001);h.releaseOwner();const restarted=h.make();await restarted.run();
 assert.equal(restarted.lastError,null);const j=h.db().state.jobs[0];assert.notEqual(j.actions.tp.id,first.actions.tp.id);
 assert.equal(j.actions.tp.state,'ACCEPTED');assert.ok(h.orders.has(j.actions.tp.id));
 await restarted.run();assert.equal(h.calls.filter(c=>c[0]==='place'&&c[1].side==='BUY'&&c[1].type==='LIMIT').length,1);
});

test('rejected break-even stop recovers on a later cycle without removing original protection first',async()=>{
 const h=harness();await h.executor.onSignal('AAAUSDT',signal);
 const original=h.db().state.jobs[0].stopId;h.options.price=98.4;h.options.stopRejected=true;
 await h.executor.run();assert.equal(h.algos.get(original).algoStatus,'NEW');
 h.options.stopRejected=false;h.advance(5001);h.releaseOwner();const restarted=h.make();await restarted.run();
 assert.equal(restarted.lastError,null);const j=h.db().state.jobs[0];assert.notEqual(j.stopId,original);
 assert.equal(h.algos.get(j.stopId).algoStatus,'NEW');assert.equal(h.algos.get(original).algoStatus,'CANCELED');
});

test('repeated definite target rejections have a bounded repair policy, not an indefinite deferred loop',async()=>{
 const h=harness(),place=h.exchange.place;let rejections=0;
 h.exchange.place=async p=>{if(p.side==='BUY'&&p.type==='LIMIT'){rejections++;throw new ExchangeError(400,-4131);}return place(p);};
 await h.executor.onSignal('AAAUSDT',signal);
 for(let i=0;i<3;i++){h.advance(5001);await h.executor.run();}
 assert.equal(rejections,3);assert.equal(h.positions.size,0);
 await h.executor.run();assert.equal(h.db().state.jobs[0].phase,'CLOSED');
});

test('lost entry that never arrived is retired only after grace and three complete flat/no-fill checks',async()=>{
 const h=harness({entryUnknown:true});await h.executor.onSignal('AAAUSDT',signal);
 h.advance(60001);await h.executor.run();assert.equal(h.db().state.jobs[0].phase,'SUBMITTING');
 h.advance(5001);await h.executor.run();assert.equal(h.db().state.jobs[0].phase,'SUBMITTING');
 h.advance(5001);await h.executor.run();assert.equal(h.db().state.jobs[0].closeReason,'ENTRY_ABSENCE_RECONCILED');
 assert.equal(h.calls.filter(c=>c[0]==='place'&&c[1].side==='SELL').length,1);
});

for(const bad of ['fills','position','truncated','outage'])test(`unknown entry stays reserved when absence evidence has ${bad}`,async()=>{
 const h=harness({entryUnknown:true});await h.executor.onSignal('AAAUSDT',signal);
 if(bad==='fills')h.exchange.trades=async()=>[{symbol:'AAAUSDT',qty:'1'}];
 if(bad==='position')h.positions.set('AAAUSDT',1);
 if(bad==='truncated')h.exchange.allOrders=async()=>Array.from({length:1000},()=>({}));
 if(bad==='outage')h.exchange.trades=async()=>{throw Error('offline');};
 h.advance(60001);for(let i=0;i<4;i++){await h.executor.run();h.advance(5001);}
 assert.equal(h.db().state.jobs[0].phase,'SUBMITTING');assert.equal(h.calls.filter(c=>c[0]==='place'&&c[1].side==='SELL').length,1);
});

test('break-even no longer moves at half R, but tightens after one R net',async()=>{
 const h=harness();await h.executor.onSignal('AAAUSDT',signal);
 const j=h.db().state.jobs[0];
 // net/qty = entry*(1-fee)-ask*(1+fee+exitSlippage)
 const priceFor=r=>(j.plan.entry*(1-j.fee)-r*j.plan.riskDollars/j.plan.qty)/(1+j.fee+.0005);
 h.options.price=priceFor(.6)-.01;await h.executor.run();assert.equal(h.db().state.jobs[0].stopId,j.stopId);
 h.options.price=priceFor(1.1)-.01;await h.executor.run();assert.notEqual(h.db().state.jobs[0].stopId,j.stopId);
});

test('lost target with proven absence recovers after grace without replaying unknown writes',async()=>{
 const h=harness({tpFails:true});await h.executor.onSignal('AAAUSDT',signal);
 const before=h.db().state.jobs[0].actions.tp.id;h.options.tpFails=false;h.advance(60001);
 for(let i=0;i<3;i++){await h.executor.run();h.advance(5001);}
 assert.equal(h.db().state.jobs[0].actions.tp.state,'REJECTED');
 await h.executor.run();assert.equal(h.executor.lastError,null);
 assert.notEqual(h.db().state.jobs[0].actions.tp.id,before);assert.equal(h.positions.size,1);
});

test('unknown target with possible exit fill cannot be resent from negative lookup alone',async()=>{
 const h=harness({tpFails:true});await h.executor.onSignal('AAAUSDT',signal);
 h.exchange.trades=async()=>[{side:'BUY',qty:'0.1'}];h.advance(60001);
 for(let i=0;i<4;i++){await h.executor.run();h.advance(5001);}
 assert.equal(h.calls.filter(c=>c[0]==='place'&&c[1].side==='BUY'&&c[1].type==='LIMIT').length,1);
 assert.notEqual(h.db().state.jobs[0].actions.tp.state,'REJECTED');
});

test('legacy SUBMITTING job without dispatch marker can reconcile complete no-fill evidence',async()=>{
 const h=harness({entryUnknown:true});await h.executor.onSignal('AAAUSDT',signal);
 delete h.executor.row.state.jobs[0].entryDispatch;delete h.executor.row.state.jobs[0].filledQty;await h.executor.save();
 h.advance(60001);for(let i=0;i<3;i++){await h.executor.run();h.advance(5001);}
 assert.equal(h.db().state.jobs[0].closeReason,'ENTRY_ABSENCE_RECONCILED');
});

test('HTTP-success response with terminal zero-fill target status schedules bounded replacement',async()=>{
 const h=harness(),place=h.exchange.place;let rejected=false;
 h.exchange.place=async p=>{const o=await place(p);if(p.side==='BUY'&&p.type==='LIMIT'&&!rejected){rejected=true;o.status='REJECTED';h.orders.set(o.clientOrderId,structuredClone(o));}return o;};
 await h.executor.onSignal('AAAUSDT',signal);assert.equal(h.db().state.jobs[0].actions.tp.state,'REJECTED');
 h.advance(5001);await h.executor.run();assert.equal(h.executor.lastError,null);assert.equal(h.positions.size,1);
});

test('terminal partial target cannot loop or resubmit its full original quantity',async()=>{
 const h=harness();await h.executor.onSignal('AAAUSDT',signal);const j=h.db().state.jobs[0];
 const tp=h.orders.get(j.actions.tp.id);tp.executedQty=String(j.plan.partial/2);tp.status='CANCELED';
 h.positions.set(j.symbol,j.plan.qty-j.plan.partial/2);
 await h.executor.run();assert.equal(h.positions.size,0);
 assert.equal(h.calls.filter(c=>c[0]==='place'&&c[1].side==='BUY'&&c[1].type==='LIMIT').length,1);
});

import { fixture as structureFixture } from './fixtures/structure-bars.js';
test('structure Fade uses confirmed SHORT gap, ATR stop, half-R protection and preserves restart state',async()=>{
 const h=harness();h.cfg.structureStrategy=true;
 const short=structureFixture('SHORT',now).map(b=>({...b,...Object.fromEntries(['open','high','low','close'].map(k=>[k,100+(b[k]-99.78)*2]))}));
 const toRow=b=>[b.time,b.open,b.high,b.low,b.close,b.volume,b.end,b.quote,0,0,b.buy];
 h.exchange.request=async(method,path,{interval})=>{
  if(interval==='1m') return short.map(toRow);
  const ms=interval==='15m'?900000:3600000;
  return Array.from({length:121},(_,i)=>{const c=112-i*.1,t=now-1-(121-i)*ms;
   return [t,c+.02,c+.05,c-.05,c,100,t+ms-1,10000,0,0,4000];});
 };
 await h.executor.onSignal('AAAUSDT',signal);
 assert.equal(h.executor.lastError,null);
 const j=h.db().state.jobs[0];assert.ok(j,'structure candidate submitted');
 assert.equal(j.policyVersion,'sweep-mss-fvg-v1');assert.equal(j.structuralStop,j.plan.stop);
 assert.ok(j.riskBudget<=.5);assert.ok(j.plan.stop>100.8 && j.plan.stop<101);
 const p=j.plan, price=(p.entry*(1-j.fee)-.6*p.riskDollars/p.qty)/(1+j.fee+.0005);
 h.exchange.book=async()=>({bidPrice:String(price-.01),askPrice:String(price)});
 await h.executor.run();assert.equal(h.executor.lastError,null);
 assert.equal(h.db().state.jobs[0].plan.stop,h.db().state.jobs[0].plan.breakEven);
 h.releaseOwner();const restarted=h.make();await restarted.run();assert.equal(restarted.lastError,null);
 assert.equal(h.db().state.jobs[0].policyVersion,'sweep-mss-fvg-v1');
});
test('structure Fade fails closed when candle context cannot be fetched',async()=>{
 const h=harness();h.cfg.structureStrategy=true;h.exchange.request=async()=>{throw Error('data offline');};
 await h.executor.onSignal('AAAUSDT',signal);
 assert.equal(h.calls.filter(c=>c[0]==='place').length,0);
});
