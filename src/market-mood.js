import { AltcoinBreadth, BREADTH_RULES } from './paper-recovery.js';
import { escapeHtml, gstTime } from './util.js';

const ageValid = (at, now, max) => Number.isFinite(at) && now >= at && now - at <= max;
const number = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : 'unavailable';
const signed = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}` : 'unavailable';
const eventTime = time => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai',
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(time);

export function marketAssessment(btc, breadth, now = Date.now()) {
  const btcValid = btc?.stale === false && ageValid(btc.at, now, 180000)
    && Number.isFinite(btc.h15?.score) && Number.isFinite(btc.h30?.score);
  // Breadth strength filters are NOT data-quality filters: a falling sample
  // is valid evidence of weakness, even though it fails the long recovery gate.
  const breadthValid = !!breadth && ageValid(breadth.observedAt, now, BREADTH_RULES.maxAgeMs)
    && ageValid(breadth.barCloseTime, now, BREADTH_RULES.maxBarAgeMs)
    && ageValid(breadth.selectedAt, now, BREADTH_RULES.maxUniverseAgeMs)
    && breadth.valid >= 20 && breadth.requested >= breadth.valid
    && breadth.valid / breadth.requested >= 0.8
    && Number.isFinite(breadth.upPct) && Number.isFinite(breadth.medianPct);
  let mood = 'INSUFFICIENT DATA';
  if (btcValid && breadthValid) {
    if (btc.h15.score >= 20 && btc.h30.score > 0 && breadth.upPct >= 60 && breadth.medianPct >= 0.1) mood = 'BULLISH';
    else if (btc.h15.score <= -20 && btc.h30.score < 0 && breadth.upPct <= 40 && breadth.medianPct <= -0.1) mood = 'BEARISH';
    else mood = 'MIXED / SIDEWAYS';
  }
  return { mood, btcValid, breadthValid };
}

export function marketReport({ btc, breadth, calendarHealth, events = [], error = null,
  calendarRefreshMs = 21600000 }, now = Date.now()) {
  const a = marketAssessment(btc, breadth, now);
  const health = calendarHealth;
  const calendarFresh = health?.enabled && health.configured && !health.lastError
    && ageValid(Date.parse(health.lastFetchAt), now, Math.min(86400000, calendarRefreshMs + 900000));
  const visible = events.filter(e => Number.isFinite(e.eventTime)
    && e.eventTime >= now - 900000 && e.eventTime <= now + 72 * 3600000)
    .sort((a, b) => a.eventTime - b.eventTime);
  const near = visible.some(e => e.eventTime <= now + 3600000);
  const risk = !calendarFresh ? 'UNKNOWN — calendar unavailable/stale'
    : near ? 'ELEVATED — high-impact release within 60m or released in the last 15m'
      : 'No loaded high-impact release within the next hour';
  const lines = [
    '🌍 <b>MARKET MOOD</b>',
    `Current 15–30m bias: <b>${a.mood}</b>`,
    'Observed conditions, not a price forecast or probability.',
    a.btcValid ? `BTC: 15m ${escapeHtml(btc.h15.label)} (${signed(btc.h15.score)}) · 30m ${escapeHtml(btc.h30.label)} (${signed(btc.h30.score)})`
      : 'BTC bias: unavailable/stale — not used',
    a.breadthValid ? `Liquid altcoins, closed 15m: ${breadth.up}/${breadth.valid} rising (${number(breadth.upPct, 0)}%) · median ${signed(breadth.medianPct)}% · coverage ${breadth.valid}/${breadth.requested}`
      : 'Altcoin breadth: unavailable/stale or insufficient coverage — not used',
  ];
  if (a.btcValid) {
    const i = btc.indicators ?? {};
    lines.push(`BTC taker buying (15m): ${Number.isFinite(i.buyRatio15m) ? number(i.buyRatio15m * 100, 0) + '%' : 'unavailable'}`,
      `BTC funding: ${Number.isFinite(i.fundingPct) ? number(i.fundingPct, 3) + '%' : 'unavailable'} · OI change: ${Number.isFinite(i.oiChgPct) ? signed(i.oiChgPct) + '%' : 'unavailable'}`);
    if (i.fundingPct > 0.03) lines.push('Positioning: elevated positive funding — possible long crowding; not a sell signal.');
    else if (i.fundingPct < -0.03) lines.push('Positioning: deeply negative funding — possible short crowding/squeeze risk; not a buy signal.');
    else lines.push('Positioning: no extreme funding reading, or funding unavailable.');
    const drivers = (btc.h15.drivers ?? []).slice(0, 3);
    if (drivers.length) lines.push(`BTC drivers: ${drivers.map(escapeHtml).join(' · ')}`);
  }
  lines.push('', `<b>Event risk: ${risk}</b>`);
  if (!calendarFresh) lines.push(`⚠️ ${escapeHtml(health?.lastError ?? 'Calendar is disabled, unconfigured, or its last successful fetch is stale.')} · /events`,
    'An empty calendar does not mean no events. Any listed cached times are unverified.');
  for (const e of visible.slice(0, 5)) lines.push(`• ${eventTime(e.eventTime)} GST — ${escapeHtml(e.name)}${e.eventTime <= now ? ' · just released' : ''}`);
  if (!visible.length && calendarFresh) lines.push('No high-impact US releases loaded for the next 72 hours.');
  lines.push('A scheduled release signals possible volatility, not direction. Actual results, expectations and the market reaction are not evaluated here.',
    '', a.mood === 'BEARISH' ? 'Context: BTC and broad altcoin weakness agree; pump-fade warnings fit the current backdrop. Individual coins can still squeeze higher.'
      : a.mood === 'BULLISH' ? 'Context: BTC and broad altcoin strength agree; a pump-fade warning may be a local pullback within a rising market.'
        : 'Context: broad direction is unclear; do not treat a single coin warning as market-wide confirmation.',
    'Sentiment inputs are market positioning/flow proxies. Social posts, news sentiment and Fear & Greed are not loaded.',
    `⏰ ${gstTime(new Date(now))} GST · /market refreshes this report`);
  if (error) lines.push(`⚠️ Latest market refresh: ${escapeHtml(error)}`);
  return lines.join('\n');
}

export class MarketMood {
  constructor({ cfg, binance, btcBias, calendar, excluded = new Set(), now = () => Date.now() }) {
    Object.assign(this, { cfg, binance, btcBias, calendar, excluded, now });
    this.breadth = new AltcoinBreadth(binance);
    this.inflight = null; this.lastAttempt = null; this.error = null;
  }
  async refresh() {
    if (this.inflight) return this.inflight;
    if (this.lastAttempt !== null && this.now() - this.lastAttempt < 60000) return;
    this.lastAttempt = this.now();
    this.inflight = (async () => {
      this.error = null;
      try {
        if (this.breadth.selectedAt === null || this.now() - this.breadth.selectedAt >= 300000) {
          const [info, tickers] = await Promise.all([this.binance.exchangeInfo(), this.binance.ticker24h()]);
          this.breadth.setUniverse(info, tickers, this.cfg.min24hQuoteVolumeUsd, this.excluded, this.now());
        }
        await this.breadth.refresh(this.now());
      } catch (error) { this.error = error.message; }
      // Uses the calendar's own refresh throttle; no reminder side effects.
      try { if (this.calendar?.configured()) await this.calendar.refresh(this.now()); }
      catch (error) { this.error = [this.error, `calendar: ${error.message}`].filter(Boolean).join('; '); }
    })();
    try { await this.inflight; } finally { this.inflight = null; }
  }
  async report() {
    await this.refresh();
    const btc = this.cfg.enableBtcFeed ? this.btcBias?.evaluate() : null;
    return marketReport({ btc, breadth: this.breadth.snapshot, calendarHealth: this.calendar?.health(),
      events: this.calendar?.events ?? [], error: this.error, calendarRefreshMs: this.cfg.economicCalendarRefreshMs }, this.now());
  }
}
