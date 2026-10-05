import test from 'node:test';
import assert from 'node:assert/strict';
import { FuturesAutoExecutor, futuresExitPlan, FuturesAutoExchange } from '../src/futures-auto-executor.js';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';
import { loadFuturesAutoConfig } from '../src/futures-auto-config.js';
import { directionalSignal, closedSeries } from '../src/futures-auto-strategy.js';
import { FuturesAutoWorkerLoop } from '../src/futures-auto-worker-loop.js';
import { ExchangeError } from '../src/fade-orders.js';
const now = Date.parse('2026-09-30T12:07:00Z');
const clone = x => structuredClone(x);
const info = symbol => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', filters: [
  { filterType: 'LOT_SIZE', stepSize: '.001', minQty: '.001', maxQty: '10000' },
  { filterType: 'MARKET_LOT_SIZE', stepSize: '.001', minQty: '.001', maxQty: '10000' },
  { filterType: 'PRICE_FILTER', tickSize: '.001', minPrice: '.001', maxPrice: '100000' },
  { filterType: 'MIN_NOTIONAL', notional: '5' }] });
function harness(opt = {}) {
  let db = { revision: 0, state: { jobs: [], paused: false } }, owner;
  const calls = [], orders = new Map(), algos = new Map(), positions = new Map();
  let clock = now;
  const cfg = { environment: 'testnet', fadeEnvironment: 'testnet', enabled: true, enableFadeExecution: true, binanceApiKey: 'separate' };
  const store = {
    fadeLease: async (scope, who) => { assert.equal(scope, 'testnet:directional'); if (opt.leaseLost) throw Error('lease lost'); owner ??= who; if (owner !== who) throw Error('lease owned'); return clone(db); },
    fadeSave: async (scope, who, revision, state) => { assert.equal(owner, who); assert.equal(revision, db.revision);
      if (opt.saveFails) throw Error('database offline'); assert.ok(state.jobs.filter(j => j.phase !== 'CLOSED').length <= 5);
      db = { revision: revision + 1, state: clone(state) }; return clone(db); },
  };
  const exchange = {
    syncTime: async () => {}, mode: async () => ({ dualSidePosition: opt.hedge ?? false }), assetsMode: async () => ({ multiAssetsMargin: false }),
    accountPermissions: async () => ({ canTrade: true }), account: async () => ({ totalWalletBalance: '100', totalUnrealizedProfit: '0', totalMarginBalance: '100', availableBalance: '100', totalInitialMargin: '0', assets: [{ asset: 'USDT', availableBalance: '100' }] }),
    positions: async () => [...positions].map(([symbol, qty]) => ({ symbol, positionAmt: String(qty), positionSide: 'BOTH', notional: String(qty * 100) })),
    orders: async () => [...orders.values()].filter(o => ['NEW', 'PARTIALLY_FILLED'].includes(o.status)).map(clone),
    algos: async () => [...algos.values()].filter(o => o.algoStatus === 'NEW').map(clone),
    income: async () => opt.income ?? [], funding: async symbol => ({ symbol, lastFundingRate: '.0001', time: clock, nextFundingTime: clock + 3600000 }),
    info: async () => ({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'].map(info) }),
    fees: async () => ({ takerCommissionRate: '.0005', makerCommissionRate: '.0002' }), isolate: async () => calls.push('isolate'),
    book: async () => ({ bidPrice: String(opt.price ?? 100), askPrice: String((opt.price ?? 100) + .01) }),
    order: async (symbol, id) => { const o = orders.get(id); if (!o) throw new ExchangeError(400, -2013); return clone(o); },
    algo: async id => { const o = algos.get(id); if (!o) throw new ExchangeError(400, -2013); return clone(o); },
    place: async params => {
      calls.push(['place', clone(params)]);
      const job = db.state.jobs.find(j => j.symbol === params.symbol && j.phase !== 'CLOSED');
      assert.ok(job && (Object.values(job.actions).some(a => a.id === params.newClientOrderId) || params.newClientOrderId.startsWith(`nx-${job.id}-z`)), 'durable intent precedes write');
      if (opt.unknownBefore && !params.reduceOnly) throw Error('unknown acceptance');
      if (opt.rejectEntry && !params.reduceOnly) throw new ExchangeError(400, -2019);
      if (opt.tpFails && params.type === 'LIMIT') throw new ExchangeError(400, -1111);
      const qty = Number(params.quantity), market = params.type === 'MARKET';
      const o = { ...params, clientOrderId: params.newClientOrderId, origQty: String(qty), executedQty: market ? String(qty) : '0',
        avgPrice: String(opt.fill ?? (params.side === 'BUY' ? 100.01 : 100)), status: market ? 'FILLED' : 'NEW' };
      orders.set(o.clientOrderId, o);
      if (market && !params.reduceOnly) { positions.set(params.symbol, qty * (params.side === 'BUY' ? 1 : -1)); if (opt.saveAfterFill) opt.saveFails = true; }
      if (market && params.reduceOnly) { assert.equal(params.side, positions.get(params.symbol) > 0 ? 'SELL' : 'BUY'); positions.delete(params.symbol); }
      if (opt.unknownAfter && !params.reduceOnly) throw Error('response lost after accepted fill');
      return clone(o);
    },
    placeDirectionalStop: async (symbol, id, price, side) => {
      calls.push(['stop', side, price]); if (opt.stopFails) throw new ExchangeError(400, -2021);
      const o = { symbol, clientAlgoId: id, algoStatus: 'NEW', side, orderType: 'STOP_MARKET', closePosition: true, triggerPrice: String(price) };
      algos.set(id, o); return clone(o);
    },
    cancel: async (symbol, id) => { orders.get(id).status = 'CANCELED'; calls.push(['cancel', id]); },
    cancelStop: async id => { algos.get(id).algoStatus = 'CANCELED'; },
  };
  const make = () => new FuturesAutoExecutor({ cfg, store, exchange, now: () => clock, wait: async () => {}, telegram: { send: async () => {} }, eventGate: { check: async () => ({ allowed: true }) } });
  return { ex: make(), make, calls, orders, algos, positions, exchange, cfg, opt, db: () => clone(db), release: () => { owner = null; }, advance: ms => { clock += ms; } };
}
const signal = direction => ({ allowed: true, symbol: 'ETHUSDT', direction, entry: 100, stop: direction === 'LONG' ? 99.5 : 100.5, barCloseTime: now - 1000, breakoutTime: now - 300000 });
for (const direction of ['LONG', 'SHORT']) {
  test(`${direction}: stop precedes target; restart doesn't duplicate; exit clears owned orders`, async () => {
    const h = harness(); await h.ex.onSignal('ETHUSDT', signal(direction)); assert.equal(h.ex.lastError, null);
    assert.equal(h.positions.get('ETHUSDT') > 0, direction === 'LONG');
    const stopIndex = h.calls.findIndex(x => x[0] === 'stop'), tpIndex = h.calls.findIndex(x => x[0] === 'place' && x[1].type === 'LIMIT');
    assert.ok(stopIndex >= 0 && stopIndex < tpIndex); assert.equal(h.calls[stopIndex][1], direction === 'LONG' ? 'SELL' : 'BUY');
    assert.ok(h.db().state.jobs[0].plan.plannedLossUsd <= 1);
    const before = h.calls.filter(x => x[0] === 'place').length; h.release(); const restarted = h.make(); await restarted.run();
    assert.equal(restarted.lastError, null); assert.equal(h.calls.filter(x => x[0] === 'place').length, before);
    await restarted.control('close'); assert.equal(h.positions.size, 0); await restarted.run();
    assert.equal(h.db().state.jobs[0].phase, 'CLOSED'); assert.equal((await h.exchange.algos()).length, 0);
  });
  test(`${direction}: failed stop/target flattens only verified bot fill`, async () => {
    for (const opt of [{ stopFails: true }, { tpFails: true }, { saveAfterFill: true }]) {
      const h = harness(opt); await h.ex.onSignal('ETHUSDT', signal(direction));
      assert.equal(h.positions.size, 0); assert.ok(h.calls.some(x => x[0] === 'place' && x[1].reduceOnly === 'true'));
    }
  });
  test(`${direction}: ambiguous accepted entry is reconciled without resubmission`, async () => {
    const h = harness({ unknownAfter: true }); await h.ex.onSignal('ETHUSDT', signal(direction));
    assert.equal(h.ex.lastError, null); await h.ex.run(); assert.equal(h.ex.lastError, null);
    assert.equal(h.calls.filter(x => x[0] === 'place' && !x[1].reduceOnly).length, 1);
  });
  test(`${direction}: cost-adjusted break-even tightens but never widens initial stop`, async () => {
    const h = harness(); await h.ex.onSignal('ETHUSDT', signal(direction)); const initial = h.db().state.jobs[0].plan.stop;
    h.opt.price = direction === 'LONG' ? 101 : 99; await h.ex.run(); const plan = h.db().state.jobs[0].plan;
    assert.equal(plan.stop, plan.breakEven); assert.ok(direction === 'LONG' ? plan.stop > initial : plan.stop < initial);
  });
}
test('unknown unaccepted entry remains blocked; never a second POST', async () => {
  const h = harness({ unknownBefore: true }); await h.ex.onSignal('ETHUSDT', signal('LONG')); await h.ex.run();
  assert.match(h.ex.lastError, /-2013/); assert.equal(h.calls.filter(x => x[0] === 'place').length, 1);
});
test('definite entry rejection retires without phantom position', async () => {
  const h = harness({ rejectEntry: true }); await h.ex.onSignal('ETHUSDT', signal('LONG'));
  assert.equal(h.positions.size, 0); assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
});
test('lease failure, pause, unmanaged account, event, daily loss and wrong account modes withhold entry', async () => {
  for (const kind of ['lease', 'pause', 'unmanaged', 'event', 'daily', 'mode']) {
    const h = harness(kind === 'lease' ? { leaseLost: true } : kind === 'mode' ? { hedge: true } : {});
    if (kind === 'pause') h.ex.authorizeEntry = async () => false;
    if (kind === 'unmanaged') h.positions.set('SOLUSDT', 1);
    if (kind === 'event') h.ex.eventGate = { check: async () => ({ allowed: false, reason: 'Event near' }) };
    if (kind === 'daily') h.opt.income = [{ asset: 'USDT', incomeType: 'REALIZED_PNL', income: '-3', time: now - 10000 }];
    await h.ex.onSignal('ETHUSDT', signal('LONG')); assert.equal(h.calls.filter(x => x[0] === 'place').length, 0, kind);
  }
});
test('remote pause arriving after sizing prevents POST; outage closes unsent intent', async () => {
  for (const fail of [false, true]) {
    const h = harness(); let n = 0; h.ex.authorizeEntry = async () => { if (++n === 2) { if (fail) throw Error('control offline'); return false; } return true; };
    await h.ex.onSignal('ETHUSDT', signal('LONG')); assert.equal(h.positions.size, 0); assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
    await h.ex.run(); assert.equal(h.db().state.jobs[0].phase, 'CLOSED');
  }
});
test('actual fill over risk budget flattens, never widens stop', async () => {
  const h = harness({ fill: 102 }); await h.ex.onSignal('ETHUSDT', signal('LONG')); assert.equal(h.positions.size, 0);
});
test('changed API fingerprint is rejected, disabled entries still reconcile', async () => {
  const h = harness(); await h.ex.onSignal('ETHUSDT', signal('LONG'));
  h.cfg.enabled = false; await h.ex.run(); assert.equal(h.ex.lastError, null); assert.equal(h.positions.size, 1);
  h.cfg.binanceApiKey = 'other'; await h.ex.run(); assert.match(h.ex.lastError, /pinned/);
});
test('risk policy enforces five, aggregate, fees, margin and minimums in both directions', () => {
  for (const direction of ['LONG', 'SHORT']) {
    const input = { direction, entry: 100, stop: direction === 'LONG' ? 99 : 101, equity: 100, available: 100,
      feeRate: .0005, qtyStep: .001, minQty: .001, minNotional: 5 };
    const p = planFuturesAutoTrade(input); assert.ok(p.allowed); assert.ok(p.plannedLossUsd <= 1 && p.marginUsd <= 50 && p.notionalUsd <= 150);
    assert.equal(planFuturesAutoTrade({ ...input, open: Array(5).fill({ riskUsd: 0, marginUsd: 0 }) }).allowed, false);
    assert.equal(planFuturesAutoTrade({ ...input, open: [{ riskUsd: 3, marginUsd: 10 }] }).allowed, false);
    assert.equal(planFuturesAutoTrade({ ...input, available: .1 }).allowed, false);
    const x = futuresExitPlan(direction, p.entry, p.qty, p.stop, input.feeRate, .001);
    const net = direction === 'LONG' ? p.qty * (x.target * .999 - p.entry * 1.0005) : p.qty * (p.entry * .9995 - x.target * 1.001);
    assert.ok(net >= 1.5 * x.plannedLossUsd - 1e-6 && net - 1.5 * x.plannedLossUsd < 0.05);
  }
});
test('separate credentials required; fade credentials never serve as fallback', () => {
  const env = { FUTURES_BINANCE_API_KEY: 'futures', FUTURES_BINANCE_API_SECRET: 'secret', FUTURES_ACCOUNT_CONFIRMATION: 'SEPARATE_FUTURES_SUBACCOUNT',
    SUPABASE_URL: 'https://example.com', SUPABASE_SERVICE_ROLE_KEY: 'role', BOT_TOKEN: 'bot', OWNER_CHAT_ID: '1' };
  assert.equal(loadFuturesAutoConfig(env).environment, 'testnet');
  assert.throws(() => loadFuturesAutoConfig({ ...env, FUTURES_BINANCE_API_KEY: '', BINANCE_API_KEY: 'fade' }), /Missing FUTURES/);
  assert.throws(() => loadFuturesAutoConfig({ ...env, BINANCE_API_KEY: 'futures' }), /separate/);
  assert.throws(() => loadFuturesAutoConfig({ ...env, FUTURES_AUTO_ENVIRONMENT: 'live', ENABLE_FUTURES_AUTO: 'true' }), /acknowledgement/);
});
function candleRows(interval, price = i => 90 + i * .05) {
  const end = Math.floor(now / interval) * interval - 1;
  return Array.from({ length: 121 }, (_, i) => { const close = price(i), t = end - (120 - i) * interval - interval + 1;
    return [t, close - .02, close + .04, close - .04, close, 100, t + interval - 1, 10000, 0, 0, 6000]; });
}
test('directional scanner requires distinct retest/reclaim; mirrors SHORT and ignores forming bars', () => {
  const m15 = candleRows(900000), h1 = candleRows(3600000), m1 = candleRows(60000, () => 96.01);
  m15.at(-1)[4] = 96.03; m15.at(-1)[2] = 96.06; m15.at(-1)[5] = 150;
  // Previous 20-bar high: 95.99. Retest then latest reclaim through its high.
  m1.at(-2)[1] = 95.99; m1.at(-2)[2] = 96.00; m1.at(-2)[3] = 95.98; m1.at(-2)[4] = 95.99;
  m1.at(-1)[1] = 96; m1.at(-1)[2] = 96.05; m1.at(-1)[3] = 96; m1.at(-1)[4] = 96.025;
  const input = { symbol: 'ETHUSDT', m1, m15, h1, btc15: m15, btc1h: h1, now };
  assert.equal(directionalSignal(input).direction, 'LONG');
  const mirror = rows => rows.map(r => [r[0], 200-r[1], 200-r[3], 200-r[2], 200-r[4], r[5], r[6], r[7], r[8], r[9], r[7]-r[10]]);
  assert.equal(directionalSignal({ ...input, m1: mirror(m1), m15: mirror(m15), h1: mirror(h1), btc15: mirror(m15), btc1h: mirror(h1) }).direction, 'SHORT');
  assert.equal(directionalSignal({ ...input, m1: candleRows(60000, () => 98) }).allowed, false);
  assert.equal(directionalSignal({ ...input, now: now + 2 * 3600000 }).allowed, false);
  assert.equal(directionalSignal({ ...input, btc1h: mirror(h1) }).allowed, false);
  const neutralBtc15 = candleRows(900000, () => 100);
  assert.equal(directionalSignal({ ...input, btc15: neutralBtc15 }).direction, 'LONG');
  const opposingBtc = directionalSignal({ ...input, btc15: mirror(m15) });
  assert.equal(opposingBtc.allowed, false); assert.match(opposingBtc.reason, /BTC 15m trend SHORT opposes symbol LONG/);
  const forming = [...m1, [now, 100, 101, 99, 100, 1, now+59999, 100, 0, 0, 50]];
  assert.equal(closedSeries(forming, 60000, now).length, m1.length);
});
test('worker controls never suppress protection on control outage or entry disable', async () => {
  const calls = []; const executor = { scope: 'testnet:directional', cfg: { enabled: false }, row: { state: { jobs: [], paused: false } },
    run: async () => calls.push('protect'), status: () => 'status', failed: async () => calls.push('error'), stop: () => {} };
  const store = { control: async () => { throw Error('db offline'); }, heartbeat: async () => calls.push('heartbeat') };
  const loop = new FuturesAutoWorkerLoop({ executor, store }); await loop.tick(); assert.deepEqual(calls, ['protect', 'error', 'heartbeat']);
});
test('exchange native stops use opposite exit sides and fixed Binance endpoints', async () => {
  const calls = [], ex = new FuturesAutoExchange({ environment: 'testnet', key: 'key', secret: 'secret', fetcher: async (url, options) => {
    calls.push({ url, method: options.method }); return { ok: true, json: async () => ({}) }; } });
  await ex.placeDirectionalStop('ETHUSDT', 'id', 99, 'SELL'); await ex.placeDirectionalStop('ETHUSDT', 'id2', 101, 'BUY');
  assert.ok(calls.every(c => c.url.startsWith('https://demo-fapi.binance.com/fapi/v1/algoOrder?') && c.method === 'POST'));
  assert.equal(new URL(calls[0].url).searchParams.get('closePosition'), 'true'); assert.equal(new URL(calls[1].url).searchParams.get('side'), 'BUY');
});
test('partially filled target retains native protection and restart never adds to position', async () => {
  const h = harness(); await h.ex.onSignal('ETHUSDT', signal('LONG'));
  const job = h.db().state.jobs[0], tp = h.orders.get(job.actions.tp.id);
  const partial = job.filledQty / 2; tp.executedQty = String(partial); tp.status = 'PARTIALLY_FILLED';
  h.positions.set('ETHUSDT', job.filledQty - partial); const entries = h.calls.filter(x => x[0] === 'place' && !x[1].reduceOnly).length;
  h.release(); const ex = h.make(); await ex.run(); assert.equal(ex.lastError, null);
  assert.equal(h.calls.filter(x => x[0] === 'place' && !x[1].reduceOnly).length, entries);
  assert.equal((await h.exchange.algos()).length, 1); assert.equal(h.positions.get('ETHUSDT'), partial);
});
test('manual orders and direction mismatch are not adopted or reversed', async () => {
  const h = harness(); h.orders.set('manual', { symbol: 'SOLUSDT', clientOrderId: 'manual', status: 'NEW' });
  await h.ex.onSignal('ETHUSDT', signal('LONG')); assert.match(h.ex.lastError, /Unmanaged order/);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  h.orders.delete('manual'); await h.ex.onSignal('ETHUSDT', signal('LONG'));
  h.positions.set('ETHUSDT', -1); const count = h.calls.filter(x => x[0] === 'place').length;
  await h.ex.run(); assert.match(h.ex.lastError, /Unexpected position direction/);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, count);
});
test('malformed fresh account balance cannot reuse a previous good snapshot for entries', async () => {
  const h = harness(); await h.ex.run(); assert.ok(h.ex.balanceSnapshot);
  h.exchange.account = async () => ({ assets: [{ asset: 'USDT', availableBalance: '100' }] });
  await h.ex.onSignal('ETHUSDT', signal('LONG')); assert.equal(h.ex.balanceSnapshot, null);
  assert.match(h.ex.lastError, /balance data unavailable/); assert.equal(h.positions.size, 0);
});
test('ordinary small adverse market fills fit the reserved slippage budget', async () => {
  for (const direction of ['LONG', 'SHORT']) {
    const h = harness({ fill: direction === 'LONG' ? 100.06 : 99.95 });
    await h.ex.onSignal('ETHUSDT', signal(direction)); assert.equal(h.ex.lastError, null);
    assert.equal(h.positions.size, 1); assert.ok(h.db().state.jobs[0].plan.plannedLossUsd <= 1);
  }
});

test('v6.9.37: target scales with risk (1.5R net), not a fixed dollar amount', () => {
  for (const [direction, entry, stop] of [['LONG', 100, 99.5], ['SHORT', 100, 100.5], ['LONG', 2500, 2487.5]]) {
    for (const qty of [0.05, 1, 20]) {
      const x = futuresExitPlan(direction, entry, qty, stop, .0005, .001);
      const net = direction === 'LONG' ? qty * (x.target * .999 - entry * 1.0005) : qty * (entry * .9995 - x.target * 1.001);
      assert.ok(net >= 1.5 * x.plannedLossUsd - 1e-6, `${direction} qty ${qty}`);
      // Distance to target stays within a few multiples of the stop distance at any size.
      assert.ok(Math.abs(x.target - entry) / Math.abs(entry - stop) < 4);
    }
  }
});
test('v6.9.37: small account gets a reachable target (was an 18% move at $30 equity)', () => {
  const p = planFuturesAutoTrade({ direction: 'LONG', entry: 2500, stop: 2487.5, equity: 29.94, available: 29.94,
    feeRate: .0005, qtyStep: .001, minQty: .001, minNotional: 20 });
  assert.ok(p.allowed); assert.ok(p.targetMovePct < 2, `target move ${p.targetMovePct}%`);
});
for (const direction of ['LONG', 'SHORT']) {
  test(`${direction}: v6.9.37 break-even waits for +1R (not 0.5R)`, async () => {
    const h = harness(); await h.ex.onSignal('ETHUSDT', signal(direction)); const initial = h.db().state.jobs[0].plan.stop;
    h.opt.price = direction === 'LONG' ? 100.5 : 99.5; await h.ex.run();
    assert.equal(h.db().state.jobs[0].plan.stop, initial);
  });
  test(`${direction}: v6.9.37 position older than the max hold window is closed`, async () => {
    const h = harness(); await h.ex.onSignal('ETHUSDT', signal(direction)); assert.equal(h.positions.size, 1);
    h.advance(4 * 3600000 + 5000); await h.ex.run(); await h.ex.run();
    assert.equal(h.positions.size, 0); assert.equal(h.db().state.jobs[0].closeReason, 'MAX_HOLD_TIME');
  });
}

for (const direction of ['LONG', 'SHORT']) {
  test(`${direction}: cost-dominated entry creates no intent or order and is not an infrastructure failure`, async () => {
    const h = harness();
    await h.ex.onSignal('ETHUSDT', { ...signal(direction), stop: direction === 'LONG' ? 99.9 : 100.1 });
    assert.equal(h.positions.size, 0);
    assert.equal(h.db().state.jobs.length, 0);
    assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
    assert.equal(h.ex.lastError, null);
    assert.match(h.ex.reason, /fees\/slippage/);
  });
}
