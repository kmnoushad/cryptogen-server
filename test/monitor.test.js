import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const now = Math.floor(Date.now() / 60_000) * 60_000;
const row = (open, price = 100, high = price + 0.05, low = price - 0.05) =>
  [open, price, high, low, price, 1000, open + 59_999, 100000, 10, 550, 55000];
const recent = Array.from({ length: 90 }, (_, i) => row(now - (90 - i) * 60_000));
const cfg = { exitSlippageBps: 3, takerFeeBps: 5, breakevenAtR: 0.75,
  tradeTimeoutMin: 120, fadeMinNetR: 0.1, universeRefreshMs: 0 };
const make = ({ price = 100, lastChecked = now - 120_001, setup = {} } = {}) => {
  let saved = { id: 'trade', symbol: 'TESTUSDT', status: 'OPEN', entry: 100,
    active_sl: 99.88, initial_sl: 99.88, tp1: 102, risk_per_unit: 0.12, fee_bps: 5,
    created_at: new Date(now - 180_000).toISOString(), entry_bar_close: now - 180_001,
    last_checked_bar_close: lastChecked, setup };
  const requests = [], messages = [];
  let failSend = false;
  const store = {
    listOpenTrades: async () => saved.status === 'OPEN' ? [{ ...saved }] : [],
    pendingTradeOutcomeAlerts: async () => saved.status === 'CLOSED' && !saved.exit_alert_sent ? [saved] : [],
    updateTrade: async (id, patch) => { saved = { ...saved, ...patch }; return { ...saved }; },
  };
  const engine = new Engine({ cfg, store,
    binance: { klines: async (symbol, interval, limit, options) => {
      requests.push({ limit, options });
      return options ? [row(now - 120_000, price), row(now - 60_000, price)] : recent;
    } },
    telegram: { send: async text => { if (failSend) throw Error('send down'); messages.push(text); },
      stopUpdateMessage: trade => `STOP ${trade.active_sl}`,
      outcomeMessage: trade => `EXIT ${trade.exit_reason}` },
  });
  let riskCalls = 0;
  engine.context = async () => { riskCalls++; return { risk: { hardBlock: false }, depth: { bestBid: price } }; };
  return { engine, store, messages, requests, saved: () => saved,
    riskCalls: () => riskCalls, failSend: value => { failSend = value; } };
};

test('normal monitoring requests a separate full risk history instead of only replay bars', async () => {
  const x = make();
  await x.engine.manageOpenTrades();
  assert.equal(x.riskCalls(), 1);
  assert.equal(x.requests[0].limit, 500);
  assert.equal(x.requests[1].limit, 90);
  assert.equal(x.requests[1].options, undefined);
});
test('live manipulation risk closes the position with present execution time', async () => {
  const x = make();
  x.engine.context = async () => ({ risk: { hardBlock: true }, depth: { bestBid: 99.9 } });
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().status, 'CLOSED');
  assert.equal(x.saved().exit_reason, 'MANIPULATION_EXIT');
  assert.ok(Date.parse(x.saved().closed_at) >= now);
  assert.equal(x.messages.length, 1);
});
test('a risk API failure does not undo breakeven progress or suppress its instruction', async () => {
  const x = make({ price: 100.2 });
  x.engine.context = async () => { throw Error('depth unavailable'); };
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().breakeven_armed, true);
  assert.equal(x.saved().setup.stopAlertPending, false);
  assert.equal(x.messages.length, 1);
  assert.match(x.messages[0], /^STOP /);
});
test('pending stop update retries on the next poll even without a new candle', async () => {
  const x = make({ price: 100.2 });
  x.failSend(true);
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().setup.stopAlertPending, true);
  x.failSend(false);
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().setup.stopAlertPending, false);
  assert.equal(x.messages.length, 1);
  await x.engine.manageOpenTrades();
  assert.equal(x.messages.length, 1);
});
test('a pending exit-notification query failure happens after active trades are evaluated', async () => {
  const x = make();
  x.store.pendingTradeOutcomeAlerts = async () => { throw Error('pending query down'); };
  await assert.rejects(x.engine.manageOpenTrades(), /pending query down/);
  assert.equal(x.riskCalls(), 1);
  assert.equal(x.engine.monitorRunning, false);
});
test('universe refresh failure cannot skip the position check', async () => {
  const x = make();
  x.engine.refreshUniverse = async () => { throw Error('universe down'); };
  await assert.rejects(x.engine.scanOnce(), /universe down/);
  assert.equal(x.riskCalls(), 1);
  assert.equal(x.engine.scanRunning, false);
});
test('monitor can run independently while scanning is busy or entries are paused', async () => {
  const x = make();
  x.engine.scanRunning = true;
  x.engine.paused = true;
  await x.engine.manageOpenTrades();
  assert.equal(x.riskCalls(), 1);
});
test('overlapping monitor polls cannot evaluate or notify twice', async () => {
  const x = make();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const original = x.store.listOpenTrades;
  x.store.listOpenTrades = async () => { await blocked; return original(); };
  const first = x.engine.manageOpenTrades();
  const second = await x.engine.manageOpenTrades();
  assert.equal(second.skipped, 'monitor already running');
  release();
  await first;
  assert.equal(x.riskCalls(), 1);
});
test('entry still being delivered is not monitored concurrently', async () => {
  const x = make();
  x.engine.pendingEntrySymbols.add('TESTUSDT');
  await x.engine.manageOpenTrades();
  assert.equal(x.requests.length, 0);
});
test('exit accounting persists even when its Telegram send fails, then retries', async () => {
  const x = make({ price: 98 });
  x.failSend(true);
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().status, 'CLOSED');
  assert.equal(x.saved().exit_alert_sent, false);
  x.failSend(false);
  await x.engine.manageOpenTrades();
  assert.equal(x.saved().exit_alert_sent, true);
  assert.equal(x.messages.length, 1);
});
