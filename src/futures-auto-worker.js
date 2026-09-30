import dns from 'node:dns';
import { loadFuturesAutoConfig } from './futures-auto-config.js';
import { FuturesAutoExchange, FuturesAutoExecutor } from './futures-auto-executor.js';
import { FuturesAutoStore } from './futures-auto-store.js';
import { FuturesAutoWorkerLoop } from './futures-auto-worker-loop.js';
import { Telegram } from './telegram.js';
import { APP_VERSION } from './version.js';
dns.setDefaultResultOrder('ipv4first');
const cfg = loadFuturesAutoConfig(), store = new FuturesAutoStore(cfg);
const executor = new FuturesAutoExecutor({ cfg, store, telegram: new Telegram(cfg),
  exchange: new FuturesAutoExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.environment }) });
const worker = new FuturesAutoWorkerLoop({ executor, store });
let lastPoll = 0;
const timer = setInterval(() => {
  const delay = executor.row?.state.jobs.some(j => j.phase !== 'CLOSED') ? 5000 : 10000;
  if (Date.now() - lastPoll < delay) return;
  lastPoll = Date.now(); void worker.tick();
}, 5000);
const watchdog = setInterval(() => {
  if (worker.busy && Date.now() - worker.lastProgress > 120000) { console.error('Futures cycle stalled; exiting for systemd recovery'); process.exit(1); }
}, 10000);
const stop = () => {
  clearInterval(timer); clearInterval(watchdog); worker.stop();
  const drain = setInterval(() => { if (!worker.busy) { clearInterval(drain); process.exit(0); } }, 250);
  setTimeout(() => process.exit(1), 20000).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log(`NEXIO ${APP_VERSION} separate Futures worker: ${cfg.environment}; entries enabled=${cfg.enabled}`);
await worker.tick();
