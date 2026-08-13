import { log } from './util.js';

const ERROR_LOG_THROTTLE_MS = 10 * 60_000;

// v6.9.6 BTC recorder: one btc_snapshots row per closed 1m candle
// (~1,440 rows/day — trivial for the Supabase free tier). Recording is
// best-effort: if the table is missing it warns ONCE ("run
// sql/btc_snapshots.sql") and disables itself; the bias engine keeps working
// in-memory. Recording errors NEVER throw into the engine.
export class BtcRecorder {
  constructor({ cfg, store, feed = null, bias = null, now = () => Date.now() }) {
    this.cfg = cfg;
    this.store = store;
    this.feed = feed;
    this.bias = bias;
    this.now = now;
    this.disabled = false;
    this.warnedMissing = false;
    this.lastError = null;
    this.lastErrorLogAt = 0;
    this.lastRowAt = 0;
    this.metrics = { inserted: 0, failed: 0, errors: 0 };
  }

  buildRow(candle, snapshot) {
    const indicators = snapshot?.indicators ?? {};
    const book = snapshot?.book ?? {};
    return {
      ts: new Date(Number(candle.closeTime ?? candle.t)).toISOString(),
      close: candle.close,
      ema9: indicators.ema9 ?? null,
      ema21: indicators.ema21 ?? null,
      ema50: indicators.ema50 ?? null,
      buy_ratio_1m: indicators.buyRatio1m ?? null,
      buy_ratio_5m: indicators.buyRatio5m ?? null,
      buy_ratio_15m: indicators.buyRatio15m ?? null,
      cvd_15m: indicators.cvd15m ?? null,
      book_imb_top10: book.imbalanceTop10 ?? null,
      bid_wall_bps: book.bidWallBps ?? null,
      ask_wall_bps: book.askWallBps ?? null,
      bid_wall_x: book.bidWallX ?? null,
      ask_wall_x: book.askWallX ?? null,
      vol_velocity: indicators.volVelocity ?? null,
      oi_chg_pct: indicators.oiChgPct ?? null,
      funding: indicators.fundingPct ?? null,
      score15: snapshot?.h15?.score ?? null,
      label15: snapshot?.h15?.label ?? null,
      conf15: snapshot?.h15?.confidence ?? null,
      score30: snapshot?.h30?.score ?? null,
      label30: snapshot?.h30?.label ?? null,
      conf30: snapshot?.h30?.confidence ?? null,
    };
  }

  async onCandle(candle) {
    if (this.disabled || !this.cfg.enableBtcRecorder || !this.store) return false;
    try {
      // Reuse the bias snapshot the engine just produced for this candle when
      // it is fresh; otherwise evaluate directly (recorder stays standalone).
      let snapshot = this.bias?.lastSnapshot ?? null;
      if (!snapshot || this.now() - snapshot.at > 120_000) {
        snapshot = this.bias?.evaluate?.() ?? null;
      }
      const ok = await this.store.insertBtcSnapshot(this.buildRow(candle, snapshot));
      if (ok) {
        this.metrics.inserted++;
        this.lastRowAt = this.now();
        return true;
      }
      this.metrics.failed++;
      if (this.store.btcSnapshotsTableMissing) {
        this.disabled = true;
        if (!this.warnedMissing) {
          this.warnedMissing = true;
          log('BTC recorder: btc_snapshots table missing — run sql/btc_snapshots.sql; recording disabled, bias engine keeps working in-memory');
        }
        return false;
      }
      this.lastError = this.store.lastBtcSnapshotError ?? 'insert failed';
      if (this.now() - this.lastErrorLogAt >= ERROR_LOG_THROTTLE_MS) {
        this.lastErrorLogAt = this.now();
        log(`BTC recorder insert failed: ${this.lastError}`);
      }
      return false;
    } catch (error) {
      // Belt-and-braces: a recording failure must never reach the engine.
      this.metrics.errors++;
      this.lastError = error.message;
      if (this.now() - this.lastErrorLogAt >= ERROR_LOG_THROTTLE_MS) {
        this.lastErrorLogAt = this.now();
        log(`BTC recorder failed: ${error.message}`);
      }
      return false;
    }
  }

  health() {
    return {
      enabled: Boolean(this.cfg.enableBtcRecorder),
      disabled: this.disabled,
      tableMissing: Boolean(this.store?.btcSnapshotsTableMissing),
      inserted: this.metrics.inserted,
      failed: this.metrics.failed,
      errors: this.metrics.errors,
      lastRowAt: this.lastRowAt ? new Date(this.lastRowAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}
