import { requestJson } from './http.js';
import { fetchAndAssessOnchain } from './onchain-risk.js';
import { clamp, log, pctChange } from './util.js';

// Exported so the v6.9.3 AlphaFastMover radar (src/alpha-mover.js) polls the
// exact same endpoint and parses tokens identically.
export const ALPHA_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const MAX_HISTORY = 16;

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const keyOf = token => `${token.chainId}:${String(token.contractAddress).toLowerCase()}`;

export const parseToken = raw => {
  const token = {
    chainId: String(raw?.chainId ?? ''),
    chainName: String(raw?.chainName ?? ''),
    contractAddress: String(raw?.contractAddress ?? ''),
    alphaId: String(raw?.alphaId ?? ''),
    symbol: String(raw?.symbol ?? '').toUpperCase(),
    name: String(raw?.name ?? ''),
    price: number(raw?.price),
    change24h: number(raw?.percentChange24h),
    volume24h: number(raw?.volume24h),
    liquidity: number(raw?.liquidity),
    marketCap: number(raw?.marketCap),
    holders: number(raw?.holders),
    hotTag: Boolean(raw?.hotTag),
    listingTime: number(raw?.listingTime),
  };
  if (!token.chainId || !token.chainName || !token.contractAddress || !token.symbol) return null;
  if (![token.price, token.change24h, token.volume24h, token.liquidity].every(Number.isFinite)) return null;
  return token;
};

const snapshot = (token, now) => ({
  ts: now,
  price: token.price,
  liquidity: token.liquidity,
  volume24h: token.volume24h,
  holders: token.holders,
  change24h: token.change24h,
});

const firstAtOrBefore = (history, target) => {
  const eligible = history.filter(item => Number(item.ts) <= target);
  return eligible.at(-1) ?? history[0] ?? null;
};

const changesFrom = (from, current) => ({
  pricePct: from?.price > 0 ? pctChange(from.price, current.price) : 0,
  liquidityPct: from?.liquidity > 0 ? pctChange(from.liquidity, current.liquidity) : 0,
  holderDelta: Number.isFinite(from?.holders) && Number.isFinite(current.holders) ? current.holders - from.holders : 0,
});

const rowToState = row => ({
  chainId: row.chain_id,
  chainName: row.chain_name,
  contractAddress: row.contract_address,
  alphaId: row.alpha_id,
  symbol: row.symbol,
  name: row.name,
  state: row.state,
  qualifiedAt: row.qualified_at ? new Date(row.qualified_at).getTime() : null,
  qualificationPrice: number(row.qualification_price),
  ignitedAt: row.ignited_at ? new Date(row.ignited_at).getTime() : null,
  history: Array.isArray(row.history) ? row.history : [],
  security: row.security && typeof row.security === 'object' ? row.security : null,
  lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0,
});

const stateToRow = state => ({
  chain_id: state.chainId,
  chain_name: state.chainName,
  contract_address: state.contractAddress,
  alpha_id: state.alphaId,
  symbol: state.symbol,
  name: state.name,
  state: state.state,
  qualified_at: state.qualifiedAt ? new Date(state.qualifiedAt).toISOString() : null,
  qualification_price: state.qualificationPrice,
  ignited_at: state.ignitedAt ? new Date(state.ignitedAt).toISOString() : null,
  history: state.history,
  security: securitySummary(state.security),
  last_seen_at: new Date(state.lastSeenAt).toISOString(),
  updated_at: new Date().toISOString(),
});

const securitySummary = security => security ? ({
  rating: security.rating,
  riskScore: security.riskScore,
  hardBlock: security.hardBlock,
  coverage: security.coverage,
  critical: security.critical ?? [],
  warnings: security.warnings ?? [],
  metrics: security.metrics ?? {},
  checkedAt: security.checkedAt,
}) : null;

const alphaOutcome = pnlPct => pnlPct > 0.25 ? 'WIN' : pnlPct < -0.50 ? 'LOSS' : 'SCRATCH';

export class AlphaRadar {
  constructor({ cfg, store, telegram, btcBias = null }) {
    this.cfg = cfg;
    this.store = store;
    this.telegram = telegram;
    this.btcBias = btcBias;
    this.states = new Map();
    this.securityCache = new Map();
    this.lastScanAt = 0;
    this.lastScanDurationMs = 0;
    this.running = false;
    this.seeded = false;
    this.top = [];
    this.onchainChecksThisScan = 0;
    this.metrics = { scans: 0, qualified: 0, ignited: 0, closed: 0, blocked: 0, warnings: 0, errors: 0 };
    // v6.9.6 observability for the BTC_BIAS_BLOCK alpha-side gate.
    this.btcBiasBlockCount = 0;
    this.lastBtcBiasBlockLogAt = 0;
  }

  async initialize() {
    if (!this.cfg.enableAlphaSignals) return;
    const rows = await this.store.loadAlphaStates();
    for (const row of rows) {
      const state = rowToState(row);
      this.states.set(`${state.chainId}:${String(state.contractAddress).toLowerCase()}`, state);
    }
    this.seeded = this.states.size > 0;
    await this.scan({ force: true, seedOnly: !this.seeded });
    this.seeded = true;
  }

  // v6.9.3: hard floors only (no heat cap). Failing any of these means the
  // token is too weak to track safely and demotes even a QUALIFIED runner.
  hardFloorsPass(token) {
    return token.price > 0
      && token.volume24h >= this.cfg.alphaMinVolumeUsd
      && token.liquidity >= this.cfg.alphaMinLiquidityUsd
      && Number.isFinite(token.holders)
      && token.holders >= this.cfg.alphaMinHolders
      && token.change24h > -20;
  }

  // Full entry universe = hard floors + the +40% heat cap. The heat cap is a
  // NEW-entry gate only; it must not demote an already QUALIFIED runner.
  eligible(token) {
    return this.hardFloorsPass(token) && token.change24h < 40;
  }

  async security(token, { force = false, urgent = false } = {}) {
    const key = keyOf(token);
    const cached = this.securityCache.get(key);
    if (!force && cached && Date.now() - cached.ts < 30 * 60_000) return cached.value;
    if (!urgent && this.onchainChecksThisScan >= this.cfg.alphaMaxOnchainChecksPerScan) return null;
    this.onchainChecksThisScan++;
    const value = await fetchAndAssessOnchain(token, this.cfg);
    this.securityCache.set(key, { ts: Date.now(), value });
    return value;
  }

  qualificationScore(token, history, current) {
    const from = firstAtOrBefore(history, current.ts - 8 * 60_000);
    const move = changesFrom(from, current);
    const volLiq = token.liquidity > 0 ? token.volume24h / token.liquidity : Infinity;
    let score = 0;
    if (token.liquidity >= this.cfg.alphaMinLiquidityUsd * 2) score += 1;
    if (token.volume24h >= this.cfg.alphaMinVolumeUsd * 2) score += 1;
    if (token.holders >= this.cfg.alphaMinHolders * 2) score += 1;
    if (volLiq >= 0.5 && volLiq <= 4.5) score += 1;
    if (token.change24h >= -3 && token.change24h <= 10) score += 1;
    if (move.liquidityPct >= -1.5) score += 1;
    if (move.holderDelta >= 0) score += 1;
    if (move.pricePct >= 0.20 && move.pricePct <= 3.5) score += 2;
    return { score: clamp(score, 0, 10), move, volLiq };
  }

  // v6.9.6: compact BTC bias tag bundled into the IGNITION alert. Default-on;
  // a null bias engine leaves the message byte-identical to previous versions.
  btcBiasTagSuffix() {
    if (this.cfg.enableBtcBiasTag === false || !this.btcBias) return '';
    try {
      const tag = this.btcBias.btcTag({ long: true });
      return tag ? `\n${tag}` : '';
    } catch (error) {
      log(`BTC bias tag failed: ${error.message}`);
      return '';
    }
  }

  async emitIgnition(eventKey, token, qualification, move, security) {
    const entry = token.price;
    const levels = { sl: entry * 0.97, tp1: entry * 1.05, tp2: entry * 1.08, tp3: entry * 1.12 };
    const inserted = await this.store.createAlphaTrade({
      event_key: eventKey,
      chain_id: token.chainId,
      chain_name: token.chainName,
      contract_address: token.contractAddress,
      symbol: token.symbol,
      entry,
      initial_sl: levels.sl,
      active_sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      entry_liquidity: token.liquidity,
      current_liquidity: token.liquidity,
      peak_price: entry,
      lowest_price: entry,
      current_price: entry,
      setup_score: qualification.score,
      security_rating: security.rating,
      risk_score: security.riskScore,
      setup: { qualification, move, security: securitySummary(security) },
    });
    if (!inserted.created) return false;

    const created = await this.store.insertEvent({
      event_key: eventKey,
      event_type: 'ALPHA_IGNITION',
      symbol: `[ALPHA] ${token.symbol}`,
      payload: {
        token: {
          chainId: token.chainId, chainName: token.chainName, contractAddress: token.contractAddress,
          symbol: token.symbol, entry, liquidity: token.liquidity, volume24h: token.volume24h, holders: token.holders,
        },
        levels,
        qualification,
        sinceQualified: move,
        security: securitySummary(security),
      },
    });
    if (!created) {
      await this.store.updateAlphaTrade(inserted.trade.id, {
        status: 'CANCELLED', exit_reason: 'DUPLICATE_EVENT', closed_at: new Date().toISOString(),
      });
      return false;
    }
    try {
      await this.telegram.send(this.telegram.alphaIgnitionMessage(token, qualification, move, security) + this.btcBiasTagSuffix());
      await this.store.updateAlphaTrade(inserted.trade.id, { alert_sent: true });
      return true;
    } catch (error) {
      await this.store.updateAlphaTrade(inserted.trade.id, {
        status: 'CANCELLED', exit_reason: `ALERT_FAILED: ${error.message}`.slice(0, 300), closed_at: new Date().toISOString(),
      });
      throw error;
    }
  }

  async riskWarning(token, state, security, reasons, kind = 'ONCHAIN_RISK') {
    const bucket = Math.floor(Date.now() / (30 * 60_000));
    const eventKey = `alpha:risk:${kind}:${keyOf(token)}:${bucket}`;
    const created = await this.store.insertEvent({
      event_key: eventKey,
      event_type: 'ALPHA_RISK_FILTERED',
      symbol: `[ALPHA] ${token.symbol}`,
      payload: { kind, reasons, security: securitySummary(security), last: state.history.at(-1) },
    });
    if (created) {
      this.metrics.warnings++;
      log(`SILENT ALPHA FILTER ${token.symbol}: ${reasons.join('; ')}`);
    }
  }

  async manageOpenTrades(tokens, now = Date.now()) {
    const pending = await this.store.pendingAlphaOutcomeAlerts();
    for (const trade of pending) {
      try {
        const liquidityPct = Number(trade.entry_liquidity) > 0
          ? pctChange(Number(trade.entry_liquidity), Number(trade.current_liquidity)) : 0;
        await this.telegram.send(this.telegram.alphaOutcomeMessage(trade, liquidityPct));
        await this.store.updateAlphaTrade(trade.id, { exit_alert_sent: true });
      } catch (error) {
        this.metrics.errors++;
        log(`Alpha outcome alert retry failed for ${trade.symbol}: ${error.message}`);
      }
    }
    const open = await this.store.listOpenAlphaTrades();
    if (!open.length) return;
    const tokenMap = new Map(tokens.map(token => [keyOf(token), token]));
    for (const trade of open) {
      const key = `${trade.chain_id}:${String(trade.contract_address).toLowerCase()}`;
      const token = tokenMap.get(key);
      if (!token) {
        log(`Alpha monitor: ${trade.symbol} missing from current feed; leaving trade open`);
        continue;
      }
      try {
        const entry = Number(trade.entry);
        const price = token.price;
        const peak = Math.max(Number(trade.peak_price ?? entry), price);
        const low = Math.min(Number(trade.lowest_price ?? entry), price);
        const gainPct = pctChange(entry, price);
        const maxGainPct = Math.max(Number(trade.max_gain_pct ?? 0), pctChange(entry, peak));
        const maxDrawdownPct = Math.min(Number(trade.max_drawdown_pct ?? 0), pctChange(entry, low));
        const liquidityPct = pctChange(Number(trade.entry_liquidity), token.liquidity);
        const ageMs = now - new Date(trade.created_at).getTime();

        let exitReason = null;
        let outcome = null;
        if (price <= Number(trade.active_sl)) {
          exitReason = 'STOP'; outcome = 'LOSS';
        } else if (price >= Number(trade.tp1)) {
          exitReason = 'TP1'; outcome = 'WIN';
        } else if (liquidityPct <= -8) {
          exitReason = 'LIQUIDITY_EXIT'; outcome = alphaOutcome(gainPct);
        } else if (maxGainPct >= 2 && maxGainPct - gainPct >= 1.5 && gainPct > 0.25) {
          exitReason = 'MOMENTUM_FADE'; outcome = 'WIN';
        } else if (ageMs >= 6 * 60 * 60_000) {
          exitReason = 'TIMEOUT'; outcome = gainPct > 0.25 ? 'WIN' : gainPct < -0.50 ? 'LOSS' : 'TIMEOUT';
        }

        const patch = {
          current_price: price,
          current_liquidity: token.liquidity,
          peak_price: peak,
          lowest_price: low,
          max_gain_pct: maxGainPct,
          max_drawdown_pct: maxDrawdownPct,
          last_checked_at: new Date(now).toISOString(),
        };
        if (exitReason) Object.assign(patch, {
          status: 'CLOSED', outcome, exit_price: price, exit_reason: exitReason,
          pnl_pct: gainPct, exit_alert_sent: false, closed_at: new Date(now).toISOString(),
        });
        const updated = await this.store.updateAlphaTrade(trade.id, patch);
        if (exitReason && updated) {
          await this.telegram.send(this.telegram.alphaOutcomeMessage(updated, liquidityPct));
          await this.store.updateAlphaTrade(trade.id, { exit_alert_sent: true });
          this.metrics.closed++;
          log(`ALPHA CLOSED ${trade.symbol}: ${exitReason} ${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%`);
        }
      } catch (error) {
        this.metrics.errors++;
        log(`Alpha trade monitor failed for ${trade.symbol}: ${error.message}`);
      }
    }
  }

  async processToken(token, now, { seedOnly = false, entryEligible = true } = {}) {
    const key = keyOf(token);
    const current = snapshot(token, now);
    let state = this.states.get(key);
    if (!state) {
      state = {
        ...token,
        state: 'SEEDED',
        qualifiedAt: null,
        qualificationPrice: null,
        ignitedAt: null,
        history: [current],
        security: null,
        lastSeenAt: now,
      };
      this.states.set(key, state);
      return;
    }

    const previous = state.history.at(-1);
    const short = changesFrom(previous, current);
    state = {
      ...state,
      ...token,
      history: [...state.history, current].filter(item => now - Number(item.ts) <= 2 * 60 * 60_000).slice(-MAX_HISTORY),
      lastSeenAt: now,
    };
    this.states.set(key, state);
    if (seedOnly || !previous) return;

    if (short.liquidityPct <= -12 || short.pricePct <= -8) {
      const reasons = [];
      if (short.liquidityPct <= -12) reasons.push(`liquidity drained ${short.liquidityPct.toFixed(1)}% since previous scan`);
      if (short.pricePct <= -8) reasons.push(`price crashed ${short.pricePct.toFixed(1)}% since previous scan`);
      let security = state.security;
      try { security = await this.security(token, { force: true, urgent: true }); } catch (error) { reasons.push(`on-chain recheck failed: ${error.message}`); }
      state.security = security;
      state.state = 'BLOCKED';
      await this.riskWarning(token, state, security, reasons, 'LIQUIDITY_DRAIN');
      this.metrics.blocked++;
      return;
    }

    // Continue observing every previously tracked token even after it falls
    // below the entry universe. A pending qualification must not remain active
    // merely because liquidity/volume/holders became too weak to scan.
    // IGNITED tokens remain stateful while their separate trade row is managed.
    //
    // v6.9.3 runner fix: the eligibility gate is split into hard floors versus
    // the +40% heat cap. Demotion of a QUALIFIED token happens ONLY when a
    // hard floor fails — a runner riding change24h past +40 keeps its ignition
    // window and can still complete IGNITION (previously it was demoted back
    // to SEEDED, abandoning exactly the strongest movers). The heat cap still
    // blocks NEW SEEDED→QUALIFIED transitions, so conservative entry is kept.
    if (!this.hardFloorsPass(token) && state.state !== 'IGNITED') {
      if (state.state === 'QUALIFIED') {
        state.state = 'SEEDED';
        state.qualifiedAt = null;
        state.qualificationPrice = null;
      }
      return;
    }
    if ((!entryEligible || token.change24h >= 40) && state.state === 'SEEDED') return;

    const qualification = this.qualificationScore(token, state.history, current);
    if (state.state === 'SEEDED' && state.history.length >= 3 && qualification.score >= 7) {
      // v6.9.6 opt-in hard gate (BTC_BIAS_BLOCK_LONGS, default off): no NEW
      // seeds while the 15m BTC bias is STRONG_DOWN. Already QUALIFIED/IGNITED
      // tokens and open alpha trades are never affected. Counted always and
      // logged throttled (≤1/10min) so a silent gate is visible in /health.
      if (this.btcBias?.blocksLongs?.()) {
        this.btcBiasBlockCount++;
        const nowMs = Date.now();
        if (nowMs - this.lastBtcBiasBlockLogAt >= 10 * 60_000) {
          this.lastBtcBiasBlockLogAt = nowMs;
          log(`BTC bias gate ACTIVE: new alpha seed blocked (15m STRONG_DOWN, ${this.btcBiasBlockCount}× BTC_BIAS_BLOCK)`);
        }
        return;
      }
      let security;
      try {
        security = await this.security(token);
      } catch (error) {
        state.security = { rating: 'BLOCKED', hardBlock: true, critical: [`security check unavailable: ${error.message}`], warnings: [], riskScore: 10 };
        await this.riskWarning(token, state, state.security, state.security.critical, 'SECURITY_UNAVAILABLE');
        return;
      }
      if (!security) return; // provider budget reached; defer without a false warning
      state.security = security;
      if (security.hardBlock) {
        state.state = 'BLOCKED';
        this.metrics.blocked++;
        await this.riskWarning(token, state, security, security.critical, 'CRITICAL_ONCHAIN');
        return;
      }
      state.state = 'QUALIFIED';
      state.qualifiedAt = now;
      state.qualificationPrice = token.price;
      const created = await this.store.insertEvent({
        event_key: `alpha:qualified:${key}`,
        event_type: 'ALPHA_QUALIFIED_SILENT',
        symbol: `[ALPHA] ${token.symbol}`,
        payload: { qualification, security: securitySummary(security) },
      });
      if (created) this.metrics.qualified++;
      log(`SILENT ALPHA QUALIFIED ${token.symbol}: setup ${qualification.score}/10, risk ${security.riskScore}/10`);
      return;
    }

    if (state.state === 'QUALIFIED') {
      const ageMs = now - state.qualifiedAt;
      const sinceQualified = changesFrom({
        price: state.qualificationPrice,
        liquidity: firstAtOrBefore(state.history, state.qualifiedAt)?.liquidity,
        holders: firstAtOrBefore(state.history, state.qualifiedAt)?.holders,
      }, current);
      if (ageMs > 2 * 60 * 60_000 || sinceQualified.liquidityPct <= -5 || sinceQualified.pricePct <= -4) {
        state.state = 'SEEDED';
        state.qualifiedAt = null;
        state.qualificationPrice = null;
        return;
      }
      const ignition = ageMs >= this.cfg.alphaScanIntervalMs
        && sinceQualified.pricePct >= 1.2
        && sinceQualified.pricePct <= 5.0
        && short.pricePct >= 0.6
        && short.pricePct <= 3.5
        && sinceQualified.liquidityPct >= -2
        && qualification.volLiq >= 0.7
        && qualification.volLiq <= 5;
      if (!ignition) return;

      let security;
      try {
        security = await this.security(token, { force: true });
      } catch (error) {
        const unavailable = { rating: 'BLOCKED', hardBlock: true, critical: [`security recheck unavailable: ${error.message}`], warnings: [], riskScore: 10 };
        await this.riskWarning(token, state, unavailable, unavailable.critical, 'SECURITY_UNAVAILABLE');
        return;
      }
      if (!security) return; // provider budget reached; retry on the next Alpha cycle
      state.security = security;
      if (security.hardBlock || security.riskScore > this.cfg.alphaMaxPossibleRugScore) {
        state.state = 'BLOCKED';
        this.metrics.blocked++;
        const reasons = security.hardBlock
          ? security.critical
          : [`possible-rug score ${security.riskScore}/10 exceeds permitted ${this.cfg.alphaMaxPossibleRugScore}`, ...security.warnings];
        await this.riskWarning(token, state, security, reasons, 'IGNITION_BLOCKED');
        return;
      }

      state.state = 'IGNITED';
      state.ignitedAt = now;
      const bucket = Math.floor(now / (6 * 60 * 60_000));
      const eventKey = `alpha:ignition:${key}:${bucket}`;
      const sent = await this.emitIgnition(eventKey, token, qualification, sinceQualified, security);
      if (sent) this.metrics.ignited++;
    } else if (state.state === 'IGNITED' && (now - state.ignitedAt > 6 * 60 * 60_000 || token.change24h < 1)) {
      state.state = 'SEEDED';
      state.qualifiedAt = null;
      state.qualificationPrice = null;
      state.ignitedAt = null;
    }
  }

  async scan({ force = false, seedOnly = false, monitorOnly = false } = {}) {
    if (!this.cfg.enableAlphaSignals) return { skipped: 'disabled' };
    if (this.running) return { skipped: 'already running' };
    if (!force && Date.now() - this.lastScanAt < this.cfg.alphaScanIntervalMs) return { skipped: 'interval' };
    this.running = true;
    this.onchainChecksThisScan = 0;
    const started = Date.now();
    try {
      const response = await requestJson(ALPHA_URL, { timeoutMs: 20_000, retries: 1 });
      const parsed = (Array.isArray(response?.data) ? response.data : []).map(parseToken).filter(Boolean);
      await this.manageOpenTrades(parsed, Date.now());
      if (monitorOnly) {
        this.lastScanAt = Date.now();
        this.lastScanDurationMs = Date.now() - started;
        this.metrics.scans++;
        log('Alpha monitor-only scan complete; new entries remain paused');
        return { monitored: true, durationMs: this.lastScanDurationMs };
      }
      const eligible = parsed.filter(token => this.eligible(token));
      const eligibleKeys = new Set(eligible.map(keyOf));
      this.top = [...eligible].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
      const trackedOrEligible = parsed.filter(token => eligibleKeys.has(keyOf(token)) || this.states.has(keyOf(token)));
      for (const token of trackedOrEligible) {
        try { await this.processToken(token, Date.now(), { seedOnly, entryEligible: eligibleKeys.has(keyOf(token)) }); }
        catch (error) { this.metrics.errors++; log(`Alpha ${token.symbol} failed: ${error.message}`); }
      }
      const rows = [...this.states.values()]
        .filter(state => Date.now() - state.lastSeenAt < 7 * 24 * 60 * 60_000)
        .map(stateToRow);
      if (rows.length) await this.store.upsertAlphaStates(rows);
      this.lastScanAt = Date.now();
      this.lastScanDurationMs = Date.now() - started;
      this.metrics.scans++;
      log(`Alpha scan: ${eligible.length} passed liquidity gate, ${this.active().length} active`);
      return { processed: eligible.length, durationMs: this.lastScanDurationMs };
    } finally {
      this.running = false;
    }
  }

  active() {
    const freshnessMs = Math.max(15 * 60_000, this.cfg.alphaScanIntervalMs * 3);
    const cutoff = Date.now() - freshnessMs;
    return [...this.states.values()].filter(state =>
      (state.state === 'QUALIFIED' || state.state === 'IGNITED') && state.lastSeenAt >= cutoff);
  }

  health() {
    return {
      enabled: this.cfg.enableAlphaSignals,
      active: this.active().length,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      lastScanDurationMs: this.lastScanDurationMs,
      metrics: this.metrics,
      btcBiasBlocks: this.btcBiasBlockCount,
    };
  }
}
