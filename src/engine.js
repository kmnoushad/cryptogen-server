import { parseKlines, closedCandles, buildFeatures, impulseBlockers } from './indicators.js';
import { selectUniverse } from './binance.js';
import { assessManipulationRisk, depthMetrics, historyRisk } from './risk.js';
import { advanceCandidate, armCandidate } from './strategy.js';
import { closeTradeAtMarket, evaluateTrade } from './trade-evaluator.js';
import { escapeHtml, formatPrice, gstTime, log, mapLimit, sleep } from './util.js';
import { APP_VERSION } from './version.js';

export const FUTURES_EXCLUDED = new Set([
  'BTCUSDT',
  'DOGEUSDT', 'SHIBUSDT', '1000SHIBUSDT', 'PEPEUSDT', '1000PEPEUSDT',
  'BONKUSDT', '1000BONKUSDT', 'WIFUSDT', 'FLOKIUSDT', '1000FLOKIUSDT',
  'TRUMPUSDT', 'MELANIAUSDT', 'BOMEUSDT', 'POPCATUSDT', 'PNUTUSDT',
  'USDCUSDT', 'BTCDOMUSDT', 'DEFIUSDT', 'PAXGUSDT', 'XAUTUSDT',
  'XAUUSDT', 'XAGUSDT',
]);

const btcTechnicalSummary = btc => {
  const distance = Number(btc?.distanceFromEma50Pct);
  const slope = Number(btc?.ema50Slope6hPct);
  if (!Number.isFinite(distance) || !Number.isFinite(slope)) return '';
  const signed = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  return ` · EMA50 ${signed(distance)} · slope6h ${signed(slope)}`;
};

const medianNumber = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const medianDepthSnapshot = snapshots => {
  if (!snapshots.length) return null;
  return {
    bidNotional05: medianNumber(snapshots.map(x => Number(x.bidNotional05))),
    askNotional05: medianNumber(snapshots.map(x => Number(x.askNotional05))),
    spreadBps: medianNumber(snapshots.map(x => Number(x.spreadBps))),
    measuredAt: Math.max(...snapshots.map(x => Number(x.measuredAt ?? 0))),
  };
};

const normalizedCandidateReason = reason => {
  const value = String(reason || 'unknown');
  if (value.startsWith('structural stop')) return 'structural stop too wide';
  if (value.startsWith('net R:R')) return 'net R:R below minimum';
  if (value.startsWith('manipulation risk')) return 'manipulation risk';
  if (value.startsWith('impulse wave retraced')) return 'impulse wave retraced beyond setup limit';
  if (value.startsWith('breakout level failed')) return 'breakout level failed';
  return value;
};

export class Engine {
  constructor({ cfg, binance, store, telegram, alpha = null, calendar = null, realtimeShock = null, fastMover = null, alphaMover = null, eventGuard = null, btcFeed = null, btcBias = null, btcRecorder = null }) {
    this.cfg = cfg;
    this.binance = binance;
    this.store = store;
    this.telegram = telegram;
    this.alpha = alpha;
    this.calendar = calendar;
    this.realtimeShock = realtimeShock;
    this.fastMover = fastMover;
    this.alphaMover = alphaMover;
    this.eventGuard = eventGuard;
    this.btcFeed = btcFeed;
    this.btcBias = btcBias;
    this.btcRecorder = btcRecorder;
    this.eventGuardWindow = null; // last observed guard window (edge-triggered Telegram lifecycle)
    this.eventGuardHoldLogged = new Set(); // `${symbol}:${eventTime}` — HOLD log once per candidate per window
    this.eventGuardFrozenBar = new Map(); // symbol → last bar closeTime already risk-checked under the freeze
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
    this.metrics = {
      scans: 0,
      armed: 0,
      retested: 0,
      reclaimed: 0,
      executionWaits: 0,
      expired: 0,
      rejected: 0,
      signaled: 0,
      dataErrors: 0,
      armedByType: {},
      signaledByType: {},
    };
    this.gateCounts = {};
    this.gateDelta = {};
    this.candidateRejectCounts = {};
    this.candidateHoldCounts = {};
    this.lastGateSummaryBucket = Math.floor(Date.now() / (15 * 60_000));
    // BTC-freeze visibility (v6.9): while the long gate stays closed the funnel
    // is silently frozen, so track how long it has been blocked and how many
    // candidates it cancelled, then heartbeat once per configured window.
    this.btcBlockedSince = null;
    this.btcBlockCancelled = 0;
    this.lastBtcBlockHeartbeatAt = null;
  }

  countGate(name, amount = 1) {
    this.gateCounts[name] = Number(this.gateCounts[name] ?? 0) + amount;
    this.gateDelta[name] = Number(this.gateDelta[name] ?? 0) + amount;
  }

  countCandidateReject(reason) {
    const category = normalizedCandidateReason(reason);
    this.candidateRejectCounts[category] = Number(this.candidateRejectCounts[category] ?? 0) + 1;
    this.countGate(`REJECT: ${category}`);
    if (category.includes('expired') || category.includes('did not recover')) this.metrics.expired++;
    return category;
  }

  countCandidateHold(reason) {
    for (const part of String(reason || 'waiting').split(', ')) {
      this.candidateHoldCounts[part] = Number(this.candidateHoldCounts[part] ?? 0) + 1;
      this.countGate(`HOLD: ${part}`);
    }
  }

  async persistCandidateOutcome(candidate, outcome, reason, features = null, context = null) {
    try {
      await this.store.insertEvent({
        event_key: `futures:candidate:${candidate.symbol}:${candidate.detectedBarClose}:${outcome}`,
        event_type: 'FUTURES_CANDIDATE_OUTCOME',
        symbol: candidate.symbol,
        payload: {
          outcome,
          reason,
          setupType: candidate.setupType,
          state: candidate.state,
          detectedBarClose: candidate.detectedBarClose,
          barsObserved: candidate.barsObserved,
          retested: Boolean(candidate.retested),
          reclaimed: Boolean(candidate.reclaimed),
          breakoutLevel: candidate.breakoutLevel,
          invalidationLevel: candidate.invalidationLevel,
          retestLow: candidate.retestLow,
          close: features?.last?.close,
          riskScore: context?.risk?.score,
          riskReasons: context?.risk?.reasons ?? [],
        },
      });
    } catch (error) {
      log(`Candidate outcome persistence failed for ${candidate.symbol}: ${error.message}`);
    }
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

  async handleRealtimeShock(event) {
    const cancelledCandidates = [...this.candidates.values()];
    const cancelled = cancelledCandidates.length;
    if (cancelled) {
      this.candidates.clear();
      this.metrics.rejected += cancelled;
      for (const candidate of cancelledCandidates) this.countCandidateReject('BTC realtime shock');
    }
    this.countGate('REALTIME_SHOCK_BLOCK');
    const windowSeconds = Math.round(this.cfg.realtimeShockWindowMs / 1000);
    const text = `⚡ <b>[FUTURES] BTC REALTIME SHOCK</b>\n` +
      `BTC ${Number(event.dropPct).toFixed(2)}% in ${windowSeconds}s\n` +
      `Cancelled pending Futures candidates: ${cancelled}\n` +
      `New Futures entries blocked for ${Math.round(this.cfg.realtimeShockCooldownMs / 60_000)} minutes.\n` +
      `<i>Existing monitored trades keep their database stop; do not widen it.</i>\n` +
      `⏰ ${gstTime()} GST`;
    const eventKey = `futures:realtime-shock:${Math.floor(Number(event.eventTime) / this.cfg.realtimeShockWindowMs)}`;
    const tasks = [
      this.store.insertEvent({
        event_key: eventKey,
        event_type: 'FUTURES_REALTIME_SHOCK',
        symbol: 'BTCUSDT',
        payload: { ...event, cancelledCandidates: cancelled },
      }),
      this.telegram.send(text),
      ...cancelledCandidates.map(candidate => this.persistCandidateOutcome(
        { ...candidate, state: 'REJECTED' },
        'REJECT',
        'BTC realtime shock',
      )),
    ];
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') log(`Realtime shock notification persistence failed: ${result.reason?.message ?? result.reason}`);
    }
  }

  // A2: while the BTC long gate is closed the Futures funnel silently freezes.
  // Heartbeat once per configured window so the freeze is visible. Firing is
  // anchored to elapsed time (not epoch buckets, which can double-fire across
  // a bucket boundary); the persisted dedup key is anchored to the block start
  // so restarts never collide with a previous block's keys.
  async maybeBtcBlockHeartbeat(now = Date.now()) {
    if (this.btc.allowed) {
      this.btcBlockedSince = null;
      this.lastBtcBlockHeartbeatAt = null;
      this.btcBlockCancelled = 0;
      return;
    }
    if (this.btcBlockedSince === null) {
      this.btcBlockedSince = now;
      this.btcBlockCancelled = 0;
    }
    const windowMin = Number(this.cfg.btcBlockHeartbeatMin ?? 0);
    if (!(windowMin > 0)) return;
    const windowMs = windowMin * 60_000;
    if (now - this.btcBlockedSince < windowMs) return;
    if (this.lastBtcBlockHeartbeatAt !== null && now - this.lastBtcBlockHeartbeatAt < windowMs) return;
    this.lastBtcBlockHeartbeatAt = now;
    const blockBucket = Math.floor(this.btcBlockedSince / windowMs);
    const windowIndex = Math.floor((now - this.btcBlockedSince) / windowMs);
    const blockedMin = Math.floor((now - this.btcBlockedSince) / 60_000);
    const topGates = Object.entries(this.gateCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const gateLines = topGates.length
      ? topGates.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
      : 'none recorded';
    const text = `🧊 <b>[FUTURES] BTC GATE BLOCKED ${blockedMin} MIN</b>\n` +
      `Regime: ${escapeHtml(this.btc.regime)}${btcTechnicalSummary(this.btc)}\n` +
      `Candidates cancelled while blocked: ${this.btcBlockCancelled}\n` +
      `<b>Top gates:</b>\n${gateLines}\n` +
      `<i>Futures entries stay frozen until the BTC gate reopens; repeats at most once per ${windowMin}min window.</i>\n` +
      `⏰ ${gstTime()} GST`;
    const results = await Promise.allSettled([
      this.store.insertEvent({
        event_key: `futures:btc-block-heartbeat:${blockBucket}:${windowIndex}`,
        event_type: 'FUTURES_BTC_BLOCK_HEARTBEAT',
        symbol: 'BTCUSDT',
        payload: {
          regime: this.btc.regime,
          distanceFromEma50Pct: this.btc.distanceFromEma50Pct ?? null,
          ema50Slope6hPct: this.btc.ema50Slope6hPct ?? null,
          blockedMin,
          topGates: topGates.map(([name, count]) => ({ name, count })),
          cancelledCandidates: this.btcBlockCancelled,
        },
      }),
      this.telegram.send(text),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') log(`BTC block heartbeat failed: ${result.reason?.message ?? result.reason}`);
    }
  }

  // v6.9.5 Event Window Guard lifecycle. Edge-triggered on the guard window:
  // one warning when ENTERING a window and one all-clear when EXITING it,
  // deduped through nexio_events so a restart mid-window never double-sends.
  async syncEventGuard(window) {
    const previous = this.eventGuardWindow;
    if (window && previous && previous.eventTime === window.eventTime) return; // same window still active
    this.eventGuardWindow = window;
    if (previous && !window) {
      // The all-clear is sent ONLY when the guard fully ends (window → null).
      // An A→B overlap switch keeps entries blocked, so no "resumed" message
      // may leak between the two events.
      await this.notifyEventGuard('exit', previous);
      this.eventGuardHoldLogged.clear();
      this.eventGuardFrozenBar.clear();
    }
    if (window && (!previous || previous.eventTime !== window.eventTime)) {
      // A→B switch: a single "guard continues" message, deduped through B's
      // own enter key so a restart mid-window never resends it.
      await this.notifyEventGuard('enter', window, { continued: Boolean(previous) });
    }
  }

  async notifyEventGuard(kind, window, { continued = false } = {}) {
    const eventTimeIso = new Date(window.eventTime).toISOString();
    const preMin = Number(this.cfg.eventGuardPreMin ?? 30);
    const postMin = Number(this.cfg.eventGuardPostMin ?? 15);
    const name = escapeHtml(window.name);
    const phaseText = window.phase === 'PRE'
      ? `in ~${Math.max(0, Math.ceil(window.minutesToEvent))}m`
      : `+${Math.max(0, Math.ceil(-window.minutesToEvent))}m post-event`;
    const text = kind === 'enter'
      ? continued
        ? `⚠️ EVENT GUARD continues — now guarding <b>${name}</b> ${phaseText} (window unchanged; entries still blocked).\n` +
          `⏰ ${gstTime()} GST`
      : `⏳ <b>[GUARD] HIGH-IMPACT EVENT WINDOW</b>\n` +
        `<b>${name}</b> — ${window.phase === 'PRE'
          ? `in ${Math.max(0, Math.ceil(window.minutesToEvent))} min`
          : `${Math.max(0, Math.ceil(-window.minutesToEvent))} min post-event`}\n` +
        `🕐 ${eventTimeIso.slice(0, 16).replace('T', ' ')} UTC · window −${preMin}m/+${postMin}m\n` +
        `New entries & radar alerts paused; open trades still monitored.\n` +
        `⏰ ${gstTime()} GST`
      : `✅ <b>[GUARD] EVENT WINDOW CLEAR</b>\n` +
        `<b>${name}</b> window (−${preMin}m/+${postMin}m around ${eventTimeIso.slice(0, 16).replace('T', ' ')} UTC) has ended.\n` +
        `New entries & radar alerts resumed; open trades were monitored throughout.\n` +
        `⏰ ${gstTime()} GST`;
    // Persist BEFORE alerting (same semantics as the radars): insertEvent →
    // false means this enter/exit was already announced (e.g. before a
    // restart), so skip the Telegram send. A DB ERROR must never silence the
    // message: log it and still send.
    let reserved;
    try {
      reserved = await this.store.insertEvent({
        event_key: `event-guard:${eventTimeIso}:${kind}`,
        event_type: 'EVENT_GUARD',
        symbol: '[GUARD]',
        payload: {
          kind,
          continued,
          name: window.name,
          eventTime: eventTimeIso,
          phase: window.phase,
          minutesToEvent: Number(window.minutesToEvent.toFixed(2)),
          preMin,
          postMin,
        },
      });
    } catch (error) {
      reserved = true; // persistence failure must not silence the guard message
      log(`Event guard persistence failed (${kind} ${window.name}): ${error.message}`);
    }
    if (reserved === false) return false;
    try {
      await this.telegram.send(text);
      log(`EVENT GUARD ${kind === 'enter' ? (continued ? 'CONTINUES' : 'WINDOW ACTIVE') : 'ALL-CLEAR'}: ${window.name} (${eventTimeIso})`);
      return true;
    } catch (error) {
      log(`Event guard Telegram send failed (${kind} ${window.name}): ${error.message}`);
      return false;
    }
  }

  eventGuardStatusLine() {
    return this.eventGuard?.statusLine() ?? 'Event guard: disabled';
  }

  // v6.9.6: compact BTC bias tag bundled into outbound alerts. Default-on; a
  // null bias engine (older tests, disabled feed) leaves messages unchanged.
  btcBiasTagLine() {
    if (this.cfg.enableBtcBiasTag === false || !this.btcBias) return null;
    try {
      return this.btcBias.btcTag({ long: true });
    } catch (error) {
      log(`BTC bias tag failed: ${error.message}`);
      return null;
    }
  }

  btcBiasStatusLine() {
    if (!this.btcBias || this.cfg.enableBtcFeed === false) return 'BTC bias: disabled';
    const snapshot = this.btcBias.lastSnapshot;
    const recorder = this.btcRecorder?.health?.() ?? null;
    const recorderText = !recorder || !recorder.enabled
      ? 'recorder off'
      : recorder.disabled ? 'recorder ⚠️ table missing' : `recorder ✅ ${recorder.inserted}`;
    if (!snapshot) return `BTC bias: warming up · ${recorderText}`;
    const signed = value => `${value < 0 ? '−' : '+'}${Math.abs(value)}`;
    return `BTC bias 15m: ${escapeHtml(snapshot.h15.label)} (${signed(snapshot.h15.score)}, conf ${snapshot.h15.confidence}%)` +
      ` · 30m: ${escapeHtml(snapshot.h30.label)} (${signed(snapshot.h30.score)})` +
      `${snapshot.stale ? ' · ⚠️ data stale' : ''} · ${recorderText}`;
  }

  btcBiasWhyLine() {
    if (!this.btcBias?.blocksLongs?.()) return null;
    const blocks = Number(this.gateCounts.BTC_BIAS_BLOCK ?? 0);
    return `⛔ BTC bias gate ACTIVE: 15m STRONG_DOWN — new arms/seeds blocked (${blocks}× BTC_BIAS_BLOCK)`;
  }

  // /btc: full bias breakdown — both horizons with top-3 drivers, book walls,
  // empirical hit rates, and feed/recorder status. All dynamic text escaped.
  btcBiasReport() {
    if (!this.btcBias || this.cfg.enableBtcFeed === false) {
      return '₿ BTC bias engine is disabled (ENABLE_BTC_FEED=false).';
    }
    const snapshot = this.btcBias.lastSnapshot ?? this.btcBias.evaluate();
    const signed = value => `${value < 0 ? '−' : '+'}${Math.abs(value)}`;
    const horizonLines = (name, horizon) => {
      const drivers = horizon.drivers.length
        ? horizon.drivers.map(driver => `▸ ${escapeHtml(driver)}`).join('\n')
        : '▸ no active drivers';
      return `<b>${name}: ${escapeHtml(horizon.label)}</b> (score ${signed(horizon.score)}, conf ${horizon.confidence}%)\n${drivers}`;
    };
    const walls = [];
    if (snapshot.book.bidWallBps !== null) {
      walls.push(`bid wall ${Math.round(snapshot.book.bidWallBps)}bps below (${Number(snapshot.book.bidWallX).toFixed(1)}× median)`);
    }
    if (snapshot.book.askWallBps !== null) {
      walls.push(`ask wall ${Math.round(snapshot.book.askWallBps)}bps above (${Number(snapshot.book.askWallX).toFixed(1)}× median)`);
    }
    const bookLine = snapshot.book.imbalanceTop10 === null
      ? 'Book: no depth snapshot yet'
      : `Book top-10 imbalance: ${snapshot.book.imbalanceTop10 >= 0 ? '+' : ''}${(snapshot.book.imbalanceTop10 * 100).toFixed(0)}% bids` +
        (walls.length ? `\nWalls: ${escapeHtml(walls.join(' · '))}` : '\nWalls: none ≥3× median nearby');
    const hitLine = (name, bucket) => bucket.total
      ? `${name}: ${Math.round(bucket.hits / bucket.total * 100)}% (n=${bucket.total})`
      : `${name}: n/a yet`;
    const outcomes = this.btcBias.outcomes;
    const feed = this.btcFeed?.health?.() ?? null;
    const feedLine = !feed
      ? 'Feed: not wired'
      : `Feed: ${feed.connected && !feed.stale ? '✅ live' : '⚠️ reconnecting'} · ${feed.closes} closes · warmed ${feed.warmed ? '✅' : '⏳'}`;
    const recorder = this.btcRecorder?.health?.() ?? null;
    const recorderLine = !recorder || !recorder.enabled
      ? 'Recorder: off'
      : recorder.disabled
        ? 'Recorder: ⚠️ table missing — run sql/btc_snapshots.sql'
        : `Recorder: ✅ ${recorder.inserted} rows`;
    return `₿ <b>BTC BIAS — 15m/30m gauge</b>\n` +
      `Price: $${formatPrice(snapshot.price)}${snapshot.stale ? ' · ⚠️ <b>data stale — treat with caution</b>' : ''}\n\n` +
      `${horizonLines('15m', snapshot.h15)}\n\n${horizonLines('30m', snapshot.h30)}\n\n` +
      `${bookLine}\n` +
      `Hit rates: ${hitLine('15m', outcomes.h15)} · ${hitLine('30m', outcomes.h30)}\n` +
      `${feedLine}\n${recorderLine}\n` +
      `<i>Bias gauge for context — not a standalone trade signal.</i>\n` +
      `⏰ ${gstTime()} GST`;
  }

  // /why variant: the /status line plus the next upcoming event when known.
  eventGuardWhyLine() {
    if (!this.eventGuard) return 'Event guard: disabled';
    const line = this.eventGuard.statusLine();
    const next = this.eventGuard.nextEvent();
    if (!next) return line;
    return `${line} · next: ${escapeHtml(next.name)} at ${new Date(next.eventTime).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
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
    const selected = selectUniverse(info, tickers, this.cfg, FUTURES_EXCLUDED, acceleration);
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
    for (const [symbol, snapshots] of this.depthSnapshots) {
      const history = Array.isArray(snapshots) ? snapshots : [snapshots];
      const latest = history.at(-1);
      if (!latest || Date.now() - latest.measuredAt > 30 * 60_000) this.depthSnapshots.delete(symbol);
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
    const depth = depthMetrics(book, features.last.close, this.cfg.assumedOrderNotionalUsd);
    const stored = this.depthSnapshots.get(symbol);
    const snapshots = (Array.isArray(stored) ? stored : stored ? [stored] : []).slice(-5);
    const depthBaseline = medianDepthSnapshot(snapshots.slice(-3));
    depth.bidRetention = depthBaseline?.bidNotional05 > 0
      ? depth.bidNotional05 / depthBaseline.bidNotional05
      : null;
    depth.spreadExpansion = depthBaseline?.spreadBps > 0
      ? depth.spreadBps / depthBaseline.spreadBps
      : null;
    const fundingPct = Number(premium.lastFundingRate) * 100;
    if (!Number.isFinite(fundingPct)) throw new Error(`Invalid funding for ${symbol}`);
    const risk = assessManipulationRisk({
      features, oi, depth, previousDepth: depthBaseline, history, fundingPct, cfg: this.cfg,
    });
    this.depthSnapshots.set(symbol, [...snapshots, depth].slice(-5));
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
          entryImpactBps: context.depth.entryImpactBps,
          depthImbalance: context.depth.imbalance,
          bidRetention: context.depth.bidRetention,
        },
      });
      if (created) log(`SILENT FUTURES FILTER ${symbol}: ${context.risk.reasons.join('; ')}`);
    } catch (error) {
      log(`Risk warning persistence/send failed for ${symbol}: ${error.message}`);
    }
  }

  async scanSymbol(item) {
    const symbol = item.symbol;
    const eventWindow = this.eventGuard?.activeWindow() ?? null;
    if (this.realtimeShock?.blocked()) {
      const hadCandidate = this.candidates.delete(symbol);
      if (hadCandidate) this.metrics.rejected++;
      return { action: 'REALTIME_SHOCK_BLOCK' };
    }
    const rows = await this.binance.klines(symbol, '1m', 90);
    const candles = closedCandles(parseKlines(rows));
    const features = buildFeatures(candles);
    if (!features) throw new Error(`Feature data incomplete for ${symbol}`);
    if (this.lastBarSeen.get(symbol) === features.last.closeTime) return { action: 'NO_NEW_BAR' };
    // Event Window Guard freeze: while a window is active an EXISTING
    // candidate is frozen, and lastBarSeen is deliberately NOT advanced for
    // its symbol — the frozen marker must still point at the last bar the
    // candidate's lifecycle actually evaluated, so the first post-window
    // advanceCandidate call resumes from exactly that state instead of
    // skipping the bars that elapsed under the guard.
    const guardFrozen = Boolean(eventWindow && this.candidates.has(symbol));
    if (!guardFrozen) {
      this.lastBarSeen.set(symbol, features.last.closeTime);
    } else if (this.eventGuardFrozenBar.get(symbol) === features.last.closeTime) {
      // This bar was already risk-checked under the freeze (see below); do
      // not burn another context/depth call on it.
      this.countGate('EVENT_GUARD_HOLD');
      return { action: 'EVENT_GUARD', reason: `event window: ${eventWindow.name}` };
    }

    let candidate = this.candidates.get(symbol);
    if (!candidate) {
      // Event Window Guard: refuse to arm NEW exposure inside the window,
      // before burning any context (depth/OI/history) calls. Unlike the BTC
      // gate this never deletes existing candidates.
      if (eventWindow) {
        this.countGate('EVENT_GUARD_BLOCK');
        return { action: 'EVENT_GUARD' };
      }
      if (!this.btc.allowed) {
        this.countGate('BTC_BLOCK');
        return { action: 'NONE' };
      }
      // v6.9.6 opt-in hard gate (BTC_BIAS_BLOCK_LONGS, default off): refuse
      // NEW arms while the 15m bias is STRONG_DOWN. Existing candidates and
      // open trades are never touched by this gate.
      if (this.btcBias?.blocksLongs?.()) {
        this.countGate('BTC_BIAS_BLOCK');
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
      this.metrics.armedByType[features.setupType] = Number(this.metrics.armedByType[features.setupType] ?? 0) + 1;
      log(`ARMED ${symbol}: breakout ${features.breakoutPct.toFixed(2)}%, flow ${(features.buyRatio3 * 100).toFixed(0)}%`);
      return { action: 'ARMED' };
    }

    if (!this.btc.allowed) {
      this.countGate('CANDIDATE_REJECT: BTC changed');
      this.candidates.delete(symbol);
      this.metrics.rejected++;
      this.btcBlockCancelled++;
      this.countCandidateReject('BTC regime changed while candidate was active');
      await this.persistCandidateOutcome(candidate, 'REJECT', `BTC changed to ${this.btc.regime}`, features);
      return { action: 'REJECT', reason: `BTC changed to ${this.btc.regime}` };
    }

    const context = await this.context(symbol, features);

    // Event Window Guard FREEZE (v6.9.5 review fix): while a window is active
    // advanceCandidate is NOT called for an existing candidate at all. The
    // candidate's fields stay untouched, so neither the post-reclaim execution
    // wait (~3 bars) nor the pre-reclaim TTL can lapse mid-window and
    // mass-reject held candidates ('execution book did not recover'). What is
    // NOT frozen: terminal manipulation risk — a terminal live event erases
    // the setup immediately, window or not — and open-trade monitoring (see
    // manageOpenTrades, never gated).
    if (eventWindow) {
      if (context.risk?.terminalRisk) {
        const reason = `manipulation risk: ${context.risk.reasons.join('; ')}`;
        this.countCandidateReject(reason);
        this.candidates.delete(symbol);
        this.eventGuardFrozenBar.delete(symbol);
        this.metrics.rejected++;
        if (context.risk.hardBlock) await this.warnRisk(symbol, features, context);
        await this.persistCandidateOutcome({ ...candidate, state: 'REJECTED' }, 'REJECT', reason, features, context);
        log(`REJECT ${symbol}: ${reason}`);
        return { action: 'REJECT', reason };
      }
      this.eventGuardFrozenBar.set(symbol, features.last.closeTime);
      this.countGate('EVENT_GUARD_HOLD');
      const holdKey = `${symbol}:${eventWindow.eventTime}`;
      if (!this.eventGuardHoldLogged.has(holdKey)) {
        this.eventGuardHoldLogged.add(holdKey);
        log(`EVENT GUARD HOLD ${symbol}: ${eventWindow.name} window active; candidate frozen, lifecycle resumes when the window ends`);
      }
      return { action: 'EVENT_GUARD', reason: `event window: ${eventWindow.name}` };
    }

    const decision = advanceCandidate(candidate, features, context, this.cfg);
    if (decision.action === 'HOLD') {
      if (!candidate.retested && decision.candidate.retested) this.metrics.retested++;
      if (!candidate.reclaimed && decision.candidate.reclaimed) {
        this.metrics.reclaimed++;
        if (decision.candidate.state === 'RECLAIMED_WAIT_BOOK') this.metrics.executionWaits++;
      }
      this.countCandidateHold(decision.reason);
      this.candidates.set(symbol, decision.candidate);
      return decision;
    }
    if (decision.action === 'REJECT') {
      const reason = String(decision.reason);
      this.countCandidateReject(reason);
      this.candidates.delete(symbol);
      this.metrics.rejected++;
      if (context.risk.hardBlock) await this.warnRisk(symbol, features, context);
      await this.persistCandidateOutcome(decision.candidate, 'REJECT', reason, features, context);
      log(`REJECT ${symbol}: ${decision.reason}`);
      return decision;
    }

    if (!this.btc.allowed) {
      this.candidates.delete(symbol);
      this.btcBlockCancelled++;
      return { action: 'REJECT', reason: `BTC changed to ${this.btc.regime}` };
    }

    // (No EVENT_GUARD branch here: with a window active advanceCandidate is
    // never reached — the freeze above returns first — so a SIGNAL decision
    // can only occur outside the window. This also keeps the guard-hold
    // metrics consistent: reclaimed/executionWaits are counted exactly once,
    // on the normal HOLD/SIGNAL paths, never double-counted by a hold shim.)

    if (!candidate.reclaimed && decision.candidate.reclaimed) this.metrics.reclaimed++;
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

    if (this.realtimeShock?.blocked()) {
      this.countGate('REALTIME_SHOCK_BLOCK');
      this.candidates.delete(symbol);
      return { action: 'REALTIME_SHOCK_BLOCK' };
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
      const btcTagLine = this.btcBiasTagLine();
      await this.telegram.send(this.telegram.signalMessage(inserted.trade, this.btc) + (btcTagLine ? `\n${btcTagLine}` : ''));
      delivered = true;
      await this.store.updateTrade(inserted.trade.id, { alert_sent: true });
      this.metrics.signaled++;
      const setupType = decision.trade.setup?.setupType ?? 'UNKNOWN';
      this.metrics.signaledByType[setupType] = Number(this.metrics.signaledByType[setupType] ?? 0) + 1;
      await this.persistCandidateOutcome(decision.candidate, 'SIGNAL', 'FIRE delivered', features, context);
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
      const eventWindow = this.eventGuard?.activeWindow() ?? null;
      await this.syncEventGuard(eventWindow);
      if (Date.now() - this.lastUniverseRefresh >= this.cfg.universeRefreshMs) await this.refreshUniverse();
      try {
        this.btc = await this.binance.btcRegime();
      } catch (error) {
        this.btc = { regime: 'DATA_BLOCK', allowed: false, reason: error.message };
        this.metrics.dataErrors++;
        log(`BTC fail-closed: ${error.message}`);
      }
      await this.maybeBtcBlockHeartbeat();

      const results = this.realtimeShock?.blocked()
        ? []
        : await mapLimit(this.universe, this.cfg.scanConcurrency, item => this.scanSymbol(item));
      if (this.realtimeShock?.blocked()) this.countGate('REALTIME_SHOCK_BLOCK');
      for (const result of results) {
        if (result?.error) {
          this.metrics.dataErrors++;
          this.countGate('DATA_ERROR');
          log(`Symbol scan failed: ${result.error.message}`);
        }
      }
      await this.manageOpenTrades();
      if (this.alpha) {
        // During an event window Alpha runs monitor-only (same as paused):
        // no new IGNITIONs, existing alpha trades keep monitoring.
        try { await this.alpha.scan(eventWindow ? { monitorOnly: true } : {}); }
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
      realtimeShock: this.realtimeShock?.health() ?? { enabled: false },
      btcFeed: this.btcFeed?.health() ?? { enabled: false },
      btcBias: this.btcBias?.health() ?? { enabled: false },
      btcRecorder: this.btcRecorder?.health() ?? { enabled: false },
      fastMover: this.fastMover?.health() ?? { enabled: false },
      alphaMover: this.alphaMover?.health() ?? { enabled: false },
    };
  }

  alphaMoverStatusLine() {
    const health = this.alphaMover?.health();
    if (!health?.enabled) return 'Alpha fast mover: disabled';
    const last = health.lastPollAt ? `last poll ${health.lastPollAt.slice(11, 19)} UTC` : 'awaiting first poll';
    return `Alpha fast mover: ✅ radar · ${health.tracked} tracked · ${health.metrics?.alerts ?? 0} alerts · ${last}`;
  }

  fastMoverStatusLine() {
    const health = this.fastMover?.health();
    if (!health?.enabled) return 'Fast mover: disabled';
    const state = health.connected && !health.stale ? '✅ connected' : '⚠️ reconnecting';
    const lines = [
      `Fast mover: ${state} · ${health.trackedSymbols} tracked · ${health.metrics?.alerts ?? 0} alerts/${health.metrics?.triggers ?? 0} triggers`,
    ];
    const trending = health.trending;
    if (trending?.enabled) {
      lines.push(`Trending mover: ${trending.metrics?.trendingAlerts ?? 0} alerts/${trending.metrics?.trendingTriggers ?? 0} triggers · ${trending.trackedSymbols ?? 0} tracked`);
    }
    return lines.join('\n');
  }

  // /why variant: the per-tier status lines plus the top-2 suppression reasons
  // (merged across both radar tiers) so a silent radar explains itself.
  fastMoverWhyLines() {
    const health = this.fastMover?.health();
    if (!health?.enabled) return ['Fast mover: disabled'];
    const lines = this.fastMoverStatusLine().split('\n');
    const merged = {};
    const add = source => {
      for (const [name, count] of Object.entries(source ?? {})) {
        const key = name === 'cap' ? 'hourlyCap' : name; // tier-1 calls the hourly cap 'cap'
        merged[key] = Number(merged[key] ?? 0) + Number(count ?? 0);
      }
    };
    add(health.suppressed ?? health.metrics?.suppressed);
    add(health.trending?.suppressed);
    const top = Object.entries(merged)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (top.length) {
      lines.push(`Radar suppressed: ${top.map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ')}`);
    }
    return lines.slice(0, 3);
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
        '/version /status /why /btc /diagnostics /audit /stats /events /scan /alphascan /pause /resume /help');
    } else if (text === '/version') {
      await this.telegram.send(`🧬 <b>NEXIO VERSION</b>\nRunning: <b>v${APP_VERSION}</b>\n` +
        `[FUTURES]: setup-aware survival + retest/reclaim + execution-book recovery\n[ALPHA]: separate guarded entry + active outcome monitoring\n` +
        `BTC gate: HTF trend + realtime ${this.cfg.realtimeShockDropPct}%/${Math.round(this.cfg.realtimeShockWindowMs / 1000)}s shock guard\n` +
        `Calendar: live Finnhub high-impact US reminders\n` +
        `⏰ ${gstTime()} GST`);
    } else if (text === '/status') {
      const risk = await this.store.riskSnapshot(this.cfg);
      const calendarHealth = this.calendar?.health() ?? { configured: false, loaded: 0, lastError: null };
      const shockHealth = this.realtimeShock?.health() ?? { enabled: false };
      await this.telegram.send(`🩺 <b>NEXIO v${APP_VERSION} STATUS</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅' : '⛔'}${btcTechnicalSummary(this.btc)}\n` +
        `Universe: ${this.universe.length} · Candidates: ${this.candidates.size}\n` +
        `Open: ${risk.openTrades} · Today: ${risk.tradesToday}/${this.cfg.maxTradesPerDay}\n` +
        `Daily PnL: ${risk.dailyPnlPct.toFixed(2)}% · Weekly: ${risk.weeklyPnlPct.toFixed(2)}%\n` +
        `Paused: ${this.paused ? 'YES' : 'NO'} · Last scan: ${this.lastScanDurationMs}ms\n` +
        `Engine: ${this.metrics.scans} scans · ${this.metrics.armed} armed · ${this.metrics.signaled} FIRE · ${this.metrics.dataErrors} errors\n` +
        `Alpha: ${this.alpha?.health().enabled ? `✅ ${this.alpha.active().length} active` : 'disabled'}\n` +
        `Calendar: ${calendarHealth.lastError ? '⚠️ API error · use /events' : calendarHealth.configured ? `✅ ${calendarHealth.loaded} events loaded` : '⚠️ FINNHUB_KEY missing/disabled'}\n` +
        `${this.eventGuardStatusLine()}\n` +
        `Realtime BTC: ${!shockHealth.enabled ? 'disabled' : shockHealth.blocked ? `⛔ SHOCK ${Number(shockHealth.lastShockDropPct).toFixed(2)}%` : shockHealth.connected && !shockHealth.stale ? '✅ connected' : '⚠️ reconnecting · REST gate active'}\n` +
        `${this.fastMoverStatusLine()}\n` +
        `${this.alphaMoverStatusLine()}\n` +
        `${this.btcBiasStatusLine()}\n` +
        `${risk.allowed ? 'Risk gate ✅' : `Risk gate ⛔ ${escapeHtml(risk.reasons.join('; '))}`}\n` +
        `⏰ ${gstTime()} GST`);
    } else if (text === '/btc') {
      await this.telegram.send(this.btcBiasReport());
    } else if (text === '/why') {
      const risk = await this.store.riskSnapshot(this.cfg);
      const topFrom = (counts, limit = 5) => Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      const linesOf = (entries, empty) => entries.length
        ? entries.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : empty;
      const impulseTop = topFrom(Object.fromEntries(Object.entries(this.gateCounts)
        .filter(([name]) => name.startsWith('IMPULSE: '))
        .map(([name, count]) => [name.replace(/^IMPULSE: /, ''), count])));
      const holdTop = topFrom(this.candidateHoldCounts);
      const rejectTop = topFrom(this.candidateRejectCounts);
      const candidateLines = [...this.candidates.values()].length
        ? [...this.candidates.values()].slice(0, 10)
          .map(candidate => `▸ ${escapeHtml(candidate.symbol)} — ${escapeHtml(String(candidate.state ?? 'ARMED'))}`)
          .join('\n')
        : 'No active Futures candidates.';
      const btcBlockedMin = this.btcBlockedSince === null ? null : Math.floor((Date.now() - this.btcBlockedSince) / 60_000);
      await this.telegram.send(`❓ <b>WHY IS NEXIO QUIET?</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅ longs allowed' : '⛔ LONG GATE CLOSED'}${btcTechnicalSummary(this.btc)}\n` +
        `${btcBlockedMin !== null ? `⛔ BTC gate has blocked Futures entries for ${btcBlockedMin} min.\n` : ''}` +
        `${this.eventGuardWhyLine()}\n` +
        `${this.btcBiasWhyLine() ? `${this.btcBiasWhyLine()}\n` : ''}` +
        `${risk.allowed ? 'Risk snapshot ✅ entries allowed' : `Risk snapshot ⛔ ${escapeHtml(risk.reasons.join('; '))}`}\n\n` +
        `<b>Top pre-arm impulse blockers:</b>\n${linesOf(impulseTop, 'None recorded since restart.')}\n\n` +
        `<b>Top candidate HOLD reasons:</b>\n${linesOf(holdTop, 'No candidate waiting reasons yet.')}\n\n` +
        `<b>Top candidate REJECT reasons:</b>\n${linesOf(rejectTop, 'No candidate rejections since restart.')}\n\n` +
        `<b>Active candidates (${this.candidates.size}):</b>\n${candidateLines}\n\n` +
        `${this.fastMoverWhyLines().join('\n')}\n` +
        `${this.alphaMoverStatusLine()}\n` +
        `<i>Gate counts are internal evaluations, not missed guaranteed trades.</i>`);
    } else if (text === '/diagnostics' || text === '/diag') {
      const persisted = await this.store.futuresGateSummaries(24);
      const persistedCounts = {};
      for (const row of persisted) {
        for (const [name, count] of Object.entries(row.payload?.gates ?? {})) {
          persistedCounts[name] = Number(persistedCounts[name] ?? 0) + Number(count ?? 0);
        }
      }
      const top = Object.entries(this.gateCounts)
        .filter(([name]) => !name.startsWith('REJECT:') && !name.startsWith('HOLD:'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const lines = top.length
        ? top.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : 'No Futures gate data collected yet.';
      const rejectTop = Object.entries(this.candidateRejectCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const rejectLines = rejectTop.length
        ? rejectTop.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : 'No candidate rejection since restart.';
      const holdTop = Object.entries(this.candidateHoldCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
      const holdLines = holdTop.length
        ? holdTop.map(([name, count], index) => `${index + 1}. ${escapeHtml(name)} — ${count}`).join('\n')
        : 'No candidate waiting reasons yet.';
      const dayRejectTop = Object.entries(persistedCounts)
        .filter(([name]) => name.startsWith('REJECT:'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      const dayRejectLines = dayRejectTop.length
        ? dayRejectTop.map(([name, count], index) => `${index + 1}. ${escapeHtml(name.replace(/^REJECT: /, ''))} — ${count}`).join('\n')
        : 'No persisted candidate rejection in the available windows.';
      const armedTypes = Object.entries(this.metrics.armedByType)
        .map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ') || 'none';
      const signaledTypes = Object.entries(this.metrics.signaledByType)
        .map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ') || 'none';
      const activeStates = Object.entries([...this.candidates.values()].reduce((out, candidate) => {
        out[candidate.state] = Number(out[candidate.state] ?? 0) + 1;
        return out;
      }, {})).map(([name, count]) => `${escapeHtml(name)} ${count}`).join(' · ') || 'none';
      await this.telegram.send(`🔬 <b>FUTURES DIAGNOSTICS</b>\n` +
        `BTC: ${escapeHtml(this.btc.regime)} ${this.btc.allowed ? '✅' : '⛔'}${btcTechnicalSummary(this.btc)}\n` +
        `<b>Funnel:</b> ${this.metrics.armed} armed → ${this.metrics.retested} retested → ${this.metrics.reclaimed} reclaimed → ${this.metrics.signaled} FIRE\n` +
        `Rejected: ${this.metrics.rejected} · Expired/book timeout: ${this.metrics.expired} · Errors: ${this.metrics.dataErrors}\n` +
        `Active: ${this.candidates.size} (${activeStates})\n` +
        `Armed by setup: ${armedTypes}\nFIRE by setup: ${signaledTypes}\n\n` +
        `<b>Candidate terminal exits:</b>\n${rejectLines}\n\n` +
        `<b>Candidate waiting gates:</b>\n${holdLines}\n\n` +
        `<b>Pre-arm filters:</b>\n${lines}\n\n` +
        `<b>Persisted rejection exits (${persisted.length} windows):</b>\n${dayRejectLines}\n\n` +
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
