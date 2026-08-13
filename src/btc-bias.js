import { ema, mean, median } from './indicators.js';
import { clamp, escapeHtml, log, pctChange } from './util.js';

// v6.9.6 BTC 15m/30m bias engine. A weighted microstructure GAUGE over the
// BtcFeed state (taker flow, order book, CVD, EMA stack) plus two low-rate
// REST context components (OI, funding). It is informational context for the
// operator and for bundling into alerts — never a standalone trade signal.
export const BIAS_WEIGHTS = Object.freeze({
  emaTrend: 0.25,
  takerFlow: 0.25,
  bookImbalance: 0.15,
  walls: 0.10,
  cvdSlope: 0.10,
  volVelocity: 0.05,
  oiContext: 0.05,
  funding: 0.05,
});

const HORIZONS = [15, 30];
const BOOK_STALE_MS = 5_000; // depth20@1000ms updates every second
const SNAPSHOT_STALE_MS = 180_000; // a snapshot older than 3min is stale, flag or not
const KLINE_STALE_MS = 90_000; // a kline tick is expected at least every minute
const OI_POLL_MS = 5 * 60_000; // ≤ 1 REST call / 5 min (weight 1)
const FUNDING_POLL_MS = 60_000; // ≤ 1 REST call / min (weight 1)
const OI_CACHE_MS = 10 * 60_000; // OI reading older than this counts as missing
const FUNDING_CACHE_MS = 5 * 60_000; // funding reading older than this counts as missing
const WALL_RANGE_PCT = 0.5; // only levels within ±0.5% of mid qualify as walls
const WALL_MIN_X = 3; // a wall is ≥3× the median level size
const FUNDING_EXTREME_PCT = 0.03; // beyond this, funding is contrarian

export const biasLabel = score => {
  if (score >= 60) return 'STRONG_UP';
  if (score <= -60) return 'STRONG_DOWN';
  if (score >= 25) return 'UP';
  if (score <= -25) return 'DOWN';
  return 'NEUTRAL';
};

export const labelDirection = label =>
  label === 'UP' || label === 'STRONG_UP' ? 1 : label === 'DOWN' || label === 'STRONG_DOWN' ? -1 : 0;

const signedScore = value => `${value < 0 ? '−' : '+'}${Math.abs(Math.round(value))}`;

export class BtcBiasEngine {
  constructor({ cfg, feed = null, binance = null, telegram = null, now = () => Date.now() }) {
    this.cfg = cfg;
    this.feed = feed;
    this.binance = binance;
    this.telegram = telegram;
    this.now = now;
    this.lastSnapshot = null;
    this.lastError = null;
    // Low-rate REST context caches. polledAt throttles attempts (even failed
    // ones); a failure leaves the value missing ⇒ component scores 0.
    this.oiCache = { changePct: null, at: 0, polledAt: 0, warnCount: 0 };
    this.fundingCache = { ratePct: null, at: 0, polledAt: 0, warnCount: 0 };
    this.contextInflight = false;
    // Outcome tracker: is the 15m or the 30m horizon empirically better?
    this.predictions = []; // { idx, close, label15, label30 }
    this.candleCount = 0;
    this.outcomes = { h15: { hits: 0, total: 0 }, h30: { hits: 0, total: 0 } };
    // Flip detection (TG alerts): last directional label + in-memory cooldown.
    this.lastDirection = 0;
    this.lastFlipAlertAt = 0;
    this.flipCount = 0;
  }

  // ── Component calculators. Each returns { value, ok, text? } with value in
  // [-1, +1]; ok=false means the data was missing/stale and value is 0. ──────

  emaTrend(closes, price, horizon) {
    const values = closes.map(c => c.close);
    if (values.length < 50) return { value: 0, ok: false };
    const ema9 = ema(values, 9);
    const ema21 = ema(values, 21);
    const ema50 = ema(values, 50);
    if (!(ema9 > 0) || !(ema21 > 0) || !(ema50 > 0)) return { value: 0, ok: false };
    const alignment = (Math.sign(ema9 - ema21) + Math.sign(ema21 - ema50)) / 2;
    const priceVs = price > ema21 ? 1 : price < ema21 ? -1 : 0;
    // Horizon slope of EMA21: pct change of EMA21 over the last `horizon` closes.
    let slopeScore = 0;
    let slopePct = 0;
    if (values.length > horizon + 21) {
      const previous = ema(values.slice(0, -horizon), 21);
      slopePct = pctChange(previous, ema21);
      slopeScore = clamp(slopePct / 0.2, -1, 1); // ±0.2% slope = full conviction
    }
    const value = clamp(0.5 * alignment + 0.25 * priceVs + 0.25 * slopeScore, -1, 1);
    const text = `EMA trend ${value >= 0 ? 'bullish' : 'bearish'} (EMA21 slope ${slopePct >= 0 ? '+' : ''}${slopePct.toFixed(2)}%)`;
    return { value, ok: true, text, ema9, ema21, ema50 };
  }

  takerFlow(horizon) {
    const window = this.feed?.takerWindow(horizon) ?? { buy: 0, sell: 0, total: 0, buyRatio: null };
    if (window.buyRatio === null) return { value: 0, ok: false };
    // 0.5 ⇒ 0; a 57.5/42.5 split ⇒ full conviction.
    const value = clamp((window.buyRatio - 0.5) / 0.15, -1, 1);
    const buyPct = Math.round(window.buyRatio * 100);
    const text = value >= 0 ? `taker buys ${buyPct}%` : `taker sells ${100 - buyPct}%`;
    return { value, ok: true, text, buyRatio: window.buyRatio };
  }

  // Stale-book guard shared by the two depth components: a book older than
  // 5s is dead data and must score 0, never lend false conviction.
  bookFresh() {
    return Boolean(this.feed?.lastBookAt) && this.now() - this.feed.lastBookAt <= BOOK_STALE_MS;
  }

  bookImbalance(book) {
    if (!book || !this.bookFresh()) return { value: 0, ok: false };
    const sum = levels => levels.slice(0, 10).reduce((acc, [, qty]) => acc + qty, 0);
    const bidQty = sum(book.bids);
    const askQty = sum(book.asks);
    if (!(bidQty + askQty > 0)) return { value: 0, ok: false };
    const imbalance = (bidQty - askQty) / (bidQty + askQty);
    const pct = Math.round(Math.abs(imbalance) * 100);
    const text = imbalance >= 0
      ? `bids ${pct}% heavier in top-10 book`
      : `asks ${pct}% heavier in top-10 book`;
    return { value: clamp(imbalance * 2, -1, 1), ok: true, text, imbalance };
  }

  // Walls: the largest bid/ask level within ±0.5% of mid counts as a wall when
  // it is ≥3× the median level size. A nearby wall (≤15 bps) pulls price
  // toward it (bid wall bullish, ask wall bearish); a far wall (>40 bps) is
  // weak influence and is scaled down.
  walls(book) {
    if (!book || !this.bookFresh()) return { value: 0, ok: false };
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    if (!(bestBid > 0) || !(bestAsk > bestBid)) return { value: 0, ok: false };
    const mid = (bestBid + bestAsk) / 2;
    const sizes = [...book.bids, ...book.asks].map(([, qty]) => qty);
    const med = median(sizes);
    if (!(med > 0)) return { value: 0, ok: false };
    const inRange = level => Math.abs(level[0] - mid) / mid * 100 <= WALL_RANGE_PCT;
    const largest = levels => levels.filter(inRange)
      .reduce((best, level) => (level[1] > (best?.[1] ?? 0) ? level : best), null);
    const bidWall = largest(book.bids);
    const askWall = largest(book.asks);
    const measure = (wall, side) => {
      if (!wall) return { bps: null, x: null, contribution: 0 };
      const x = wall[1] / med;
      const bps = Math.abs(mid - wall[0]) / mid * 10_000;
      if (x < WALL_MIN_X) return { bps, x, contribution: 0 };
      const magnitude = bps <= 15 ? 1 : bps <= 40 ? 0.5 : 0.2;
      return { bps, x, contribution: (side === 'bid' ? 1 : -1) * magnitude };
    };
    const bid = measure(bidWall, 'bid');
    const ask = measure(askWall, 'ask');
    const parts = [];
    if (bid.contribution > 0) parts.push(`bid wall ${Math.round(bid.bps)}bps below (${bid.x.toFixed(1)}× median)`);
    if (ask.contribution < 0) parts.push(`ask wall ${Math.round(ask.bps)}bps above (${ask.x.toFixed(1)}× median)`);
    return {
      value: clamp(bid.contribution + ask.contribution, -1, 1),
      ok: true,
      text: parts.join(' · ') || 'no significant walls',
      bidWallBps: bid.bps,
      askWallBps: ask.bps,
      bidWallX: bid.x,
      askWallX: ask.x,
      bidWallActive: bid.contribution > 0,
      askWallActive: ask.contribution < 0,
    };
  }

  cvdSlope(horizon) {
    const window = this.feed?.cvdWindow(horizon) ?? { delta: 0, volume: 0 };
    if (!(window.volume > 0)) return { value: 0, ok: false };
    const normalized = window.delta / window.volume;
    const value = clamp(normalized / 0.25, -1, 1); // 25% net CVD skew = full conviction
    const text = `CVD ${normalized >= 0 ? '+' : '−'}${(Math.abs(normalized) * 100).toFixed(1)}% of ${horizon}m volume`;
    return { value, ok: true, text, delta: window.delta };
  }

  // Conviction amplifier: only counts when the latest 1m quote volume is
  // elevated versus the rolling 60×1m mean AND the move direction over the
  // horizon agrees; otherwise 0.
  volVelocity(closes, price, horizon) {
    if (closes.length < 61) return { value: 0, ok: false };
    const last = closes.at(-1);
    const baseline = mean(closes.slice(-61, -1).map(c => c.qv).filter(v => v > 0));
    if (!(baseline > 0) || !(last.qv > 0)) return { value: 0, ok: false };
    const ratio = last.qv / baseline;
    if (ratio <= 1.5) return { value: 0, ok: true, text: 'volume not elevated', ratio };
    const reference = closes.length > horizon ? closes.at(-1 - horizon) : closes[0];
    const direction = Math.sign(price - reference.close);
    if (direction === 0) return { value: 0, ok: true, text: 'flat price window', ratio };
    const value = clamp((ratio - 1.5) / 1.5, 0, 1) * direction;
    const text = `volume ${ratio.toFixed(1)}× mean ${direction > 0 ? 'with the up move' : 'with the down move'}`;
    return { value, ok: true, text, ratio };
  }

  oiContext(closes, price, horizon) {
    const { changePct, at } = this.oiCache;
    if (!Number.isFinite(changePct) || !at || this.now() - at > OI_CACHE_MS) return { value: 0, ok: false };
    if (!(changePct > 0)) return { value: 0, ok: true, text: 'OI falling (deleveraging, no edge)', changePct };
    const reference = closes.length > horizon ? closes.at(-1 - horizon) : closes[0];
    if (!reference) return { value: 0, ok: false };
    const priceDir = Math.sign(price - reference.close);
    if (priceDir === 0) return { value: 0, ok: true, text: 'OI up, price flat', changePct };
    const value = clamp(changePct / 0.2, 0, 1) * priceDir;
    const text = `OI ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% with price ${priceDir > 0 ? 'up' : 'down'}`;
    return { value, ok: true, text, changePct };
  }

  funding() {
    const { ratePct, at } = this.fundingCache;
    if (!Number.isFinite(ratePct) || !at || this.now() - at > FUNDING_CACHE_MS) return { value: 0, ok: false };
    let value = 0;
    if (ratePct > FUNDING_EXTREME_PCT) value = -clamp(ratePct / 0.1, 0, 1); // crowded longs ⇒ contrarian bearish
    else if (ratePct < -FUNDING_EXTREME_PCT) value = clamp(-ratePct / 0.1, 0, 1); // crowded shorts ⇒ contrarian bullish
    const text = value === 0
      ? `funding neutral (${ratePct.toFixed(3)}%)`
      : `funding ${ratePct >= 0 ? '+' : ''}${ratePct.toFixed(3)}% (contrarian ${value < 0 ? 'bearish' : 'bullish'})`;
    return { value, ok: true, text, ratePct };
  }

  // ── Low-rate REST context (ban-safe: ≤1 poll/5min OI, ≤1/min funding). ────
  // Fire-and-forget from evaluate(); failures degrade the component to 0 and
  // warn only once per source.
  refreshContext() {
    if (!this.binance || this.contextInflight) return;
    const nowMs = this.now();
    const needOi = nowMs - this.oiCache.polledAt >= OI_POLL_MS;
    const needFunding = nowMs - this.fundingCache.polledAt >= FUNDING_POLL_MS;
    if (!needOi && !needFunding) return;
    if (needOi) this.oiCache.polledAt = nowMs;
    if (needFunding) this.fundingCache.polledAt = nowMs;
    this.contextInflight = true;
    void (async () => {
      try {
        if (needOi) {
          try {
            const rows = await this.binance.openInterestHistory('BTCUSDT', '5m', 3);
            if (Array.isArray(rows) && rows.length >= 2) {
              const previous = Number(rows.at(-2).sumOpenInterest);
              const current = Number(rows.at(-1).sumOpenInterest);
              if (previous > 0 && current > 0) {
                this.oiCache.changePct = pctChange(previous, current);
                this.oiCache.at = this.now();
              }
            }
          } catch (error) {
            if (!this.oiCache.warnCount++) log(`BTC bias OI poll failed (component scores 0): ${error.message}`);
          }
        }
        if (needFunding) {
          try {
            const premium = await this.binance.premiumIndex('BTCUSDT');
            const ratePct = Number(premium?.lastFundingRate) * 100;
            if (Number.isFinite(ratePct)) {
              this.fundingCache.ratePct = ratePct;
              this.fundingCache.at = this.now();
            }
          } catch (error) {
            if (!this.fundingCache.warnCount++) log(`BTC bias funding poll failed (component scores 0): ${error.message}`);
          }
        }
      } finally {
        this.contextInflight = false;
      }
    })();
  }

  // ── Main evaluation. Pure over feed state + context caches; never throws. ──
  evaluate() {
    const nowMs = this.now();
    const closes = this.feed?.closes ?? [];
    const price = this.feed?.lastPrice > 0 ? this.feed.lastPrice : closes.at(-1)?.close ?? 0;
    const book = this.feed?.book ?? null;
    const bookAge = this.feed?.lastBookAt ? nowMs - this.feed.lastBookAt : Infinity;
    const klineAge = this.feed?.lastKlineAt ? nowMs - this.feed.lastKlineAt : Infinity;
    const stale = !(bookAge <= BOOK_STALE_MS) || !(klineAge <= KLINE_STALE_MS);
    this.refreshContext();

    const byHorizon = {};
    for (const horizon of HORIZONS) {
      const components = {
        emaTrend: this.emaTrend(closes, price, horizon),
        takerFlow: this.takerFlow(horizon),
        bookImbalance: this.bookImbalance(book),
        walls: this.walls(book),
        cvdSlope: this.cvdSlope(horizon),
        volVelocity: this.volVelocity(closes, price, horizon),
        oiContext: this.oiContext(closes, price, horizon),
        funding: this.funding(),
      };
      let weighted = 0;
      let completeness = 0;
      const contributions = [];
      for (const [name, weight] of Object.entries(BIAS_WEIGHTS)) {
        const component = components[name];
        const contribution = weight * component.value;
        weighted += contribution;
        if (component.ok) completeness += weight;
        if (component.value !== 0) contributions.push({ name, abs: Math.abs(contribution), text: component.text });
      }
      const score = clamp(Math.round(100 * weighted), -100, 100);
      let confidence = Math.round(Math.abs(score) * (0.5 + 0.5 * completeness));
      if (stale) confidence = Math.min(confidence, 40); // say so: stale feed caps trust
      const drivers = contributions.sort((a, b) => b.abs - a.abs).slice(0, 3).map(c => c.text);
      byHorizon[horizon] = { score, label: biasLabel(score), confidence, drivers, components };
    }

    const h15 = byHorizon[15];
    const h30 = byHorizon[30];
    const snapshot = {
      at: nowMs,
      price,
      h15: { score: h15.score, label: h15.label, confidence: h15.confidence, drivers: h15.drivers },
      h30: { score: h30.score, label: h30.label, confidence: h30.confidence, drivers: h30.drivers },
      components: Object.fromEntries(Object.entries(h15.components).map(([name, c]) => [name, c.value])),
      book: {
        imbalanceTop10: h15.components.bookImbalance.imbalance ?? null,
        bidWallBps: h15.components.walls.bidWallBps ?? null,
        askWallBps: h15.components.walls.askWallBps ?? null,
        bidWallX: h15.components.walls.bidWallX ?? null,
        askWallX: h15.components.walls.askWallX ?? null,
      },
      indicators: {
        ema9: h15.components.emaTrend.ema9 ?? null,
        ema21: h15.components.emaTrend.ema21 ?? null,
        ema50: h15.components.emaTrend.ema50 ?? null,
        buyRatio1m: this.feed?.takerWindow(1).buyRatio ?? null,
        buyRatio5m: this.feed?.takerWindow(5).buyRatio ?? null,
        buyRatio15m: h15.components.takerFlow.buyRatio ?? null,
        cvd15m: h15.components.cvdSlope.delta ?? null,
        volVelocity: h15.components.volVelocity.ratio ?? null,
        oiChgPct: h15.components.oiContext.changePct ?? null,
        fundingPct: h15.components.funding.ratePct ?? null,
      },
      stale,
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  // A snapshot is stale when evaluate() flagged it OR it has simply aged out
  // (feed died after the last evaluation) — never trust data older than 3min.
  snapshotStale(snapshot) {
    if (!snapshot) return true;
    return Boolean(snapshot.stale) || this.now() - snapshot.at > SNAPSHOT_STALE_MS;
  }

  // Compact one-line HTML tag bundled into every outbound alert.
  btcTag({ long = true } = {}) {
    const snapshot = this.lastSnapshot ?? this.evaluate();
    if (!snapshot || this.snapshotStale(snapshot)) return '₿ BTC bias: data stale — treat with caution';
    const down = labelDirection(snapshot.h15.label) === -1;
    const warning = long && down ? ' · ⚠️ against this long' : '';
    return `₿ BTC 15m: <b>${escapeHtml(snapshot.h15.label)}</b> (${snapshot.h15.confidence}%)` +
      ` · 30m: ${escapeHtml(snapshot.h30.label)}${warning}`;
  }

  // Opt-in hard gate (BTC_BIAS_BLOCK_LONGS): NEW exposure only — open trades
  // and in-flight candidates are never touched by this.
  blocksLongs() {
    if (this.cfg.btcBiasBlockLongs !== true) return false;
    const snapshot = this.lastSnapshot;
    // Fail open on stale data: a dead feed must never block longs.
    return Boolean(snapshot) && !this.snapshotStale(snapshot) && snapshot.h15.label === 'STRONG_DOWN';
  }

  // Called on every closed 1m candle (wired in index.js): evaluate, score past
  // predictions against this close, and detect directional flips. Never throws
  // into the feed's WebSocket handler.
  async handleCandle(candle) {
    try {
      const snapshot = this.evaluate();
      this.trackOutcome(candle, snapshot);
      await this.maybeFlip(snapshot);
    } catch (error) {
      this.lastError = `handleCandle: ${error.message}`;
      log(`BTC bias candle handling failed: ${error.message}`);
    }
  }

  trackOutcome(candle, snapshot) {
    this.candleCount++;
    const idx = this.candleCount;
    this.predictions.push({ idx, close: candle.close, label15: snapshot.h15.label, label30: snapshot.h30.label });
    const scorePrediction = (horizon, labelKey, bucket) => {
      const prediction = this.predictions.find(p => p.idx === idx - horizon);
      if (!prediction) return;
      const direction = labelDirection(prediction[labelKey]);
      if (direction === 0) return; // NEUTRAL predictions are not scored
      bucket.total++;
      if (Math.sign(candle.close - prediction.close) === direction) bucket.hits++;
    };
    scorePrediction(15, 'label15', this.outcomes.h15);
    scorePrediction(30, 'label30', this.outcomes.h30);
    while (this.predictions.length > 40) this.predictions.shift();
  }

  async maybeFlip(snapshot) {
    const direction = labelDirection(snapshot.h15.label);
    if (direction === 0) return; // NEUTRAL transitions never alert
    const previous = this.lastDirection;
    this.lastDirection = direction;
    if (previous === 0 || previous === direction) return;
    const nowMs = this.now();
    const cooldownMs = (this.cfg.btcBiasFlipCooldownMin ?? 10) * 60_000;
    if (nowMs - this.lastFlipAlertAt < cooldownMs) return;
    this.lastFlipAlertAt = nowMs;
    this.flipCount++;
    if (!this.cfg.enableBtcBiasAlerts || !this.telegram) return;
    const text = `₿ <b>BTC BIAS FLIP: ${previous > 0 ? 'UP' : 'DOWN'} → ${direction > 0 ? 'UP' : 'DOWN'}</b>\n` +
      `15m: ${escapeHtml(snapshot.h15.label)} (score ${signedScore(snapshot.h15.score)}, conf ${snapshot.h15.confidence}%)` +
      ` · 30m: ${escapeHtml(snapshot.h30.label)} (${signedScore(snapshot.h30.score)})\n` +
      `Drivers: ${snapshot.h15.drivers.map(escapeHtml).join(' · ') || 'n/a'}\n` +
      `<i>Bias gauge for context — not a standalone trade signal</i>`;
    try {
      await this.telegram.send(text);
      log(`BTC BIAS FLIP: ${previous > 0 ? 'UP' : 'DOWN'} → ${direction > 0 ? 'UP' : 'DOWN'} (15m score ${snapshot.h15.score})`);
    } catch (error) {
      this.lastError = `flip alert: ${error.message}`;
      log(`BTC bias flip alert failed: ${error.message}`);
    }
  }

  health() {
    const snapshot = this.lastSnapshot;
    return {
      enabled: Boolean(this.cfg.enableBtcFeed),
      snapshot: snapshot ? {
        at: new Date(snapshot.at).toISOString(),
        price: snapshot.price,
        h15: { score: snapshot.h15.score, label: snapshot.h15.label, confidence: snapshot.h15.confidence },
        h30: { score: snapshot.h30.score, label: snapshot.h30.label, confidence: snapshot.h30.confidence },
        stale: snapshot.stale,
      } : null,
      outcomes: this.outcomes,
      flips: this.flipCount,
      lastFlipAlertAt: this.lastFlipAlertAt ? new Date(this.lastFlipAlertAt).toISOString() : null,
      blockLongs: this.blocksLongs(),
      oiPolledAt: this.oiCache.polledAt ? new Date(this.oiCache.polledAt).toISOString() : null,
      fundingPolledAt: this.fundingCache.polledAt ? new Date(this.fundingCache.polledAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}
