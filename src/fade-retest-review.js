// Historical price-path observation, not a trading rule or fill simulation.
export function reviewFadeRetest(signal, rows, minutes = 30) {
  const high = Number(signal?.resistance), price = Number(signal?.price);
  const start = Number(signal?.barCloseTime) + 1;
  if (!(high > price && price > 0 && Number.isFinite(start)) || !Array.isArray(rows) || rows.length !== minutes) return 'unknown';
  for (let i = 0; i < minutes; i++) {
    const row = rows[i], time = Number(row?.[0]), peak = Number(row?.[2]);
    if (!Array.isArray(row) || time !== start + i * 60000 || Number(row[6]) !== time + 59999
      || !(peak > 0) || !Number.isFinite(peak)) return 'unknown';
    // An invalidation in the same 1m candle wins; intrabar ordering is unknown.
    if (peak >= high) return 'invalidated_first';
    if (peak >= high * 0.99) return 'retested_band_first';
  }
  return 'no_retest';
}
