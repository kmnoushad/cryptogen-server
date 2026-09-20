import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const todayUtc = (timestamp = Date.now()) => new Date(timestamp).toISOString().slice(0, 10);
const round = (value, digits = 4) => Number(value.toFixed(digits));

const initialState = (balance) => ({
  version: 1,
  balance,
  highWatermark: balance,
  openTrade: null,
  closedTrades: [],
  daily: { date: todayUtc(), realizedPnl: 0 },
  lastBarTime: 0,
  lastAlertSignature: '',
  lastHeartbeatAt: 0,
  lastEventPollAt: 0,
  seenEventIds: [],
});

export class GoldPaperAccount {
  constructor(config) {
    this.config = config;
    this.state = initialState(config.paperStartBalance);
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.config.stateFile, 'utf8'));
      this.state = { ...initialState(this.config.paperStartBalance), ...saved };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await this.save();
    }
    this.rollDay();
    return this.state;
  }

  rollDay(now = Date.now()) {
    const date = todayUtc(now);
    if (this.state.daily?.date !== date) this.state.daily = { date, realizedPnl: 0 };
  }

  async save() {
    await mkdir(dirname(this.config.stateFile), { recursive: true });
    const temporary = `${this.config.stateFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.config.stateFile);
  }

  canOpen() {
    this.rollDay();
    return !this.state.openTrade
      && this.state.balance > 0
      && this.state.daily.realizedPnl > -this.config.paperDailyLossUsd;
  }

  open(setup, time) {
    if (!this.canOpen()) return null;
    const riskUsd = Math.min(this.state.balance * this.config.paperRiskPct, this.config.paperDailyLossUsd);
    const rawOunces = riskUsd / Math.abs(setup.entry - setup.stop);
    const lots = rawOunces / this.config.contractOzPerLot;
    const directionMultiplier = setup.direction === 'LONG' ? 1 : -1;
    const entryFill = setup.entry + (directionMultiplier * (this.config.estimatedSpreadUsd + this.config.estimatedSlippageUsd));
    this.state.openTrade = {
      id: `gold-${time}`,
      direction: setup.direction,
      openedAt: time,
      signalEntry: setup.entry,
      entry: round(entryFill),
      stop: setup.stop,
      target1: setup.target1,
      target2: setup.target2,
      ounces: round(rawOunces, 6),
      lots: round(lots, 6),
      brokerMinimumLot: this.config.brokerMinimumLot,
      brokerViable: lots >= this.config.brokerMinimumLot,
      initialRiskUsd: round(riskUsd, 2),
      remainingFraction: 1,
      realizedPnl: 0,
      target1Hit: false,
    };
    return this.state.openTrade;
  }

  applyBar(bar) {
    const trade = this.state.openTrade;
    if (!trade || bar.time <= trade.openedAt) return [];
    const events = [];
    const isLong = trade.direction === 'LONG';
    const stopHit = isLong ? bar.low <= trade.stop : bar.high >= trade.stop;
    const target1Hit = !trade.target1Hit && (isLong ? bar.high >= trade.target1 : bar.low <= trade.target1);
    const target2Hit = isLong ? bar.high >= trade.target2 : bar.low <= trade.target2;

    // Conservative intrabar rule: if stop and target are both crossed, assume stop occurred first.
    if (stopHit) {
      events.push(this.closeRemaining(trade.stop, bar.time, trade.target1Hit ? 'BREAK_EVEN_STOP' : 'STOP'));
      return events;
    }
    if (target1Hit) {
      events.push(this.partialClose(trade.target1, 0.5, bar.time, 'TARGET_1'));
      trade.target1Hit = true;
      trade.stop = trade.entry;
    }
    if (target2Hit && this.state.openTrade) events.push(this.closeRemaining(trade.target2, bar.time, 'TARGET_2'));
    return events.filter(Boolean);
  }

  pnlFor(trade, exit, fraction) {
    const multiplier = trade.direction === 'LONG' ? 1 : -1;
    const exitFill = exit - (multiplier * this.config.estimatedSlippageUsd);
    return (exitFill - trade.entry) * multiplier * trade.ounces * fraction;
  }

  partialClose(exit, fraction, time, reason) {
    const trade = this.state.openTrade;
    const appliedFraction = Math.min(fraction, trade.remainingFraction);
    const pnl = this.pnlFor(trade, exit, appliedFraction);
    trade.remainingFraction = round(trade.remainingFraction - appliedFraction, 4);
    trade.realizedPnl = round(trade.realizedPnl + pnl, 4);
    this.realize(pnl);
    return { type: 'PARTIAL_CLOSE', reason, pnl: round(pnl, 2), balance: round(this.state.balance, 2), trade };
  }

  closeRemaining(exit, time, reason) {
    const trade = this.state.openTrade;
    const pnl = this.pnlFor(trade, exit, trade.remainingFraction);
    trade.realizedPnl = round(trade.realizedPnl + pnl, 4);
    trade.remainingFraction = 0;
    trade.closedAt = time;
    trade.exit = exit;
    trade.exitReason = reason;
    this.realize(pnl);
    this.state.closedTrades.push(trade);
    this.state.closedTrades = this.state.closedTrades.slice(-500);
    this.state.openTrade = null;
    return { type: 'CLOSE', reason, pnl: round(pnl, 2), totalPnl: round(trade.realizedPnl, 2), balance: round(this.state.balance, 2), trade };
  }

  realize(pnl) {
    this.rollDay();
    this.state.balance = round(this.state.balance + pnl, 4);
    this.state.daily.realizedPnl = round(this.state.daily.realizedPnl + pnl, 4);
    this.state.highWatermark = Math.max(this.state.highWatermark, this.state.balance);
  }

  summary() {
    const trades = this.state.closedTrades;
    const wins = trades.filter((trade) => trade.realizedPnl > 0).length;
    return {
      balance: round(this.state.balance, 2),
      open: Boolean(this.state.openTrade),
      closed: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length ? round((wins / trades.length) * 100, 1) : 0,
      dailyPnl: round(this.state.daily.realizedPnl, 2),
      drawdown: round(this.state.highWatermark - this.state.balance, 2),
    };
  }
}
