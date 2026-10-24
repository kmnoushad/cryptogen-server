import test from 'node:test';
import assert from 'node:assert/strict';
import { FuturesAutoExecutor, futuresExitPlan, FuturesAutoExchange } from '../src/futures-auto-executor.js';
import { planFuturesAutoTrade } from '../src/futures-auto-policy.js';
import { loadFuturesAutoConfig } from '../src/futures-auto-config.js';
import { legacyDirectionalSignal as directionalSignal, closedSeries, selectFuturesUniverse } from '../src/futures-auto-strategy.js';
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
      const qty = Number(params.quantity), market = params.type === 'MARKET' || params.timeInForce === 'FOK';
      const o = { ...params, clientOrderId: params.newClientOrderId, origQty: String(qty), executedQty: market ? String(qty) : '0',
        avgPrice: String(opt.fill ?? (params.side === 'BUY' ? 100.01 : 100)), status: market ? 'FILLED' : 'NEW' };
      orders.set(o.clientOrderId, o);
      if (market && !params.reduceOnly) { positions.set(params.symbol, qty * (params.side === 'BUY' ? 1 : -1)); if (opt.saveAfterFill) opt.saveFails = true; }
      if (market && params.reduceOnly) { assert.equal(params.side, positions.get(params.symbol) > 0 ? 'SELL' : 'BUY'); positions.delete(params.symbol); }
      if (opt.unknownAfter && !params.reduceOnly) throw Error('response lost after accepted fill');
      return clone(o);
    },
    placeDirectionalStop: async (symbol, id, price, side, quantity) => {
      calls.push(['stop', side, price]); if (opt.stopFails) throw new ExchangeError(400, -2021);
      if (quantity == null && [...algos.values()].some(o => o.symbol===symbol && o.side===side && o.algoStatus==='NEW' && o.closePosition)) throw new ExchangeError(400,-4130);
      const o = { symbol, clientAlgoId: id, algoStatus: 'NEW', side, orderType: 'STOP_MARKET', ...(quantity == null ? {closePosition:true} : {closePosition:false,reduceOnly:true,quantity:String(quantity)}), triggerPrice: String(price) };
      algos.set(id, o); return clone(o);
    },
    cancel: async (symbol, id) => { orders.get(id).status = 'CANCELED'; calls.push(['cancel', id]); },
    cancelStop: async id => { algos.get(id).algoStatus = 'CANCELED'; },
  };
  const make = () => new FuturesAutoExecutor({ cfg, store, exchange, now: () => clock, wait: async () => {}, telegram: { send: async () => {} }, eventGate: { check: async () => ({ allowed: true }) } });
  return { ex: make(), make, calls, orders, algos, positions, exchange, cfg, opt, db: () => clone(db), release: () => { owner = null; }, advance: ms => { clock += ms; } };
}
const signal = direction => ({ allowed: true, symbol: 'ETHUSDT', direction, entry: 100, stop: direction === 'LONG' ? 99.5 : 100.5, barCloseTime: now - 1000, breakoutTime: now - 300000,
  marketQuality: { checkedAt: now, quoteVolume: 50_000_000, trades: 10_000, listingAgeDays: 90, changePct: 2, longAllowed: true } });
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
test('live executor fails closed without a fresh broad-universe quality proof', async () => {
  const h = harness();
  await h.ex.onSignal('ETHUSDT', { ...signal('LONG'), marketQuality: undefined });
  assert.equal(h.positions.size, 0);
  assert.equal(h.calls.filter(x => x[0] === 'place').length, 0);
  assert.match(h.ex.reason, /quality check/);
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
  const input = { symbol: 'ETHUSDT', m1, m15, h1, btc15: m15, btc1h: h1, now,
    marketQuality: { checkedAt: now, longAllowed: true } };
  assert.equal(directionalSignal(input).direction, 'LONG');
  assert.equal(directionalSignal({ ...input, marketQuality: undefined }).direction, 'LONG', 'research-only replay can omit live market-quality metadata');
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
test('dynamic universe includes broad eligible contracts and keeps the long quality gate separate', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const symbols = Array.from({ length: 260 }, (_,i) => ({ symbol: `COIN${i}USDT`, baseAsset: `COIN${i}`,
    status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT', onboardDate: now-60*86400000 }));
  const tickers = symbols.map((s,i) => ({ symbol:s.symbol, quoteVolume:String(10_000_000+i*1000), count:'5000',
    lastPrice:'1', priceChangePercent: i===259 ? '80' : '-2' }));
  const u = selectFuturesUniverse({ exchangeInfo:{symbols}, tickers, now, maxSymbols:120 });
  assert.equal(u.eligible.length,260); assert.equal(u.symbols.length,120);
  assert.ok(u.symbols.includes('COIN259USDT')); // high mover is prioritized for short review
  assert.equal(u.quality.get('COIN259USDT').longAllowed,false); // extension cannot qualify for a long
  const bad = selectFuturesUniverse({ exchangeInfo:{symbols}, tickers:[], now });
  assert.equal(bad.symbols.length,0); assert.match(bad.reason,/No contracts/);
});
test('long market-quality gate rejects stale or unqualified market snapshots', () => {
  const m15=candleRows(900000),h1=candleRows(3600000),m1=candleRows(60000,()=>96.01);
  m15.at(-1)[4]=96.03;m15.at(-1)[2]=96.06;m15.at(-1)[5]=150;
  m1.at(-2)[1]=95.99;m1.at(-2)[2]=96;m1.at(-2)[3]=95.98;m1.at(-2)[4]=95.99;
  m1.at(-1)[1]=96;m1.at(-1)[2]=96.05;m1.at(-1)[3]=96;m1.at(-1)[4]=96.025;
  const input={symbol:'ETHUSDT',m1,m15,h1,btc15:m15,btc1h:h1,now,marketQuality:{checkedAt:now,longAllowed:false,reason:'Long quality filter'}};
  assert.equal(directionalSignal(input).allowed,false); assert.match(directionalSignal(input).reason,/Long quality/);
  assert.equal(directionalSignal({...input,marketQuality:{...input.marketQuality,longAllowed:true,checkedAt:now-100000}}).allowed,false);
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

test('rejected execution checks retain their final reason in symbol status',async()=>{
  const h=harness();h.exchange.funding=async symbol=>({symbol,lastFundingRate:'.001',time:now,nextFundingTime:now+3600000});
  await h.ex.onSignal('ETHUSDT',signal('SHORT'));
  assert.equal(h.positions.size,0);
  assert.match(h.ex.scanReasons.ETHUSDT,/Extreme funding; crowding risk/);
  assert.equal(h.ex.lastEntryAttempt.reason,h.ex.reason);
  assert.match(h.ex.status(),/Last execution check: ETHUSDT/);
});

test('protection failure records timestamp code and reason for later audit',async()=>{
 const h=harness();h.exchange.placeDirectionalStop=async()=>{throw new ExchangeError(400,-1021);};
 await h.ex.onSignal('ETHUSDT',signal('LONG'));
 const job=h.db().state.jobs[0];assert.equal(job.closeReason,'PROTECTION_FAILURE');
 assert.equal(job.protectionFailure.code,-1021);assert.equal(job.protectionFailure.status,400);
 assert.match(job.protectionFailure.reason,/-1021/);assert.equal(h.positions.size,0);
});


test('local request-budget refusal retires a known-unsent Futures entry without order lookup', async()=>{
 const h=harness();let lookups=0;
 h.exchange.place=async()=>{const e=Error('shared budget');e.requestSent=false;e.status=429;e.code=-1003;throw e;};
 h.exchange.order=async()=>{lookups++;throw Error('must not query an unsent order');};
 await h.ex.onSignal('ETHUSDT',signal('LONG'));
 assert.equal(h.db().state.jobs[0].phase,'CLOSED');assert.equal(h.db().state.jobs[0].closeReason,'REQUEST_NOT_SENT');assert.equal(lookups,0);assert.equal(h.positions.size,0);
});
test('request-budget refusal during Futures monitoring retains its previously confirmed native stop', async()=>{
 const h=harness();await h.ex.onSignal('ETHUSDT',signal('SHORT'));const job=h.db().state.jobs[0];
 assert.ok(job.stopId);const stop=h.algos.get(job.stopId);assert.equal(stop.algoStatus,'NEW');
 h.exchange.book=async()=>{const e=Error('shared budget');e.requestSent=false;e.status=429;e.code=-1003;throw e;};
 const exits=h.calls.filter(x=>x[0]==='place'&&x[1].reduceOnly&&x[1].type==='MARKET').length;
 await h.ex.run();assert.match(h.ex.lastError,/monitoring deferred/);assert.equal(h.positions.size,1);assert.equal(h.algos.get(job.stopId).algoStatus,'NEW');
 assert.equal(h.calls.filter(x=>x[0]==='place'&&x[1].reduceOnly&&x[1].type==='MARKET').length,exits);
});

for(const direction of ['LONG','SHORT']) {
 test(`${direction}: replacement rejection retains verified prior stop and later repairs without a market exit`,async()=>{
  const h=harness();await h.ex.onSignal('ETHUSDT',signal(direction));const original=h.db().state.jobs[0].stopId;
  const place=h.exchange.placeDirectionalStop;let reject=true;
  h.exchange.placeDirectionalStop=async(...args)=>{if(args[4]!=null && reject)throw new ExchangeError(400,-2022);return place(...args);};
  h.opt.price=direction==='LONG'?101:99;await h.ex.run();
  assert.equal(h.positions.size,1);assert.equal(h.algos.get(original).algoStatus,'NEW');assert.match(h.ex.lastError,/verified native stop retained/);
  reject=false;h.advance(5001);h.release();const restarted=h.make();await restarted.run();
  assert.equal(restarted.lastError,null);const job=h.db().state.jobs[0];assert.equal(h.algos.get(job.stopId).reduceOnly,true);
  assert.equal(h.algos.get(original).algoStatus,'CANCELED');assert.equal(h.positions.size,1);
 });
 test(`${direction}: lost replacement response is lookup-only after restart`,async()=>{
  const h=harness();await h.ex.onSignal('ETHUSDT',signal(direction));const place=h.exchange.placeDirectionalStop;let posts=0;
  h.exchange.placeDirectionalStop=async(...args)=>{const result=await place(...args);if(args[4]!=null){posts++;throw Error('lost acknowledgement');}return result;};
  h.opt.price=direction==='LONG'?101:99;await h.ex.run();assert.equal(posts,1);
  h.release();const restarted=h.make();await restarted.run();assert.equal(posts,1);assert.equal(restarted.lastError,null);
 });
}

for (const direction of ['LONG','SHORT']) {
 test(`structure ${direction}: FOK inside gap, half-R protection, restart retains stop`, async () => {
  const h=harness();h.cfg.structureStrategy=true;
  const s={...signal(direction),strategy:'sweep-mss-fvg-v1',sweepTime:now-300000,fvg:{low:99.95,high:100.05}};
  await h.ex.onSignal('ETHUSDT',s);assert.equal(h.ex.lastError,null);
  const job=h.db().state.jobs[0];assert.equal(job.policyVersion,s.strategy);assert.equal(job.reentryAttempt,0);
  const entry=h.calls.find(c=>c[0]==='place' && !c[1].reduceOnly)[1];
  assert.equal(entry.timeInForce,'FOK');assert.ok(Number(entry.price)>=s.fvg.low && Number(entry.price)<=s.fvg.high);
  const p=job.plan, fee=job.fee, profit=.6*p.plannedLossUsd/p.qty;
  h.opt.price=direction==='LONG'?(p.entry*(1+fee)+profit)/(1-fee-.0005)
   :(p.entry*(1-fee)-profit)/(1+fee+.0005)-.01;
  await h.ex.run();assert.equal(h.ex.lastError,null);
  const protectedJob=h.db().state.jobs[0];assert.equal(protectedJob.plan.stop,protectedJob.plan.breakEven);
  h.release();const resumed=h.make();await resumed.run();assert.equal(resumed.lastError,null);
  assert.equal(h.db().state.jobs[0].plan.stop,protectedJob.plan.stop);
 });
}
test('structure execution rejects missing proof and price outside FVG',async()=>{
 for(const extra of [{},{strategy:'sweep-mss-fvg-v1',fvg:{low:98,high:99}}]) {
 const h=harness();h.cfg.structureStrategy=true;await h.ex.onSignal('ETHUSDT',{...signal('LONG'),...extra});
 assert.equal(h.calls.filter(c=>c[0]==='place').length,0);
 }
});
test('structure stop-out permits one fresh reduced-risk entry; duplicate remains blocked',async()=>{
 const h=harness();h.cfg.structureStrategy=true;
 const s={...signal('LONG'),strategy:'sweep-mss-fvg-v1',sweepTime:now-300000,fvg:{low:99.95,high:100.05}};
 await h.ex.onSignal('ETHUSDT',s);assert.equal(h.ex.lastError,null);
 const first=h.db().state.jobs[0];h.opt.price=99.4;
 await h.ex.run();await h.ex.run();
 assert.equal(h.db().state.jobs[0].structuralStopExit,true);
 h.opt.income=[{symbol:'ETHUSDT',asset:'USDT',incomeType:'REALIZED_PNL',income:'-.3',time:now},
 {symbol:'ETHUSDT',asset:'USDT',incomeType:'COMMISSION',income:'-.05',time:now}];
 h.advance(180000);h.opt.price=100;
 const next={...s,sweepTime:now+120000,breakoutTime:now+120000,barCloseTime:now+179000,
  marketQuality:{...s.marketQuality,checkedAt:now+180000}};
 await h.ex.onSignal('ETHUSDT',next);assert.equal(h.ex.lastError,null);
 assert.equal(h.db().state.jobs.length,2,h.ex.reason);
 const second=h.db().state.jobs[1];assert.equal(second.reentryAttempt,1);
 assert.ok(second.riskBudget<=first.campaignRiskBudget*.5);assert.ok(second.filledQty<first.filledQty);
 await h.ex.onSignal('ETHUSDT',next);assert.equal(h.db().state.jobs.length,2);
});

function momentumHarness(opt={}) {
 const h=harness(opt);h.cfg.momentumStrategy=true;
 h.exchange.depth=async()=>({asks:[['100.01','1000']],bids:[['100','1000']]});
 h.exchange.candles=async()=>candleRows(300000,()=>100);
 return h;
}
const momentumProof=direction=>({...signal(direction),strategy:'momentum-live-v1',kind:'BASE_BREAKOUT',atr5:.1,entryMin:99.95,entryMax:100.05,pullbackStart:now-240000,marketQuality:{...signal(direction).marketQuality,changePct:59}});
for(const direction of ['LONG','SHORT'])test(`momentum live ${direction}: FOK, native stop, no TP, restart and volatility tightening`,async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof(direction));
 assert.equal(h.ex.lastError,null);assert.equal(h.positions.size,1,h.ex.reason);
 const entry=h.calls.find(x=>x[0]==='place')[1];assert.equal(entry.timeInForce,'FOK');
 assert.equal(h.calls.filter(x=>x[0]==='place'&&x[1].reduceOnly).length,0);
 assert.equal((await h.exchange.algos()).length,1);
 const initial=h.db().state.jobs[0].plan.stop;
 assert.equal(initial,h.db().state.jobs[0].structuralStop,'no immediate ATR tightening on entry');
 assert.notEqual(h.db().state.jobs[0].momentumTrailArmed,true);
 h.release();const restarted=h.make();await restarted.run();assert.equal(restarted.lastError,null);
 assert.equal(h.db().state.jobs[0].plan.stop,initial,'restart before 1R retains structural stop');
 assert.equal(h.calls.filter(x=>x[0]==='place').length,1);
 h.opt.price=direction==='LONG'?101:99;await restarted.run();assert.equal(restarted.lastError,null);
 const stop=h.db().state.jobs[0].plan.stop;assert.ok(direction==='LONG'?stop>initial:stop<initial);
 assert.equal(h.db().state.jobs[0].momentumTrailArmed,true,'arming is durably saved');
 assert.equal((await h.exchange.algos()).length,1);
});
test('momentum live missing or shallow depth prevents order submission',async()=>{
 for(const depth of [{asks:[],bids:[]},{asks:[['bad','10']],bids:[]}]){
  const h=momentumHarness();h.exchange.depth=async()=>depth;await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
  assert.equal(h.positions.size,0);assert.equal(h.calls.filter(x=>x[0]==='place').length,0);
 }
});
test('momentum live candle outage retains verified native stop and withholds new entries',async()=>{
 const h=momentumHarness();h.exchange.candles=async()=>{throw Error('candle service offline');};
 await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 assert.equal(h.positions.size,1);assert.match(h.ex.lastError,/native stop retained/);
 assert.equal((await h.exchange.algos()).length,1);assert.equal(h.calls.filter(x=>x[0]==='place').length,1);
});
test('momentum live rejected native stop closes verified fill',async()=>{
 const h=momentumHarness({stopFails:true});await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 assert.equal(h.positions.size,0);assert.match(h.ex.lastError,/protection issue/);
});
test('momentum live missing outcome evidence prevents re-entry',async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 await h.ex.control('close');await h.ex.run();const job=h.ex.row.state.jobs[0];
 await h.ex.verifyMomentumOutcome(job);assert.notEqual(job.momentumExitVerified,true);
});
test('momentum native exit requires matching underlying fill and net income before re-arming',async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 let job=h.ex.row.state.jobs[0];const stop=h.algos.get(job.stopId);stop.algoStatus='FINISHED';stop.actualOrderId='12345';h.positions.clear();
 h.advance(1000);await h.ex.run();job=h.ex.row.state.jobs[0];assert.equal(job.phase,'CLOSED');
 h.exchange.request=async()=>({orderId:12345,symbol:'ETHUSDT',side:'SELL',status:'FILLED',reduceOnly:true,executedQty:String(job.filledQty)});
 await h.ex.verifyMomentumOutcome(job);assert.notEqual(job.momentumExitVerified,true,'missing income');
 h.opt.income=[{symbol:'ETHUSDT',asset:'USDT',incomeType:'REALIZED_PNL',income:'.8',time:now+1000},{symbol:'ETHUSDT',asset:'USDT',incomeType:'COMMISSION',income:'-.1',time:now+1000}];
 await h.ex.verifyMomentumOutcome(job);assert.equal(job.momentumExitVerified,true);assert.ok(Math.abs(job.verifiedNet-.7)<1e-9);
 h.release();const restarted=h.make();await restarted.run();assert.equal(restarted.row.state.jobs[0].momentumExitVerified,true);
});
test('momentum stale timestamped depth is rejected before creating an intent',async()=>{
 const h=momentumHarness();h.exchange.depth=async()=>({T:now-5000,asks:[['100.01','1000']]});await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 assert.equal(h.db().state.jobs.length,0);assert.match(h.ex.reason,/depth unavailable/);
});
for(const direction of ['LONG','SHORT'])test(`momentum ${direction}: verified FOK zero fill re-arms fresh signals, never resends an intent`,async()=>{
 const h=momentumHarness();const place=h.exchange.place;
 h.exchange.place=async p=>{
  if(!p.reduceOnly){const o={...p,clientOrderId:p.newClientOrderId,origQty:p.quantity,executedQty:'0',avgPrice:'0',status:'EXPIRED'};h.orders.set(o.clientOrderId,o);return o;}
  return place(p);
 };
 const s=momentumProof(direction);await h.ex.onSignal('ETHUSDT',s);
 let j=h.db().state.jobs[0];assert.equal(j.noFillVerified,true);assert.equal(j.phase,'CLOSED');assert.equal(j.filledQty,0);
 h.exchange.place=place;h.advance(60000);
 const next={...s,breakoutTime:now+59000,barCloseTime:now+59000,pullbackStart:now+1000,marketQuality:{...s.marketQuality,checkedAt:now+60000}};
 await h.ex.onSignal('ETHUSDT',next);assert.equal(h.positions.size,1,h.ex.reason);
 j=h.db().state.jobs[1];assert.equal(j.reentryAttempt,0);
 const count=h.db().state.jobs.length;await h.ex.onSignal('ETHUSDT',next);assert.equal(h.db().state.jobs.length,count);
});
for(const reason of ['MAX_HOLD_TIME','OWNER_CLOSE'])test(`momentum ${reason}: owned full exit verifies automatically after delayed income`,async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 const j=h.ex.row.state.jobs[0];await h.ex.close(j,reason);h.advance(1000);await h.ex.run();
 let closed=h.ex.row.state.jobs[0];assert.equal(closed.phase,'CLOSED');assert.notEqual(closed.momentumExitVerified,true);
 // A canceled stop disappearing from lookup must not mask the owned x order.
 h.algos.clear();h.opt.income=[{symbol:'ETHUSDT',asset:'USDT',incomeType:'REALIZED_PNL',income:'.8',time:now+1000},{symbol:'ETHUSDT',asset:'USDT',incomeType:'COMMISSION',income:'-.1',time:now+1000}];
 h.advance(31000);h.release();const restarted=h.make();await restarted.run();
 closed=restarted.row.state.jobs[0];assert.equal(closed.momentumExitVerified,true);assert.ok(Math.abs(closed.verifiedNet-.7)<1e-9);
});
test('momentum protection checks run once per pass; partial or unowned changes still flatten',async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof('LONG'));
 let checks=0;const ensure=h.ex.ensureStop.bind(h.ex);h.ex.ensureStop=async(...a)=>{checks++;return ensure(...a);};
 await h.ex.run();assert.equal(h.ex.lastError,null);assert.equal(checks,1);
 h.positions.set('ETHUSDT',h.positions.get('ETHUSDT')/2);await h.ex.run();
 assert.equal(h.positions.size,0);assert.match(h.ex.lastError,/protection issue/);
});
for(const direction of ['LONG','SHORT'])test(`momentum ${direction}: nine-hour outage closes by max hold without candle replay`,async()=>{
 const h=momentumHarness();await h.ex.onSignal('ETHUSDT',momentumProof(direction));
 h.advance(9*3600000);h.exchange.candles=async()=>{throw Error('history gap');};h.release();const restarted=h.make();await restarted.run();
 assert.equal(h.positions.size,0);await restarted.run();assert.equal(restarted.row.state.jobs[0].phase,'CLOSED');assert.equal(restarted.row.state.jobs[0].closeReason,'MAX_HOLD_TIME');
});
