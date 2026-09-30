import { createHash } from 'node:crypto';
import { loadFuturesAutoConfig } from '../src/futures-auto-config.js';
import { FuturesAutoExchange, FuturesAutoExecutor } from '../src/futures-auto-executor.js';
import { FuturesAutoStore, futuresScope } from '../src/futures-auto-store.js';
const cfg = loadFuturesAutoConfig(), store = new FuturesAutoStore(cfg);
const exchange = new FuturesAutoExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.environment });
await exchange.syncTime();
const ex = new FuturesAutoExecutor({ cfg, store, exchange, telegram: { send: async () => {} } });
const snapshot = await ex.accountState();
const scope = futuresScope(cfg.environment);
const [control, runtime] = await Promise.all([store.control(scope), store.get('nexio_futures_runtime', [['scope', `eq.${scope}`], ['select', 'state']])]);
const jobs = runtime[0]?.state?.jobs ?? [];
const pinned = runtime[0]?.state?.keyFingerprint;
if (pinned && pinned !== createHash('sha256').update(cfg.binanceApiKey).digest('hex').slice(0, 16)) throw Error('Futures account API fingerprint differs from runtime pin');
if (snapshot.positions.some(p => !jobs.some(j => j.phase !== 'CLOSED' && j.symbol === p.symbol))
  || [...snapshot.orders, ...snapshot.algos].some(o => !ex.ownsOrder(o, jobs))) throw Error('Unmanaged positions/orders; dedicated Futures account required');
console.log(`Futures preflight: ${cfg.environment}; account reads and independent tables reachable.`);
console.log(`Wallet $${ex.balanceSnapshot.wallet.toFixed(2)}; positions ${snapshot.positions.length}; orders ${snapshot.orders.length}; conditional ${snapshot.algos.length}; requested entries ${control.paused ? 'paused' : 'enabled'}.`);
console.log('No orders placed or account modes changed. Testnet fill/protection/restart drills are not performed by this read-only check.');
