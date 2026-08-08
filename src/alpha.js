import { requestJson } from './http.js';
import { fetchAndAssessOnchain } from './onchain-risk.js';
import { clamp, log, pctChange } from './util.js';

const ALPHA_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
const MAX_HISTORY = 16;

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const keyOf = token => `${token.chainId}:${String(token.contractAddress).toLowerCase()}`;

const parseToken = raw => {
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
  security: state.security,
  last_seen_at: new Date(state.lastSeenAt).toISOString(),
  updated_at: new Date().toISOString(),
});

export class AlphaRadar {
  constructor({ cfg, store, telegram }) {
    this.cfg = cfg;
    this.store = store;
    this.telegram = telegram;
    this.states = new Map();
    this.securityCache = new Map();
    this.lastScanAt = 0;
    this.lastScanDurationMs = 0;
    this.running = false;
    this.seeded = false;
    this.top = [];
    this.onchainChecksThisScan = 0;
    this.metrics = { scans: 0, qualified: 0, ignited: 0, blocked: 0, warnings: 0, errors: 0 };
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

  eligible(token) {
    return token.price > 0
      && token.volume24h >= this.cfg.alphaMinVolumeUsd
      && token.liquidity >= this.cfg.alphaMinLiquidityUsd
      && Number.isFinite(token.holders)
      && token.holders >= this.cfg.alphaMinHolders
      && token.change24h > -20
      && token.change24h < 40;
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

  async emit(eventKey, eventType, token, payload, message) {
    const created = await this.store.insertEvent({
      event_key: eventKey,
      event_type: eventType,
      symbol: `[ALPHA] ${token.symbol}`,
      payload,
    });
    if (!created) return false;
    await this.telegram.send(message);
    return true;
  }

  async riskWarning(token, state, security, reasons, kind = 'ONCHAIN_RISK') {
    const bucket = Math.floor(Date.now() / (30 * 60_000));
    const eventKey = `alpha:risk:${kind}:${keyOf(token)}:${bucket}`;
    const created = await this.store.insertEvent({
      event_key: eventKey,
      event_type: 'ALPHA_RISK_FILTERED',
      symbol: `[ALPHA] ${token.symbol}`,
      payload: { kind, reasons, security, last: state.history.at(-1) },
    });
    if (created) {
      this.metrics.warnings++;
      log(`SILENT ALPHA FILTER ${token.symbol}: ${reasons.join('; ')}`);
    }
  }

  async processToken(token, now, { seedOnly = false } = {}) {
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

    const qualification = this.qualificationScore(token, state.history, current);
    if (state.state === 'SEEDED' && state.history.length >= 3 && qualification.score >= 7) {
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
        payload: { qualification, security },
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
      const sent = await this.emit(
        eventKey,
        'ALPHA_IGNITION',
        token,
        { qualification, sinceQualified, security },
        this.telegram.alphaIgnitionMessage(token, qualification, sinceQualified, security),
      );
      if (sent) this.metrics.ignited++;
    } else if (state.state === 'IGNITED' && (now - state.ignitedAt > 6 * 60 * 60_000 || token.change24h < 1)) {
      state.state = 'SEEDED';
      state.qualifiedAt = null;
      state.qualificationPrice = null;
      state.ignitedAt = null;
    }
  }

  async scan({ force = false, seedOnly = false } = {}) {
    if (!this.cfg.enableAlphaSignals) return { skipped: 'disabled' };
    if (this.running) return { skipped: 'already running' };
    if (!force && Date.now() - this.lastScanAt < this.cfg.alphaScanIntervalMs) return { skipped: 'interval' };
    this.running = true;
    this.onchainChecksThisScan = 0;
    const started = Date.now();
    try {
      const response = await requestJson(ALPHA_URL, { timeoutMs: 20_000, retries: 1 });
      const parsed = (Array.isArray(response?.data) ? response.data : []).map(parseToken).filter(Boolean);
      const eligible = parsed.filter(token => this.eligible(token));
      this.top = [...eligible].sort((a, b) => b.change24h - a.change24h).slice(0, 10);
      for (const token of eligible) {
        try { await this.processToken(token, Date.now(), { seedOnly }); }
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
    return [...this.states.values()].filter(state => state.state === 'QUALIFIED' || state.state === 'IGNITED');
  }

  health() {
    return {
      enabled: this.cfg.enableAlphaSignals,
      active: this.active().length,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      lastScanDurationMs: this.lastScanDurationMs,
      metrics: this.metrics,
    };
  }
}
