import { requestJson } from './http.js';
import { escapeHtml, gstTime, log, sleep } from './util.js';

const FINNHUB_CALENDAR_URL = 'https://finnhub.io/api/v1/calendar/economic';
const DAY_MS = 24 * 60 * 60_000;

const dubaiDate = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));

const dubaiHour = value => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23',
}).format(new Date(value)));

const dubaiEventTime = value => new Date(value).toLocaleString('en-GB', {
  timeZone: 'Asia/Dubai', weekday: 'short', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

const parseEventTime = value => {
  if (value !== null && value !== undefined && Number.isFinite(Number(value)) && String(value).trim() !== '') {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = hasZone ? text : `${text.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const highImpact = value => Number(value) === 3 || String(value ?? '').trim().toLowerCase() === 'high';

export const parseFinnhubCalendar = payload => {
  const rows = Array.isArray(payload?.economicCalendar) ? payload.economicCalendar : [];
  const unique = new Map();
  for (const row of rows) {
    const country = String(row?.country ?? '').trim().toUpperCase();
    if (!['US', 'UNITED STATES'].includes(country) || !highImpact(row?.impact)) continue;
    const name = String(row?.event ?? row?.name ?? row?.indicator ?? '').trim();
    const eventTime = parseEventTime(row?.time ?? row?.datetime ?? row?.timestamp);
    if (!name || !Number.isFinite(eventTime)) continue;
    const key = `${eventTime}:${name.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, { name, eventTime, country: 'US', impact: 'HIGH' });
  }
  return [...unique.values()].sort((a, b) => a.eventTime - b.eventTime);
};

const reminderStage = minutesUntil => {
  if (minutesUntil < -10 || minutesUntil > 240) return null;
  if (minutesUntil <= 0) return { key: 'NOW', label: 'happening NOW', icon: '🔴', action: 'Data is releasing. Do not chase the first candle.' };
  if (minutesUntil <= 15) return { key: 'T15', label: `in ${Math.max(1, Math.ceil(minutesUntil))} minutes`, icon: '🔴', action: 'Final warning: reduce exposure and tighten stops.' };
  if (minutesUntil <= 30) return { key: 'T30', label: `in ${Math.ceil(minutesUntil)} minutes`, icon: '⚠️', action: 'Prepare for a volatility burst in either direction.' };
  if (minutesUntil <= 45) return { key: 'T45', label: `in ${Math.ceil(minutesUntil)} minutes`, icon: '⚠️', action: 'Review open positions before the data window.' };
  if (minutesUntil <= 60) return { key: 'T60', label: `in ${Math.ceil(minutesUntil)} minutes`, icon: '⚠️', action: 'Avoid entering late moves immediately before the release.' };
  return { key: 'T240', label: `in about ${Math.max(1, Math.round(minutesUntil / 60))} hour(s)`, icon: '📅', action: 'Plan open positions around the release window.' };
};

const eventIdentity = event => `${event.eventTime}:${event.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)}`;

export class EconomicCalendar {
  constructor({ cfg, store, telegram, fetcher = requestJson }) {
    this.cfg = cfg;
    this.store = store;
    this.telegram = telegram;
    this.fetcher = fetcher;
    this.events = [];
    this.lastFetchAt = 0;
    this.lastAttemptAt = 0;
    this.lastError = null;
    this.running = false;
    this.stopping = false;
    this.metrics = { fetches: 0, reminders: 0, errors: 0 };
  }

  configured() {
    return this.cfg.enableEconomicCalendar && Boolean(this.cfg.finnhubKey);
  }

  async initialize(now = Date.now()) {
    if (!this.configured()) {
      if (this.cfg.enableEconomicCalendar) log('Economic calendar enabled but FINNHUB_KEY is missing');
      return;
    }
    await this.refresh(now);
    await this.sendDue(now);
  }

  async refresh(now = Date.now(), { force = false } = {}) {
    if (!this.configured()) return { skipped: 'not configured' };
    const refreshAfter = this.lastError
      ? Math.min(this.cfg.economicCalendarRefreshMs, 15 * 60_000)
      : this.cfg.economicCalendarRefreshMs;
    if (!force && now - this.lastAttemptAt < refreshAfter) return { skipped: 'cached' };
    this.lastAttemptAt = now;
    const from = new Date(now).toISOString().slice(0, 10);
    const to = new Date(now + 14 * DAY_MS).toISOString().slice(0, 10);
    const url = `${FINNHUB_CALENDAR_URL}?${new URLSearchParams({ from, to, token: this.cfg.finnhubKey })}`;
    try {
      const payload = await this.fetcher(url, { timeoutMs: 15_000, retries: 1 });
      if (!Array.isArray(payload?.economicCalendar)) {
        throw new Error(`Finnhub returned no economicCalendar list${payload?.error ? `: ${payload.error}` : ''}`);
      }
      const parsed = parseFinnhubCalendar(payload);
      this.events = parsed.filter(event => event.eventTime >= now - 60 * 60_000 && event.eventTime <= now + 14 * DAY_MS);
      this.lastFetchAt = now;
      this.lastError = null;
      this.metrics.fetches++;
      log(`Economic calendar: ${this.events.length} US high-impact event(s) loaded`);
      return { loaded: this.events.length };
    } catch (error) {
      this.lastError = error.message;
      this.metrics.errors++;
      log(`Economic calendar fetch failed (trading unaffected): ${error.message}`);
      return { error: error.message };
    }
  }

  async sendOnce(eventKey, eventType, payload, message) {
    const reserved = await this.store.insertEvent({
      event_key: eventKey,
      event_type: eventType,
      symbol: '[ECONOMIC]',
      payload,
    });
    if (!reserved) return false;
    try {
      await this.telegram.send(message);
      this.metrics.reminders++;
      return true;
    } catch (error) {
      // Release the reservation so the next scan can retry a failed Telegram send.
      await this.store.deleteEvent(eventKey).catch(() => {});
      throw error;
    }
  }

  async sendMorningSummary(now = Date.now()) {
    const hour = dubaiHour(now);
    if (hour < 8 || hour > 10) return;
    const today = dubaiDate(now);
    const allTodayEvents = this.events.filter(event => dubaiDate(event.eventTime) === today && event.eventTime > now);
    const todayEvents = allTodayEvents.slice(0, 12);
    if (!todayEvents.length) return;
    const eventKey = `economic:morning:${today}`;
    const more = allTodayEvents.length > todayEvents.length ? `\n• +${allTodayEvents.length - todayEvents.length} more; use /events` : '';
    const lines = todayEvents.map(event => `• ${dubaiEventTime(event.eventTime)} GST — ${escapeHtml(event.name)}`).join('\n') + more;
    await this.sendOnce(eventKey, 'ECONOMIC_MORNING_SUMMARY', {
      dubaiDate: today,
      events: todayEvents,
    }, `📅 <b>TODAY'S HIGH-IMPACT US EVENTS</b>\n━━━━━━━━━━━━━━━\n${lines}\n\n` +
      `<i>Information only · trade scoring and risk gates are unchanged</i>\n⏰ ${gstTime(new Date(now))} GST`);
  }

  async sendDue(now = Date.now()) {
    if (!this.configured() || !this.events.length) return;
    try {
      await this.sendMorningSummary(now);
      for (const event of this.events) {
        const minutesUntil = (event.eventTime - now) / 60_000;
        const stage = reminderStage(minutesUntil);
        if (!stage) continue;
        const eventKey = `economic:${eventIdentity(event)}:${stage.key}`;
        await this.sendOnce(eventKey, 'ECONOMIC_REMINDER', {
          name: event.name,
          eventTime: new Date(event.eventTime).toISOString(),
          stage: stage.key,
          minutesUntil,
        }, `${stage.icon} <b>HIGH-IMPACT US EVENT</b>\n` +
          `<b>${escapeHtml(event.name)}</b> — ${stage.label}\n` +
          `🕐 ${dubaiEventTime(event.eventTime)} GST\n\n` +
          `${escapeHtml(stage.action)}\n` +
          `<i>Information only · direction is unknown · Futures/Alpha logic unchanged</i>\n` +
          `⏰ ${gstTime(new Date(now))} GST`);
      }
    } catch (error) {
      this.lastError = `reminder: ${error.message}`;
      this.metrics.errors++;
      log(`Economic reminder failed (will retry): ${error.message}`);
    }
  }

  async scan({ force = false, now = Date.now() } = {}) {
    if (!this.configured()) return { skipped: 'not configured' };
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    try {
      const refresh = await this.refresh(now, { force });
      await this.sendDue(now);
      return refresh;
    } finally {
      this.running = false;
    }
  }

  async runLoop() {
    while (!this.stopping) {
      const started = Date.now();
      try { await this.scan(); }
      catch (error) {
        this.lastError = error.message;
        this.metrics.errors++;
        log(`Economic calendar loop error (trading unaffected): ${error.message}`);
      }
      await sleep(Math.max(1_000, 30_000 - (Date.now() - started)));
    }
  }

  stop() {
    this.stopping = true;
  }

  upcoming(now = Date.now(), days = 14) {
    return this.events.filter(event => event.eventTime > now && event.eventTime <= now + days * DAY_MS);
  }

  message(now = Date.now()) {
    if (!this.cfg.enableEconomicCalendar) return '📅 Economic calendar is disabled.';
    if (!this.cfg.finnhubKey) return '📅 Economic calendar is ON, but FINNHUB_KEY is missing in Railway.';
    const upcoming = this.upcoming(now);
    const lines = upcoming.slice(0, 15).map(event => `• ${dubaiEventTime(event.eventTime)} GST — ${escapeHtml(event.name)}`);
    return `📅 <b>UPCOMING HIGH-IMPACT US EVENTS</b>\n` +
      `${this.lastError ? `⚠️ Last API error: ${escapeHtml(this.lastError)}\n` : '🟢 Finnhub live calendar loaded\n'}` +
      `━━━━━━━━━━━━━━━\n` +
      `${lines.length ? lines.join('\n') : 'No US high-impact events currently loaded for the next 14 days.'}\n\n` +
      `<i>Information only · does not block or score trades</i>`;
  }

  health() {
    return {
      enabled: this.cfg.enableEconomicCalendar,
      configured: this.configured(),
      loaded: this.events.length,
      lastFetchAt: this.lastFetchAt ? new Date(this.lastFetchAt).toISOString() : null,
      lastError: this.lastError,
      metrics: this.metrics,
    };
  }
}
