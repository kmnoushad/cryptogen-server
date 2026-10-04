import dns from 'node:dns';
import { loadFadeConfig } from './fade-config.js';
import { FadeExchange } from './fade-orders.js';
import { FadeExecutor } from './fade-executor.js';
import { FadeWorkerLoop, workerPollDelay, workerStalled } from './fade-worker-loop.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { APP_VERSION } from './version.js';
import { FadeSpikeSource } from './fade-spike-source.js';

dns.setDefaultResultOrder('ipv4first');
const cfg = loadFadeConfig();
const store = new Store(cfg);
const telegram = new Telegram(cfg); // send only; Railway owns getUpdates
const executor = new FadeExecutor({ cfg, store, telegram,
  exchange: new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment }) });
let worker;
const source = cfg.fadeEntrySource === 'spike' ? new FadeSpikeSource({ exchange: executor.exchange,
  environment: cfg.fadeEnvironment, isPaused: () => !worker || executor.isPaused() || !executor.enabled() }) : null;
worker = new FadeWorkerLoop({ executor, store, signalSource: source });
if (source) {
  executor.spikeAuthorize = (symbol, signal) => source.authorize(symbol, signal);
  executor.spikeHealth = () => source.health();
  source.onCandidate = () => { void worker.tick({ wake: true }); };
}
let lastPollAt = Date.now();
const timer = setInterval(() => {
  source?.checkLiveness();
  const now = Date.now();
  if (workerPollDelay(worker) === 10000 && now - lastPollAt < 10000) return;
  lastPollAt = now;
  void worker.tick();
}, 5000);
const watchdog = setInterval(() => {
  if (!workerStalled(worker)) return;
  console.error('Fade worker cycle stalled for more than 45s; exiting for systemd recovery.');
  process.exit(1);
}, 5000);
const stop = () => {
  clearInterval(timer); clearInterval(watchdog); worker.stop();
  // Allow an in-flight exchange request to settle before systemd terminates us.
  const drain = setInterval(() => { if (!worker.busy) { clearInterval(drain); process.exit(0); } }, 250);
  setTimeout(() => process.exit(1), 20000).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log(`NEXIO ${APP_VERSION} external fade worker: ${cfg.fadeEnvironment}; enabled=${cfg.enableFadeExecution}; source=${cfg.fadeEntrySource}`);
await worker.tick();
if (source) void source.start();
