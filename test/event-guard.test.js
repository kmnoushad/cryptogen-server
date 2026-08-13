import test from 'node:test';
import assert from 'node:assert/strict';
import { EventGuard, parseManualEvents } from '../src/event-guard.js';

const MIN = 60_000;
const T0 = Date.parse('2026-08-13T12:30:00Z'); // fixed reference "now"

const makeGuard = (overrides = {}, calendar = null, now = () => T0) => new EventGuard({
  cfg: {
    enableEventGuard: true,
    eventGuardPreMin: 30,
    eventGuardPostMin: 15,
    eventGuardManual: '',
    ...overrides,
  },
  calendar,
  now,
});

test('window math: exact boundaries are active, just outside is clear', () => {
  const calendar = { events: [{ name: 'CPI', eventTime: T0 }] };
  const guard = makeGuard({}, calendar);

  // PRE boundary: now == eventTime - preMin ⇒ active (inclusive)
  assert.deepEqual(
    guard.activeWindow(T0 - 30 * MIN),
    { name: 'CPI', eventTime: T0, phase: 'PRE', minutesToEvent: 30 },
  );
  // one ms before the window opens ⇒ clear
  assert.equal(guard.activeWindow(T0 - 30 * MIN - 1), null);
  // at the event itself ⇒ still PRE phase
  assert.equal(guard.activeWindow(T0).phase, 'PRE');
  assert.equal(guard.activeWindow(T0).minutesToEvent, 0);
  // POST boundary: now == eventTime + postMin ⇒ active (inclusive)
  const post = guard.activeWindow(T0 + 15 * MIN);
  assert.equal(post.phase, 'POST');
  assert.equal(post.minutesToEvent, -15);
  // one ms after the window closes ⇒ clear
  assert.equal(guard.activeWindow(T0 + 15 * MIN + 1), null);
  // mid-window
  const mid = guard.activeWindow(T0 - 10 * MIN);
  assert.equal(mid.phase, 'PRE');
  assert.equal(mid.minutesToEvent, 10);
});

test('multiple overlapping events: the nearest event wins', () => {
  const calendar = {
    events: [
      { name: 'FAR', eventTime: T0 + 25 * MIN },
      { name: 'NEAR', eventTime: T0 + 5 * MIN },
    ],
  };
  const guard = makeGuard({}, calendar);
  const window = guard.activeWindow(T0);
  assert.equal(window.name, 'NEAR');
  assert.equal(window.minutesToEvent, 5);
});

test('manual events drive the guard with no calendar at all', () => {
  const iso = new Date(T0 + 20 * MIN).toISOString();
  const guard = makeGuard({ eventGuardManual: `${iso}=PPI` }, null);
  const window = guard.activeWindow(T0);
  assert.equal(window.name, 'PPI');
  assert.equal(window.phase, 'PRE');
  assert.equal(window.minutesToEvent, 20);
  // an unconfigured calendar ({ events: [] }) behaves the same as null
  const empty = makeGuard({ eventGuardManual: `${iso}=PPI` }, { events: [] });
  assert.equal(empty.activeWindow(T0).name, 'PPI');
});

test('manual parsing: labels optional, bad entries skipped with a warning, never throws', () => {
  const warnings = [];
  const events = parseManualEvents(
    ' 2026-08-13T12:30:00Z = PPI , 2026-08-14T18:00:00Z, garbage-entry, =no-time,  ',
    message => warnings.push(message),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'PPI');
  assert.equal(events[0].eventTime, Date.parse('2026-08-13T12:30:00Z'));
  assert.equal(events[1].name, 'Manual event'); // missing label defaults
  assert.equal(events[1].eventTime, Date.parse('2026-08-14T18:00:00Z'));
  assert.ok(warnings.some(w => w.includes('garbage-entry')));
  assert.equal(parseManualEvents('').length, 0);
  assert.equal(parseManualEvents(undefined).length, 0);
});

test('manual parsing: naive ISO datetimes are interpreted as UTC, explicit zones preserved', () => {
  const events = parseManualEvents(
    '2026-08-13T12:30:00=PPI, 2026-08-13T12:30=FOMC, 2026-08-13T14:30:00+02:00=ECB, 2026-08-13T12:30:00Z=CPI',
    () => {},
  );
  assert.equal(events.length, 4);
  // No trailing 'Z' and no ±HH:MM offset ⇒ UTC (NOT server-local time).
  assert.equal(events[0].eventTime, Date.parse('2026-08-13T12:30:00Z'));
  assert.equal(events[1].eventTime, Date.parse('2026-08-13T12:30:00Z')); // seconds optional
  // An explicit offset is honored as-is (14:30+02:00 == 12:30Z).
  assert.equal(events[2].eventTime, Date.parse('2026-08-13T12:30:00Z'));
  assert.equal(events[3].eventTime, Date.parse('2026-08-13T12:30:00Z'));
});

test('manual parsing: date-only entries are UTC midnight', () => {
  const events = parseManualEvents('2026-08-14=NFP_DAY', () => {});
  assert.equal(events.length, 1);
  assert.equal(events[0].eventTime, Date.parse('2026-08-14T00:00:00Z'));
});

test('stale or far-future manual entries are ignored at evaluation time', () => {
  const stale = new Date(T0 - 60 * MIN).toISOString(); // older than now − postMin
  const far = new Date(T0 + 8 * 24 * 60 * MIN).toISOString(); // beyond now + 7 days
  const soon = new Date(T0 + 10 * MIN).toISOString();
  const guard = makeGuard({ eventGuardManual: `${stale}=OLD, ${far}=FAR, ${soon}=SOON` }, null);
  const window = guard.activeWindow(T0);
  assert.equal(window.name, 'SOON');
  assert.deepEqual(guard.sources(T0).map(e => e.name), ['SOON']);
});

test('disabled config is always clear', () => {
  const calendar = { events: [{ name: 'CPI', eventTime: T0 }] };
  const guard = makeGuard({ enableEventGuard: false }, calendar);
  assert.equal(guard.activeWindow(T0), null);
  assert.equal(guard.statusLine(T0), 'Event guard: disabled');
  assert.equal(guard.nextEvent(T0), null);
});

test('zero windows with no events are always clear', () => {
  const guard = makeGuard({ eventGuardPreMin: 0, eventGuardPostMin: 0, eventGuardManual: '' }, null);
  assert.equal(guard.activeWindow(T0), null);
  assert.equal(guard.statusLine(T0), 'Event guard: clear ✅');
  // even with pre/post 0 a manual event is active exactly at its timestamp
  const exact = makeGuard({ eventGuardPreMin: 0, eventGuardPostMin: 0, eventGuardManual: `${new Date(T0).toISOString()}=CPI` }, null);
  assert.equal(exact.activeWindow(T0).name, 'CPI');
  assert.equal(exact.activeWindow(T0 - 1), null);
  assert.equal(exact.activeWindow(T0 + 1), null);
});

test('calendar and manual sources merge', () => {
  const calendar = { events: [{ name: 'NFP', eventTime: T0 + 60 * MIN }] };
  const manual = new Date(T0 + 5 * MIN).toISOString();
  const guard = makeGuard({ eventGuardManual: `${manual}=FOMC` }, calendar);
  assert.equal(guard.activeWindow(T0).name, 'FOMC');
  // after the manual window closes the calendar window takes over
  const later = guard.activeWindow(T0 + 40 * MIN);
  assert.equal(later.name, 'NFP');
  assert.equal(later.phase, 'PRE');
});

test('statusLine shapes: clear, PRE countdown, POST post-event', () => {
  const calendar = { events: [{ name: 'CPI', eventTime: T0 }] };
  const guard = makeGuard({}, calendar);
  assert.equal(guard.statusLine(T0 - 60 * MIN), 'Event guard: clear ✅');
  assert.equal(guard.statusLine(T0 - 12 * MIN), '⏳ GUARD: CPI in 12m');
  assert.equal(guard.statusLine(T0 + 7 * MIN), '⏳ GUARD: CPI +7m post-event');
});

test('nextEvent reports the nearest upcoming event across sources', () => {
  const calendar = { events: [{ name: 'NFP', eventTime: T0 + 2 * 60 * MIN }] };
  const manual = new Date(T0 + 45 * MIN).toISOString();
  const guard = makeGuard({ eventGuardManual: `${manual}=PPI` }, calendar);
  assert.deepEqual(guard.nextEvent(T0), { name: 'PPI', eventTime: T0 + 45 * MIN });
  const none = makeGuard({}, null);
  assert.equal(none.nextEvent(T0), null);
});

test('a broken calendar object never breaks the guard', () => {
  const guard = makeGuard({}, { events: null });
  assert.equal(guard.activeWindow(T0), null);
  const weird = makeGuard({}, { events: [{ name: '', eventTime: T0 }, { name: 'OK', eventTime: 'nope' }] });
  assert.equal(weird.activeWindow(T0), null);
});
