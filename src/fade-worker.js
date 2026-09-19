import dns from 'node:dns';
import { loadFadeConfig } from './fade-config.js';
import { FadeExchange } from './fade-orders.js';
import { FadeExecutor } from './fade-executor.js';
import { FadeWorkerLoop } from './fade-worker-loop.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { APP_VERSION } from './version.js';

dns.setDefaultResultOrder('ipv4first');
const cfg = loadFadeConfig();
const store = new Store(cfg);
const telegram = new Telegram(cfg); // send only; Railway owns getUpdates
const executor = new FadeExecutor({ cfg, store, telegram,
  exchange: new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment }) });
const worker = new FadeWorkerLoop({ executor, store });
const timer = setInterval(() => { void worker.tick(); }, 5000);
const stop = () => {
  clearInterval(timer); worker.stop();
  // Allow an in-flight exchange request to settle before systemd terminates us.
  const drain = setInterval(() => { if (!worker.busy) { clearInterval(drain); process.exit(0); } }, 250);
  setTimeout(() => process.exit(1), 20000).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log(`NEXIO ${APP_VERSION} external fade worker: ${cfg.fadeEnvironment}; enabled=${cfg.enableFadeExecution}`);
await worker.tick();
