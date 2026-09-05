import { requestJson } from './http.js';
import { ALPHA_URL, keyOf, parseToken } from './alpha.js';
import { fetchAndAssessOnchain } from './onchain-risk.js';
import { escapeHtml, formatPrice, gstTime, log, pctChange, sleep } from './util.js';

const HORIZON_MS = 60 * 60_000; // ring-buffer horizon per token
const MAX_POINTS = 120; // hard cap per token (~90s polls over the horizon)

const usd = value => Number(value || 0) >= 1_000_000
  ? `$${(Number(value) / 1_000_000).toFixed(1)}M`
  : `$${Math.round(Number(value || 0) / 1_000)}k`;

const securityLabel = security => {
  if (!security || security.rating === 'BLOCKED') return '🚨 BLOCKED';
  if (security.rating === 'POSSIBLE_RUG') return '⚠️ POSSIBLE RUG';
  if (security.rating === 'CAUTION') return '⚠️ CAUTION';
  return '✅ NO CRITICAL FLAGS';
};

// Alpha Fast-Mover radar (v6.9.3). Independent of the slow AlphaRadar
// qualification pipeline: it polls the same Binance Alpha token list but only
// needs ~10 minutes of history to catch the early leg of a vertical move
// (e.g. APR +163% in ~18h). It sends an informational-actionable radar ping —
// NO database trade row is created and NO outcome is monitored. It also never
// checks for an open alpha trade / IGNITED state for the same contract: the
// radar is deliberately independent, so a token can appear in both pipelines.
export class AlphaFastMover {
  constructor({
    cfg,
    store,
    telegram,
    fetcher = requestJson,
    assessSecurity = fetchAndAssessOnchain,
    btcBias = null,
    isPaused = () => false,
    isEventGuarded = () => false,
    now = () => Date.now(),
    sleepImpl = sleep,
  }) {
    this.cfg = cfg;
    this.store = store;
    this.telegram = telegram;
    this.fetcher = fetcher;
    this.assessSecurity = assessSecurity;
    this.btcBias = btcBias;
    this.isPaused = isPaused;
    this.isEventGuarded = isEventGuarded;
    this.now = now;
    this.sleepImpl = sleepImpl;
    this.buffers = new Map(); // key -> [{ t, price, liquidity, holders }]
    this.cooldowns = new Map(); // key -> last alert ms
    this.alertTimestamps = []; // global per-hour cap window
    this.timer = null;
    this.polling = false; // re-entrancy guard (same pattern as alpha.js `this.running`)
    this.lastPollAt = 0;
    this.lastError = null;
    this.metrics = {
      polls: 0,
      triggers: 0,
      alerts: 0,
      blocked: 0,
      errors: 0,
      dedupSkipped: 0,
      suppressed: { cooldown: 0, cap: 0, paused: 0, eventGuard: 0, drain: 0 },
    };
  }

  start() {
    if (!this.cfg.enableAlphaFastMover || this.timer) return;
    const tick = async () => {
      try { await this.pollOnce(); }
      catch (error) { // pollOnce already counts/logs; belt-and-braces so the loop keeps going
        this.metrics.errors++;
        this.lastError = error.message;
        log(`Alpha fast-mover poll failed: ${error.message}`);
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.cfg.alphaMoverPollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Static floors: a token failing these is never tracked, so the buffer map
  // only holds plausible candidates.
  passesFloors(token) {
    return token.price > 0
      && token.liquidity >= this.cfg.alphaMoverMinLiquidityUsd
      && token.volume24h >= this.cfg.alphaMinVolumeUsd
      && Number.isFinite(token.holders)
      && token.holders >= this.cfg.alphaMinHolders;
  }

  // Latest buffered point at or before `target`, within a staleness cap of two
  // poll intervals (hard-clamped to 5 minutes) — a too-old point must never
  // fabricate a reference.
  referenceAt(buffer, target) {
    const stalenessCapMs = Math.min(2 * this.cfg.alphaMoverPollMs, 5 * 60_000);
    for (let i = buffer.length - 1; i >= 0; i--) {
      const point = buffer[i];
      if (point.t <= target) {
        return target - point.t <= stalenessCapMs ? point : null;
      }
    }
    return null;
  }

  cooldownBucket(nowMs) {
    return Math.floor(nowMs / (this.cfg.alphaMoverCooldownMin * 60_000));
  }

  async pollOnce() {
    if (!this.cfg.enableAlphaFastMover) return { skipped: 'disabled' };
    if (this.polling) return { skipped: 'already running' };
    this.polling = true;
    try {
      const nowMs = this.now();
      let response;
      try {
        response = await this.fetcher(ALPHA_URL, { timeoutMs: 20_000, retries: 1 });
      } catch (error) {
        this.metrics.errors++;
        this.lastError = error.message;
        log(`Alpha fast-mover fetch failed: ${error.message}`);
        return { error: error.message };
      }
      const tokens = (Array.isArray(response?.data) ? response.data : []).map(parseToken).filter(Boolean);
      for (const token of tokens) {
        try { await this.track(token, nowMs); }
        catch (error) {
          this.metrics.errors++;
          this.lastError = error.message;
          log(`Alpha fast-mover ${token.symbol} failed: ${error.message}`);
        }
      }
      // Prune stale points so `tracked` reflects the live feed.
      for (const [key, buffer] of this.buffers) {
        while (buffer.length && nowMs - buffer[0].t > HORIZON_MS) buffer.shift();
        if (!buffer.length) this.buffers.delete(key);
      }
      // Prune expired cooldown entries so the map cannot grow unboundedly.
      const cooldownMs = this.cfg.alphaMoverCooldownMin * 60_000;
      for (const [key, ts] of this.cooldowns) {
        if (nowMs - ts > cooldownMs) this.cooldowns.delete(key);
      }
      this.lastPollAt = nowMs;
      this.metrics.polls++;
      return { processed: tokens.length };
    } finally {
      this.polling = false;
    }
  }

  async track(token, nowMs) {
    const key = keyOf(token);
    if (!this.passesFloors(token)) return null;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }
    const point = { t: nowMs, price: token.price, liquidity: token.liquidity, holders: token.holders };
    if (buffer.length && buffer.at(-1).t >= nowMs) buffer[buffer.length - 1] = point;
    else buffer.push(point);
    while (buffer.length && nowMs - buffer[0].t > HORIZON_MS) buffer.shift();
    while (buffer.length > MAX_POINTS) buffer.shift();
    return this.evaluate(token, key, buffer, nowMs);
  }

  evaluate(token, key, buffer, nowMs) {
    // Too late (already vertical) or already dumping — the radar only wants
    // the early leg.
    if (token.change24h >= this.cfg.alphaMoverMax24hChangePct || token.change24h <= -20) return null;
    // v6.9.8: a configurable FAST window is checked ahead of 10m/30m so an
    // igniting token can be flagged sooner. It is deliberately a separate,
    // higher-bar-per-minute threshold rather than a loosening of the 10m rule:
    // thin Alpha pools wiggle 2-3% on a single fill, so a short window needs a
    // proportionally larger move to mean anything. Set ALPHA_MOVER_FAST_WINDOW_MIN
    // equal to 10 to collapse it back to the previous behaviour.
    const fastWindowMin = this.cfg.alphaMoverFastWindowMin;
    const refFast = this.referenceAt(buffer, nowMs - fastWindowMin * 60_000);
    const moveFast = refFast && refFast.price > 0 ? pctChange(refFast.price, token.price) : null;
    const hitFast = moveFast !== null && moveFast >= this.cfg.alphaMoverMinFastPct;

    const ref10 = this.referenceAt(buffer, nowMs - 10 * 60_000);
    const ref30 = this.referenceAt(buffer, nowMs - 30 * 60_000);
    const move10 = ref10 && ref10.price > 0 ? pctChange(ref10.price, token.price) : null;
    const move30 = ref30 && ref30.price > 0 ? pctChange(ref30.price, token.price) : null;
    const hit10 = move10 !== null && move10 >= this.cfg.alphaMoverMin10mPct;
    const hit30 = move30 !== null && move30 >= this.cfg.alphaMoverMin30mPct;
    if (!hitFast && !hit10 && !hit30) return null; // no reference ⇒ no trigger
    const move = hitFast ? { pct: moveFast, windowMin: fastWindowMin }
      : hit10 ? { pct: move10, windowMin: 10 }
        : { pct: move30, windowMin: 30 };

    // Soft confirmation: liquidity must not be bleeding out vs 30 min ago
    // (when that reference exists) and holders must not be shrinking vs the
    // previous point (when both are finite).
    if (ref30 && ref30.liquidity > 0 && pctChange(ref30.liquidity, token.liquidity) < -3) return null;
    const previous = buffer.length >= 2 ? buffer.at(-2) : null;
    if (Number.isFinite(previous?.holders) && Number.isFinite(token.holders) && token.holders < previous.holders) return null;

    // v6.9.9 SHORT-WINDOW DRAIN GUARD.
    // The ref30 check above is skipped entirely when no 30-minute-old point
    // exists (referenceAt returns null, and `&&` short-circuits). A token the
    // radar has only tracked for a few minutes therefore passed with NO
    // liquidity validation at all — precisely the newest, highest-rug-risk
    // tokens. This mirrors the LIQUIDITY_DRAIN guard alpha.js already applies
    // on every poll, using the immediately previous buffered point so it works
    // from the second observation onward.
    if (previous && Number.isFinite(previous.liquidity) && previous.liquidity > 0
      && Number.isFinite(token.liquidity)) {
      const drainPct = pctChange(previous.liquidity, token.liquidity);
      if (drainPct <= this.cfg.alphaMoverMaxDrainPct) {
        this.metrics.suppressed.drain++;
        return { triggered: false, suppressed: 'liquidityDrain', symbol: token.symbol, drainPct };
      }
    }

    if (this.isPaused()) {
      this.metrics.suppressed.paused++;
      return { triggered: true, suppressed: 'paused', symbol: token.symbol };
    }
    // v6.9.5: treat an active high-impact event window exactly like paused —
    // suppress before any security-screen call is burned.
    if (this.isEventGuarded()) {
      this.metrics.suppressed.eventGuard++;
      return { triggered: true, suppressed: 'eventGuard', symbol: token.symbol };
    }
    const lastAlertAt = this.cooldowns.get(key) ?? 0;
    if (nowMs - lastAlertAt < this.cfg.alphaMoverCooldownMin * 60_000) {
      this.metrics.suppressed.cooldown++;
      return { triggered: true, suppressed: 'cooldown', symbol: token.symbol };
    }
    this.alertTimestamps = this.alertTimestamps.filter(ts => nowMs - ts < 3_600_000);
    if (this.alertTimestamps.length >= this.cfg.alphaMoverMaxAlertsPerHour) {
      this.metrics.suppressed.cap++;
      return { triggered: true, suppressed: 'cap', symbol: token.symbol };
    }

    this.metrics.triggers++;
    return this.screenAndAlert(token, key, move, nowMs);
  }

  // v6.9.6: compact BTC bias tag bundled into every radar alert. Default-on;
  // a null bias engine leaves messages byte-identical to previous versions.
  btcBiasLine() {
    if (this.cfg.enableBtcBiasTag === false || !this.btcBias) return '';
    try {
      const tag = this.btcBias.btcTag({ long: true });
      return tag ? `${tag}\n` : '';
    } catch (error) {
      log(`BTC bias tag failed: ${error.message}`);
      return '';
    }
  }

  alertMessage(token, move, security) {
    const change = Number(token.change24h);
    return `⚡ <b>[ALPHA] FAST MOVER</b>\n` +
      `<b>${escapeHtml(token.symbol)}</b> (${escapeHtml(token.chainName)}) +${move.pct.toFixed(2)}% in ${move.windowMin}m\n` +
      `Price: $${formatPrice(token.price)} · 💧 ${usd(token.liquidity)} · 👥 ${Math.round(token.holders).toLocaleString()}\n` +
      `24h change: ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n` +
      `Security: ${securityLabel(security)} (risk ${Number(security?.riskScore ?? 0)}/10)\n` +
      this.btcBiasLine() +
      `⚠️ <b>Early radar ping — unverified move.</b> Tiny size / DYOR. This is NOT the guarded IGNITION entry; no database trade was opened.\n` +
      `⏰ ${gstTime()} GST`;
  }

  async screenAndAlert(token, key, move, nowMs) {
    // Security screen BEFORE alerting. A provider failure is fail-safe: skip
    // this cycle, count an error, send nothing.
    let security;
    try {
      security = await this.assessSecurity(token, this.cfg);
    } catch (error) {
      this.metrics.errors++;
      this.lastError = error.message;
      log(`Alpha fast-mover security check failed for ${token.symbol}: ${error.message}; skipping this cycle`);
      return { triggered: true, suppressed: 'security-error', symbol: token.symbol };
    }
    if (security?.hardBlock === true) {
      this.metrics.blocked++;
      log(`SILENT ALPHA FAST-MOVER BLOCK ${token.symbol}: ${(security.critical ?? []).join('; ')}`);
      return { triggered: true, suppressed: 'blocked', symbol: token.symbol };
    }
    if (Number(security?.riskScore ?? 10) > this.cfg.alphaMoverMaxRiskScore) {
      this.metrics.blocked++;
      log(`SILENT ALPHA FAST-MOVER BLOCK ${token.symbol}: risk score ${security?.riskScore}/10 above ${this.cfg.alphaMoverMaxRiskScore}`);
      return { triggered: true, suppressed: 'blocked', symbol: token.symbol };
    }

    // The per-token cooldown is set pre-send to stop tick-level retrigger; the
    // hourly-cap timestamp is only recorded AFTER a successful Telegram send so
    // a dedup-skipped or send-failed alert never burns an hourly slot.
    this.cooldowns.set(key, nowMs);
    // Persist BEFORE alerting (same semantics as the v6.9.1 futures detector):
    // a dedup hit (insertEvent → false) means this cooldown bucket already
    // alerted — e.g. a restart wiped the in-memory cooldowns — so skip the
    // Telegram send. A DB ERROR (throw) must never silence the alert.
    let persisted;
    try {
      persisted = await this.store.insertEvent({
        event_key: `alpha-mover:${key}:${this.cooldownBucket(nowMs)}`,
        event_type: 'ALPHA_FAST_MOVER',
        symbol: `[ALPHA] ${token.symbol}`,
        payload: {
          token: {
            chainId: token.chainId, chainName: token.chainName, contractAddress: token.contractAddress,
            symbol: token.symbol, price: token.price, liquidity: token.liquidity,
            volume24h: token.volume24h, holders: token.holders, change24h: token.change24h,
          },
          movePct: Number(move.pct.toFixed(4)),
          windowMin: move.windowMin,
          security: security ? {
            rating: security.rating,
            riskScore: security.riskScore,
            hardBlock: security.hardBlock,
            warnings: security.warnings ?? [],
          } : null,
        },
      });
    } catch (error) {
      persisted = true; // persistence failure must not silence the alert
      log(`Alpha fast-mover persistence failed for ${token.symbol}: ${error.message}`);
    }
    if (persisted === false) {
      this.metrics.dedupSkipped++;
      log(`Alpha fast-mover dedup skip ${token.symbol}: cooldown-bucket event already persisted; alert suppressed`);
      return { triggered: true, suppressed: 'dedup', symbol: token.symbol };
    }
    await this.telegram.send(this.alertMessage(token, move, security));
    this.metrics.alerts++;
    this.alertTimestamps.push(nowMs);
    log(`ALPHA FAST MOVER ${token.symbol}: +${move.pct.toFixed(2)}%/${move.windowMin}m, risk ${security?.riskScore ?? '?'}/10`);
    return { triggered: true, alerted: true, symbol: token.symbol, movePct: move.pct, windowMin: move.windowMin };
  }

  health() {
    return {
      enabled: Boolean(this.cfg.enableAlphaFastMover),
      lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null,
      tracked: this.buffers.size,
      metrics: this.metrics,
      lastError: this.lastError,
    };
  }
}


