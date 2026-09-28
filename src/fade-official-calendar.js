// Public US agency schedules. Strict parsing and coverage checks: unknown feed
// formats never turn a calendar outage into an all-clear.
import { requestJson } from './http.js';

const BLS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BEA_URL = 'https://apps.bea.gov/API/signup/release_dates.json';
const BLS_HIGH_IMPACT = /employment situation|consumer price index|producer price index|job openings|employment cost index/i;
const BEA_HIGH_IMPACT = /gross domestic product|personal income and outlays|international trade in goods and services/i;
// Published Fed meeting end dates. Block each decision day in UTC;
// update from the Fed before trading in 2028 or after any schedule change.
const FED_DECISION_DAYS_2026 = new Set(['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']);
const FED_DECISION_DAYS_2027 = new Set(['2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09',
  '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08']);

const blsDate = line => {
  const match = /^DTSTART(?:;TZID=([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i.exec(line);
  if (!match) throw Error('BLS calendar date format unverified');
  const [, zone, year, month, day, hour, minute, second, utc] = match;
  const asUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  if (utc) return asUtc;
  if (!['America/New_York', 'US/Eastern', 'America/Washington_DC'].includes(zone)) throw Error('BLS calendar timezone unverified');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(asUtc));
  const offset = /^GMT([+-]\d{1,2})$/.exec(parts.find(p => p.type === 'timeZoneName')?.value ?? '');
  if (!offset) throw Error('BLS calendar timezone offset unavailable');
  return asUtc - Number(offset[1]) * 3600000;
};

export function parseOfficialSchedules(ics, bea, now) {
  if (typeof ics !== 'string' || !ics.includes('BEGIN:VCALENDAR') || !ics.includes('END:VCALENDAR')
    || !bea || typeof bea !== 'object') throw Error('Official calendar response invalid');
  const bls = [];
  for (const raw of ics.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? []) {
    const eventLines = raw.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
    const summary = eventLines.find(x => x.startsWith('SUMMARY:'))?.slice(8)?.trim();
    if (!summary || !BLS_HIGH_IMPACT.test(summary)) continue;
    const start = eventLines.find(x => x.startsWith('DTSTART'));
    const eventTime = blsDate(start ?? '');
    if (!Number.isFinite(eventTime)) throw Error('BLS event timestamp invalid');
    bls.push({ name: `BLS: ${summary}`, eventTime });
  }
  const beaEvents = [];
  for (const [name, data] of Object.entries(bea)) {
    if (!BEA_HIGH_IMPACT.test(name)) continue;
    if (!Array.isArray(data?.release_dates)) throw Error('BEA release dates incomplete');
    for (const date of data.release_dates) {
      const eventTime = Date.parse(date);
      if (!Number.isFinite(eventTime) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(date))) throw Error('BEA event time invalid');
      beaEvents.push({ name: `BEA: ${name}`, eventTime });
    }
  }
  const coverageEnd = now + 45 * 86400000;
  const hasUpcoming = (events, pattern) => events.some(e => pattern.test(e.name)
    && e.eventTime > now && e.eventTime <= coverageEnd);
  if (!hasUpcoming(bls, /employment situation|consumer price index/i)
    || !hasUpcoming(beaEvents, /gross domestic product|personal income and outlays/i)) {
    throw Error('Official calendar coverage unverified');
  }
  return [...bls, ...beaEvents].filter(e => e.eventTime >= now - 3600000 && e.eventTime <= now + 14 * 86400000);
}

export const fedDecisionDay = now => {
  const date = new Date(now).toISOString().slice(0, 10);
  const dates = date.startsWith('2026-') ? FED_DECISION_DAYS_2026
    : date.startsWith('2027-') ? FED_DECISION_DAYS_2027 : null;
  if (!dates) throw Error('Federal Reserve meeting schedule unverified for this year');
  return dates.has(date) ? 'Federal Reserve FOMC decision day' : null;
};

export async function loadOfficialSchedules(now, jsonFetcher = requestJson, textFetcher = fetch) {
  const [bea, response] = await Promise.all([
    jsonFetcher(BEA_URL, { timeoutMs: 7000, retries: 0 }),
    textFetcher(BLS_URL, { signal: AbortSignal.timeout(7000) }),
  ]);
  if (!response.ok) throw Error('BLS calendar request failed');
  const length = Number(response.headers?.get?.('content-length') ?? 0);
  if (length > 2_000_000) throw Error('BLS calendar exceeds size cap');
  const ics = await response.text();
  if (ics.length > 2_000_000) throw Error('BLS calendar exceeds size cap');
  return parseOfficialSchedules(ics, bea, now);
}
