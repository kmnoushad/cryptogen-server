import { directionalSignal, selectFuturesUniverse } from './futures-auto-strategy.js';
import { DetectionLedger } from './detection-audit.js';
import { earlyFuturesWatch } from './early-setup-watch.js';
import { recordDailyGate, recordScanCoverage } from './daily-gates.js';

export class FuturesAutoWorkerLoop {
  constructor({ executor, store, now = () => Date.now(), detect = directionalSignal }) {
    Object.assign(this, { executor, store, now, detect });
    this.busy = false; this.stopped = false; this.lastScan = -Infinity; this.lastProgress = now();
    this.detectionLedger = new DetectionLedger(); this.lastScanMinute = -Infinity; this.rotationCursor = 0;
    this.candleCache = new Map(); this.dataBackoffUntil = 0;
    this.exchangeInfo = null; this.exchangeInfoAt = 0;
    executor.authorizeEntry = async () => {
      const c = await store.control(executor.scope);
      return !this.stopped && !c.paused && !c.close_requested;
    };
  }
  async candles(symbol, interval) {
    const duration = {'1m':60000,'15m':900000,'1h':3600000}[interval];
    const now=this.now(), key=symbol+':'+interval;
    const cached=this.candleCache.get(key);
    if(cached && now>=cached.startedAt && now<cached.expiresAt)return cached.rows;
    const startedAt=now;
    const rows=await this.executor.exchange.candles(symbol,interval);
    // Detectors ignore forming bars. Refetch after the next close (with 1.5s
    // publication allowance); never cache across that close or a clock rollback.
    const expiresAt=(Math.floor(startedAt/duration)+1)*duration+1500;
    this.candleCache.delete(key);this.candleCache.set(key,{rows,startedAt,expiresAt});
    while(this.candleCache.size>480)this.candleCache.delete(this.candleCache.keys().next().value);
    return rows;
  }
  async maintain() {
    const ex = this.executor;
    await ex.run(); this.lastProgress = this.now(); this.lastMaintenance = this.now();
    const control = await this.store.control(ex.scope);
    if (ex.lastError) return false;
    if (control.close_requested && ex.row.state.jobs.some(j => j.phase !== 'CLOSED' && !j.closeRequested)) await ex.control('close');
    else if (ex.row.state.paused !== control.paused) await ex.control(control.paused ? 'pause' : 'resume');
    await this.store.heartbeat(ex.scope, ex.status());
    return ex.cfg.enabled && !control.paused && !control.close_requested && !ex.lastError && !this.stopped;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let stats;
    try {
      const ex = this.executor;
      if (!await this.maintain()) return;
      const scanNow = this.now(), minute = Math.floor(scanNow / 60000);
      if (scanNow < this.dataBackoffUntil) { ex.reason = 'Binance scan backoff; protection remains scheduled'; return; }
      if (scanNow % 60000 < 1500 || minute === this.lastScanMinute) return;
      this.lastScanMinute = minute; this.lastScan = scanNow;
      stats = ex.scanStats = { startedAt: scanNow, completedAt: null, scanned: 0, confirmed: 0, attempted: 0, expired: 0, dataErrors: 0 };
      if (!this.exchangeInfo || scanNow - this.exchangeInfoAt >= 6 * 3600000) {
        this.exchangeInfo = await ex.exchange.info(); this.exchangeInfoAt = this.now();
      }
      let tickers = await ex.exchange.ticker24h(), snapshotAt = this.now();
      const selectionCursor = this.rotationCursor;
      let universe = selectFuturesUniverse({ exchangeInfo: this.exchangeInfo, tickers, now: snapshotAt,
        cursor: selectionCursor, maxSymbols: 60 });
      this.rotationCursor = universe.nextCursor;
      if (!universe.symbols.length) {
        ex.universeSummary = `${universe.reason ?? 'no eligible contracts'}; no entry scan`;
        ex.reason = 'Dynamic universe unavailable; entries withheld'; ex.scanReasons = {}; return;
      }
      const symbols = universe.symbols;
      const mix = universe.selectionGroups;
      ex.universeSummary = `${universe.eligible.length} eligible USDT perpetuals · ${symbols.length} selected · ${universe.notSelected} outside this scan\n` +
        `Mix: BTC ${mix.btc} · volume ${mix.volume} · fallers ${mix.fallers} · risers ${mix.risers} · rotation ${mix.rotation}`;
      ex.scanReasons = {};
      let [btc15, btc1h] = await Promise.all([this.candles('BTCUSDT', '15m'), this.candles('BTCUSDT', '1h')]);
      for (let offset = 0; offset < symbols.length; offset += 1) {
        if (this.stopped || ex.lastError || this.now()<this.dataBackoffUntil) break;
        const active = ex.row.state.jobs.some(j => j.phase !== 'CLOSED');
        if (this.now() - this.lastMaintenance >= (active ? 5000 : 10000) && !await this.maintain()) break;
        // Refresh actual snapshots rather than relabeling old quality/BTC data.
        if (this.now() - snapshotAt >= 45000) {
          [tickers, btc15, btc1h] = await Promise.all([ex.exchange.ticker24h(),
            this.candles('BTCUSDT', '15m'), this.candles('BTCUSDT', '1h')]);
          snapshotAt = this.now();
          universe = selectFuturesUniverse({ exchangeInfo: this.exchangeInfo, tickers, now: snapshotAt,
            cursor: selectionCursor, maxSymbols: 60 });
        }
        const candidates = [];
        await Promise.all(symbols.slice(offset, offset + 1).map(async symbol => {
          try {
            const [m1, m15, h1] = await Promise.all([this.candles(symbol, '1m'),
              symbol === 'BTCUSDT' ? btc15 : this.candles(symbol, '15m'),
              symbol === 'BTCUSDT' ? btc1h : this.candles(symbol, '1h')]);
            const marketQuality = universe.quality.get(symbol);
            if (!marketQuality) { ex.scanReasons[symbol] = 'Contract no longer selected/eligible in refreshed snapshot';
              recordDailyGate(ex, 'scan', ex.scanReasons[symbol], symbol, { id: minute }); return; }
            const input = { symbol, m1, m15, h1, btc15, btc1h, now: this.now(), marketQuality };
            const signal = this.detect(input);
            recordScanCoverage(ex, symbol);
            recordDailyGate(ex, 'scan', signal.reason ?? 'Confirmed directional setup', symbol, { id: minute, outcome: signal.allowed ? 'info' : 'blocked' });
            ex.scanReasons[symbol] = signal.allowed ? `${signal.direction}: confirmed` : signal.reason;
            if (!signal.allowed) {
              const watch = ex.cfg.structureStrategy ? null : earlyFuturesWatch(input);
              if (watch) ex.scanReasons[symbol] = `${watch.direction} WATCH: ${watch.reason}; ${signal.reason}`;
            } else {
              stats.confirmed++;
              const audit = this.detectionLedger.record(symbol, signal, this.now());
              candidates.push({ ...signal, marketQuality, detectionAudit: audit });
            }
          } catch (error) {
            if (error.status===429 || error.status===418 || error.code===-1003) this.dataBackoffUntil=Math.max(this.dataBackoffUntil,this.now()+(error.retryAfterMs??60000));
            stats.dataErrors++; ex.scanReasons[symbol] = `Market data error: ${error.message}`;
            recordDailyGate(ex, 'scan data', error.message, symbol, { id: minute, outcome: 'error' });
          } finally { stats.scanned++; this.lastProgress = this.now(); }
        }));
        // Never park a fresh confirmation behind the remaining universe scan.
        for (const signal of candidates.sort((a,b) => b.score-a.score)) {
          if (this.stopped || ex.lastError || this.now()<this.dataBackoffUntil) break;
          if (this.now() - signal.barCloseTime > 90000) {
            stats.expired++; ex.scanReasons[signal.symbol] = 'Confirmation expired before execution checks';
            recordDailyGate(ex, 'execution', ex.scanReasons[signal.symbol], signal.symbol, { id: signal.barCloseTime }); continue;
          }
          stats.attempted++;
          await ex.onSignal(signal.symbol, signal); this.lastProgress = this.now();
          ex.scanReasons[signal.symbol] = ex.lastError ?? ex.reason;
        }
      }
      if (!stats.attempted && !ex.lastError) ex.reason = stats.confirmed
        ? 'Confirmed setups expired before execution checks' : 'No confirmed directional setup';
    } catch (e) { await this.executor.failed(e); }
    finally {
      if (stats) stats.completedAt = this.now();
      try { await this.store.heartbeat(this.executor.scope, this.executor.status()); } catch { console.error('Futures heartbeat write failed'); }
      this.lastProgress = this.now(); this.busy = false;
    }
  }
  stop() { this.stopped = true; this.executor.stop(); }
}
