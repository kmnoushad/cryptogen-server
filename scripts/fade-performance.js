// Read-only Binance/Supabase report. No leases, no order endpoints, no file of secrets.
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
import { readFadeIncome } from '../src/fade-risk.js';
import { summarizeFadePerformance } from '../src/fade-performance.js';
import { Store } from '../src/store.js';

const cfg = loadFadeConfig();
const exchange = new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment });
const store = new Store(cfg);
const since = Date.now() - 7 * 86400000;
const usd = n => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
try {
  await exchange.syncTime();
  const now = Date.now();
  const [rows, runtime, account] = await Promise.all([
    readFadeIncome(exchange, since, now, 10),
    store.get('nexio_fade_runtime', [['scope', `eq.${cfg.fadeEnvironment}:primary`], ['select', 'scope,state']]),
    exchange.account(),
  ]);
  if (!Array.isArray(runtime) || runtime.length !== 1 || !Array.isArray(runtime[0].state?.jobs)) {
    throw Error('Fade runtime journal unavailable');
  }
  const report = summarizeFadePerformance(rows, runtime[0].state.jobs, since, now);
  const equity = Number(account.totalMarginBalance);
  if (!Number.isFinite(equity)) throw Error('Exchange equity unavailable');
  console.log(`FADE READ-ONLY AUDIT · ${cfg.fadeEnvironment} · last 7d · exchange equity $${equity.toFixed(2)}`);
  console.log(`Realized ${usd(report.totals.REALIZED_PNL)} · commission ${usd(report.totals.COMMISSION)} · funding ${usd(report.totals.FUNDING_FEE)} · net ${usd(report.net)}`);
  console.log(`Realized path peak ${usd(report.peak)} · current giveback $${report.currentGiveback.toFixed(2)} · max realized drawdown $${report.maxRealizedDrawdown.toFixed(2)}`);
  console.log(`Verified closed bot jobs ${report.count} · ${report.wins}W/${report.losses}L · unmatched/open cashflow ${usd(report.otherOrOpenNet)}`);
  for (const trade of report.trades.sort((a, b) => a.net - b.net).slice(0, 15)) {
    const sampled = trade.peakSampledNet == null ? 'N/A (old version)' : usd(trade.peakSampledNet);
    console.log(`${new Date(trade.closedAt).toISOString()} ${trade.symbol} · ${trade.exit} · ${trade.verified ? usd(trade.net) : 'UNVERIFIED'} · fees ${usd(trade.fees)} · sampled pre-partial peak ${sampled}`);
  }
  console.log('Realized-path peak excludes open PnL. Sampled trade peaks are indicative quotes, not executable fills. Missing outcomes are not counted as wins. No orders placed.');
} catch (error) {
  console.error(`FADE AUDIT UNAVAILABLE: ${error.message}`);
  process.exitCode = 1;
}
