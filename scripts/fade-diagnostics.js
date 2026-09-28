// Read-only trace of fade warnings, AWS handoff and entry prerequisites.
// No leases, control changes, exchange mutations or order endpoints.
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
import { fadeBtcGate } from '../src/fade-btc-gate.js';
import { FadeEventGate } from '../src/fade-entry-gates.js';
import { BLS_URL, BEA_URL, parseOfficialSchedules, parseFedSchedules,
  fedCalendarMonths, fedCalendarUrl } from '../src/fade-official-calendar.js';
import { readFadeRisk } from '../src/fade-risk.js';
import { Store } from '../src/store.js';
import { requestJson } from '../src/http.js';

const cfg = loadFadeConfig();
const now = Date.now();
const scope = `${cfg.fadeEnvironment}:primary`;
const store = new Store(cfg);
const exchange = new FadeExchange({ key: cfg.binanceApiKey, secret: cfg.binanceApiSecret, environment: cfg.fadeEnvironment });
const since = new Date(now - 24 * 3600000).toISOString();
const countEvents = async type => {
  let count = 0, latest = null;
  for (let offset = 0; ; offset += 500) {
    const page = await store.get('nexio_events', [['event_type', `eq.${type}`], ['created_at', `gte.${since}`],
      ['select', 'created_at'], ['order', 'created_at.desc'], ['limit', '500'], ['offset', String(offset)]]);
    if (!Array.isArray(page)) throw Error('Fade event history unavailable');
    if (offset === 0) latest = page[0]?.created_at ?? null;
    count += page.length;
    if (page.length < 500) return { count, latest };
    if (offset >= 10000) throw Error('Fade event history exceeds diagnostic limit');
  }
};
const check = async (label, operation) => {
  try { return await operation(); }
  catch (error) { console.log(`${label}: unavailable (${error.message})`); return null; }
};

console.log(`FADE READ-ONLY DIAGNOSTICS · ${cfg.fadeEnvironment} · ${new Date(now).toISOString()} · last 24h`);
await check('Binance clock', () => exchange.syncTime());
const [warnings, signals, state, control, btcRows, btcBook, account] = await Promise.all([
  check('Scanner warnings', () => countEvents('FUTURES_PUMP_FADE_WARNING')),
  check('Worker signals', () => countEvents('FADE_WORKER_SIGNAL_V1')),
  check('Runtime', async () => (await store.get('nexio_fade_runtime', [['scope', `eq.${scope}`], ['select', 'state']]))[0]?.state),
  check('Control', () => store.fadeControl(scope)),
  check('BTC candles', () => exchange.btcCandles()),
  check('BTC quote', () => exchange.book('BTCUSDT')),
  check('Account', () => exchange.account()),
]);
if (warnings) console.log(`Railway fade warnings: ${warnings.count} · latest ${warnings.latest ?? 'none'}`);
if (signals) console.log(`AWS handoff events: ${signals.count} · latest ${signals.latest ?? 'none'}`);
if (warnings && signals && warnings.count > signals.count) console.log('Some warnings had no worker handoff (or occurred before the handoff feature was enabled).');
if (control) console.log(`Requested entries: ${control.paused ? 'PAUSED' : 'enabled'}${control.close_requested ? ' · close requested' : ''}`);
if (btcRows && btcBook) {
  const gate = fadeBtcGate(btcRows, btcBook, Date.now());
  console.log(`BTC entry gate now: ${gate.allowed ? 'OPEN' : 'CLOSED'} · ${gate.reason}`);
}
if (state && account) {
  const equity = Number(account.totalMarginBalance ?? account.assets?.find(a => a.asset === 'USDT')?.marginBalance);
  const risk = await check('Realized risk', () => readFadeRisk(exchange, state.jobs, equity, Date.now()));
  if (risk) console.log(`Risk entry gate now: ${risk.allowed ? 'OPEN' : 'CLOSED'} · ${risk.reason}`);
}
const event = await check('Calendar', () => new FadeEventGate({ cfg }).check());
if (event) console.log(`Calendar entry gate now: ${event.allowed ? 'OPEN' : 'CLOSED'} · ${event.reason}`);
if (event && !event.allowed && /feeds unavailable|coverage unverified/.test(event.reason)) {
  // Read only: inspect public schedules without exposing API keys or full feed bodies.
  const [bls, bea] = await Promise.all([
    check('BLS calendar', async () => {
      const response = await fetch(BLS_URL, { signal: AbortSignal.timeout(7000) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) throw Error('size limit exceeded');
      const body = await response.text();
      if (body.length > 2_000_000) throw Error('size limit exceeded');
      console.log(`BLS calendar: HTTP ${response.status} · ${body.length} characters`);
      return body;
    }),
    check('BEA calendar', async () => {
      const body = await requestJson(BEA_URL, { timeoutMs: 7000, retries: 0 });
      console.log(`BEA calendar: received ${Object.keys(body ?? {}).length} reports`);
      return body;
    }),
  ]);
  if (bls && bea) {
    try {
      const parsed = parseOfficialSchedules(bls, bea, Date.now());
      console.log(`Official calendar parse: OK · ${parsed.length} selected releases in the next 14 days`);
    } catch (error) {
      console.log(`Official calendar parse: ${error.message}`);
      const samples = [...bls.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].map(match => match[0])
        .filter(block => /employment situation|consumer price index/i.test(block)).slice(0, 2);
      for (const block of samples) {
        const summary = block.match(/^SUMMARY:[^\r\n]*/m)?.[0]?.slice(0, 100) ?? 'SUMMARY missing';
        const start = block.match(/^DTSTART[^\r\n]*/m)?.[0]?.slice(0, 100) ?? 'DTSTART missing';
        console.log(`BLS public event format: ${summary} · ${start}`);
      }
    }
  }
  if (!bls && bea) {
    const pages = await Promise.all(fedCalendarMonths(now).map(async month => {
      const label = 'NYFed ' + month.toISOString().slice(0, 7);
      return check(label, async () => {
        const response = await fetch(fedCalendarUrl(month), { signal: AbortSignal.timeout(7000) });
        if (!response.ok) throw Error('HTTP ' + response.status);
        if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) throw Error('size limit exceeded');
        const body = await response.text();
        if (body.length > 2_000_000) throw Error('size limit exceeded');
        console.log(label + ': HTTP ' + response.status + ' · ' + body.length + ' characters');
        return body;
      });
    }));
    if (pages.every(Boolean)) {
      try {
        const parsed = parseFedSchedules(pages, bea, Date.now());
        console.log('NYFed/BEA calendar parse: OK · ' + parsed.length + ' selected releases in the next 14 days');
      } catch (error) { console.log('NYFed/BEA calendar parse: ' + error.message); }
    }
  }
}
console.log('Scanner eligibility: 24h gain >=8%, 24h quote volume >=$15m, top 20 by volume, then failed highs and weak buying. Falling coins without a prior pump are outside this strategy.');
console.log('OI/funding, fresh quote, symbol filters and final entry checks occur only after an eligible signal. No orders placed.');
