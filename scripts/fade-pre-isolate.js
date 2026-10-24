// One-time Fade setup (v4): set USDT perpetuals to ISOLATED margin at 2x leverage
// ahead of time, so live entries avoid redundant margin/leverage writes during a spike; savings vary.
//
// Safety:
// - Dry run by default (read-only; safe while Fade runs). --apply changes settings.
// - --apply requires the nexio-fade service to be STOPPED (checked with systemctl,
//   at start and again before every change) and the account to be completely flat:
//   no positions, no open orders, no open algo orders on any symbol.
// - Every Binance response is validated; any malformed response aborts the run.
// - Refuses to run without NEXIO_BINANCE_BUDGET_DIR (shared request budget).
// - Requires One-way position mode and Single-Asset margin mode.
// - Rechecks position, open orders and algo orders right before each change.
// - Honours retryAfterMs; stops completely on an IP ban (418, or -1003 ban) or if still rate limited after one wait.
// - Exit codes: 0 success · 1 failures/stopped · 2 refused or invalid data.
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';

dns.setDefaultResultOrder('ipv4first');
const APPLY = process.argv.includes('--apply');
const SERVICE = 'nexio-fade';
const PAUSE_MS = 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (e) => `${e?.status ?? ''} ${e?.code ?? ''} ${e?.message ?? e}`.trim();
const banned = (e) => e?.status === 418 || (e?.code === -1003 && /ban/i.test(e?.message ?? ''));
const busy = (e) => !banned(e) && (e?.status === 429 || e?.code === -1003 || /deferred|budget/i.test(e?.message ?? ''));

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// ---- validation: abort on anything unexpected rather than guess
function array(name, value) {
  if (!Array.isArray(value)) refuse(`${name}: expected an array from Binance, got ${typeof value}`);
  return value;
}
function positionsList(name, value) {
  for (const p of array(name, value)) {
    if (typeof p?.symbol !== 'string' || !Number.isFinite(Number(p?.positionAmt)) || p.positionAmt === '' || p.positionAmt == null)
      refuse(`${name}: malformed position row ${JSON.stringify(p)}`);
  }
  return value;
}
function configsList(value) {
  for (const c of array('symbolConfig', value)) {
    if (typeof c?.symbol !== 'string' || !['ISOLATED', 'CROSSED'].includes(c?.marginType) || !Number.isInteger(Number(c?.leverage)) || Number(c.leverage) < 1)
      refuse(`symbolConfig: malformed row ${JSON.stringify(c)}`);
  }
  return value;
}
function algoList(name, value) {
  const rows = Array.isArray(value) ? value : value?.orders;
  return array(name, rows);
}

// ---- worker must be stopped for --apply
function serviceState() {
  try {
    return execFileSync('systemctl', ['is-active', SERVICE], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    const out = String(e?.stdout ?? '').trim(); // is-active exits nonzero when not active
    if (out) return out;
    refuse(`could not read ${SERVICE} state with systemctl: ${e?.message ?? e}`);
  }
}
function requireStopped() {
  const state = serviceState();
  if (state !== 'inactive') refuse(`${SERVICE} is "${state}". Stop it first: sudo systemctl stop ${SERVICE}`);
}

if (!process.env.NEXIO_BINANCE_BUDGET_DIR) {
  console.error('Refused: NEXIO_BINANCE_BUDGET_DIR is not set; use the systemd-run command so the shared request budget is used.');
  process.exit(2);
}
const cfg = loadFadeConfig();
const exchange = new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment });

async function accountFlat() {
  const [positions, orders, algos] = await Promise.all([
    exchange.positions(),
    exchange.request('GET', '/fapi/v1/openOrders', {}),
    exchange.request('GET', '/fapi/v1/openAlgoOrders', {}),
  ]);
  const open = positionsList('positionRisk', positions).filter((p) => Number(p.positionAmt) !== 0).map((p) => p.symbol);
  const orderRows = array('openOrders', orders), algoRows = algoList('openAlgoOrders', algos);
  const problems = [];
  if (open.length) problems.push(`open positions: ${open.join(', ')}`);
  if (orderRows.length) problems.push(`${orderRows.length} open orders`);
  if (algoRows.length) problems.push(`${algoRows.length} open algo orders`);
  return problems;
}

async function symbolBlocked(symbol) {
  const [positions, orders, algos] = await Promise.all([
    exchange.request('GET', '/fapi/v3/positionRisk', { symbol }),
    exchange.request('GET', '/fapi/v1/openOrders', { symbol }),
    exchange.request('GET', '/fapi/v1/openAlgoOrders', { symbol }),
  ]);
  if (positionsList(`positionRisk ${symbol}`, positions).some((p) => Number(p.positionAmt) !== 0)) return 'open position';
  if (array(`openOrders ${symbol}`, orders).length) return 'open orders';
  if (algoList(`openAlgoOrders ${symbol}`, algos).length) return 'open algo orders';
  return null;
}

async function main() {
  console.log(`Fade pre-isolate v4 · environment=${cfg.fadeEnvironment} · ${APPLY ? 'APPLY' : 'DRY RUN (read-only)'}`);
  if (APPLY) requireStopped();
  if (typeof exchange.syncTime === 'function') await exchange.syncTime();

  const [dual, multi] = await Promise.all([exchange.mode(), exchange.assetsMode()]);
  if (dual?.dualSidePosition !== false) refuse('account is not in One-way position mode.');
  if (multi?.multiAssetsMargin !== false) refuse('account is not in Single-Asset margin mode.');

  const flatProblems = await accountFlat();
  if (APPLY && flatProblems.length) refuse(`account is not flat (${flatProblems.join('; ')}). Run only when Fade has nothing open.`);

  const info = await exchange.info();
  const symbols = array('exchangeInfo.symbols', info?.symbols)
    .filter((s) => s?.contractType === 'PERPETUAL' && s?.quoteAsset === 'USDT' && s?.status === 'TRADING')
    .map((s) => s.symbol);
  if (!symbols.length) refuse('exchangeInfo returned no USDT perpetuals.');
  const configs = configsList(await exchange.request('GET', '/fapi/v1/symbolConfig', {}));
  const bySymbol = new Map(configs.map((c) => [c.symbol, c]));
  if (bySymbol.size !== configs.length) refuse('symbolConfig contains duplicate symbols.');
  const missing = symbols.filter((s) => !bySymbol.has(s));
  if (missing.length > symbols.length * 0.1) refuse(`symbolConfig is missing ${missing.length} of ${symbols.length} symbols; response looks incomplete.`);
  const ready = symbols.filter((s) => bySymbol.get(s)?.marginType === 'ISOLATED' && Number(bySymbol.get(s)?.leverage) === 2);
  const todo = symbols.filter((s) => !ready.includes(s));

  console.log(`${symbols.length} USDT perpetuals · ${ready.length} already isolated 2x · ${todo.length} to change`);
  if (!APPLY) {
    console.log(`Account flat: ${flatProblems.length ? 'NO (' + flatProblems.join('; ') + ')' : 'yes'} · ${SERVICE}: ${serviceState()}`);
    console.log(`Would change: ${todo.join(', ') || 'none'}`);
    console.log(`To apply: send nothing new, wait until flat, sudo systemctl stop ${SERVICE}, rerun with --apply.`);
    return 0;
  }

  const changed = [], skipped = [], failed = [];
  for (const [i, symbol] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${symbol}`;
    requireStopped(); // guards against the worker being restarted mid-run
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const reason = await symbolBlocked(symbol);
        if (reason) { skipped.push(`${symbol} (${reason})`); console.log(`${tag}: skipped, ${reason}`); break; }
        requireStopped(); // Recheck after reads and after every budget wait.
        await exchange.isolate(symbol);
        changed.push(symbol); console.log(`${tag}: isolated 2x`);
        break;
      } catch (e) {
        if (e instanceof Refusal) throw e;
        if (banned(e)) {
          console.error(`${tag}: Binance IP ban (418); stopping. ${describe(e)}`);
          console.log(`Stopped · changed ${changed.length} · skipped ${skipped.length} · failed ${failed.length + 1}`);
          return 1;
        }
        if (attempt === 1 && busy(e)) {
          const wait = Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0 ? e.retryAfterMs + 1000 : 65000;
          console.log(`${tag}: request budget busy, waiting ${Math.round(wait / 1000)} s`);
          await sleep(wait); continue;
        }
        if (busy(e)) {
          // Still rate limited after waiting: stop rather than keep hitting Binance.
          console.error(`${tag}: still rate limited after waiting; stopping. ${describe(e)}`);
          console.log(`Stopped · changed ${changed.length} · skipped ${skipped.length} · failed ${failed.length + 1}`);
          return 1;
        }
        failed.push(`${symbol} (${describe(e)})`); console.log(`${tag}: FAILED ${describe(e)}`);
        break;
      }
    }
    await sleep(PAUSE_MS);
  }
  console.log(`Done · changed ${changed.length} · skipped ${skipped.length} · failed ${failed.length}`);
  if (skipped.length) console.log(`Skipped:\n  ${skipped.join('\n  ')}`);
  if (failed.length) console.log(`Failed (the bot still sets these at entry):\n  ${failed.join('\n  ')}`);
  return failed.length || skipped.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof Refusal) { console.error(`Refused: ${e.message}`); process.exit(2); }
    console.error(`Stopped: ${describe(e)}`); process.exit(1);
  });
