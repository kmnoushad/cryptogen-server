// Read-only trade count and results for Fade Auto or Futures Auto.
// Sources: Supabase runtime journal + archived jobs (bot-owned trades only),
// Binance income history for P&L (fees and funding included). No orders, no writes.
//   node scripts/bot-trade-report.js fade
//   node scripts/bot-trade-report.js futures
import dns from 'node:dns';
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
import { Store } from '../src/store.js';
import { loadFuturesAutoConfig } from '../src/futures-auto-config.js';
import { FuturesAutoExchange } from '../src/futures-auto-executor.js';
import { FuturesAutoStore, futuresScope } from '../src/futures-auto-store.js';

dns.setDefaultResultOrder('ipv4first');
const bot = process.argv[2];
const sinceArg = process.argv.find(a => a.startsWith('--since='));
const SINCE = sinceArg ? Date.parse(sinceArg.slice(8)) : 0; // e.g. --since=2026-10-13T19:12Z (clean trades only)
if (sinceArg && !Number.isFinite(SINCE)) { console.error('Bad --since date'); process.exit(2); }
if (!['fade', 'futures'].includes(bot)) { console.error('Usage: node scripts/bot-trade-report.js fade|futures'); process.exit(2); }

const DAY = 86400000, GST = 4 * 3600000;
const usd = n => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const day = ms => new Date(ms + GST).toISOString().slice(0, 10);
const weekOf = ms => { const d = new Date(ms + GST); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const tally = (rows, key) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map());
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cfg, exchange, store, table, scope;
if (bot === 'fade') {
  cfg = loadFadeConfig(); store = new Store(cfg); table = 'nexio_fade_runtime'; scope = `${cfg.fadeEnvironment}:primary`;
  exchange = new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment });
} else {
  cfg = loadFuturesAutoConfig(); store = new FuturesAutoStore(cfg); table = 'nexio_futures_runtime'; scope = futuresScope(cfg.environment);
  exchange = new FuturesAutoExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.environment });
}

async function loadJobs() {
  const runtime = await store.get(table, [['scope', `eq.${scope}`], ['select', 'state']]);
  if (!Array.isArray(runtime) || runtime.length !== 1 || !Array.isArray(runtime[0].state?.jobs)) throw Error(`Runtime journal ${table} (${scope}) unavailable`);
  const jobs = new Map(runtime[0].state.jobs.map(j => [j.id, j]));
  let archived = 0;
  for (let offset = 0; ; offset += 1000) {
    const rows = await store.get('nexio_events', [['event_type', 'eq.FADE_JOB_ARCHIVE_V1'], ['payload->>scope', `eq.${scope}`],
      ['select', 'payload'], ['order', 'event_key.asc'], ['limit', '1000'], ['offset', String(offset)]]);
    if (!Array.isArray(rows)) throw Error('Archived jobs unavailable');
    for (const r of rows) { const j = r.payload?.job; if (j?.id && !jobs.has(j.id)) { jobs.set(j.id, j); archived++; } }
    if (rows.length < 1000) break;
  }
  return { jobs: [...jobs.values()], archived };
}

async function loadIncome(from, now) {
  // 7-day windows; older windows Binance no longer serves are reported, not guessed.
  const rows = [], gaps = [];
  for (let start = from; start < now; start += 7 * DAY) {
    const end = Math.min(now, start + 7 * DAY - 1);
    try {
      for (let page = 1; page <= 10; page++) {
        const batch = await exchange.income({ startTime: start, endTime: end, page, limit: 1000 });
        if (!Array.isArray(batch)) throw Error('invalid income response');
        rows.push(...batch); if (batch.length < 1000) break;
      }
    } catch (e) { gaps.push(`${day(start)}..${day(end)} (${e.message})`); }
    await sleep(300);
  }
  const seen = new Set();
  return { rows: rows.filter(r => ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'].includes(r.incomeType) && r.asset === 'USDT')
    .filter(r => { const k = `${r.incomeType}:${r.tranId}:${r.time}`; if (seen.has(k)) return false; seen.add(k); return true; }), gaps };
}

try {
  if (typeof exchange.syncTime === 'function') await exchange.syncTime();
  const now = Date.now();
  const { jobs, archived } = await loadJobs();
  const closed = jobs.filter(j => j.phase === 'CLOSED' && Number.isFinite(j.closedAt));
  const filled = closed.filter(j => Number(j.filledQty) > 0 && Number.isFinite(j.createdAt) && j.createdAt >= SINCE).sort((a, b) => a.createdAt - b.createdAt);
  const unfilled = closed.filter(j => !(Number(j.filledQty) > 0));
  const open = jobs.filter(j => j.phase !== 'CLOSED');

  console.log(`${bot.toUpperCase()} AUTO · ${scope} · read-only report · ${new Date(now).toISOString()}${SINCE ? ` · trades since ${new Date(SINCE).toISOString()}` : ''}`);
  console.log(`Journal: ${jobs.length} jobs (${archived} from archive) · ${filled.length} filled trades closed · ${open.length} open · ${unfilled.length} attempts with no fill`);
  if (!filled.length) { console.log('No filled trades found.'); process.exit(0); }
  console.log(`First trade ${day(filled[0].createdAt)} · last trade ${day(filled.at(-1).createdAt)} (UAE dates)\n`);

  const { rows, gaps } = await loadIncome(filled[0].createdAt - DAY, now);
  const results = filled.map(j => {
    const m = rows.filter(r => r.symbol === j.symbol && Number(r.time) >= j.createdAt && Number(r.time) <= j.closedAt + 300000);
    const verified = m.some(r => r.incomeType === 'REALIZED_PNL') && m.some(r => r.incomeType === 'COMMISSION');
    return { ...j, verified, net: m.reduce((s, r) => s + Number(r.income), 0),
      fees: m.filter(r => r.incomeType === 'COMMISSION').reduce((s, r) => s + Number(r.income), 0) };
  });
  const v = results.filter(r => r.verified), wins = v.filter(r => r.net > 0), losses = v.filter(r => r.net < 0);
  const sum = a => a.reduce((s, r) => s + r.net, 0);
  console.log(`RESULTS (Binance income matched to each bot trade; fees and funding included)`);
  console.log(`Verified ${v.length}/${filled.length} · ${wins.length}W/${losses.length}L/${v.length - wins.length - losses.length} flat · win rate ${v.length ? (100 * wins.length / v.length).toFixed(1) : '0'}%`);
  console.log(`Net ${usd(sum(v))} · fees ${usd(v.reduce((s, r) => s + r.fees, 0))} · avg win ${wins.length ? usd(sum(wins) / wins.length) : 'n/a'} · avg loss ${losses.length ? usd(sum(losses) / losses.length) : 'n/a'}`);
  if (wins.length && losses.length) console.log(`Payoff ratio ${(sum(wins) / wins.length / Math.abs(sum(losses) / losses.length)).toFixed(2)} · expectancy per trade ${usd(sum(v) / v.length)}`);
  if (gaps.length) console.log(`Income unavailable for: ${gaps.join('; ')}`);

  console.log(`\nBY WEEK (UAE, week starting Monday)`);
  const weeks = new Map();
  for (const r of results) { const w = weekOf(r.createdAt), x = weeks.get(w) ?? { n: 0, net: 0, w: 0 }; x.n++; if (r.verified) { x.net += r.net; x.w += r.net > 0 ? 1 : 0; } weeks.set(w, x); }
  for (const [w, x] of weeks) console.log(`  ${w}  trades ${String(x.n).padEnd(4)} wins ${String(x.w).padEnd(4)} net ${usd(x.net)}`);

  console.log(`\nBY EXIT REASON`);
  const byExit = new Map();
  for (const r of results) { const k = r.closeReason ?? 'EXCHANGE_EXIT', x = byExit.get(k) ?? { n: 0, net: 0 }; x.n++; if (r.verified) x.net += r.net; byExit.set(k, x); }
  for (const [k, x] of [...byExit].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(28)} ${String(x.n).padEnd(4)} net ${usd(x.net)}`);

  console.log(`\nBY ENTRY HOUR (UAE)`);
  const byHour = new Map();
  for (const r of results.filter(r => r.verified)) { const h = new Date(r.createdAt + GST).getUTCHours(), x = byHour.get(h) ?? { n: 0, net: 0, w: 0 }; x.n++; x.net += r.net; x.w += r.net > 0 ? 1 : 0; byHour.set(h, x); }
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) { const x = byHour.get(h); console.log(`  ${String(h).padStart(2, '0')}:00${h === 17 ? ' Golden' : '       '} trades ${String(x.n).padEnd(3)} wins ${String(x.w).padEnd(3)} net ${usd(x.net)}`); }

  const failed = results.filter(r => r.protectionFailure?.reason);
  if (failed.length) {
    console.log(`\nPROTECTION_FAILURE REASONS (from the bot journal)`);
    const reasons = new Map();
    for (const r of failed) { const k = String(r.protectionFailure.reason).slice(0, 90), x = reasons.get(k) ?? { n: 0, net: 0 }; x.n++; if (r.verified) x.net += r.net; reasons.set(k, x); }
    for (const [k, x] of [...reasons].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(x.n).padEnd(4)} net ${usd(x.net).padEnd(9)} ${k}`);
  }

  if (unfilled.length) {
    console.log(`\nATTEMPTS WITHOUT A FILL (by reason)`);
    for (const [k, n] of [...tally(unfilled, j => j.closeReason ?? (j.noOrderSent ? 'NOT_SENT' : 'REJECTED/UNFILLED'))].sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(28)} ${n}`);
  }
  // EDGE FINDER: which trade conditions win and which lose (verified trades only).
  const pct = (a, b) => Math.abs(a / b - 1) * 100;
  const bucket = (x, edges, unit = '') => { if (!Number.isFinite(x)) return 'unknown';
    for (let i = 0; i < edges.length; i++) if (x < edges[i]) return `${i ? edges[i - 1] : '<'}${i ? '-' : ''}${edges[i]}${unit}`;
    return `>=${edges.at(-1)}${unit}`; };
  const holdMin = r => (r.closedAt - r.createdAt) / 60000;
  const features = bot === 'futures' ? {
    'direction': r => r.direction ?? 'unknown',
    'stop distance %': r => bucket(pct(r.signal?.stop, r.signal?.entry), [0.6, 0.9, 1.2], '%'),
    'breakout strength (ATR)': r => bucket(r.signal?.score, [0.3, 0.6, 1.0]),
    'hold time': r => bucket(holdMin(r), [15, 60, 120], 'm'),
    'UAE session': r => { const h = new Date(r.createdAt + GST).getUTCHours(); return h < 8 ? 'night 00-08' : h < 16 ? 'day 08-16' : 'evening 16-24'; },
  } : {
    'spike size %': r => bucket(100 * Number(r.signal?.spikeGain), [3, 5, 8], '%'),
    'sell pressure %': r => bucket(100 * Number(r.signal?.sellShare), [70, 80, 90], '%'),
    'stop distance %': r => bucket(pct(r.signal?.stop, r.signal?.entry), [0.8, 1.2, 1.8], '%'),
    'fee share of risk %': r => bucket(100 * Number(r.signal?.costShare), [10, 15, 20], '%'),
    'hold time': r => bucket(holdMin(r), [5, 15, 60], 'm'),
    'UAE session': r => { const h = new Date(r.createdAt + GST).getUTCHours(); return h < 8 ? 'night 00-08' : h < 16 ? 'day 08-16' : 'evening 16-24'; },
  };
  console.log(`\nEDGE FINDER (verified trades; a bucket needs ~20+ trades before trusting it)`);
  for (const [name, fn] of Object.entries(features)) {
    console.log(`  ${name}`);
    const groups = new Map();
    for (const r of v) { const k = fn(r), x = groups.get(k) ?? { n: 0, w: 0, net: 0 }; x.n++; x.w += r.net > 0 ? 1 : 0; x.net += r.net; groups.set(k, x); }
    for (const [k, x] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true })))
      console.log(`    ${String(k).padEnd(16)} trades ${String(x.n).padEnd(4)} win ${String(Math.round(100 * x.w / x.n) + '%').padEnd(5)} net ${usd(x.net).padEnd(9)} per trade ${usd(x.net / x.n)}`);
  }

  console.log(`\nLAST 10 TRADES`);
  for (const r of results.slice(-10)) console.log(`  ${day(r.createdAt)} ${r.symbol.padEnd(14)} ${(r.direction ?? 'SHORT').padEnd(5)} ${String(r.closeReason ?? 'EXCHANGE_EXIT').padEnd(22)} ${r.verified ? usd(r.net) : 'unverified'}`);
} catch (e) { console.error(`Report failed: ${e.message}`); process.exit(1); }
