// Fast mover study: what if we had entered every recorded FUTURES_FAST_MOVER alert?
// Read-only. Reads alert events from the database (GET only) and public Binance candles.
// No orders, no trading keys used, no live setting touched.
//   node --env-file=/etc/nexio-fade.env scripts/fast-mover-study.js fetch --days 60
//   node scripts/fast-mover-study.js run
// Options: --days 60  --max 2500  --type FUTURES_FAST_MOVER  --dir /var/tmp/nexio-fast-study
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MIN = 60000, SPAN = 250, NEED = 245;
const FEE = 0.0005, ENTRY_SLIP = 0.001, EXIT_SLIP = 0.0005, RISK_USD = 1.8;
const HORIZONS = [5, 15, 30, 60, 120, 240];
const VARIANTS = [
  { name: 'LONG  stop 1.0% target 1.5R 60m', side: 'LONG', stopPct: 1.0, targetR: 1.5, be: true, holdMin: 60 },
  { name: 'LONG  stop 0.6% target 1.5R 30m', side: 'LONG', stopPct: 0.6, targetR: 1.5, be: true, holdMin: 30 },
  { name: 'LONG  stop 1.5% target 2.0R 4h', side: 'LONG', stopPct: 1.5, targetR: 2, be: false, holdMin: 240 },
  { name: 'SHORT stop 1.0% target 1.5R 60m', side: 'SHORT', stopPct: 1.0, targetR: 1.5, be: true, holdMin: 60 },
  { name: 'SHORT stop 0.6% target 1.5R 30m', side: 'SHORT', stopPct: 0.6, targetR: 1.5, be: true, holdMin: 30 },
  { name: 'SHORT stop 1.5% target 2.0R 4h', side: 'SHORT', stopPct: 1.5, targetR: 2, be: false, holdMin: 240 },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (value, width) => String(value).padEnd(width);
const num = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : 'inf');
const stamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// ---- trade simulation for one alert: entry at the next minute open, same style of exits as the futures bot
export function simulateTrade(getBar, n, i0, v) {
  if (!Number.isInteger(i0) || i0 < 0 || n < i0 + v.holdMin) return null;
  const m = v.side === 'LONG' ? 1 : -1;
  const first = getBar(i0); if (!first) return null;
  const entry = first.open * (1 + (m * ENTRY_SLIP));
  const risk = entry * v.stopPct / 100;
  let stop = entry - (m * risk);
  const target = entry + (m * risk * v.targetR), be1 = entry + (m * risk);
  const breakEven = entry * (1 + (m * ((2 * FEE) + EXIT_SLIP)));
  let moved = false, last = i0;
  const done = (px, market, reason, j) => {
    const ret = (m * (px - entry) / entry) - (2 * FEE) - (market ? EXIT_SLIP : 0);
    return { R: ret / (v.stopPct / 100), reason: reason, holdMin: j - i0 + 1 };
  };
  for (let j = i0; j < n && j < i0 + v.holdMin; j += 1) {
    const b = getBar(j);
    if (!b || ![b.open, b.high, b.low, b.close].every(Number.isFinite)
      || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) return null;
    last = j;
    if (m === 1 ? b.low <= stop : b.high >= stop) return done(m === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open), true, moved ? 'BREAK_EVEN' : 'STOP', j);
    if (m === 1 ? b.high >= target : b.low <= target) return done(target, false, 'TARGET', j);
    if (v.be && !moved && (m === 1 ? b.high >= be1 : b.low <= be1)) { stop = breakEven; moved = true; }
  }
  const lastBar = getBar(last);
  return lastBar ? done(lastBar.close, true, 'TIME', last) : null;
}
export function summarize(rs) {
  const n = rs.length;
  if (!n) return { n: 0, winRate: 0, avgR: 0, lo: 0, hi: 0, pf: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? rs.reduce((a, b) => a + ((b - mean) ** 2), 0) / (n - 1) : 0; const margin = 1.96 * Math.sqrt(variance / n);
  const win = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0), loss = -rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return { n: n, winRate: rs.filter((x) => x > 0).length / n * 100, avgR: mean, lo: mean - margin, hi: mean + margin, pf: loss > 0 ? win / loss : Infinity };
}
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---- data
async function readEvents(days, type) {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Database settings missing. Run with: node --env-file=/etc/nexio-fade.env scripts/fast-mover-study.js fetch');
  const since = new Date(Date.now() - (days * 86400000)).toISOString();
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(url + '/rest/v1/nexio_events?select=created_at,symbol,payload&event_type=eq.' + type + '&created_at=gte.' + since
      + '&order=created_at.asc,id.asc&limit=1000&offset=' + offset, { headers: { apikey: key, authorization: 'Bearer ' + key } });
    if (!res.ok) throw new Error('Database HTTP ' + res.status);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function getCandles(symbol, start) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + symbol + '&interval=1m&limit=' + SPAN + '&startTime=' + start);
    if (res.status === 429 || res.status === 418) { console.log('Rate limited by Binance, waiting 65s'); await sleep(65000); continue; }
    if (res.status === 400) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from Binance');
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  }
  throw new Error('Binance kept rate limiting; try again later');
}
async function fetchAll(dir, days, max, type) {
  await mkdir(dir, { recursive: true });
  const raw = await readEvents(days, type);
  const now = Date.now(); const events = [];
  for (const r of raw) {
    const p = r.payload || {}; const t = Number(p.eventTime) || Date.parse(r.created_at); const price = Number(p.price);
    if (r.symbol && t > 0 && price > 0 && t + ((NEED + 2) * MIN) < now) events.push({ symbol: r.symbol, t: t, p: price, move: Number(p.movePct), accel: Number(p.volumeAccel), buy: Number(p.takerBuyRatio) });
  }
  console.log('Alerts found: ' + raw.length + ' | usable (old enough, with a price): ' + events.length);
  if (events.length < 20) throw new Error('Too few usable alerts to study (' + events.length + ').');
  const use = events.slice(-max);
  if (use.length < events.length) console.log('Using the most recent ' + use.length + ' alerts (cap ' + max + ').');
  const index = []; let offset = 0, skipped = 0;
  const fh = await open(dir + '/candles.f64', 'w');
  try {
    for (let i = 0; i < use.length; i += 1) {
      const ev = use[i]; const start = Math.floor((ev.t - (2 * MIN)) / MIN) * MIN;
      const rows = await getCandles(ev.symbol, start);
      if (!rows || rows.length < NEED) { skipped += 1; continue; }
      if (rows.some((r, j) => Number(r[0]) !== start + j * MIN
        || ![1, 2, 3, 4].every(k => Number.isFinite(Number(r[k])))
        || Number(r[3]) <= 0 || Number(r[2]) < Math.max(Number(r[1]), Number(r[4]))
        || Number(r[3]) > Math.min(Number(r[1]), Number(r[4])))) { skipped += 1; continue; }
      const a = new Float64Array(rows.length * 4);
      rows.forEach((r, j) => { a[j * 4] = Number(r[1]); a[(j * 4) + 1] = Number(r[2]); a[(j * 4) + 2] = Number(r[3]); a[(j * 4) + 3] = Number(r[4]); });
      await fh.write(Buffer.from(a.buffer));
      index.push({ ...ev, start: Number(rows[0][0]), n: rows.length, off: offset }); offset += rows.length;
      if ((i + 1) % 100 === 0) console.log('  ' + (i + 1) + ' / ' + use.length + ' alerts processed');
      await sleep(250);
    }
  } finally { await fh.close(); }
  await writeFile(dir + '/index.json', JSON.stringify(index));
  if (!index.length) throw Error('No complete valid alert windows were fetched');
  console.log('Saved ' + index.length + ' alerts with candles (' + skipped + ' skipped: missing or invalid data), ' + stamp(index[0].t) + ' to ' + stamp(index.at(-1).t) + ' UTC');
}

// ---- study
async function runStudy(dir) {
  const index = JSON.parse(await readFile(dir + '/index.json', 'utf8'));
  if (!Array.isArray(index) || !index.length) throw Error('No alert index entries');
  const buf = await readFile(dir + '/candles.f64');
  const all = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const t0 = index[0].t, t1 = index.at(-1).t, split = t0 + ((t1 - t0) * 0.6);
  console.log('Alerts studied: ' + index.length + ' | ' + stamp(t0) + ' to ' + stamp(t1) + ' UTC (' + ((t1 - t0) / 86400000).toFixed(1) + ' days, about ' + (index.length / Math.max(1, (t1 - t0) / 86400000)).toFixed(1) + ' per day)');
  console.log('Symbols: ' + new Set(index.map((e) => e.symbol)).size);
  const rows = []; const fwd = HORIZONS.map(() => []); const mfe = [], mae = [];
  const runs = VARIANTS.map(() => []);
  for (const ev of index) {
    const getBar = (j) => { if (j < 0 || j >= ev.n) return null; const o = (ev.off + j) * 4; return { open: all[o], high: all[o + 1], low: all[o + 2], close: all[o + 3] }; };
    const i0 = Math.floor((ev.t - ev.start) / MIN) + 1;
    if (i0 < 1 || i0 + 241 > ev.n) continue;
    HORIZONS.forEach((h, k) => { const b = getBar(Math.floor((ev.t + (h * MIN) - ev.start) / MIN) - 1); if (b) fwd[k].push((b.close / ev.p - 1) * 100); });
    const entry = getBar(i0).open; let hi = entry, lo = entry;
    for (let j = i0; j < i0 + 60; j += 1) { const b = getBar(j); hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
    mfe.push((hi / entry - 1) * 100); mae.push((1 - (lo / entry)) * 100);
    VARIANTS.forEach((v, k) => { const r = simulateTrade(getBar, ev.n, i0, v); if (r) runs[k].push({ t: ev.t, entryTime: ev.start + i0 * MIN, exitTime: ev.start + (i0 + r.holdMin) * MIN, symbol: ev.symbol, R: r.R, reason: r.reason, holdMin: r.holdMin }); });
  }
  console.log('\nA) What the price did after each alert (gross, measured from the alert price; costs are about +0.25% round trip):');
  console.log(pad('after', 8) + pad('avg move %', 12) + pad('95% range', 16) + 'share up');
  HORIZONS.forEach((h, k) => {
    const a = fwd[k]; const n = a.length; if (!n) return;
    const mean = a.reduce((x, y) => x + y, 0) / n; const sd = Math.sqrt(a.reduce((x, y) => x + ((y - mean) ** 2), 0) / Math.max(1, n - 1)); const mg = 1.96 * sd / Math.sqrt(n);
    console.log(pad(h + ' min', 8) + pad(num(mean, 3), 12) + pad(num(mean - mg, 2) + '..' + num(mean + mg, 2), 16) + num(a.filter((x) => x > 0).length / n * 100, 1) + '%');
  });
  console.log('\nB) First 60 minutes after entry: median best move ' + num(median(mfe), 2) + '% up, median worst move ' + num(median(mae), 2) + '% down.');
  console.log('\nC) Simulated trades (one per alert, entry at the next minute open + 0.10% slippage, 0.05% fee per side, market exits +0.05% slippage).');
  console.log('   avgR = average result per trade in units of risk; positive is needed. $ = at $1.80 risk per trade.\n');
  console.log(pad('variant', 36) + pad('seg', 6) + pad('trades', 7) + pad('win%', 7) + pad('avgR', 8) + pad('95% range', 14) + pad('PF', 6) + 'net$');
  VARIANTS.forEach((v, k) => {
    for (const [seg, pick] of [['all', () => true], ['train', (x) => x.exitTime < split], ['test', (x) => x.entryTime >= split]]) {
      const sel = runs[k].filter(pick); const s = summarize(sel.map((x) => x.R)); const usd = sel.reduce((a, x) => a + (x.R * RISK_USD), 0);
      console.log(pad(seg === 'all' ? v.name : '', 36) + pad(seg, 6) + pad(s.n, 7) + pad(num(s.winRate, 1), 7) + pad(num(s.avgR, 3), 8) + pad(num(s.lo, 2) + '..' + num(s.hi, 2), 14) + pad(num(s.pf, 2), 6) + (usd < 0 ? '-' : '') + '$' + Math.abs(usd).toFixed(2));
    }
    const reasons = {}; for (const x of runs[k]) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
    console.log(pad('', 36) + 'exits ' + JSON.stringify(reasons) + '\n');
  });
  console.log('How to read: a variant is only worth trusting if avgR is positive in BOTH train and test, with the test 95% range above 0.');
  console.log('Six variants were tried, so a lucky pass is possible: treat a pass as a candidate to confirm on new alerts, not proof.');
  console.log('Ranges above assume independent observations. Repeated/overlapping alerts are correlated; these are descriptive ranges, not validated confidence bounds.');
  console.log('Targets are gross price-risk multiples. This is an alert-direction study, NOT a replay of Fade Auto sizing, partial/runner exits or entry gates.');
  console.log('Trades crossing the 60/40 boundary are excluded from both train/test summaries.');
  await writeFile(dir + '/review-results.json', JSON.stringify({ generatedAt: new Date().toISOString(), variants: VARIANTS, runs }, null, 2));
  console.log('Limits: each alert is simulated on its own (no position cap or daily lock), 1-minute candles, assumed costs, past results do not predict future results.');
  console.log('Peak memory used by this run: ' + Math.round(process.resourceUsage().maxRSS / 1024) + ' MB');
}

async function main() {
  const args = process.argv.slice(2); const command = args[0] || 'help';
  const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const dir = opt('dir', '/var/tmp/nexio-fast-study');
  try {
    if (command === 'fetch') await fetchAll(dir, Number(opt('days', 60)), Number(opt('max', 2500)), opt('type', 'FUTURES_FAST_MOVER'));
    else if (command === 'run') await runStudy(dir);
    else console.log('Usage: fast-mover-study.js fetch --days 60 | run   (options: --max, --type, --dir)');
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Error: no data yet. Run the fetch command first.' : 'Error: ' + error.message);
    process.exit(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
