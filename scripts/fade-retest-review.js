// Read-only research: see whether late pump-fade alerts revisited the existing
// 1% entry band before invalidation. No trade, fill, profit or order inference.
import { loadFadeConfig } from '../src/fade-config.js';
import { Store } from '../src/store.js';
import { requestJson } from '../src/http.js';
import { reviewFadeRetest } from '../src/fade-retest-review.js';

const now = Date.now(), cfg = loadFadeConfig(), store = new Store(cfg);
const since = new Date(now - 24 * 3600000).toISOString();
const events = await store.get('nexio_events', [['event_type', 'eq.FADE_WORKER_SIGNAL_V1'],
  ['created_at', `gte.${since}`], ['select', 'created_at,symbol,payload'],
  ['order', 'created_at.desc'], ['limit', '100']]);
if (!Array.isArray(events)) throw Error('Signal history unavailable');
const counts = { matured_late: 0, retested_band_first: 0, invalidated_first: 0, no_retest: 0,
  unknown: 0, already_within_band: 0, not_matured: 0 };
console.log(`FADE RETEST READ-ONLY REVIEW · ${new Date(now).toISOString()} · newest 100 handoffs in 24h`);
for (const event of events) {
  const signal = event.payload, price = Number(signal?.price), high = Number(signal?.resistance);
  const barClose = Number(signal?.barCloseTime);
  if (!(price > 0 && high > price && Number.isFinite(barClose))) { counts.unknown++; continue; }
  if (price >= high * 0.99) { counts.already_within_band++; continue; }
  if (now < barClose + 30 * 60000 + 1) { counts.not_matured++; continue; }
  counts.matured_late++;
  let result = 'unknown';
  try {
    const start = barClose + 1;
    const url = `https://fapi.binance.com/fapi/v1/klines?${new URLSearchParams({
      symbol: event.symbol, interval: '1m', startTime: String(start),
      endTime: String(start + 30 * 60000 - 1), limit: '30',
    })}`;
    const rows = await requestJson(url, { retries: 0, timeoutMs: 7000 });
    result = reviewFadeRetest(signal, rows);
  } catch { /* Delisted symbols, rate limits and missing data remain unknown. */ }
  counts[result]++;
}
console.log(`Already within 1% at alert: ${counts.already_within_band} · too recent: ${counts.not_matured} · matured late alerts: ${counts.matured_late}`);
console.log(`Late alerts: band revisited before invalidation ${counts.retested_band_first} · failed high crossed first ${counts.invalidated_first} · no retest within 30m ${counts.no_retest} · unknown ${counts.unknown}`);
console.log('A band touch is not a fill or a valid short. Closed 1m highs cannot show the order of moves inside a candle; same-bar invalidation is counted first. BTC, funding, fees, execution and subsequent PnL are excluded. No orders placed.');
