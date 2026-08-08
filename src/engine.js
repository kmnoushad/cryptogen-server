import { parseKlines, closedCandles, buildFeatures } from './indicators.js';
import { selectUniverse } from './binance.js';
import { assessManipulationRisk, depthMetrics, historyRisk } from './risk.js';
import { advanceCandidate, armCandidate } from './strategy.js';
import { closeTradeAtMarket, evaluateTrade } from './trade-evaluator.js';
import { escapeHtml, formatPrice, gstTime, log, mapLimit, sleep } from './util.js';

const EXCLUDED = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'TRXUSDT',
  'DOGEUSDT', 'SHIBUSDT', '1000SHIBUSDT', 'PEPEUSDT', '1000PEPEUSDT',
  'BONKUSDT', '1000BONKUSDT', 'WIFUSDT', 'FLOKIUSDT', '1000FLOKIUSDT',
  'TRUMPUSDT', 'MELANIAUSDT', 'BOMEUSDT', 'POPCATUSDT', 'PNUTUSDT',
  'USDCUSDT', 'BTCDOMUSDT', 'DEFIUSDT', 'PAXGUSDT', 'XAUTUSDT',
  'XAUUSDT', 'XAGUSDT',
]);

export class Engine {
  constructor({ cfg, binance, store, telegram, alpha = null }) {
    this.cfg = cfg;
    this.binance = binance;
    this.store = store;
    this.telegram = telegram;
    this.alpha = alpha;
    this.universe = [];
    this.candidates = new Map();
    this.lastBarSeen = new Map();
    this.depthSnapshots = new Map();
    this.historyCache = new Map();
    this.lastUniverseRefresh = 0;
    this.lastScanAt = 0;
    this.lastScanDurationMs = 0;
    this.btc = { regime: 'UNINITIALIZED', allowed: false };
    this.paused = false;
    this.scanRunning = false;
    this.stopping = false;
    this.metrics = { scans: 0, armed: 0, rejected: 0, signaled: 0, dataErrors: 0 };
    this.priority = new Map();
    this.lastPriorityAlertAt = Date.now();
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
    this.universe = selectUniverse(info, tickers, this.cfg, EXCLUDED);
    const activeSymbols = new Set(this.universe.map(item => item.symbol));
    for (const symbol of this.candidates.keys()) {
      if (!activeSymbols.has(symbol)) this.candidates.delete(symbol);
    }
    for (const symbol of this.lastBarSeen.keys()) {
      if (!activeSymbols.has(symbol)) this.lastBarSeen.delete(symbol);
    }
    for (const [symbol, snapshot] of this.depthSnapshots) {
      if (Date.now() - snapshot.measuredAt > 30 * 60_000) this.depthSnapshots.delete(symbol);
    }
    for (const [symbol, cached] of this.historyCache) {
      if (Date.now() - cached.ts > 2 * 60 * 60_000) this.historyCache.delete(symbol);
    }
    this.lastUniverseRefresh = Date.now();
    log(`Universe refreshed: ${this.universe.length} liquid alt perpetuals`);
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
      if (!created) return;
      await this.telegram.send(`🛡 <b>PUMP/DUMP RISK BLOCK — ${escapeHtml(symbol.replace('USDT', ''))}</b>\n` +
        `${escapeHtml(context.risk.reasons.join('\n'))}\n` +
        `Flow ${(features.buyRatio1 * 100).toFixed(0)}% buy · OI ${context.oi.changePct.toFixed(2)}% · spread ${context.depth.spreadBps.toFixed(1)} bps\n` +
        `<i>No entry was issued.</i>\n⏰ ${gstTime()} GST`);
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

    this.priority.set(symbol, {
      symbol,
      score: Number(features.setupScore ?? 0),
      state: 'BUILDING',
      quoteVolume: Number(item.quoteVolume ?? 0),
      buyRatio: Number(features.buyRatio3),
      volumeRatio: Number(features.impulseVolumeRatio),
      updatedAt: Date.now(),
    });

    let candidate = this.candidates.get(symbol);
    if (!candidate) {
      if (!this.btc.allowed || !features.impulse) return { action: 'NONE' };
      const context = await this.context(symbol, features);
      if (context.risk.hardBlock || context.risk.score >= 3) {
        await this.warnRisk(symbol, features, context);
        return { action: 'FILTERED', reason: context.risk.reasons.join('; ') };
      }
      candidate = armCandidate(symbol, candles, features, context);
      this.candidates.set(symbol, candidate);
      this.priority.set(symbol, {
        ...this.priority.get(symbol),
        state: 'ARMED',
        score: Math.max(features.setupScore, candidate.setupScore),
      });
      this.metrics.armed++;
      log(`ARMED ${symbol}: breakout ${features.breakoutPct.toFixed(2)}%, flow ${(features.buyRatio3 * 100).toFixed(0)}%`);
      return { action: 'ARMED' };
    }

    if (!this.btc.allowed) {
      this.candidates.delete(symbol);
      this.metrics.rejected++;
      return { action: 'REJECT', reason: `BTC changed to ${this.btc.regime}` };
    }

    const context = await this.context(symbol, features);
    const decision = advanceCandidate(candidate, features, context, this.cfg);
    if (decision.action === 'HOLD') {
      this.candidates.set(symbol, decision.candidate);
      this.priority.set(symbol, {
        ...this.priority.get(symbol),
        state: decision.candidate.state,
        score: Math.max(this.priority.get(symbol)?.score ?? 0, decision.candidate.setupScore ?? 0),
      });
      return decision;
    }
    if (decision.action === 'REJECT') {
      this.candidates.delete(symbol);
      this.priority.delete(symbol);
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
      this.candidates.delete(symbol);
      const reasons = [...limits.reasons];
      if (cooldown.blocked) reasons.push(`${symbol} loss cooldown ${cooldown.minutesLeft}min`);
      log(`RISK BLOCK ${symbol}: ${reasons.join('; ')}`);
      return { action: 'RISK_BLOCK', reason: reasons.join('; ') };
    }

    decision.trade.btc_regime = this.btc;
    const inserted = await this.store.createTrade(decision.trade);
    this.candidates.delete(symbol);
    if (!inserted.created) return { action: 'DUPLICATE' };

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
          log(`Symbol scan failed: ${result.error.message}`);
        }
      }
      await this.manageOpenTrades();
      if (this.alpha) {
        try { await this.alpha.scan(); }
        catch (error) { this.metrics.dataErrors++; log(`Alpha scan failed: ${error.message}`); }
      }
      this.metrics.scans++;
      this.lastScanAt = Date.now();
      this.lastScanDurationMs = Date.now() - started;
      if (Date.now() - this.lastPriorityAlertAt >= this.cfg.priorityAlertIntervalMs) {
        const rows = this.priorityRows();
        if (rows.length) {
          await this.telegram.send(this.telegram.priorityMessage(rows, this.btc));
          this.lastPriorityAlertAt = Date.now();
        }
      }
      return { processed: results.length, durationMs: this.lastScanDurationMs };
    } finally {
      this.scanRunning = false;
    }
  }

  async manageOpenTrades() {
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
            if (context.risk.hardBlock || context.risk.score >= 5) {
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
      paperMode: this.cfg.paperMode,
      paused: this.paused,
      scanRunning: this.scanRunning,
      btc: this.btc,
      universe: this.universe.length,
      candidates: this.candidates.size,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      lastScanDurationMs: this.lastScanDurationMs,
      metrics: this.metrics,
      alpha: this.alpha?.health() ?? { enabled: false },
    };
  }

  priorityRows() {
    const cutoff = Date.now() - 5 * 60_000;
    return [...this.priority.values()]
      .filter(row => row.updatedAt >= cutoff && row.score >= 5)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, 8);
  }

  async command(message) {
    const chatId = String(message.chat?.id ?? '');
    const text = String(message.text ?? '').trim().toLowerCase();
    if (chatId !== String(this.cfg.ownerChatId)) {
      if (text === '/start') await this.telegram.send('This is a private paper-research bot.', chatId);
      return;
    }

    if (text === '/start' || text === '/help') {
      await this.telegram.send('🧪 <b>NEXIO v6 Recovery Core</b>\n/status /priority /candidates /alpha /stats /scan /alphascan /pause /resume /help');
    } else if (text === '/status') {
      const risk = await this.store.riskSnapshot(this.cfg);
      await this.telegram.send(`🩺 <b>NEXIO v6 STATUS</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅' : '⛔'}\n` +
        `Universe: ${this.universe.length} · Candidates: ${this.candidates.size}\n` +
        `Open: ${risk.openTrades} · Today: ${risk.tradesToday}/${this.cfg.maxTradesPerDay}\n` +
        `Daily PnL: ${risk.dailyPnlPct.toFixed(2)}% · Weekly: ${risk.weeklyPnlPct.toFixed(2)}%\n` +
        `Paused: ${this.paused ? 'YES' : 'NO'} · Last scan: ${this.lastScanDurationMs}ms\n` +
        `Alpha: ${this.alpha?.health().enabled ? `✅ ${this.alpha.active().length} active` : 'disabled'}\n` +
        `${risk.allowed ? 'Risk gate ✅' : `Risk gate ⛔ ${escapeHtml(risk.reasons.join('; '))}`}\n` +
        `⏰ ${gstTime()} GST`);
    } else if (text === '/candidates') {
      const rows = [...this.candidates.values()];
      const body = rows.length ? rows.map(c =>
        `• ${escapeHtml(c.symbol.replace('USDT', ''))}: ${c.state} · breakout $${formatPrice(c.breakoutLevel)}${c.retested ? ' · retested' : ''}`
      ).join('\n') : 'No armed candidates. This is normal.';
      await this.telegram.send(`🎯 <b>CANDIDATES (${rows.length})</b>\n${body}`);
    } else if (text === '/priority') {
      await this.telegram.send(this.telegram.priorityMessage(this.priorityRows(), this.btc));
    } else if (text === '/alpha') {
      if (!this.alpha?.health().enabled) {
        await this.telegram.send('🔷 Alpha signals are disabled in configuration.');
      } else {
        const active = this.alpha.active();
        const body = active.length
          ? active.slice(0, 12).map(row => {
            const risk = row.security?.rating ?? 'UNCHECKED';
            return `• <b>${escapeHtml(row.symbol)}</b> ${escapeHtml(row.state)} · ${escapeHtml(row.chainName)} · ${escapeHtml(risk)}`;
          }).join('\n')
          : 'No qualified/ignited Alpha setups right now.';
        await this.telegram.send(`🔷 <b>ALPHA RADAR</b>\n━━━━━━━━━━━━━━━\n${body}\n⏰ ${gstTime()} GST`);
      }
    } else if (text === '/stats') {
      const s = await this.store.statistics(200);
      const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞';
      await this.telegram.send(`📊 <b>VERIFIED CLOSED-BAR STATS</b>\n` +
        `Trades: ${s.total} · ${s.wins}W/${s.losses}L/${s.scratches} scratch\n` +
        `Win rate: ${s.winRate.toFixed(1)}%\n` +
        `Net PnL: ${s.netPnlPct >= 0 ? '+' : ''}${s.netPnlPct.toFixed(2)}%\n` +
        `Expectancy: ${s.expectancyR >= 0 ? '+' : ''}${s.expectancyR.toFixed(2)}R · PF ${pf}\n` +
        `${s.total < 100 ? '⏳ Not enough out-of-sample trades for live use.' : 'Review drawdown and regime splits before any live use.'}`);
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
  }
}
