import test from 'node:test';
import assert from 'node:assert/strict';
import { EconomicCalendar, parseFinnhubCalendar } from '../src/calendar.js';

const cfg = {
  enableEconomicCalendar: true,
  finnhubKey: 'test-key',
  economicCalendarRefreshMs: 6 * 60 * 60_000,
};

const storeDouble = () => {
  const keys = new Set();
  const events = [];
  return {
    events,
    insertEvent: async event => {
      if (keys.has(event.event_key)) return false;
      keys.add(event.event_key);
      events.push(event);
      return true;
    },
    deleteEvent: async key => { keys.delete(key); return true; },
  };
};

test('Finnhub parser keeps only unique US high-impact events and treats unzoned time as UTC', () => {
  const parsed = parseFinnhubCalendar({ economicCalendar: [
    { country: 'US', impact: 'high', event: 'CPI Inflation', time: '2026-08-10 12:30:00' },
    { country: 'US', impact: 3, event: 'CPI Inflation', time: '2026-08-10 12:30:00' },
    { country: 'GB', impact: 'high', event: 'UK CPI', time: '2026-08-10 06:00:00' },
    { country: 'US', impact: 'low', event: 'Minor release', time: '2026-08-10 14:00:00' },
  ] });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'CPI Inflation');
  assert.equal(parsed[0].eventTime, Date.parse('2026-08-10T12:30:00Z'));
});

test('calendar sends one staged reminder and deduplicates it through nexio_events', async () => {
  const now = Date.parse('2026-08-10T12:15:00Z');
  const messages = [];
  const store = storeDouble();
  const calendar = new EconomicCalendar({
    cfg,
    store,
    telegram: { send: async message => messages.push(message) },
    fetcher: async () => ({ economicCalendar: [
      { country: 'US', impact: 'high', event: 'CPI Inflation', time: '2026-08-10 12:30:00' },
    ] }),
  });
  await calendar.scan({ force: true, now });
  await calendar.sendDue(now);

  assert.equal(messages.length, 1);
  assert.match(messages[0], /CPI Inflation/);
  assert.match(messages[0], /in 15 minutes/);
  assert.match(messages[0], /Futures\/Alpha logic unchanged/);
  assert.equal(store.events.filter(event => event.event_type === 'ECONOMIC_REMINDER').length, 1);
});

test('calendar API failure is visible but never throws into the trading engine', async () => {
  const calendar = new EconomicCalendar({
    cfg,
    store: storeDouble(),
    telegram: { send: async () => {} },
    fetcher: async () => { throw new Error('subscription does not include calendar'); },
  });
  const result = await calendar.scan({ force: true, now: Date.parse('2026-08-10T00:00:00Z') });
  assert.match(result.error, /subscription/);
  assert.match(calendar.health().lastError, /subscription/);
});

test('failed Telegram reminder releases its dedupe key and retries next cycle', async () => {
  const now = Date.parse('2026-08-10T12:15:00Z');
  const store = storeDouble();
  let attempts = 0;
  const calendar = new EconomicCalendar({
    cfg,
    store,
    telegram: { send: async () => { attempts++; if (attempts === 1) throw new Error('Telegram unavailable'); } },
    fetcher: async () => ({ economicCalendar: [
      { country: 'US', impact: 3, event: 'FOMC Rate Decision', time: '2026-08-10 12:30:00' },
    ] }),
  });
  await calendar.scan({ force: true, now });
  await calendar.sendDue(now);
  assert.equal(attempts, 2);
  assert.equal(calendar.metrics.reminders, 1);
});
