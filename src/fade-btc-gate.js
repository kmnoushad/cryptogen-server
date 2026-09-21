// Conservative short-entry eligibility, not a forecast. Unknown data blocks entry.
export function fadeBtcGate(rows, book, now) {
  const blocked = reason => ({ allowed: false, reason, checkedAt: now });
  if (!Array.isArray(rows) || rows.some(r => !Array.isArray(r) || !Number.isFinite(r[6]))) return blocked('BTC data unavailable');
  const bars = rows.filter(r => r[6] < now).slice(-120);
  if (bars.length < 120) return blocked('BTC history incomplete');
  for (let i = 0; i < bars.length; i++) {
    const r = bars[i], values = r.slice(1, 5).map(Number);
    if (!Number.isFinite(r[0]) || r[6] !== r[0] + 59999
      || values.some(v => !Number.isFinite(v) || v <= 0)
      || Number(r[2]) < Math.max(Number(r[1]), Number(r[4]))
      || Number(r[3]) > Math.min(Number(r[1]), Number(r[4]))
      || (i && r[0] !== bars[i - 1][0] + 60000)) return blocked('BTC candles invalid or discontinuous');
  }
  const age = now - bars.at(-1)[6];
  const bid = Number(book?.bidPrice), ask = Number(book?.askPrice);
  if (age > 90000 || !(bid > 0 && ask >= bid) || (ask / bid - 1) > 0.001) return blocked('BTC data stale or quote invalid');
  const closes = bars.map(r => Number(r[4]));
  let ema = closes[0];
  const emas = closes.map(c => (ema += (c - ema) * 2 / 21));
  const last = closes.at(-1);
  const r15 = last / closes.at(-16) - 1, r30 = last / closes.at(-31) - 1;
  if (ask / closes.at(-4) - 1 >= 0.0035 || ask / last - 1 >= 0.002) return blocked('BTC upward burst');
  if (r15 >= 0 || r30 >= 0 || last >= emas.at(-1) || ask >= emas.at(-1)
    || emas.at(-1) >= emas.at(-6)) return blocked('BTC bullish or mixed; short gate closed');
  return { allowed: true, reason: 'BTC bearish confirmation', checkedAt: now };
}
