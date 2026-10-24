// v6.9.67 Fade night entry block (Fade only; Futures Auto is not affected).
// Blocks NEW Fade entries during the configured UAE (GST, UTC+4) hours.
// Open trades are untouched: stops, targets and management continue normally.
//
// Setting (optional): FADE_NIGHT_BLOCK_UAE in /etc/nexio-fade.env
//   unset        -> default 00-08 (12 midnight to 8 AM UAE)
//   "00-08"      -> start hour - end hour, UAE time, end exclusive (23-08 wraps past midnight)
//   "off"        -> no night block
// An invalid value falls back to the default 00-08 (never blocks all trading).
const GST_MS = 4 * 3600000;
export const DEFAULT_NIGHT_BLOCK = Object.freeze({ start: 0, end: 8 });

export function parseNightBlock(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return { ...DEFAULT_NIGHT_BLOCK, valid: true };
  if (['off', 'none', 'false', '0'].includes(text)) return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text);
  const start = m ? Number(m[1]) : NaN, end = m ? Number(m[2]) : NaN;
  if (!m || start > 23 || end < 1 || end > 24 || start === end % 24) return { ...DEFAULT_NIGHT_BLOCK, valid: false, raw: text };
  return { start, end: end % 24 === 0 && start !== 0 ? 24 : end, valid: true };
}

export function nightBlockLabel(block) {
  if (!block) return 'off';
  const h = n => String(n % 24).padStart(2, '0') + ':00';
  return `${h(block.start)}-${h(block.end)} UAE`;
}

// Returns a block reason string when `now` falls inside the window, else null.
export function fadeNightBlocked(now, block) {
  if (!block || !Number.isFinite(now)) return null;
  const hour = new Date(now + GST_MS).getUTCHours();
  const inside = block.start < block.end ? hour >= block.start && hour < block.end : hour >= block.start || hour < block.end;
  return inside ? `Night entry block ${nightBlockLabel(block)}; new Fade entries resume at ${String(block.end % 24).padStart(2, '0')}:00 UAE` : null;
}

let warned = false;
export function configuredNightBlock(env = process.env) {
  const block = parseNightBlock(env.FADE_NIGHT_BLOCK_UAE);
  if (block && block.valid === false && !warned) {
    warned = true;
    console.warn(`FADE_NIGHT_BLOCK_UAE="${block.raw}" is invalid; using default ${nightBlockLabel(DEFAULT_NIGHT_BLOCK)}`);
  }
  return block;
}
