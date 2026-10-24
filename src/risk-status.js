import { escapeHtml } from './util.js';

const validTime = value => Number.isFinite(value) && value > 0;
const gst = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(value) + ' GST';
const money = value => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

export function newerRiskStatus(previous, next) {
  return validTime(previous?.checkedAt) && validTime(next?.checkedAt)
    && previous.checkedAt > next.checkedAt ? previous : next;
}

// Display only. Expiring a timer never authorises an entry or changes controls.
export function formatRiskStatus(snapshot, now) {
  if (!snapshot || !validTime(snapshot.checkedAt) || snapshot.checkedAt > now)
    return 'Risk limits: awaiting a verified check\n';
  const age = Math.max(0, now - snapshot.checkedAt);
  const unavailable = /unavailable|unverified|incomplete|older than/i.test(String(snapshot.reason));
  const expiry = snapshot.cooldownUntil ?? snapshot.resetAt;
  const elapsed = validTime(expiry) && now >= expiry;
  const historical = age > 90000 || elapsed;
  const state = unavailable ? 'UNVERIFIED' : historical
    ? snapshot.allowed ? 'PREVIOUSLY CLEAR' : 'PREVIOUSLY BLOCKED'
    : snapshot.allowed ? 'CLEAR' : 'BLOCKED';
  let report = `Risk limits snapshot: ${state} · ${escapeHtml(snapshot.reason)}\n` +
    `Risk checked: ${gst(snapshot.checkedAt)} · ${Math.floor(age / 1000)}s ago${historical ? ' (cached; fresh entry checks required)' : ''}\n`;
  if (!unavailable && Number.isFinite(snapshot.dailyNet) && Number.isFinite(snapshot.dailyPeak))
    report += `Daily net ${money(snapshot.dailyNet)} · peak ${money(snapshot.dailyPeak)} · giveback $${Math.max(0, snapshot.dailyPeak - snapshot.dailyNet).toFixed(2)}\n`;
  if (validTime(snapshot.cooldownUntil))
    report += `Cooldown ends: ${gst(snapshot.cooldownUntil)} · ${elapsed ? 'window elapsed; eligibility needs rechecking' : Math.ceil((snapshot.cooldownUntil - now) / 60000) + ' min remaining'}\n`;
  else if (validTime(snapshot.resetAt))
    report += `GST day reset: ${gst(snapshot.resetAt)}${elapsed ? ' · boundary passed; eligibility needs rechecking' : ' · eligibility rechecked after reset'}\n`;
  return report;
}
