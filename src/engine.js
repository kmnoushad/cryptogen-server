import { parseKlines, closedCandles, buildFeatures, impulseBlockers } from './indicators.js';
import { selectUniverse } from './binance.js';
import { assessManipulationRisk, depthMetrics, historyRisk } from './risk.js';
import { advanceCandidate, armCandidate } from './strategy.js';
import { closeTradeAtMarket, evaluateTrade } from './trade-evaluator.js';
import { escapeHtml, gstTime, log, mapLimit, sleep } from './util.js';
import { APP_VERSION } from './version.js';

const EXCLUDED = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT',
  'DOGEUSDT', 'SHIBUSDT', '1000SHIBUSDT', 'PEPEUSDT', '1000PEPEUSDT',
  'BONKUSDT', '1000BONKUSDT', 'WIFUSDT', 'FLOKIUSDT', '1000FLOKIUSDT',
  'TRUMPUSDT', 'MELANIAUSDT', 'BOMEUSDT', 'POPCATUSDT', 'PNUTUSDT',
  'USDCUSDT', 'BTCDOMUSDT', 'DEFIUSDT', 'PAXGUSDT', 'XAUTUSDT',
  'XAUUSDT', 'XAGUSDT',
]);

export class Engine {
  constructor({ cfg, binance, store, telegram, alpha = null, calendar = null }) {
    this.cfg = cfg;
    this.binance = binance;
    this.store = store;
    this.telegram = telegram;
    this.alpha = alpha;
    this.calendar = calendar;
    this.universe = [];
    this.candidates = new Map();
    this.lastBarSeen = new Map();
    this.depthSnapshots = new Map();
    this.historyCache = new Map();
    this.lastUniverseRefresh = 0;
    this.tickerSnapshot = { ts: 0, prices: new Map() };
    this.lastScanAt = 0;
    this.lastScanDurationMs = 0;
    this.btc = { regime: 'UNINITIALIZED', allowed: false };
    this.paused = false;
    this.scanRunning = false;
    this.stopping = false;
    this.metrics = { scans: 0, armed: 0, rejected: 0, signaled: 0, dataErrors: 0 };
    this.gateCounts = {};
    this.gateDelta = {};
    this.lastGateSummaryBucket = Math.floor(Date.now() / (15 * 60_000));
  }

  countGate(name, amount = 1) {
    this.gateCounts[name] = Number(this.gateCounts[name] ?? 0) + amount;
    this.gateDelta[name] = Number(this.gateDelta[name] ?? 0) + amount;
  }

  async persistGateSummary() {
    const bucket = Math.floor(Date.now() / (15 * 60_000));
    if (bucket <= this.lastGateSummaryBucket) return;
    const completedBucket = this.lastGateSummaryBucket;
    const gates = this.gateDelta;
    this.lastGateSummaryBucket = bucket;
    this.gateDelta = {};
    try {
      await this.store.insertEvent({
        event_key: `futures:gates:${completedBucket}`,
        event_type: 'FUTURES_GATE_SUMMARY',
        symbol: '[FUTURES]',
        payload: {
          bucket: completedBucket,
          btc: this.btc,
          universe: this.universe.length,
          candidates: this.candidates.size,
          metrics: this.metrics,
          gates,
        },
      });
    } catch (error) {
      // Restore the unsaved counts so a transient database failure does not
      // erase the diagnostic window.
      for (const [name, count] of Object.entries(gates)) {
        this.gateDelta[name] = Number(this.gateDelta[name] ?? 0) + Number(count);
      }
      log(`Futures gate summary persistence failed: ${error.message}`);
    }
  }

  async initialize() {
    await this.binance.ping();
    await this.store.health();
    this.btc = await this.binance.btcRegime();
    await this.refreshUniverse();
    await this.manageOpenTrades();
    if (this.alpha) await this.alpha.initialize();
    log(`Initialized: BTC=${this.btc.regime}, universe=${this.universe.length}, paper=${this.cfg.paperMode}`);
  }

  async refreshUniverse() {
    const [info, tickers] = await Promise.all([this.binance.exchangeInfo(), this.binance.ticker24h()]);
    const now = Date.now();
    const snapshotAge = this.tickerSnapshot.ts ? now - this.tickerSnapshot.ts : 0;
    const acceleration = new Map();
    if (snapshotAge >= 60_000 && snapshotAge <= 20 * 60_000) {
      for (const ticker of tickers) {
        const price = Number(ticker.lastPrice);
        const previous = this.tickerSnapshot.prices.get(ticker.symbol);
        if (price > 0 && previous > 0) acceleration.set(ticker.symbol, ((price - previous) / previous) * 100);
      }
    }
    const selected = selectUniverse(info, tickers, this.cfg, EXCLUDED, acceleration);
    const selectedSymbols = new Set(selected.map(item => item.symbol));
    // Preserve armed setups when the rotating liquidity/momentum universe changes.
    for (const symbol of this.candidates.keys()) {
      if (!selectedSymbols.has(symbol)) selected.push({ symbol, retainedCandidate: true });
    }
    this.universe = selected;
    this.tickerSnapshot = {
      ts: now,
      prices: new Map(tickers.map(ticker => [ticker.symbol, Number(ticker.lastPrice)]).filter(([, price]) => price > 0)),
    };
    const activeSymbols = new Set(this.universe.map(item => item.symbol));
    for (const symbol of this.lastBarSeen.keys()) {
      if (!activeSymbols.has(symbol) && !this.candidates.has(symbol)) this.lastBarSeen.delete(symbol);
    }
    for (const [symbol, snapshot] of this.depthSnapshots) {
      if (Date.now() - snapshot.measuredAt > 30 * 60_000) this.depthSnapshots.delete(symbol);
    }
    for (const [symbol, cached] of this.historyCache) {
      if (Date.now() - cached.ts > 2 * 60 * 60_000) this.historyCache.delete(symbol);
    }
    this.lastUniverseRefresh = Date.now();
    const accelerated = this.universe.filter(item => Number(item.accelerationPct) > 0).length;
    log(`Universe refreshed: ${this.universe.length} liquid alt perpetuals (${accelerated} accelerating)`);
  }

  async getHistory(symbol) {
    const cached = this.historyCache.get(symbol);
    if (cached && Date.now() - cached.ts < 60 * 60_000) return cached.value;
    const rows = await this.binance.klines(symbol, '5m', 300);
    const candles = closedCandles(parseKlines(rows));
    if (candles.length < 100) throw new Error(`Insufficient 5m history for ${symbol}`);
    const value = historyRisk(candles);
    this.historyCache.set(symbol, { ts: Date.now(), value });
    return value;
  }

  async context(symbol, features) {
    const [book, oi, premium, history] = await Promise.all([
      this.binance.depth(symbol, 100),
      this.binance.oiContext(symbol),
      this.binance.premiumIndex(symbol),
      this.getHistory(symbol),
    ]);
    const depth = depthMetrics(book, features.last.close);
    const previousDepth = this.depthSnapshots.get(symbol);
    const fundingPct = Number(premium.lastFundingRate) * 100;
    if (!Number.isFinite(fundingPct)) throw new Error(`Invalid funding for ${symbol}`);
    const risk = assessManipulationRisk({
      features, oi, depth, previousDepth, history, fundingPct, cfg: this.cfg,
    });
    this.depthSnapshots.set(symbol, depth);
    return { oi, depth, fundingPct, history, risk };
  }

  async warnRisk(symbol, features, context) {
    try {
      const fifteenMinuteBucket = Math.floor(features.last.closeTime / (15 * 60_000));
      const eventKey = `manipulation:${symbol}:${fifteenMinuteBucket}`;
      const created = await this.store.insertEvent({
        event_key: eventKey,
        event_type: 'MANIPULATION_BLOCK',
        symbol,
        payload: {
          score: context.risk.score,
          reasons: context.risk.reasons,
          ret1m: features.ret1m,
          ret3m: features.ret3m,
          buyRatio1: features.buyRatio1,
          oiChangePct: context.oi.changePct,
          spreadBps: context.depth.spreadBps,
        },
      });
      if (created) log(`SILENT FUTURES FILTER ${symbol}: ${context.risk.reasons.join('; ')}`);
    } catch (error) {
      log(`Risk warning persistence/send failed for ${symbol}: ${error.message}`);
    }
  }

  async scanSymbol(item) {
    const symbol = item.symbol;
    const rows = await this.binance.klines(symbol, '1m', 90);
    const candles = closedCandles(parseKlines(rows));
    const features = buildFeatures(candles);
    if (!features) throw new Error(`Feature data incomplete for ${symbol}`);
    if (this.lastBarSeen.get(symbol) === features.last.closeTime) return { action: 'NO_NEW_BAR' };
    this.lastBarSeen.set(symbol, features.last.closeTime);

    let candidate = this.candidates.get(symbol);
    if (!candidate) {
      if (!this.btc.allowed) {
        this.countGate('BTC_BLOCK');
        return { action: 'NONE' };
      }
      if (!features.impulse) {
        for (const reason of impulseBlockers(features)) this.countGate(`IMPULSE: ${reason}`);
        return { action: 'NONE' };
      }
      const context = await this.context(symbol, features);
      if (context.risk.hardBlock) {
        this.countGate('ARM_BLOCK: manipulation/liquidity risk');
        await this.warnRisk(symbol, features, context);
        return { action: 'FILTERED', reason: context.risk.reasons.join('; ') };
      }
      candidate = armCandidate(symbol, candles, features, context, this.cfg);
      this.candidates.set(symbol, candidate);
      this.metrics.armed++;
      log(`ARMED ${symbol}: breakout ${features.breakoutPct.toFixed(2)}%, flow ${(features.buyRatio3 * 100).toFixed(0)}%`);
      return { action: 'ARMED' };
    }

    if (!this.btc.allowed) {
      this.countGate('CANDIDATE_REJECT: BTC changed');
      this.candidates.delete(symbol);
      this.metrics.rejected++;
      return { action: 'REJECT', reason: `BTC changed to ${this.btc.regime}` };
    }

    const context = await this.context(symbol, features);
    const decision = advanceCandidate(candidate, features, context, this.cfg);
    if (decision.action === 'HOLD') {
      for (const reason of String(decision.reason || 'waiting').split(', ')) this.countGate(`HOLD: ${reason}`);
      this.candidates.set(symbol, decision.candidate);
      return decision;
    }
    if (decision.action === 'REJECT') {
      const reason = String(decision.reason);
      const category = reason.startsWith('structural stop') ? 'structural stop too wide'
        : reason.startsWith('net R:R') ? 'net R:R below minimum'
        : reason.startsWith('manipulation risk') ? 'manipulation risk'
        : reason;
      this.countGate(`REJECT: ${category}`);
      this.candidates.delete(symbol);
      this.metrics.rejected++;
      if (context.risk.hardBlock) await this.warnRisk(symbol, features, context);
      log(`REJECT ${symbol}: ${decision.reason}`);
      return decision;
    }

    if (!this.btc.allowed) {
      this.candidates.delete(symbol);
      return { action: 'REJECT', reason: `BTC changed to ${this.btc.regime}` };
    }
    const [limits, cooldown] = await Promise.all([
      this.store.riskSnapshot(this.cfg),
      this.store.symbolCooldown(symbol, this.cfg),
    ]);
    if (!limits.allowed || cooldown.blocked) {
      this.countGate('RISK_BLOCK: account/cooldown');
      this.candidates.delete(symbol);
      const reasons = [...limits.reasons];
      if (cooldown.blocked) reasons.push(`${symbol} loss cooldown ${cooldown.minutesLeft}min`);
      log(`RISK BLOCK ${symbol}: ${reasons.join('; ')}`);
      return { action: 'RISK_BLOCK', reason: reasons.join('; ') };
    }

    decision.trade.btc_regime = this.btc;
    const inserted = await this.store.createTrade(decision.trade);
    this.candidates.delete(symbol);
    if (!inserted.created) {
      this.countGate('DUPLICATE_TRADE');
      return { action: 'DUPLICATE' };
    }

    let delivered = false;
    try {
      await this.telegram.send(this.telegram.signalMessage(inserted.trade, this.btc));
      delivered = true;
      await this.store.updateTrade(inserted.trade.id, { alert_sent: true });
      this.metrics.signaled++;
      log(`SIGNAL ${symbol}: entry=${decision.trade.entry} stop=${decision.trade.initial_sl}`);
      return { action: 'SIGNAL' };
    } catch (error) {
      if (!delivered) {
        await this.store.updateTrade(inserted.trade.id, {
          status: 'CANCELLED',
          exit_reason: `ALERT_FAILED: ${error.message}`.slice(0, 300),
          closed_at: new Date().toISOString(),
        });
      } else {
        log(`CRITICAL: Telegram delivered ${symbol}, but alert_sent acknowledgement failed; trade remains monitored`);
      }
      throw error;
    }
  }

  async scanOnce({ manual = false } = {}) {
    if (this.scanRunning) return { skipped: 'already running' };
    if (this.paused) {
      await this.manageOpenTrades();
      if (this.alpha) await this.alpha.scan({ monitorOnly: true });
      return { skipped: 'paused' };
    }
    this.scanRunning = true;
    const started = Date.now();
    try {
      if (Date.now() - this.lastUniverseRefresh >= this.cfg.universeRefreshMs) await this.refreshUniverse();
      try {
        this.btc = await this.binance.btcRegime();
      } catch (error) {
        this.btc = { regime: 'DATA_BLOCK', allowed: false, reason: error.message };
        this.metrics.dataErrors++;
        log(`BTC fail-closed: ${error.message}`);
      }

      const results = await mapLimit(this.universe, this.cfg.scanConcurrency, item => this.scanSymbol(item));
      for (const result of results) {
        if (result?.error) {
          this.metrics.dataErrors++;
          this.countGate('DATA_ERROR');
          log(`Symbol scan failed: ${result.error.message}`);
        }
      }
      await this.manageOpenTrades();
      if (this.alpha) {
        try { await this.alpha.scan(); }
        catch (error) { this.metrics.dataErrors++; log(`Alpha scan failed: ${error.message}`); }
      }
      await this.persistGateSummary();
      this.metrics.scans++;
      this.lastScanAt = Date.now();
      this.lastScanDurationMs = Date.now() - started;
      return { processed: results.length, durationMs: this.lastScanDurationMs };
    } finally {
      this.scanRunning = false;
    }
  }

  async manageOpenTrades() {
    const pending = await this.store.pendingTradeOutcomeAlerts();
    for (const trade of pending) {
      try {
        await this.telegram.send(this.telegram.outcomeMessage(trade));
        await this.store.updateTrade(trade.id, { exit_alert_sent: true });
      } catch (error) {
        this.metrics.dataErrors++;
        log(`Outcome alert retry failed for ${trade.symbol}: ${error.message}`);
      }
    }
    const trades = await this.store.listOpenTrades();
    for (const trade of trades) {
      try {
        const startTime = Math.max(0, Number(trade.last_checked_bar_close ?? trade.entry_bar_close) - 60_000);
        const rows = await this.binance.klines(trade.symbol, '1m', 500, { startTime });
        const candles = closedCandles(parseKlines(rows));
        const result = evaluateTrade(trade, candles, this.cfg);
        if (!result.patch) continue;
        let finalResult = result;
        if (!result.closed) {
          const features = buildFeatures(candles);
          if (features) {
            const context = await this.context(trade.symbol, features);
            if (context.risk.hardBlock) {
              await this.warnRisk(trade.symbol, features, context);
              finalResult = closeTradeAtMarket(
                { ...trade, ...result.patch },
                context.depth.bestBid,
                features.last.closeTime,
                'MANIPULATION_EXIT',
                this.cfg,
                { mfePct: result.patch.mfe_pct, maePct: result.patch.mae_pct },
              );
            }
          }
        }
        const updated = await this.store.updateTrade(trade.id, finalResult.patch);
        if (finalResult.closed && updated) {
          await this.telegram.send(this.telegram.outcomeMessage(updated));
          await this.store.updateTrade(trade.id, { exit_alert_sent: true });
          log(`CLOSED ${trade.symbol}: ${updated.exit_reason} ${Number(updated.net_pnl_pct).toFixed(2)}%`);
        }
      } catch (error) {
        this.metrics.dataErrors++;
        log(`Open-trade monitor failed for ${trade.symbol}: ${error.message}`);
      }
    }
  }

  async runLoop() {
    while (!this.stopping) {
      const started = Date.now();
      try { await this.scanOnce(); }
      catch (error) { log(`Scan failed: ${error.message}`); }
      const remaining = Math.max(1_000, this.cfg.scanIntervalMs - (Date.now() - started));
      await sleep(remaining);
    }
  }

  health() {
    return {
      ok: true,
      version: APP_VERSION,
      paperMode: this.cfg.paperMode,
      paused: this.paused,
      scanRunning: this.scanRunning,
      btc: this.btc,
      universe: this.universe.length,
      candidates: this.candidates.size,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      lastScanDurationMs: this.lastScanDurationMs,
      metrics: this.metrics,
      gateCounts: this.gateCounts,
      alpha: this.alpha?.health() ?? { enabled: false },
      calendar: this.calendar?.health() ?? { enabled: false, configured: false },
    };
  }

  async command(message) {
    const chatId = String(message.chat?.id ?? '');
    const text = String(message.text ?? '').trim().toLowerCase();
    if (chatId !== String(this.cfg.ownerChatId)) {
      if (text === '/start') await this.telegram.send('This is a private paper-research bot.', chatId);
      return;
    }

    if (text === '/start' || text === '/help') {
      await this.telegram.send(`🧪 <b>NEXIO v${APP_VERSION} Actionable Alerts</b>\n` +
        '/version /status /diagnostics /audit /stats /events /scan /alphascan /pause /resume /help');
    } else if (text === '/version') {
      await this.telegram.send(`🧬 <b>NEXIO VERSION</b>\nRunning: <b>v${APP_VERSION}</b>\n` +
        `Futures: fast breakout + steady momentum\nAlpha: guarded entry + active outcome monitoring\n` +
        `Calendar: live Finnhub high-impact US reminders\n` +
        `⏰ ${gstTime()} GST`);
    } else if (text === '/status') {
      const risk = await this.store.riskSnapshot(this.cfg);
      const calendarHealth = this.calendar?.health() ?? { configured: false, loaded: 0, lastError: null };
      await this.telegram.send(`🩺 <b>NEXIO v6 STATUS</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅' : '⛔'}\n` +
        `Universe: ${this.universe.length} · Candidates: ${this.candidates.size}\n` +
        `Open: ${risk.openTrades} · Today: ${risk.tradesToday}/${this.cfg.maxTradesPerDay}\n` +
        `Daily PnL: ${risk.dailyPnlPct.toFixed(2)}% · Weekly: ${risk.weeklyPnlPct.toFixed(2)}%\n` +
        `Paused: ${this.paused ? 'YES' : 'NO'} · Last scan: ${this.lastScanDurationMs}ms\n` +
        `Engine: ${this.metrics.scans} scans · ${this.metrics.armed} armed · ${this.metrics.signaled} FIRE · ${this.metrics.dataErrors} errors\n` +
        `Alpha: ${this.alpha?.health().enabled ? `✅ ${this.alpha.active().length} active` : 'disabled'}\n` +
        `Calendar: ${calendarHealth.lastError ? '⚠️ API error · use /events' : calendarHealth.configured ? `✅ ${calendarHealth.loaded} events loaded` : '⚠️ FINNHUB_KEY missing/disabled'}\n` +
        `${risk.allowed ? 'Risk gate ✅' : `Risk gate ⛔ ${escapeHtml(risk.reasons.join('; '))}`}\n` +
        `⏰ ${gstTime()} GST`);
    } else if (text === '/diagnostics' || text === '/diag') {
      const persisted = await this.store.futuresGateSummaries(24);
      const persistedCounts = {};
      for (const row of persisted) {
        for (const [name, count] of Object.entries(row.payload?.gates ?? {})) {
          persistedCounts[name] = Number(persistedCounts[name] ?? 0) + Number(count ?? 0);
        }
      }
      const top = Object.entries(this.gateCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      const lines = top.length
        ? top.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : 'No Futures gate data collected yet.';
      const dayTop = Object.entries(persistedCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const dayLines = dayTop.length
        ? dayTop.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : 'Waiting for the first completed 15-minute v6.5 window.';
      await this.telegram.send(`🔬 <b>FUTURES DIAGNOSTICS</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅' : '⛔'}\n` +
        `Scans: ${this.metrics.scans} · Armed: ${this.metrics.armed} · Rejected: ${this.metrics.rejected}\n` +
        `FIRE: ${this.metrics.signaled} · Data errors: ${this.metrics.dataErrors}\n` +
        `Active candidates: ${this.candidates.size}\n\n` +
        `<b>Top gates since restart:</b>\n${lines}\n\n` +
        `<b>Persisted last 24h (${persisted.length} windows):</b>\n${dayLines}\n\n` +
        `<i>Counts are internal evaluations, not missed guaranteed trades.</i>`);
    } else if (text === '/audit') {
      const audit = await this.store.auditSnapshot(200);
      const line = (label, section) => {
        const rate = section.total ? section.wins / section.total * 100 : 0;
        return `${label}: ${section.total} closed · ${section.wins}W/${section.losses}L/${section.scratches} other · ` +
          `${rate.toFixed(1)}% WR · ${section.pnl >= 0 ? '+' : ''}${section.pnl.toFixed(2)}%`;
      };
      const recent = [
        ...audit.futures.rows.slice(0, 3).map(row =>
          `▸ [FUTURES] ${escapeHtml(row.symbol)} ${escapeHtml(row.exit_reason ?? row.outcome ?? 'CLOSED')} ` +
          `${Number(row.net_pnl_pct) >= 0 ? '+' : ''}${Number(row.net_pnl_pct ?? 0).toFixed(2)}%`),
        ...audit.alpha.rows.slice(0, 3).map(row =>
          `▸ [ALPHA] ${escapeHtml(row.symbol)} ${escapeHtml(row.exit_reason ?? row.outcome ?? 'CLOSED')} ` +
          `${Number(row.pnl_pct) >= 0 ? '+' : ''}${Number(row.pnl_pct ?? 0).toFixed(2)}%`),
      ];
      await this.telegram.send(`🧮 <b>VERIFIED OUTCOME AUDIT</b>\n` +
        `${line('[FUTURES]', audit.futures)}\n${line('[ALPHA]', audit.alpha)}\n\n` +
        `<b>Latest closes:</b>\n${recent.length ? recent.join('\n') : 'No monitored trades have closed yet.'}\n\n` +
        `<i>Only bot-issued, database-monitored entries are counted.</i>`);
    } else if (text === '/stats') {
      const s = await this.store.statistics(200);
      const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞';
      await this.telegram.send(`📊 <b>VERIFIED CLOSED-BAR STATS</b>\n` +
        `Trades: ${s.total} · ${s.wins}W/${s.losses}L/${s.scratches} scratch\n` +
        `Win rate: ${s.winRate.toFixed(1)}%\n` +
        `Net PnL: ${s.netPnlPct >= 0 ? '+' : ''}${s.netPnlPct.toFixed(2)}%\n` +
        `Expectancy: ${s.expectancyR >= 0 ? '+' : ''}${s.expectancyR.toFixed(2)}R · PF ${pf}\n` +
        `${s.total < 100 ? '⏳ Not enough out-of-sample trades for live use.' : 'Review drawdown and regime splits before any live use.'}`);
    } else if (text === '/events' || text === '/calendar') {
      if (!this.calendar) {
        await this.telegram.send('📅 Economic calendar module is not loaded.');
      } else {
        await this.calendar.scan();
        await this.telegram.send(this.calendar.message());
      }
    } else if (text === '/scan') {
      await this.telegram.send('Running one manual scan…');
      const result = await this.scanOnce({ manual: true });
      await this.telegram.send(`Scan complete: ${result.processed ?? 0} symbols in ${result.durationMs ?? 0}ms`);
    } else if (text === '/alphascan') {
      if (!this.alpha?.health().enabled) {
        await this.telegram.send('Alpha signals are disabled in configuration.');
      } else {
        await this.telegram.send('Running one Alpha scan with on-chain risk checks…');
        const result = await this.alpha.scan({ force: true });
        await this.telegram.send(`Alpha scan complete: ${result.processed ?? 0} liquid tokens in ${result.durationMs ?? 0}ms`);
      }
    } else if (text === '/pause') {
      this.paused = true;
      await this.telegram.send('⏸ New entries paused. Open-trade monitoring remains active.');
    } else if (text === '/resume') {
      this.paused = false;
      await this.telegram.send('▶️ New-entry scanning resumed.');
    }
  }

  stop() {
    this.stopping = true;
    this.calendar?.stop();
  }
}
