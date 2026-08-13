import { escapeHtml, log } from './util.js';

const DAY_MS = 24 * 60 * 60_000;
const MANUAL_HORIZON_MS = 7 * DAY_MS; // manual entries beyond now + 7 days are ignored at evaluation time

// A datetime with a time part but no explicit zone (`YYYY-MM-DDTHH:MM[:SS[.fff]]`,
// no trailing 'Z', no ±HH:MM offset). Date.parse would read such a value as
// SERVER-local time, but the operator-facing env is documented in UTC, so a
// 'Z' is appended before parsing. Date-only entries (`YYYY-MM-DD`) need no
// fix: per the ECMAScript spec Date.parse already treats them as UTC midnight
// (operators should still always include the time and a trailing 'Z').
const NAIVE_ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

// Lenient EVENT_GUARD_MANUAL parser: comma-separated `ISO_TIMESTAMP=Label`
// entries. The label is optional (default "Manual event"). Bad entries are
// skipped with a console warning — a typo must never abort boot or scanning.
export const parseManualEvents = (raw, warn = message => console.warn(message)) => {
  const events = [];
  for (const entry of String(raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    const timeText = (separator > 0 ? trimmed.slice(0, separator) : trimmed).trim();
    const label = (separator > 0 ? trimmed.slice(separator + 1) : '').trim() || 'Manual event';
    const normalized = NAIVE_ISO_TIME.test(timeText) && !EXPLICIT_ZONE.test(timeText)
      ? `${timeText}Z` // naive datetime ⇒ UTC (see NAIVE_ISO_TIME above)
      : timeText;
    const eventTime = Date.parse(normalized);
    if (!Number.isFinite(eventTime)) {
      warn(`[EVENT GUARD] skipping invalid EVENT_GUARD_MANUAL entry "${trimmed}" (unparseable timestamp)`);
      continue;
    }
    events.push({ name: label, eventTime, source: 'manual' });
  }
  return events.sort((a, b) => a.eventTime - b.eventTime);
};

// Event Window Guard (v6.9.5). Refuses NEW exposure around high-impact US data
// releases (CPI/FOMC/NFP/PPI…). Sources are merged: the Finnhub economic
// calendar (high-impact US, already filtered upstream — may be unconfigured or
// empty) plus manual entries from EVENT_GUARD_MANUAL so the guard works TODAY
// with no Finnhub key. Open-trade monitoring is never gated by this module.
export class EventGuard {
  constructor({ cfg, calendar = null, now = () => Date.now() }) {
    this.cfg = cfg;
    this.calendar = calendar; // read-only use of calendar.events ({ name, eventTime }[])
    this.now = now;
    this.manualEvents = parseManualEvents(cfg?.eventGuardManual);
    if (this.manualEvents.length) {
      log(`Event guard: ${this.manualEvents.length} manual event(s) loaded from EVENT_GUARD_MANUAL`);
    }
  }

  enabled() {
    return this.cfg?.enableEventGuard !== false;
  }

  preMs() {
    return Math.max(0, Number(this.cfg?.eventGuardPreMin ?? 30)) * 60_000;
  }

  postMs() {
    return Math.max(0, Number(this.cfg?.eventGuardPostMin ?? 15)) * 60_000;
  }

  // Merged, evaluation-time-filtered event list. Manual entries older than
  // now − postMin or beyond now + 7 days are ignored (no pruning needed).
  sources(now) {
    const calendarEvents = Array.isArray(this.calendar?.events) ? this.calendar.events : [];
    const merged = [];
    for (const event of calendarEvents) {
      const eventTime = Number(event?.eventTime);
      const name = String(event?.name ?? '').trim();
      if (Number.isFinite(eventTime) && name) merged.push({ name, eventTime, source: 'calendar' });
    }
    for (const event of this.manualEvents) {
      if (event.eventTime < now - this.postMs()) continue;
      if (event.eventTime > now + MANUAL_HORIZON_MS) continue;
      merged.push(event);
    }
    return merged.sort((a, b) => a.eventTime - b.eventTime);
  }

  // A window is active when now ∈ [eventTime − preMin, eventTime + postMin] for
  // ANY event (boundaries inclusive). With multiple overlapping windows the
  // event nearest to now wins.
  activeWindow(now = this.now()) {
    if (!this.enabled()) return null;
    const preMs = this.preMs();
    const postMs = this.postMs();
    let best = null;
    for (const event of this.sources(now)) {
      if (now < event.eventTime - preMs || now > event.eventTime + postMs) continue;
      const distance = Math.abs(now - event.eventTime);
      if (!best || distance < best.distance) best = { event, distance };
    }
    if (!best) return null;
    const { name, eventTime } = best.event;
    return {
      name,
      eventTime,
      phase: now <= eventTime ? 'PRE' : 'POST',
      minutesToEvent: (eventTime - now) / 60_000,
    };
  }

  // Next upcoming event across both sources (name + time), when known.
  nextEvent(now = this.now()) {
    if (!this.enabled()) return null;
    const upcoming = this.sources(now).filter(event => event.eventTime > now);
    if (!upcoming.length) return null;
    const { name, eventTime } = upcoming[0];
    return { name, eventTime };
  }

  // Short text for /status and /why.
  statusLine(now = this.now()) {
    if (!this.enabled()) return 'Event guard: disabled';
    const window = this.activeWindow(now);
    if (!window) return 'Event guard: clear ✅';
    if (window.phase === 'PRE') {
      return `⏳ GUARD: ${escapeHtml(window.name)} in ${Math.max(0, Math.ceil(window.minutesToEvent))}m`;
    }
    return `⏳ GUARD: ${escapeHtml(window.name)} +${Math.max(0, Math.ceil(-window.minutesToEvent))}m post-event`;
  }
}
