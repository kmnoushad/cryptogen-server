import { parseFinnhubCalendar } from './calendar.js';
import { EventGuard } from './event-guard.js';
import { requestJson } from './http.js';

export function fadePositioningGate(oi, funding, symbol, now) {
  const blocked = reason => ({ allowed: false, reason });
  if (!Array.isArray(oi) || oi.length < 4 || oi.length > 5 || funding?.symbol !== symbol) return blocked('OI/funding context unavailable');
  const points = oi.map(r => ({ time: Number(r.timestamp), value: Number(r.sumOpenInterestValue), symbol: r.symbol }));
  if (points.some(p => p.symbol !== symbol || !(p.value > 0) || !Number.isFinite(p.time))
    || points.some((p, i) => i && p.time <= points[i - 1].time)
    || now - points.at(-1).time > 600000 || points.at(-1).time > now) return blocked('OI history stale or invalid');
  if (points.at(-1).value > points[0].value * 1.03) return blocked('OI expansion; squeeze risk');
  const rate = Number(funding.lastFundingRate), next = Number(funding.nextFundingTime), captured = Number(funding.time);
  if (!Number.isFinite(rate) || !Number.isFinite(next) || !Number.isFinite(captured)
    || captured > now || now - captured > 90000 || next < captured) return blocked('Funding context stale or invalid');
  if (Math.abs(rate) >= 0.0008) return blocked('Extreme funding; crowding risk');
  if (next - now <= 900000) return blocked('Funding settlement near');
  return { allowed: true, reason: 'OI and funding context clear' };
}

export class FadeEventGate {
  constructor({ cfg, fetcher = requestJson, now = () => Date.now() }) {
    this.cfg = cfg; this.fetcher = fetcher; this.now = now;
    this.events = []; this.loadedAt = null;
    this.guard = new EventGuard({ cfg: { enableEventGuard: true,
      eventGuardManual: cfg.fadeManualEvents ?? '', eventGuardPreMin: 60, eventGuardPostMin: 30 }, calendar: this, now });
  }
  async check() {
    const now = this.now();
    if (!this.cfg.finnhubKey) return { allowed: false, reason: 'High-impact event feed not configured' };
    if (!this.loadedAt || now - this.loadedAt > 15 * 60000) {
      try {
        const from = new Date(now).toISOString().slice(0, 10);
        const to = new Date(now + 14 * 86400000).toISOString().slice(0, 10);
        const url = `https://finnhub.io/api/v1/calendar/economic?${new URLSearchParams({ from, to, token: this.cfg.finnhubKey })}`;
        const result = await this.fetcher(url, { timeoutMs: 7000, retries: 0 });
        if (!Array.isArray(result?.economicCalendar)) throw Error('Invalid event calendar');
        const events = parseFinnhubCalendar(result);
        // A green 200 carrying an empty/incomplete calendar is not evidence
        // that the next fourteen days are event-free.
        if (!events.some(e => e.eventTime >= now && e.eventTime <= now + 14 * 86400000)) throw Error('High-impact calendar coverage unverified');
        this.events = events; this.loadedAt = now;
      } catch { this.loadedAt = null; return { allowed: false, reason: 'High-impact event feed unavailable' }; }
    }
    const active = this.guard.activeWindow(now);
    return active ? { allowed: false, reason: `High-impact event window: ${active.name}` }
      : { allowed: true, reason: 'High-impact event window clear' };
  }
}
