import { directionalSignal, FUTURES_AUTO_SYMBOLS } from './futures-auto-strategy.js';
export class FuturesAutoWorkerLoop {
  constructor({ executor, store, now = () => Date.now() }) {
    Object.assign(this, { executor, store, now }); this.busy = false; this.stopped = false; this.lastScan = -Infinity; this.lastProgress = now();
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
      if (this.now() - this.lastScan < 60000) return;
      this.lastScan = this.now();
      const [btc15, btc1h] = await Promise.all([ex.exchange.candles('BTCUSDT', '15m'), ex.exchange.candles('BTCUSDT', '1h')]);
      const candidates = [];
      for (const symbol of FUTURES_AUTO_SYMBOLS) {
        if (this.stopped) return;
        try {
          const [m1, m15, h1] = await Promise.all([ex.exchange.candles(symbol, '1m'),
            symbol === 'BTCUSDT' ? btc15 : ex.exchange.candles(symbol, '15m'),
            symbol === 'BTCUSDT' ? btc1h : ex.exchange.candles(symbol, '1h')]);
          const signal = directionalSignal({ symbol, m1, m15, h1, btc15, btc1h, now: this.now() });
          ex.scanReasons[symbol] = signal.allowed ? `${signal.direction}: confirmed` : signal.reason;
          if (signal.allowed) candidates.push(signal);
        } catch (e) { ex.scanReasons[symbol] = 'Market data unavailable'; }
        this.lastProgress = this.now();
      }
      ex.reason = candidates.length ? `${candidates.length} confirmed candidates; applying execution checks` : 'No confirmed directional setup';
      for (const signal of candidates.sort((a, b) => b.score - a.score)) {
        if (this.stopped) break;
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
