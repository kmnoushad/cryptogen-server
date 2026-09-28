import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialSchedules, parseFedSchedules, fedCalendarMonths, fedCalendarUrl,
  loadOfficialSchedules } from '../src/fade-official-calendar.js';

const now = Date.parse('2026-09-28T15:00:00Z');
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
  'SUMMARY:Consumer Price Index', 'DTSTART;TZID=US/Eastern:20261006T083000',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const bea = { 'Gross Domestic Product': { release_dates: ['2026-09-30T12:30:00+00:00'] },
  'Personal Income and Outlays': { release_dates: ['2026-10-29T12:30:00+00:00'] } };

test('verified BLS and BEA dates use actual UTC release times', () => {
  const events = parseOfficialSchedules(ics, bea, now);
  assert.deepEqual(events.map(e => e.eventTime).sort(),
    [Date.parse('2026-10-06T12:30:00Z'), Date.parse('2026-09-30T12:30:00Z')].sort());
});

test('unknown BLS timezone, empty BLS coverage or BEA schedule block', () => {
  assert.throws(() => parseOfficialSchedules(ics.replace('US/Eastern', 'Unknown'), bea, now), /timezone/);
  assert.throws(() => parseOfficialSchedules(ics.replace('Consumer Price Index', 'Other release'), bea, now), /coverage/);
  assert.throws(() => parseOfficialSchedules(ics, {}, now), /coverage/);
});

const fedPage = (month, entries) => '<html><div>' + month
  + '</div><table class="research-table-1col greyborder"><tbody>'
  + Array(20).fill('<td class="somatdR">&nbsp;</td>').join('')
  + entries.map(([day, name, time]) => '<td class="somatdR"><div>' + day
    + '<br><br><span class="ts-accordion-content"><a href="https://www.bls.gov/news.release/empsit.toc.htm">'
    + name + '</a><br>(' + time + ')<br></span></div></td>').join('')
  + '</tbody></table></html>';
const september = fedPage('September 2026', [['29', 'Job Openings and Labor Turnover Survey', '10:00']]);
const october = fedPage('October 2026', [['02', 'Employment Situation', '08:30'],
  ['14', 'Consumer Price Index', '08:30']]);

test('New York Fed current/next month grid validates BLS-linked times and BEA coverage', () => {
  assert.deepEqual(fedCalendarMonths(now).map(fedCalendarUrl), [
    'https://www.newyorkfed.org/research/calendars/i-sep26.html',
    'https://www.newyorkfed.org/research/calendars/i-oct26.html',
  ]);
  const events = parseFedSchedules([september, october], bea, now);
  assert.deepEqual(events.map(e => e.eventTime).sort(), [
    Date.parse('2026-09-29T14:00:00Z'), Date.parse('2026-10-02T12:30:00Z'),
    Date.parse('2026-09-30T12:30:00Z')].sort());
});

test('New York Fed missing month, missing future jobs/CPI or missing BEA coverage fails closed', () => {
  assert.throws(() => parseFedSchedules([september, october.replace('October 2026', 'October 2025')], bea, now), /page invalid/);
  assert.throws(() => parseFedSchedules([september, october.replace('Employment Situation', 'Other release')
    .replace('Consumer Price Index', 'Other release')], bea, now), /coverage/);
  assert.throws(() => parseFedSchedules([september, october], {}, now), /coverage/);
});

test('BLS HTTP 403 uses a validated New York Fed calendar, never an empty fallback', async () => {
  const seen = [];
  const fetcher = async url => {
    seen.push(url);
    return url.includes('bls.gov') ? { ok: false, status: 403 } : {
      ok: true, headers: { get: () => null }, text: async () => url.includes('sep26') ? september : october };
  };
  const events = await loadOfficialSchedules(now, async () => bea, fetcher);
  assert.equal(events.source, 'NYFed/BEA');
  assert.equal(seen.length, 3);
  await assert.rejects(() => loadOfficialSchedules(now, async () => bea, async url => url.includes('bls.gov')
    ? { ok: false, status: 403 } : { ok: true, headers: { get: () => null }, text: async () => '<html></html>' }), /page invalid/);
});
