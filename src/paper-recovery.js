import { closedCandles, parseKlines, median } from './indicators.js';
import { mapLimit } from './util.js';

export const RECOVERY_MODEL = 'paper-breadth-recovery-v1';
export const BREADTH_RULES = Object.freeze({ sampleSize: 30, minValid: 20,
  minCoverage: 0.8, minUpFraction: 0.6, minMedianPct: 0.1,
  refreshMs: 60_000, maxAgeMs: 90_000, maxBarAgeMs: 330_000, maxUniverseAgeMs: 600_000 });
export const paperRecoveryEnabled = cfg => cfg.paperMode === true && cfg.paper100Test === true
  && cfg.enablePaperBtcRecovery === true;

export function selectBreadthSymbols(info, tickers, minVolume, excluded = new Set()) {
  const volume = new Map((tickers ?? []).map(t => [t.symbol, Number(t.quoteVolume)]));
  return [...new Set((info?.symbols ?? []).filter(s => s.status === 'TRADING'
    && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT'
    && (!s.underlyingType || s.underlyingType === 'COIN')
    && !(s.underlyingSubType ?? []).some(t => String(t).toLowerCase() === 'meme')
    && s.symbol !== 'BTCUSDT' && !excluded.has(s.symbol)
    && Number.isFinite(volume.get(s.symbol)) && volume.get(s.symbol) >= Math.max(15_000_000, minVolume ?? 15_000_000))
    .map(s => s.symbol))]
    // Select by liquidity, never by winners or membership in the trade universe.
    .sort((a, b) => volume.get(b) - volume.get(a) || a.localeCompare(b))
    .slice(0, BREADTH_RULES.sampleSize);
}

export function fifteenMinuteReturn(rows, now) {
  const candles = closedCandles(parseKlines(rows), now).sort((a, b) => a.closeTime - b.closeTime).slice(-4);
  const expectedClose = Math.floor(now / 300_000) * 300_000 - 1;
  if (candles.length !== 4 || candles.at(-1).closeTime !== expectedClose
    || candles.some((c, i) => !(c.close > 0) || c.closeTime - c.openTime !== 299_999
      || (i > 0 && c.closeTime - candles[i - 1].closeTime !== 300_000))) return null;
  return (candles[3].close / candles[0].close - 1) * 100;
}

export function summarizeBreadth(symbols, results, now, selectedAt) {
  const valid = results.filter(r => Number.isFinite(r));
  const up = valid.filter(r => r > 0).length;
  const reasons = [];
  if (!Number.isFinite(selectedAt) || now - selectedAt > BREADTH_RULES.maxUniverseAgeMs || selectedAt > now) reasons.push('breadth universe missing/stale');
  if (valid.length < BREADTH_RULES.minValid) reasons.push('breadth needs at least 20 valid liquid altcoins');
  if (!symbols.length || valid.length / symbols.length < BREADTH_RULES.minCoverage) reasons.push('breadth coverage below 80%');
  if (!valid.length || up / valid.length < BREADTH_RULES.minUpFraction) reasons.push('fewer than 60% of sampled altcoins rising over 15m');
  const medianPct = valid.length ? median(valid) : null;
  if (medianPct === null || medianPct < BREADTH_RULES.minMedianPct) reasons.push('median altcoin 15m return below +0.10%');
  return { model: RECOVERY_MODEL, allowed: reasons.length === 0, reasons, observedAt: now,
    barCloseTime: Math.floor(now / 300_000) * 300_000 - 1, selectedAt,
    requested: symbols.length, valid: valid.length, up,
    upPct: valid.length ? up / valid.length * 100 : null, medianPct,
    symbols: [...symbols] };
}

export function breadthReasons(snapshot, now = Date.now()) {
  if (!snapshot) return ['breadth not sampled yet'];
  const reasons = [...snapshot.reasons];
  if (!(now >= snapshot.observedAt && now - snapshot.observedAt <= BREADTH_RULES.maxAgeMs)) reasons.push('breadth sample stale');
  if (!(now > snapshot.barCloseTime && now - snapshot.barCloseTime <= BREADTH_RULES.maxBarAgeMs)) reasons.push('breadth candles stale');
  if (!(now >= snapshot.selectedAt && now - snapshot.selectedAt <= BREADTH_RULES.maxUniverseAgeMs)) reasons.push('breadth universe stale');
  return [...new Set(reasons)];
}

export class AltcoinBreadth {
  constructor(binance) { this.binance = binance; this.symbols = []; this.selectedAt = null; this.snapshot = null; this.lastAttempt = null; }
  setUniverse(info, tickers, minVolume, excluded, now = Date.now()) {
    const symbols = selectBreadthSymbols(info, tickers, minVolume, excluded);
    if (symbols.join(',') !== this.symbols.join(',')) { this.snapshot = null; this.lastAttempt = null; }
    this.symbols = symbols;
    this.selectedAt = now;
  }
  async refresh(now = Date.now()) {
    if (this.lastAttempt !== null && now - this.lastAttempt < BREADTH_RULES.refreshMs) return this.snapshot;
    this.lastAttempt = now;
    const symbols = [...this.symbols], selectedAt = this.selectedAt;
    if (!Number.isFinite(selectedAt) || now - selectedAt > BREADTH_RULES.maxUniverseAgeMs || symbols.length < BREADTH_RULES.minValid) {
      this.snapshot = summarizeBreadth(symbols, [], now, selectedAt);
      return this.snapshot;
    }
    // Use one common cutoff, so a request crossing a candle boundary cannot
    // combine different 15-minute periods into apparent market strength.
    const results = await mapLimit(symbols, 5, async symbol => {
      const rows = await this.binance.klines(symbol, '5m', 5);
      return fifteenMinuteReturn(rows, now);
    });
    this.snapshot = summarizeBreadth(symbols, results, now, selectedAt);
    return this.snapshot;
  }
}

export function applyPaperRecovery(btc, snapshot, cfg, shock, now = Date.now()) {
  const baseAllowed = btc.baseAllowed ?? btc.allowed;
  const baseRegime = btc.baseRegime ?? btc.regime;
  if (baseAllowed) return { ...btc, allowed: true, regime: baseRegime, recoveryActive: false };
  const reasons = [...(btc.recoveryBlockReasons ?? ['BTC recovery inputs unavailable'])];
  if (!paperRecoveryEnabled(cfg)) reasons.push('recovery requires enabled virtual-$100 paper mode');
  if (btc.shock || baseRegime === 'SHOCK_BLOCK' || baseRegime === 'DATA_BLOCK') reasons.push('BTC shock/data block');
  if (btc.recoveryCandidate !== true) reasons.push('BTC recovery conditions not met');
  if (!(Number.isFinite(btc.barCloseTime) && now > btc.barCloseTime && now - btc.barCloseTime <= 330_000)
    || !(Number.isFinite(btc.hourBarCloseTime) && now > btc.hourBarCloseTime && now - btc.hourBarCloseTime <= 3_630_000)) reasons.push('BTC candles missing/stale');
  const lastMessage = Date.parse(shock?.lastMessageAt);
  if (!(shock?.enabled === true && shock.connected === true && shock.stale === false
    && Number.isFinite(lastMessage) && now >= lastMessage && now - lastMessage <= 30_000)) reasons.push('live BTC shock feed unavailable/stale');
  if (shock?.blocked) reasons.push('BTC realtime shock cooldown active');
  reasons.push(...breadthReasons(snapshot, now));
  const active = reasons.length === 0;
  return { ...btc, baseAllowed, baseRegime, allowed: active, regime: active ? 'BULLISH_RECOVERY' : baseRegime,
    recoveryActive: active, recoveryReasons: [...new Set(reasons)], recoveryModel: RECOVERY_MODEL,
    breadth: snapshot };
}
