// Independent virtual accounts for confirmed mover alerts. This module has no
// exchange client and cannot submit orders.
const GST_OFFSET_MS = 4 * 60 * 60_000;
const STRATEGIES = Object.freeze({
  FUTURES_TRENDING_MOVER: { cohort: 'futures-trending-mover-v1', maxHoldMs: 4 * 60 * 60_000, maxNotional: 200, marginMultiple: 2 },
  ALPHA_FAST_MOVER: { cohort: 'alpha-fast-mover-v1', maxHoldMs: 60 * 60_000, maxNotional: 100, marginMultiple: 1 },
});
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
const finite = n => Number.isFinite(Number(n)) && Number(n) > 0;
const gstDay = ms => new Date(ms + GST_OFFSET_MS).toISOString().slice(0, 10);

export class MoverPaperBook {
  constructor({ store, now = () => Date.now(), feeBps = 5, slippageBps = 5, maxRiskUsd = 10, dailyLossUsd = 30 }) {
    this.store = store; this.now = now; this.feeBps = feeBps; this.slippageBps = slippageBps;
    this.maxRiskUsd = maxRiskUsd; this.dailyLossUsd = dailyLossUsd;
    this.ready = false; this.error = null; this.positions = new Map(); this.closed = [];
    this.closing = new Set(); this.lastSweepAt = 0;
    this.lastEntryAt = null;
  }

  async initialize() {
    try {
      const rows = await this.store.moverPaperEvents();
      const ordered = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))
        || (a.event_type === 'MOVER_PAPER_OPEN' ? -1 : 1));
      for (const row of ordered) {
        const p = row.payload ?? {};
        if (row.event_type === 'MOVER_PAPER_OPEN' && p.id && p.strategy && p.position) this.positions.set(p.id, p.position);
        if (row.event_type === 'MOVER_PAPER_CLOSE' && p.id) {
          this.positions.delete(p.id); this.closed.push(p.trade);
        }
      }
      this.closed = this.closed.filter(Boolean);
      this.ready = true; this.error = null;
      return true;
    } catch (e) { this.ready = false; this.error = e.message; return false; }
  }

  realizedToday(strategy = null) {
    const day = gstDay(this.now());
    return this.closed.filter(t => t && gstDay(Date.parse(t.closedAt)) === day && (!strategy || t.strategy === strategy))
      .reduce((sum, t) => sum + Number(t.netPnl || 0), 0);
  }

  openRisk(strategy = null) {
    return [...this.positions.values()].filter(p => !strategy || p.strategy === strategy)
      .reduce((sum, p) => sum + p.riskUsd, 0);
  }

  async open({ strategy, eventKey, symbol, price, stopPrice, details = {} }) {
    const rules = STRATEGIES[strategy];
    if (!this.ready || !rules || !finite(price) || !finite(stopPrice) || stopPrice >= price || !eventKey || !symbol)
      return { opened: false, reason: this.ready ? 'invalid setup' : 'paper ledger unavailable' };
    const now = this.now();
    if (this.realizedToday(strategy) <= -this.dailyLossUsd) return { opened: false, reason: 'daily loss lock' };
    const id = `${rules.cohort}:${eventKey}`;
    if (this.positions.has(id) || this.closed.some(t => t.id === id)) return { opened: false, reason: 'duplicate event' };
    const roundTripCostRate = (2 * (this.feeBps + this.slippageBps)) / 10_000;
    const stopMove = (price - stopPrice) / price;
    const unitRisk = stopMove + roundTripCostRate;
    const used = [...this.positions.values()].filter(p => p.strategy === strategy).reduce((s, p) => s + p.notional / rules.marginMultiple, 0);
    const cash = this.balance(strategy).equity;
    const marginRoom = Math.max(0, cash * 0.5 - used);
    const remainingRisk = Math.max(0, this.dailyLossUsd + this.realizedToday(strategy) - this.openRisk(strategy));
    const notional = Math.min(this.maxRiskUsd / unitRisk, remainingRisk / unitRisk, rules.maxNotional, marginRoom * rules.marginMultiple);
    if (!(notional > 0)) return { opened: false, reason: 'virtual margin limit' };
    const riskUsd = round(notional * unitRisk);
    if (riskUsd > this.maxRiskUsd + 0.01) return { opened: false, reason: 'risk cap' };
    const targetPrice = price * (1 + (1.5 * unitRisk + roundTripCostRate));
    if (!(targetPrice > price)) return { opened: false, reason: 'target infeasible' };
    const pos = { id, strategy, cohort: rules.cohort, symbol, entry: Number(price), mark: Number(price), stop: Number(stopPrice), target: targetPrice,
      qty: notional / price, notional, riskUsd, openedAt: new Date(now).toISOString(), lastMarkAt: new Date(now).toISOString(), expiresAt: new Date(now + rules.maxHoldMs).toISOString(),
      entryFee: notional * this.feeBps / 10_000, entrySlippage: notional * this.slippageBps / 10_000, details };
    const persisted = await this.store.insertEvent({ event_key: `mover-paper-open:${encodeURIComponent(id)}`, event_type: 'MOVER_PAPER_OPEN', symbol,
      payload: { id, strategy, position: pos } });
    if (persisted === false) return { opened: false, reason: 'duplicate event' };
    this.positions.set(id, pos); this.lastEntryAt = pos.openedAt;
    return { opened: true, position: pos };
  }

  async mark(strategy, symbol, price) {
    if (!this.ready || !finite(price)) return;
    for (const p of [...this.positions.values()]) {
      if (p.strategy !== strategy || p.symbol !== symbol) continue;
      p.mark = Number(price); p.lastMarkAt = new Date(this.now()).toISOString();
      const timed = this.now() >= Date.parse(p.expiresAt);
      const reason = price <= p.stop ? 'STOP' : price >= p.target ? 'TARGET' : timed ? 'TIME' : null;
      if (reason) await this.close(p, reason, reason === 'STOP' ? Math.min(price, p.stop) : reason === 'TARGET' ? p.target : price);
    }
    await this.sweep();
  }

  async close(p, reason, exit) {
    if (this.closing.has(p.id)) return;
    this.closing.add(p.id);
    try {
    const notionalExit = p.qty * exit;
    const gross = p.qty * (exit - p.entry);
    const exitCosts = notionalExit * (this.feeBps + this.slippageBps) / 10_000;
    const netPnl = round(gross - p.entryFee - p.entrySlippage - exitCosts);
    const trade = { id: p.id, strategy: p.strategy, cohort: p.cohort, symbol: p.symbol, direction: 'LONG', entry: p.entry,
      exit: Number(exit), stop: p.stop, target: p.target, riskUsd: p.riskUsd, notional: p.notional,
      openedAt: p.openedAt, closedAt: new Date(this.now()).toISOString(), reason, grossPnl: round(gross), modeledCosts: round(p.entryFee + p.entrySlippage + exitCosts), netPnl,
      r: p.riskUsd ? round(netPnl / p.riskUsd) : 0 };
    const persisted = await this.store.insertEvent({ event_key: `mover-paper-close:${encodeURIComponent(p.id)}`, event_type: 'MOVER_PAPER_CLOSE', symbol: p.symbol,
      payload: { id: p.id, trade } });
    if (persisted === false) { this.positions.delete(p.id); return; }
    this.positions.delete(p.id); this.closed.push(trade);
    } finally { this.closing.delete(p.id); }
  }

  async sweep() {
    const now = this.now();
    if (!this.ready || now - this.lastSweepAt < 15_000) return;
    this.lastSweepAt = now;
    for (const p of [...this.positions.values()]) {
      if (now >= Date.parse(p.expiresAt)) await this.close(p, 'TIME', p.mark);
    }
  }

  balance(strategy) {
    const rules = STRATEGIES[strategy];
    const closed = this.closed.filter(t => t?.strategy === strategy);
    const realized = closed.reduce((s, t) => s + Number(t.netPnl || 0), 0);
    const open = [...this.positions.values()].filter(p => p.strategy === strategy);
    const openPnl = open.reduce((s, p) => s + p.qty * (p.mark - p.entry) - p.entryFee - p.entrySlippage - p.qty * p.mark * (this.feeBps + this.slippageBps) / 10_000, 0);
    const wins = closed.filter(t => t.netPnl > 0).length;
    const losses = closed.filter(t => t.netPnl < 0).length;
    const today = this.realizedToday(strategy);
    return { cohort: rules.cohort, starting: 100, cash: round(100 + realized), realized: round(realized), openPnl: round(openPnl), equity: round(100 + realized + openPnl),
      open: open.length, closed: closed.length, wins, losses, winRate: closed.length ? round(wins / closed.length * 100) : null,
      today: round(today), riskOpen: round(this.openRisk(strategy)), locked: today <= -this.dailyLossUsd, dailyLossLimit: this.dailyLossUsd,
      positions: open.map(p => ({ symbol: p.symbol, entry: p.entry, mark: p.mark, stop: p.stop, target: p.target, riskUsd: p.riskUsd, expiresAt: p.expiresAt })) };
  }

  summary() {
    return { ready: this.ready, error: this.error, maxRiskUsd: this.maxRiskUsd, dailyLossUsd: this.dailyLossUsd,
      feeBps: this.feeBps, slippageBps: this.slippageBps, accounts: Object.fromEntries(Object.keys(STRATEGIES).map(s => [s, this.balance(s)])) };
  }
}

export const MOVER_PAPER_STRATEGIES = STRATEGIES;
