import { directionalSignal, FUTURES_AUTO_SYMBOLS } from './futures-auto-strategy.js';
import { DetectionLedger } from './detection-audit.js';
import { earlyFuturesWatch } from './early-setup-watch.js';
export class FuturesAutoWorkerLoop {
  constructor({ executor, store, now = () => Date.now() }) {
    Object.assign(this, { executor, store, now }); this.busy = false; this.stopped = false; this.lastScan = -Infinity; this.lastProgress = now();
    this.detectionLedger = new DetectionLedger();
    this.lastScanMinute = -Infinity;
    executor.authorizeEntry = async () => { const c = await store.control(executor.scope); return !c.paused && !c.close_requested; };
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const ex = this.executor;
      // Protective reconciliation is independent of entry controls.
      await ex.run(); this.lastProgress = this.now();
      const control = await this.store.control(ex.scope);
      if (ex.lastError) return;
      if (control.close_requested && ex.row.state.jobs.some(j => j.phase !== 'CLOSED' && !j.closeRequested)) await ex.control('close');
      else if (ex.row.state.paused !== control.paused) await ex.control(control.paused ? 'pause' : 'resume');
      if (!ex.cfg.enabled || control.paused || control.close_requested || ex.lastError || this.stopped) return;
      const scanNow = this.now(), minute = Math.floor(scanNow / 60000);
      // Protective reconciliation above still runs during the close grace.
      if (scanNow % 60000 < 1500 || minute === this.lastScanMinute) return;
      this.lastScanMinute = minute;
      this.lastScan = this.now();
      const [btc15, btc1h] = await Promise.all([ex.exchange.candles('BTCUSDT', '15m'), ex.exchange.candles('BTCUSDT', '1h')]);
      const candidates = [];
      // Bounded market-data concurrency: a slow first symbol must not age every
      // later symbol's closed-bar confirmation. Exchange writes remain serial.
      for (let offset = 0; offset < FUTURES_AUTO_SYMBOLS.length; offset += 3) {
        if (this.stopped) return;
        await Promise.all(FUTURES_AUTO_SYMBOLS.slice(offset, offset + 3).map(async symbol => {
        try {
          const [m1, m15, h1] = await Promise.all([ex.exchange.candles(symbol, '1m'),
            symbol === 'BTCUSDT' ? btc15 : ex.exchange.candles(symbol, '15m'),
            symbol === 'BTCUSDT' ? btc1h : ex.exchange.candles(symbol, '1h')]);
          const input = { symbol, m1, m15, h1, btc15, btc1h, now: this.now() };
          const signal = directionalSignal(input);
          ex.scanReasons[symbol] = signal.allowed ? `${signal.direction}: confirmed` : signal.reason;
          if (!signal.allowed) {
            const watch=earlyFuturesWatch(input);
            if (watch) ex.scanReasons[symbol]=`${watch.direction} WATCH: ${watch.reason}; ${signal.reason}`;
          }
          if (signal.allowed) {
            const audit = this.detectionLedger.record(symbol, signal, this.now());
            candidates.push({ ...signal, detectionAudit: audit });
            if (audit) ex.scanReasons[symbol] += ` · age ${(audit.confirmationAgeMs / 1000).toFixed(0)}s · stop ${audit.stopDistancePct.toFixed(3)}% · modeled cost ${(audit.approximateCostShare * 100).toFixed(0)}% of loss risk`;
          }
        } catch (e) { ex.scanReasons[symbol] = 'Market data unavailable'; }
        this.lastProgress = this.now();
        }));
      }
      ex.reason = candidates.length ? `${candidates.length} confirmed candidates; applying execution checks` : 'No confirmed directional setup';
      for (const signal of candidates.sort((a, b) => b.score - a.score
        || FUTURES_AUTO_SYMBOLS.indexOf(a.symbol)-FUTURES_AUTO_SYMBOLS.indexOf(b.symbol))) {
        if (this.stopped) break;
        if (this.now() - signal.barCloseTime > 90000) {
          ex.scanReasons[signal.symbol] = 'Confirmation expired during scan; no entry'; continue;
        }
        await ex.onSignal(signal.symbol, signal); this.lastProgress = this.now();
        if (ex.lastError) break;
      }
    } catch (e) { await this.executor.failed(e); }
    finally {
      // Status failures never suppress exchange protection next cycle.
      try { await this.store.heartbeat(this.executor.scope, this.executor.status()); } catch { console.error('Futures heartbeat write failed'); }
      this.lastProgress = this.now(); this.busy = false;
    }
  }
  stop() { this.stopped = true; this.executor.stop(); }
}
