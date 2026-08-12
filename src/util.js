export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const pctChange = (from, to) => from > 0 ? ((to - from) / from) * 100 : 0;

export const gstTime = (date = new Date()) => date.toLocaleTimeString('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Dubai',
});

export const log = (...args) => console.log(`[${gstTime()} GST]`, ...args);

export const escapeHtml = value => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export const formatPrice = value => {
  const p = finite(value);
  if (p >= 1_000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(8);
  return p.toPrecision(5);
};

export const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(runners);
  return results;
};

export const dubaiDayBounds = (date = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const startMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 4 * 3_600_000;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 3_600_000).toISOString(),
    label: `${parts.year}-${parts.month}-${parts.day}`,
  };
};

export const consecutiveLosses = trades => {
  let count = 0;
  for (const trade of trades) {
    if (trade.outcome === 'LOSS') count++;
    else if (trade.outcome === 'WIN') break;
  }
  return count;
};
