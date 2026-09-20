const toFinite = (value, name) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name} in Twelve Data response.`);
  return parsed;
};

export const parseTwelveDataBars = (payload) => {
  if (payload?.status === 'error' || payload?.code) {
    throw new Error(`Twelve Data: ${payload?.message || 'request failed'}`);
  }
  if (!Array.isArray(payload?.values) || payload.values.length === 0) {
    throw new Error('Twelve Data returned no XAU/USD bars.');
  }
  return payload.values.map((bar) => ({
    time: Date.parse(`${bar.datetime}${bar.datetime.includes('T') ? '' : 'Z'}`),
    datetime: bar.datetime,
    open: toFinite(bar.open, 'open'),
    high: toFinite(bar.high, 'high'),
    low: toFinite(bar.low, 'low'),
    close: toFinite(bar.close, 'close'),
  })).filter((bar) => Number.isFinite(bar.time)).sort((a, b) => a.time - b.time);
};

export class TwelveDataGoldFeed {
  constructor({ twelveDataApiKey, symbol, interval, outputSize }) {
    this.apiKey = twelveDataApiKey;
    this.symbol = symbol;
    this.interval = interval;
    this.outputSize = outputSize;
  }

  get ready() {
    return Boolean(this.apiKey);
  }

  async bars() {
    if (!this.ready) throw new Error('TWELVE_DATA_API_KEY is not configured.');
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', this.symbol);
    url.searchParams.set('interval', this.interval);
    url.searchParams.set('outputsize', String(this.outputSize));
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('format', 'JSON');
    url.searchParams.set('apikey', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'CryptoNerd-GoldWatch/0.1' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}`);
      return parseTwelveDataBars(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}

