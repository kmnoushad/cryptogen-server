// Public historical files only. No credentials, exchange client or live imports.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { researchEntry, REBUILD_MODELS } from '../src/research-entry-models.js';
export function readSeries(buffer, start, end) {
  if (buffer.length !== (end - start) / 60000 * 64) throw Error('Incomplete continuous data');
  const rows = [];
  for (let i = 0; i < buffer.length; i += 64) {
    const r = Array.from({ length: 8 }, (_, j) => buffer.readDoubleLE(i + j * 8));
    if (!r.every(Number.isFinite) || r[0] !== start + i / 64 * 60000 || r[3] <= 0
      || r[2] < Math.max(r[1], r[4]) || r[3] > Math.min(r[1], r[4])
      || r[5] < 0 || r[6] < 0 || r[7] < 0 || r[7] > r[6]) throw Error('Malformed continuous data');
    rows.push(r);
  }
  return rows;
}
const windowAt = (rows, time, interval) => {
  const end = Math.max(0, Math.min(rows.length, Math.floor((time - rows[0][0]) / interval)));
  return rows.slice(Math.max(0, end - 80), end);
};
const MIN = 60000;
export function aggregate(rows, minutes) {
  const out = [], interval = minutes * MIN;
  for (let i = 0; i + minutes <= rows.length; i++) {
    if (rows[i][0] % interval) continue;
    const group = rows.slice(i, i + minutes);
    if (group.at(-1)[0] !== rows[i][0] + interval - MIN) throw Error('Aggregation gap');
    out.push([rows[i][0], group[0][1], Math.max(...group.map(x => x[2])),
      Math.min(...group.map(x => x[3])), group.at(-1)[4], group.reduce((s, x) => s + x[5], 0),
      rows[i][0] + interval - 1, group.reduce((s, x) => s + x[6], 0), 0, 0,
      group.reduce((s, x) => s + x[7], 0)]);
    i += minutes - 1;
  }
  return out;
}
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
    const time = btc.rows[i][0] + MIN; if (time % (5 * MIN)) continue;
    const eligible = [...data].map(([symbol, d]) => ({ symbol, gain: (d.rows[i][4] / d.rows[i - 1440][4] - 1) * 100,
      quote: d.prefix[i + 1] - d.prefix[i + 1 - 1440] })).filter(x => x.gain >= 8 && x.quote >= 15000000)
      .sort((a, b) => b.quote - a.quote || a.symbol.localeCompare(b.symbol)).slice(0, 20);
    const rank = new Map(eligible.map(x => [x.symbol, x]));
    const btc15 = windowAt(btc.m15, time, 15 * MIN);
    for (const [symbol, d] of data) {
      const m5 = windowAt(d.m5, time, 5 * MIN), m15 = windowAt(d.m15, time, 15 * MIN);
      for (const model of REBUILD_MODELS) {
        if (model === 'auctionFade5' ? !rank.has(symbol) : !majors.has(symbol)) continue;
        const key = model + ':' + symbol; if (time < (cooldown.get(key) ?? 0)) continue;
        const signal = researchEntry({ model, symbol, m5, m15, btc15, now: time,
          gain24h: rank.get(symbol)?.gain, quote24h: rank.get(symbol)?.quote });
        const label = model + ':' + (signal.allowed ? 'candidate' : signal.reason);
        counts[label] = (counts[label] ?? 0) + 1;
        if (signal.allowed) { events.push({ ...signal, time, barIndex: i }); cooldown.set(key, time + 30 * MIN); }
      }
    }
  }
  await mkdir(output, { recursive: true });
  await writeFile(output + '/entry-signals.json', JSON.stringify(events));
  await writeFile(output + '/entry-replay.json', JSON.stringify({ evaluationStart: manifest.evaluationStart,
    end: manifest.end, included: [...data.keys()], excluded, counts, models: REBUILD_MODELS, liveOrders: false,
    note: 'Previously inspected history; temporal partitions are reused confirmation, not untouched holdout. Current-listing sample and sampled-universe top20.' }, null, 2));
  console.log(JSON.stringify({ signals: events.length, counts }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
