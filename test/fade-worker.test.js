import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FadeWorkerLoop } from '../src/fade-worker-loop.js';
import { FadeRemote } from '../src/fade-remote.js';
import { loadFadeConfig } from '../src/fade-config.js';
import { loadConfig } from '../src/config.js';

const now = Date.parse('2026-09-19T12:00:00Z');
const event = (key = 'one', patch = {}) => ({ event_key: key, symbol: 'AAAUSDT',
  event_type: 'FADE_WORKER_SIGNAL_V1', created_at: new Date(now).toISOString(),
  payload: { model: 'pump-fade-v1', price: 100, resistance: 102, peakTime: now - 300000, barCloseTime: now - 1000 }, ...patch });
function harness() {
  const calls = [], reports = [];
  let clock = now;
  const store = { control: { paused: true, close_requested: false }, events: [],
    fadeControl: async () => structuredClone(store.control), fadeSignals: async () => store.events,
    fadeHeartbeat: async (scope, report) => reports.push(report) };
  const executor = { scope: 'testnet:primary', row: { state: { paused: false } },
    enabled: () => true, run: async () => calls.push('monitor'), status: () => 'status', stop: () => {},
    control: async action => { calls.push(action); executor.row.state.paused = action !== 'resume'; },
    onSignal: async symbol => { if (!executor.isPaused() && await executor.authorizeEntry()) calls.push(symbol); } };
  const worker = new FadeWorkerLoop({ executor, store, now: () => clock });
  return { calls, reports, store, executor, worker, advance: ms => { clock += ms; } };
}
test('only fresh delivered fade events enter; repeats, old history and other signals do not', async () => {
  const h = harness(); h.store.control.paused = false;
  h.store.events = [event(), event('old', { created_at: new Date(now - 1).toISOString() }),
    event('wrong', { event_type: 'FUTURES_PUMP_FADE_WARNING' }),
    event('stale', { payload: { ...event().payload, barCloseTime: now - 91000 } })];
  await h.worker.tick(); await h.worker.tick();
  assert.equal(h.calls.filter(x => x === 'AAAUSDT').length, 1);
  h.advance(2000);
  const restarted = new FadeWorkerLoop({ executor: h.executor, store: h.store, now: () => now + 2000 });
  await restarted.tick(); assert.equal(h.calls.filter(x => x === 'AAAUSDT').length, 1);
});
test('pause drops signals, resume takes only new events, close remains persistent', async () => {
  const h = harness(); h.store.events = [event()];
  await h.worker.tick(); assert.ok(h.calls.includes('pause')); assert.ok(!h.calls.includes('AAAUSDT'));
  h.store.control.paused = false; await h.worker.tick(); assert.ok(h.calls.includes('resume'));
  assert.ok(!h.calls.includes('AAAUSDT'));
  h.store.events.push(event('two')); await h.worker.tick(); assert.ok(h.calls.includes('AAAUSDT'));
  h.store.control = { paused: true, close_requested: true };
  await h.worker.tick(); await h.worker.tick(); assert.equal(h.calls.filter(x => x === 'close').length, 2);
});
test('failed control reads block entries but do not suppress protection attempts', async () => {
  const h = harness(); h.store.events = [event()];
  h.store.fadeControl = async () => { throw Error('offline'); };
  await h.worker.tick(); await h.worker.tick();
  assert.deepEqual(h.calls, ['monitor', 'monitor']); assert.equal(h.executor.isPaused(), true);
  assert.match(h.reports.at(-1), /unavailable/);
});
test('worker never overlaps polls and stopped worker does not enter', async () => {
  const h = harness(); let release;
  h.executor.run = () => new Promise(resolve => { release = resolve; });
  const pending = h.worker.tick(); await h.worker.tick();
  assert.equal(h.worker.busy, true); h.worker.stop(); release(); await pending;
  assert.ok(!h.calls.includes('AAAUSDT'));
});
test('remote failure is visible and stale status never claims successful closure', async () => {
  const cfg = { fadeEnvironment: 'live' };
  const remote = new FadeRemote({ cfg, store: { fadeControl: async () => ({ paused: true }),
    get: async () => [{ updated_at: '2020-01-01', report: '0 active' }],
    fadeSetControl: async () => { throw Error('offline'); } } });
  assert.match(await remote.status(), /OFFLINE \/ STALE/);
  assert.match(await remote.control('close'), /failed; no confirmation/);
  cfg.fadeEnvironment = 'bad'; assert.match(await remote.status(), /unavailable/);
});
test('remote balance returns only a fresh sanitized worker balance section', async () => {
  const report = 'FADE AUTO — LIVE\n💰 FADE BALANCE\nWallet $98.50 · Open PnL +$0.75 · Equity $99.25\nAvailable $70.00\n\nLast reconciliation: now';
  const store = { get: async () => [{ updated_at: new Date().toISOString(), report }] };
  const remote = new FadeRemote({ cfg: { fadeEnvironment: 'live' }, store });
  const balance = await remote.balance();
  assert.match(balance, /FADE BALANCE/); assert.match(balance, /Equity \$99\.25/);
  assert.doesNotMatch(balance, /Last reconciliation/);
  store.get = async () => [{ updated_at: '2020-01-01', report }];
  assert.match(await remote.balance(), /offline or stale/);
});
test('Railway ignores execution credentials/settings; worker validates its own minimal config', () => {
  const env = { BOT_TOKEN: 'test', OWNER_CHAT_ID: '1', SUPABASE_URL: 'https://example.com',
    SUPABASE_SERVICE_ROLE_KEY: 'test', BINANCE_API_KEY: 'test', BINANCE_API_SECRET: 'test',
    FADE_ENVIRONMENT: 'broken', ENABLE_FADE_EXECUTION: 'broken' };
  assert.equal(loadConfig(env).enableFadeExecution, false);
  assert.throws(() => loadFadeConfig(env), /FADE_ENVIRONMENT/);
  const workerCfg = loadFadeConfig({ ...env, FADE_ENVIRONMENT: 'testnet', ENABLE_FADE_EXECUTION: 'false' });
  assert.equal(workerCfg.enableFadeExecution, false); assert.equal(workerCfg.fadeStartBalanceUsdt, 100);
  assert.throws(() => loadFadeConfig({ ...env, FADE_ENVIRONMENT: 'testnet', ENABLE_FADE_EXECUTION: 'false',
    FADE_START_BALANCE_USDT: 'zero' }), /FADE_START_BALANCE_USDT/);
  const main = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /FadeExchange|FadeExecutor|fade-orders|fade-executor/);
  const worker = readFileSync(new URL('../src/fade-worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /pollLoop|PumpFadeRadar|new Engine/);
});
