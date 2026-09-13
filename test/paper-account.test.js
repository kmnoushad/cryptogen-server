import test from 'node:test';
import assert from 'node:assert/strict';
import { paperAccount, sizePaperTrade, PAPER_TEST_ID, PAPER_EXECUTION_MODEL } from '../src/paper-account.js';
import { evaluateTrade, closeTradeAtMarket } from '../src/trade-evaluator.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { Telegram } from '../src/telegram.js';
import { Engine } from '../src/engine.js';

const time = Date.parse('2026-09-13T10:00:00Z');
const cfg = { paperMode: true, paper100Test: true, exitSlippageBps: 3, takerFeeBps: 5 };
const info = { filters: [
  { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '1000', stepSize: '0.001' },
  { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' },
  { filterType: 'MIN_NOTIONAL', notional: '5' },
  { filterType: 'PRICE_FILTER', tickSize: '0.001' },
] };
const empty = () => paperAccount([], new Date(time));
const make = (extra = {}) => sizePaperTrade({ id: 'test', symbol: 'ETHUSDT', status: 'OPEN',
  entry: 100, initial_sl: 99, active_sl: 99, risk_per_unit: 1, tp1: 102, tp2: 103,
  entry_bar_close: time - 1, created_at: new Date(time).toISOString(), setup: {}, ...extra }, empty(), info, cfg);
const bar = (i, values = {}) => ({ openTime: time + i * 60_000, closeTime: time + (i + 1) * 60_000 - 1,
  open: 100, high: 100.1, low: 99.9, close: 100, ...values });
const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-8, `${x} != ${y}`);
const merge = (t, result) => ({ ...t, ...result.patch });

test('$100 experiment is opt-in, immutable caps override old settings, and alert-only is rejected', () => {
  const env = { BOT_TOKEN: 'x', OWNER_CHAT_ID: '1', SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'x' };
  assert.equal(loadConfig(env).paper100Test, false);
  const config = loadConfig({ ...env, PAPER_100_TEST: 'true', MAX_TRADES_PER_DUBAI_DAY: '20', SCAN_CONCURRENCY: '9' });
  assert.equal(config.maxTradesPerDay, 5);
  assert.equal(config.scanConcurrency, 1);
  assert.equal(config.assumedOrderNotionalUsd, 200);
  assert.throws(() => loadConfig({ ...env, PAPER_100_TEST: 'true', PAPER_MODE: 'false' }), /requires PAPER_MODE/);
});

test('sizing respects planned $1 risk including actual-notional fees and exit slippage', () => {
  const t = make(), p = t.setup.paperTest;
  assert.ok(p.riskUsd <= 1 && p.riskUsd > 0.99);
  assert.ok(p.marginUsd - p.netUsd <= 100);
  const closed = merge(t, evaluateTrade(t, [bar(0, { low: 98.9 })], cfg));
  near(closed.setup.paperTest.netUsd, -p.riskUsd);
  near(closed.r_multiple, -1);
  assert.equal(closed.setup.exitExecutionModel, PAPER_EXECUTION_MODEL);
});

test('tight stops cap notional at available virtual 2x margin, not at desired risk', () => {
  const t = make({ initial_sl: 99.99, active_sl: 99.99, risk_per_unit: 0.01 });
  const p = t.setup.paperTest;
  assert.ok(p.notionalUsd < 200);
  assert.ok(p.riskUsd < 1);
  assert.ok(p.marginUsd - p.netUsd <= 100);
});

test('missing filters and too-small sizes fail closed; never round up to minimum size', () => {
  assert.throws(() => sizePaperTrade(make(), empty(), {}, cfg), /filters unavailable/);
  assert.throws(() => sizePaperTrade(make(), { balance: 0.1, riskBudget: 0.001 }, info, cfg), /below exchange minimum/);
  assert.throws(() => sizePaperTrade(make(), empty(), info, { ...cfg, paperMode: false }), /requires PAPER_MODE/);
});

test('a runner below conservative minimum size falls back to full profit-taking', () => {
  const t = sizePaperTrade(make(), empty(), { filters: info.filters.map(f =>
    f.filterType === 'MIN_NOTIONAL' ? { ...f, notional: '30' } : f) }, cfg);
  assert.equal(t.setup.paperTest.split, false);
  const result = evaluateTrade(t, [bar(0, { high: 104, close: 103 })], cfg);
  assert.equal(result.patch.exit_reason, 'PAPER_TAKE_ALL');
  assert.ok(result.patch.r_multiple >= 1.2);
});

test('stop precedes target in an ambiguous bar and gaps can exceed $1', () => {
  const t = make();
  const result = evaluateTrade(t, [bar(0, { open: 97, low: 96, high: 110, close: 109 })], cfg);
  assert.equal(result.patch.exit_reason, 'STOP');
  assert.equal(result.patch.setup.paperTest.partialDone, false);
  assert.ok(result.patch.setup.paperTest.netUsd < -1);
});

test('first partial entry candle ignores pre-entry extremes', () => {
  const t = make({ created_at: new Date(time + 10_000).toISOString() });
  const result = evaluateTrade(t, [bar(0, { low: 90, high: 110, close: 100 })], cfg);
  assert.equal(result.closed, false);
  assert.equal(result.patch.setup.paperTest.partialDone, false);
});

test('partial and new breakeven in the same candle conservatively close the runner', () => {
  const t = make();
  const result = evaluateTrade(t, [bar(0, { high: 103, close: 102 })], cfg);
  assert.equal(result.patch.exit_reason, 'RUNNER_STOP');
  const p = result.patch.setup.paperTest;
  assert.equal(p.partialDone, true);
  assert.equal(p.remainingQty, 0);
  assert.equal(p.ledger.length, 3);
  assert.ok(p.netUsd > 0);
  assert.ok(result.patch.mfe_pct > 1);
  near(p.ledger.reduce((s, e) => s + e.netUsd, 0), p.netUsd);
});

test('partial fill persists across restarts; replay neither charges nor closes twice', () => {
  const t = make(), target = t.setup.paperTest.takePrice;
  const firstBar = bar(0, { open: target - 0.1, low: target - 0.1, high: target + 0.1, close: target });
  const first = evaluateTrade(t, [firstBar], cfg);
  assert.equal(first.closed, false);
  const saved = merge(t, first), p = saved.setup.paperTest;
  assert.equal(p.partialDone, true);
  assert.equal(p.partialAlertPending, true);
  assert.equal(p.ledger.length, 2);
  assert.equal(evaluateTrade(saved, [firstBar], cfg).patch, null);
  const final = merge(saved, closeTradeAtMarket(saved, target + 1, time + 120_000, 'MANIPULATION_EXIT', cfg));
  assert.equal(final.setup.paperTest.ledger.length, 3);
  assert.equal(final.setup.paperTest.remainingQty, 0);
  assert.equal(t.setup.paperTest.ledger.length, 1, 'source state never mutated');
  near(final.setup.paperTest.netUsd, final.setup.paperTest.ledger.reduce((s, e) => s + e.netUsd, 0));
  near(final.net_pnl_pct, final.setup.paperTest.netUsd / p.notionalUsd * 100);
});

test('trailing stop becomes active only next bar; a gap applies only to remaining quantity', () => {
  const t = make(), target = t.setup.paperTest.takePrice;
  const saved = merge(t, evaluateTrade(t, [bar(0, { open: target, low: target - 0.1, high: target, close: target })], cfg));
  assert.equal(saved.status, 'OPEN');
  assert.ok(saved.active_sl < target);
  const result = evaluateTrade(saved, [bar(1, { open: 98, high: 98.1, low: 97, close: 97.5 })], cfg);
  const p = saved.setup.paperTest;
  near(result.patch.setup.paperTest.netUsd,
    p.netUsd + p.remainingQty * (98 * (1 - p.slip) - 100) - p.remainingQty * 98 * (1 - p.slip) * p.fee);
});

test('timeout and momentum fade close remaining quantity after costs', () => {
  const t = make();
  assert.equal(evaluateTrade(t, [bar(120)], cfg).patch.exit_reason, 'TIMEOUT');
  const target = t.setup.paperTest.takePrice;
  const saved = merge(t, evaluateTrade(t, [bar(0, { open: target, low: target - 0.1, high: target, close: target })], cfg));
  const result = evaluateTrade(saved, [bar(1, { open: target, low: target, high: target + 2, close: target + 0.5 })], cfg);
  assert.equal(result.patch.exit_reason, 'MOMENTUM_FADE');
  assert.equal(result.patch.setup.paperTest.remainingQty, 0);
});

test('account excludes old/cancelled trades and carries entry fees and partials while open', () => {
  const t = make();
  const p = t.setup.paperTest;
  const s = paperAccount([t, { ...t, status: 'CANCELLED' }, { status: 'CLOSED', setup: {}, net_pnl_pct: -90 }], new Date(time + 60_000));
  near(s.balance, 100 + p.netUsd);
  near(s.daily, p.netUsd);
  assert.equal(s.open, 1);
  assert.equal(s.total, 0);
  assert.equal(s.winRate, null);
  const final = merge(t, closeTradeAtMarket(t, 102, time + 120_000, 'TIMEOUT', cfg));
  const after = paperAccount([final], new Date(time + 180_000));
  near(after.balance, 100 + final.setup.paperTest.netUsd);
  assert.equal(after.total, 1);
  assert.equal(after.winRate, 100);
});

const lossRow = (i, net = -1) => ({ id: String(i), status: 'CLOSED', created_at: new Date(time + i).toISOString(),
  closed_at: new Date(time + i + 1).toISOString(), r_multiple: net,
  setup: { paperTest: { id: PAPER_TEST_ID, netUsd: net, ledger: [{ time: time + i, netUsd: net }] } } });

test('daily loss, consecutive losses, trade cap and weekly loss are based on dollars', () => {
  const three = paperAccount([0, 1, 2].map(i => lossRow(i)), new Date(time + 100));
  assert.equal(three.balance, 97);
  assert.equal(three.riskBudget, 0);
  assert.ok(three.reasons.some(r => r.includes('daily loss')));
  assert.ok(three.reasons.some(r => r.includes('consecutive')));
  const five = paperAccount([0, 1, 2, 3, 4].map(i => lossRow(i, 1)), new Date(time + 100));
  assert.ok(five.reasons.some(r => r.includes('trade cap')));
  const nextDay = paperAccount([lossRow(0, -7)], new Date(time + 86_400_000));
  assert.equal(nextDay.daily, 0);
  assert.ok(nextDay.reasons.some(r => r.includes('7-day')));
  const eightDays = paperAccount([lossRow(0, -7)], new Date(time + 8 * 86_400_000));
  assert.equal(eightDays.weekly, 0);
  assert.equal(eightDays.balance, 93, 'elapsed time must not reset the account');
});

test('risk budgets shrink with equity and remaining daily/weekly allowance', () => {
  const s = paperAccount([lossRow(0, -2.8)], new Date(time + 100));
  near(s.riskBudget, 0.2);
  assert.equal(paperAccount([lossRow(0, -101)], new Date(time + 100)).riskBudget, 0);
  assert.throws(() => paperAccount([{ ...lossRow(0), setup: { paperTest: { id: PAPER_TEST_ID } } }]), /ledger/);
});

test('store pages the whole cohort, filters on the server and respects any older open trade', async () => {
  const store = new Store({ supabaseUrl: 'https://example.test', supabaseKey: 'test' });
  const requests = [];
  store.get = async (table, params) => {
    requests.push(Object.fromEntries(params));
    return params.some(([k, v]) => k === 'offset' && v === '0') ? Array.from({ length: 500 }, (_, i) => lossRow(i, 0)) : [];
  };
  assert.equal((await store.paperTestAccount(new Date(time + 1000))).total, 500);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]['setup->paperTest->>id'], `eq.${PAPER_TEST_ID}`);
  store.listOpenTrades = async () => [{ id: 'legacy' }];
  const risk = await store.riskSnapshot(cfg, new Date(time + 1000));
  assert.equal(risk.allowed, false);
  assert.ok(risk.reasons.some(r => r.includes('older open')));
});

test('paper messages are simulation-only, report dollars and avoid manual entry instructions', () => {
  const telegram = new Telegram(cfg), t = make();
  assert.match(telegram.signalMessage(t, {}), /do not enter manually/);
  assert.doesNotMatch(telegram.signalMessage(t, {}), /Close 100% at TP1/);
  assert.match(telegram.paperPartialMessage(t), /Simulation only/);
  const final = merge(t, closeTradeAtMarket(t, 102, time + 60_000, 'TIMEOUT', cfg));
  assert.match(telegram.outcomeMessage(final), /Net result: \$/);
});

test('/stats routes the enabled experiment to its own ledger; /statsnew works when disabled', async () => {
  const messages = [];
  const engine = new Engine({ cfg: { ...cfg, ownerChatId: '1' }, binance: {},
    store: { paperTestAccount: async () => empty(), statistics: () => { throw Error('old history'); } },
    telegram: { send: async t => messages.push(t) } });
  await engine.command({ chat: { id: 1 }, text: '/stats' });
  assert.match(messages[0], /Win rate: N\/A/);
  assert.match(messages[0], /Closed: 0/);
  engine.cfg = { ownerChatId: '1' };
  await engine.command({ chat: { id: 1 }, text: '/statsnew' });
  assert.match(messages[1], /disabled; history retained/);
});

test('engine restart retries partial notice without duplicating partial accounting or losing setup', async () => {
  const start = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
  let saved = make({ created_at: new Date(start).toISOString(), entry_bar_close: start - 1 });
  const target = saved.setup.paperTest.takePrice;
  const row = [start, target, target + 0.1, target - 0.1, target, 1000, start + 59_999, 100000, 10, 550, 55000];
  const store = {
    listOpenTrades: async () => [structuredClone(saved)],
    updateTrade: async (id, patch) => { saved = { ...saved, ...patch }; return structuredClone(saved); },
    pendingTradeOutcomeAlerts: async () => [],
  };
  const messages = [];
  let fail = true;
  const telegram = new Telegram(cfg);
  telegram.send = async text => { if (fail) throw Error('offline'); messages.push(text); };
  const createEngine = () => new Engine({ cfg, store, telegram,
    binance: { klines: async (symbol, interval, limit, options) => options ? [row] : [] } });
  await createEngine().manageOpenTrades();
  assert.equal(saved.setup.paperTest.partialAlertPending, true);
  assert.equal(saved.setup.paperTest.ledger.length, 2);
  assert.equal(saved.setup.stopAlertPending, undefined);
  fail = false;
  const restarted = createEngine();
  await restarted.manageOpenTrades();
  assert.equal(saved.setup.paperTest.partialAlertPending, false);
  assert.equal(saved.setup.paperTest.ledger.length, 2);
  assert.equal(messages.length, 1);
  await restarted.manageOpenTrades();
  assert.equal(messages.length, 1);
});

test('legacy /stats excludes the new cohort in its server query', async () => {
  const store = new Store({ supabaseUrl: 'https://example.test', supabaseKey: 'test' });
  let query;
  store.get = async (table, params) => { query = Object.fromEntries(params); return []; };
  await store.statistics();
  assert.match(query.or, /paper100-runner-v1/);
  assert.match(query.or, /is.null/);
});
