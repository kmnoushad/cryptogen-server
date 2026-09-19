// Read-only credential/account/schema check. This script never places orders,
// acquires a runtime lease or changes leverage/margin/account modes.
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
import { Store } from '../src/store.js';
const cfg = loadFadeConfig();
const exchange = new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment });
const store = new Store(cfg);
try {
  await exchange.syncTime();
  const [mode, assets, permissions, account, positions, orders, algos] = await Promise.all([
    exchange.mode(), exchange.assetsMode(), exchange.accountPermissions(), exchange.account(),
    exchange.positions(), exchange.orders(), exchange.algos(),
    store.get('nexio_fade_runtime', [['select', 'scope,revision'], ['limit', '1']]),
    store.fadeControl(`${cfg.fadeEnvironment}:primary`),
    store.get('nexio_fade_worker_status', [['select', 'scope'], ['limit', '1']]),
    store.fadeSignals(Date.now()),
  ]);
  if (mode.dualSidePosition !== false || assets.multiAssetsMargin !== false) throw Error('Use One-way and Single-Asset mode on a dedicated Futures account');
  if (permissions.canTrade !== true) throw Error('Account trading is unavailable');
  if (!Array.isArray(account.assets) || !Array.isArray(positions) || !Array.isArray(orders) || !Array.isArray(algos)) throw Error('Account response is incomplete');
  const active = positions.filter(p => Number(p.positionAmt) !== 0);
  console.log(`Fade preflight: ${cfg.fadeEnvironment}; account reads and runtime table reachable.`);
  console.log(`Open positions ${active.length}; ordinary orders ${orders.length}; conditional orders ${algos.length}.`);
  console.log('No orders were placed. Demo order acceptance, stop/partial fills and restart recovery still require exchange testing.');
} catch (error) {
  console.error(`Fade preflight failed: ${error.message}`);
  process.exitCode = 1;
}
