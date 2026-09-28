import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialSchedules } from '../src/fade-official-calendar.js';

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
