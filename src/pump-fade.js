import { closedCandles, parseKlines } from './indicators.js';
import { escapeHtml, formatPrice, gstTime, log } from './util.js';

// Informational, experimental detector. No trade or risk-account API.
export function detectPumpFade(rows, now = Date.now()) {
  const c = closedCandles(parseKlines(rows), now).slice(-90);
  if (c.length < 60 || c.at(-1).closeTime !== Math.floor(now / 60000) * 60000 - 1
    || c.some((b, i) => b.close <= 0 || b.low <= 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)
      || b.closeTime - b.openTime !== 59999 || (i && b.openTime - c[i - 1].openTime !== 60000))) return null;
  const last = c.at(-1);
  const peaks = [];
  // Two following CLOSED bars confirm a peak; don't count one wick twice.
  for (let i = c.length - 30; i < c.length - 2; i++) {
    if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high
      && c[i].high >= c[i + 1].high && c[i].high >= c[i + 2].high) peaks.push(i);
  }
  const flow = bars => {
    const total = bars.reduce((s, b) => s + b.quoteVolume, 0);
    if (!(total > 0) || bars.some(b => b.quoteVolume < 0 || b.takerBuyQuoteVolume < 0 || b.takerBuyQuoteVolume > b.quoteVolume)) return null;
    return bars.reduce((s, b) => s + b.takerBuyQuoteVolume, 0) / total;
  };
  const buy = flow(c.slice(-3)), priorBuy = flow(c.slice(-18, -3));
  if (buy === null || priorBuy === null || buy > 0.48 || priorBuy - buy < 0.05
    || last.close >= c.at(-4).close || last.close >= Math.min(c.at(-2).low, c.at(-3).low)) return null;
  for (let b = peaks.length - 1; b >= 1; b--) {
    const j = peaks[b];
    if (c.length - 1 - j > 10) continue;
    for (let a = b - 1; a >= 0; a--) {
      const i = peaks[a];
      if (j - i < 3) continue;
      const level = c[i].high, second = c[j].high;
      const dip = Math.min(...c.slice(i + 1, j).map(x => x.low));
      const base = Math.min(...c.slice(Math.max(0, i - 60), i).map(x => x.low));
      const pumpPct = (level / base - 1) * 100;
      const offHighPct = (1 - last.close / Math.max(level, second)) * 100;
      if (second > level * 1.002 || second < level * 0.995 || dip > level * 0.997
        || c.slice(i + 1).some(x => x.high > level * 1.002)
        || c[i].close > level * 0.998 || c[j].close > second * 0.998
        || pumpPct < 5 || offHighPct < 0.3 || offHighPct > 4) continue;
      return { price: last.close, resistance: Math.max(level, second), pumpPct, offHighPct,
        buyPct: buy * 100, priorBuyPct: priorBuy * 100, peakTime: c[i].closeTime,
        secondPeakTime: c[j].closeTime, barCloseTime: last.closeTime };
    }
  }
  return null;
}

export class PumpFadeRadar {
  constructor({ cfg, binance, store, telegram, excluded = new Set(), isPaused = () => false, now = () => Date.now() }) {
    Object.assign(this, { cfg, binance, store, telegram, excluded, isPaused, now });
    this.running = false; this.stopped = false; this.timer = null;
    this.info = null; this.infoAt = 0; this.cooldowns = new Map(); this.sent = [];
    this.metrics = { polls: 0, checked: 0, alerts: 0, errors: 0 };
    this.lastError = null; this.lastPollAt = null;
  }
  start() {
    if (!this.cfg.enablePumpFadeAlerts || this.timer || this.stopped) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, 60000);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  health() { return { enabled: this.cfg.enablePumpFadeAlerts === true,
    running: this.running, lastPollAt: this.lastPollAt, lastError: this.lastError, ...this.metrics }; }
  async poll() {
    if (!this.cfg.enablePumpFadeAlerts || this.running || this.stopped || this.isPaused()) return;
    this.running = true;
    try {
      if (!this.info || this.now() - this.infoAt > 600000) {
        this.info = await this.binance.exchangeInfo(); this.infoAt = this.now();
      }
      const eligible = new Set((this.info.symbols ?? []).filter(s => s.status === 'TRADING'
        && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT'
        && (!s.underlyingType || s.underlyingType === 'COIN')
        && !(s.underlyingSubType ?? []).some(x => String(x).toLowerCase() === 'meme')
        && !this.excluded.has(s.symbol)).map(s => s.symbol));
      const tickers = await this.binance.ticker24h();
      // Includes >15% gainers excluded by the long-entry universe.
      const candidates = tickers.filter(t => eligible.has(t.symbol)
        && Number(t.priceChangePercent) >= 8 && Number(t.quoteVolume) >= 15000000)
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, 20);
      this.metrics.polls++;
      for (const t of candidates) {
        if (this.stopped || this.isPaused()) break;
        const now = this.now();
        this.sent = this.sent.filter(x => now - x < 3600000);
        if (this.sent.length >= 6) break;
        if (now - (this.cooldowns.get(t.symbol) ?? -Infinity) < 1800000) continue;
        try {
          const rows = await this.binance.klines(t.symbol, '1m', 91);
          this.metrics.checked++;
          const signal = detectPumpFade(rows, this.now());
          if (!signal || this.stopped || this.isPaused()) continue;
          const inserted = await this.store.insertEvent({ event_key: `pump-fade-v1:${t.symbol}:${signal.peakTime}`,
            event_type: 'FUTURES_PUMP_FADE_WARNING', symbol: t.symbol,
            payload: { ...signal, change24h: Number(t.priceChangePercent), model: 'pump-fade-v1', informationalOnly: true } });
          if (inserted === false) { this.cooldowns.set(t.symbol, this.now()); continue; }
          if (this.stopped || this.isPaused() || this.now() - signal.barCloseTime > 90000) continue;
          await this.telegram.send(`⚠️ <b>PUMP FADE — DOWNSIDE RISK INCREASING</b>\n` +
            `${escapeHtml(t.symbol)} · $${formatPrice(signal.price)} · 24h +${Number(t.priceChangePercent).toFixed(1)}%\n` +
            `Two distinct failed highs near $${formatPrice(signal.resistance)}\n` +
            `Prior local rise +${signal.pumpPct.toFixed(1)}% · now ${signal.offHighPct.toFixed(1)}% below the highs\n` +
            `Taker buying weakened: ${signal.priorBuyPct.toFixed(0)}% → ${signal.buyPct.toFixed(0)}% (last 3 closed minutes)\n` +
            `Latest closed minute broke the previous two minutes' lows.\n` +
            `A sustained reclaim above $${formatPrice(signal.resistance)} would weaken this warning.\n` +
            `<i>Possible reversal, not a guaranteed fall or a short-entry signal. No trade opened.</i>\n⏰ ${gstTime()} GST`);
          this.cooldowns.set(t.symbol, this.now()); this.sent.push(this.now()); this.metrics.alerts++;
        } catch (error) { this.metrics.errors++; this.lastError = error.message; log(`Pump-fade ${t.symbol}: ${error.message}`); }
      }
      this.lastPollAt = new Date(this.now()).toISOString();
    } catch (error) { this.metrics.errors++; this.lastError = error.message; log(`Pump-fade poll: ${error.message}`); }
    finally { this.running = false; }
  }
}
