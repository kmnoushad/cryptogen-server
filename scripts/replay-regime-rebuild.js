// Public historical files only. No credentials, exchange client or live imports.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { regimeEntry, REGIME_MODELS } from '../src/regime-entry-models.js';
import { aggregate, readSeries } from './replay-entry-rebuild.js';
const windowAt = (rows, time, interval) => {
  const end = Math.max(0, Math.min(rows.length, Math.floor((time - rows[0][0]) / interval)));
  return rows.slice(Math.max(0, end - 80), end);
};
const MIN = 60000;
async function main() {
  const [root, output] = process.argv.slice(2); if (!root || !output) throw Error('Usage: replay-entry-rebuild.js DATA OUT');
  const manifest = JSON.parse(await readFile(root + '/manifest.json', 'utf8'));
  const data = new Map(), symbols = manifest.universe, counts = {}, events = [], cooldown = new Map(), excluded = [];
  for (const symbol of symbols) {
    if (manifest.files[symbol]?.status !== 'complete') continue;
    let rows;
    try { rows = readSeries(await readFile(root + '/' + manifest.files[symbol].file), manifest.start, manifest.end); }
    catch (error) { excluded.push({ symbol, reason: error.message }); continue; }
    const prefix = [0]; for (const row of rows) prefix.push(prefix.at(-1) + row[6]);
    data.set(symbol, { rows, prefix, m5: aggregate(rows, 5), m15: aggregate(rows, 15) });
  }
  const majors = new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT']);
  const btc = data.get('BTCUSDT'); if (!btc) throw Error('BTC context missing');
  for (let i = 1440; i < btc.rows.length - 241; i++) {
    const time = btc.rows[i][0] + MIN;
    const eligible = [...data].map(([symbol, d]) => ({ symbol, gain: (d.rows[i][4] / d.rows[i - 1440][4] - 1) * 100,
      quote: d.prefix[i + 1] - d.prefix[i + 1 - 1440] })).filter(x => x.gain >= 8 && x.quote >= 15000000)
      .sort((a, b) => b.quote - a.quote || a.symbol.localeCompare(b.symbol)).slice(0, 20);
    const rank = new Map(eligible.map(x => [x.symbol, x]));
    const toKline = r => [r[0], r[1], r[2], r[3], r[4], r[5], r[0]+MIN-1, r[6], 0, 0, r[7]];
    const btc1 = btc.rows.slice(Math.max(0, i-89), i+1).map(toKline);
    for (const [symbol, d] of data) {
      const m5 = windowAt(d.m5, time, 5 * MIN), m15 = windowAt(d.m15, time, 15 * MIN);
      for (const model of REGIME_MODELS) {
        if (model === 'failedReclaimFade1' ? !rank.has(symbol) : !majors.has(symbol) || time % (5 * MIN)) continue;
        const key = model + ':' + symbol; if (time < (cooldown.get(key) ?? 0)) continue;
        const signal = regimeEntry({ model, symbol, m1: d.rows.slice(i-89, i+1).map(toKline), m5, btc1, now: time,
          gain24h: rank.get(symbol)?.gain, quote24h: rank.get(symbol)?.quote });
        const label = model + ':' + (signal.candidate ? 'candidate' : signal.reason);
        counts[label] = (counts[label] ?? 0) + 1;
        if (signal.candidate) { events.push({ ...signal, time, barIndex: i }); cooldown.set(key, time + 30 * MIN); }
      }
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(output + '/regime-signals.json', JSON.stringify(events));
  await writeFile(output + '/regime-replay.json', JSON.stringify({ evaluationStart: manifest.evaluationStart,
    end: manifest.end, included: [...data.keys()], excluded, counts, models: REGIME_MODELS, liveOrders: false,
    note: 'Previously inspected history; temporal partitions are reused confirmation, not untouched holdout. Current-listing sample and sampled-universe top20.' }, null, 2));
  console.log(JSON.stringify({ signals: events.length, counts }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
