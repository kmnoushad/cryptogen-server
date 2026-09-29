import { parseFinnhubCalendar } from './calendar.js';
import { EventGuard } from './event-guard.js';
import { requestJson } from './http.js';
import { fedDecisionDay, loadOfficialSchedules } from './fade-official-calendar.js';

export function fadePositioningGate(oi, funding, symbol, now) {
  const blocked = reason => ({ allowed: false, reason });
  if (!Array.isArray(oi) || oi.length < 4 || oi.length > 5 || funding?.symbol !== symbol) return blocked('OI/funding context unavailable');
  // Use open contract quantity. The quote value rises with price even when no
  // additional contracts are opened, which falsely labels pumps as OI expansion.
  const points = oi.map(r => ({ time: Number(r.timestamp), contracts: Number(r.sumOpenInterest), symbol: r.symbol }));
  if (points.some(p => p.symbol !== symbol || !(p.contracts > 0) || !Number.isFinite(p.time))
    || points.some((p, i) => i && p.time <= points[i - 1].time)
    || now - points.at(-1).time > 600000 || points.at(-1).time > now) return blocked('OI history stale or invalid');
  if (points.at(-1).contracts > points[0].contracts * 1.03) return blocked('OI contract expansion; squeeze risk');
  const rate = Number(funding.lastFundingRate), next = Number(funding.nextFundingTime), captured = Number(funding.time);
  if (!Number.isFinite(rate) || !Number.isFinite(next) || !Number.isFinite(captured)
    || captured > now || now - captured > 90000 || next < captured) return blocked('Funding context stale or invalid');
  if (Math.abs(rate) >= 0.0008) return blocked('Extreme funding; crowding risk');
  if (next - now <= 900000) return blocked('Funding settlement near');
  return { allowed: true, reason: 'OI and funding context clear' };
}

export class FadeEventGate {
  constructor({ cfg, fetcher = requestJson, officialLoader = loadOfficialSchedules, now = () => Date.now() }) {
    this.cfg = cfg; this.fetcher = fetcher; this.officialLoader = officialLoader; this.now = now;
    this.events = []; this.loadedAt = null;
    this.source = null;
    this.guard = new EventGuard({ cfg: { enableEventGuard: true,
      eventGuardManual: cfg.fadeManualEvents ?? '', eventGuardPreMin: 60, eventGuardPostMin: 30 }, calendar: this, now });
  }
  async check() {
    const now = this.now();
    try {
      const fedDay = fedDecisionDay(now);
      if (fedDay) return { allowed: false, reason: fedDay };
    } catch { return { allowed: false, reason: 'Federal Reserve meeting schedule unverified' }; }
    if (!this.loadedAt || now - this.loadedAt > 15 * 60000) {
      try {
        let events;
        let source = 'Finnhub';
        if (this.cfg.finnhubKey) {
          try {
            const from = new Date(now).toISOString().slice(0, 10);
            const to = new Date(now + 14 * 86400000).toISOString().slice(0, 10);
            const url = `https://finnhub.io/api/v1/calendar/economic?${new URLSearchParams({ from, to, token: this.cfg.finnhubKey })}`;
            const result = await this.fetcher(url, { timeoutMs: 7000, retries: 0 });
            if (!Array.isArray(result?.economicCalendar)) throw Error('Invalid event calendar');
            events = parseFinnhubCalendar(result);
            if (!events.some(e => e.eventTime >= now && e.eventTime <= now + 14 * 86400000)) throw Error('Finnhub calendar coverage unverified');
          } catch { events = null; }
        }
        if (!events) {
          events = await this.officialLoader(now);
          source = events.source ?? 'BLS/BEA';
          if (!Array.isArray(events)) throw Error('Official calendar coverage unverified');
        }
        this.events = events; this.loadedAt = now; this.source = source;
      } catch {
        this.loadedAt = null; this.source = null; this.events = [];
        return { allowed: false, reason: 'High-impact event feeds unavailable or coverage unverified (Finnhub, BLS, NYFed, BEA)' };
      }
    }
    const active = this.guard.activeWindow(now);
    return active ? { allowed: false, reason: `High-impact event window: ${active.name}` }
      : { allowed: true, reason: `High-impact event window clear (${this.source})` };
  }
}
