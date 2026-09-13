// An immutable paper-only experiment. No signed Binance endpoints or credentials.
import { dubaiDayBounds } from './util.js';

export const PAPER_TEST_ID = 'paper100-runner-v1';
export const PAPER_EXECUTION_MODEL = 'paper100-closed-bar-v1';
export const PAPER_RULES = Object.freeze({ balance: 100, maxRisk: 1, leverage: 2,
  dailyLoss: 3, weeklyLoss: 7, maxTrades: 5, maxLosses: 3, takeR: 1.2,
  closeFraction: 0.8, trailR: 0.5, timeoutMin: 120 });
export const isPaperTest = trade => trade.setup?.paperTest?.id === PAPER_TEST_ID;

const floorStep = (value, step) => Number((Math.floor((value + step * 1e-9) / step) * step).toPrecision(14));
const money = (value, name) => {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) throw Error(`Invalid paper ledger: ${name}`);
  return n;
};

export function paperAccount(rows, now = new Date()) {
  const trades = rows.filter(t => isPaperTest(t) && t.status !== 'CANCELLED');
  const day = dubaiDayBounds(now);
  const weekStart = now.getTime() - 7 * 86_400_000;
  const events = trades.flatMap(t => {
    if (!Array.isArray(t.setup.paperTest.ledger)) throw Error('Missing paper ledger');
    return t.setup.paperTest.ledger;
  }).sort((a, b) => a.time - b.time);
  let realized = 0, daily = 0, weekly = 0, peak = PAPER_RULES.balance, drawdown = 0;
  for (const event of events) {
    const delta = money(event.netUsd, 'netUsd');
    const time = money(event.time, 'event time');
    realized += delta;
    if (time >= Date.parse(day.start) && time < Date.parse(day.end)) daily += delta;
    if (time >= weekStart && time <= now.getTime()) weekly += delta;
    peak = Math.max(peak, PAPER_RULES.balance + realized);
    drawdown = Math.max(drawdown, peak - PAPER_RULES.balance - realized);
  }
  const closed = trades.filter(t => t.status === 'CLOSED').sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
  const results = closed.map(t => money(t.setup.paperTest.netUsd, 'closed netUsd'));
  const wins = results.filter(x => x > 0.005).length;
  const losses = results.filter(x => x < -0.005).length;
  const profit = results.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const loss = -results.filter(x => x < 0).reduce((a, b) => a + b, 0);
  let consecutive = 0;
  for (const t of closed) {
    if (t.closed_at < day.start || t.closed_at >= day.end || t.setup.paperTest.netUsd >= -0.005) break;
    consecutive++;
  }
  const today = trades.filter(t => t.created_at >= day.start && t.created_at < day.end).length;
  const balance = PAPER_RULES.balance + realized;
  const reasons = [];
  if (balance <= 0) reasons.push('virtual balance exhausted');
  if (daily <= -PAPER_RULES.dailyLoss + 1e-8) reasons.push('paper daily loss limit $3');
  if (weekly <= -PAPER_RULES.weeklyLoss + 1e-8) reasons.push('paper rolling 7-day loss limit $7');
  if (today >= PAPER_RULES.maxTrades) reasons.push('paper daily trade cap 5');
  if (consecutive >= PAPER_RULES.maxLosses) reasons.push('paper 3 consecutive losses today');
  return { balance, realized, daily, weekly, drawdown, today, consecutive, reasons,
    open: trades.filter(t => t.status === 'OPEN').length,
    total: closed.length, wins, losses, scratches: closed.length - wins - losses,
    winRate: closed.length ? wins / closed.length * 100 : null,
    profitFactor: loss > 0 ? profit / loss : profit > 0 ? Infinity : null,
    expectancyR: closed.length ? closed.reduce((s, t) => s + money(t.r_multiple, 'R'), 0) / closed.length : null,
    riskBudget: Math.max(0, Math.min(1, balance * 0.01, 3 + daily, 7 + weekly)) };
}

export function sizePaperTrade(trade, account, symbolInfo, cfg) {
  if (!cfg.paperMode) throw Error('The $100 experiment requires PAPER_MODE=true');
  const entry = Number(trade.entry);
  let stop = Number(trade.initial_sl);
  const createdAt = trade.created_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw Error('Invalid paper entry time');
  if (!(money(account.balance, 'balance') > 0 && money(account.riskBudget, 'riskBudget') > 0)) {
    throw Error('Paper risk budget exhausted');
  }
  const fee = Number(trade.fee_bps ?? cfg.takerFeeBps) / 10_000;
  const slip = Number(cfg.exitSlippageBps) / 10_000;
  if (!(entry > stop && stop > 0 && fee >= 0 && slip >= 0 && slip < 1)) throw Error('Invalid paper entry/costs');
  const filters = symbolInfo?.filters ?? [];
  const lot = filters.find(f => f.filterType === 'LOT_SIZE');
  const market = filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
  const price = filters.find(f => f.filterType === 'PRICE_FILTER');
  const notional = filters.find(f => ['MIN_NOTIONAL', 'NOTIONAL'].includes(f.filterType));
  if (!lot || !price || !notional || !(Number(lot.stepSize) > 0)) throw Error('Paper symbol filters unavailable');
  // Use stricter entry/split constraints even where exchange reduce-only exemptions exist.
  const step = Math.max(Number(lot.stepSize), Number(market?.stepSize ?? 0));
  const minQty = Math.max(Number(lot.minQty), Number(market?.minQty ?? 0));
  const maxQty = Math.min(Number(lot.maxQty), Number(market?.maxQty) > 0 ? Number(market.maxQty) : Infinity);
  const minNotional = Number(notional.notional ?? notional.minNotional);
  const tick = Number(price.tickSize);
  if (![step, minQty, maxQty, minNotional, tick].every(x => Number.isFinite(x) && x > 0)) throw Error('Invalid paper symbol filters');
  stop = floorStep(stop, tick);
  if (!(stop > 0)) throw Error('Paper stop below minimum price tick');
  const stopFill = stop * (1 - slip);
  const riskPerUnit = entry - stopFill + fee * (entry + stopFill);
  // Reserve entry fees as well as 2x notional margin. Round DOWN; never upscale to a minimum.
  const quantity = floorStep(Math.min(account.riskBudget / riskPerUnit,
    account.balance / (entry / 2 + entry * fee), 200 / entry, maxQty), step);
  if (quantity < minQty || quantity * entry < minNotional) throw Error('Paper size below exchange minimum; skip');
  const partialQty = floorStep(quantity * PAPER_RULES.closeFraction, step);
  const remainder = Number((quantity - partialQty).toPrecision(14));
  // Desired pre-partial net liquidation PnL is +1.2 times the planned initial loss.
  const takePrice = Math.ceil(((entry * (1 + fee) + PAPER_RULES.takeR * riskPerUnit)
    / ((1 - slip) * (1 - fee))) / tick) * tick;
  const split = partialQty >= minQty && remainder >= minQty
    && partialQty * takePrice >= minNotional && remainder * stopFill >= minNotional;
  const paper = { id: PAPER_TEST_ID, quantity, remainingQty: quantity, riskUsd: quantity * riskPerUnit,
    riskPerUnit, notionalUsd: quantity * entry, marginUsd: quantity * entry / 2,
    fee, slip, takePrice, partialQty: split ? partialQty : quantity,
    split, partialDone: false, tick, netUsd: -quantity * entry * fee, exitValue: 0,
    timeoutMin: PAPER_RULES.timeoutMin,
    ledger: [{ type: 'ENTRY_FEE', time: Date.parse(createdAt), netUsd: -quantity * entry * fee }] };
  return { ...trade, created_at: createdAt, initial_sl: stop, active_sl: stop,
    risk_per_unit: entry - stop,
    setup: { ...trade.setup, executionModel: PAPER_EXECUTION_MODEL, paperTest: paper } };
}

const fillExit = (state, entry, qty, rawPrice, time, type) => {
  const fill = rawPrice * (1 - state.slip);
  const netUsd = qty * (fill - entry) - qty * fill * state.fee;
  state.netUsd += netUsd;
  state.exitValue += qty * fill;
  state.remainingQty = Math.max(0, state.remainingQty - qty);
  state.ledger.push({ type, time, quantity: qty, fill, netUsd });
};

export function closePaperTrade(trade, rawPrice, time, reason, state = structuredClone(trade.setup.paperTest)) {
  fillExit(state, Number(trade.entry), state.remainingQty, rawPrice, time, reason);
  const netPct = state.netUsd / state.notionalUsd * 100;
  return { closed: true, patch: { status: 'CLOSED',
    setup: { ...trade.setup, paperTest: state, exitExecutionModel: PAPER_EXECUTION_MODEL, stopAlertPending: false },
    outcome: state.netUsd > 0.005 ? 'WIN' : state.netUsd < -0.005 ? 'LOSS' : 'SCRATCH',
    exit_price: state.exitValue / state.quantity, exit_reason: reason,
    gross_pnl_pct: (state.exitValue / state.notionalUsd - 1) * 100,
    net_pnl_pct: netPct, r_multiple: state.netUsd / state.riskUsd,
    exit_alert_sent: false, last_checked_bar_close: time, closed_at: new Date(time).toISOString() } };
}

export function evaluatePaperTrade(trade, closedCandles) {
  const entry = Number(trade.entry), created = Date.parse(trade.created_at);
  let checked = Number(trade.last_checked_bar_close ?? trade.entry_bar_close ?? 0);
  let stop = Number(trade.active_sl), mfe = Number(trade.mfe_pct ?? 0), mae = Number(trade.mae_pct ?? 0);
  const state = structuredClone(trade.setup.paperTest);
  const bars = closedCandles.filter(c => c.closeTime > checked && c.closeTime >= created)
    .sort((a, b) => a.closeTime - b.closeTime)
    .map(c => Number(c.openTime ?? c.closeTime - 59_999) < created ? { ...c, open: c.close, low: c.close, high: c.close } : c);
  if (!bars.length) return { closed: false, patch: null };
  const finish = (price, time, reason) => {
    const result = closePaperTrade(trade, price, time, reason, state);
    Object.assign(result.patch, { mfe_pct: mfe, mae_pct: mae });
    return result;
  };
  for (const c of bars) {
    // Existing stop always precedes profit-taking if intrabar order is unknown.
    if (c.low <= stop) {
      const raw = Math.min(stop, Number(c.open ?? c.close));
      mae = Math.min(mae, (raw / entry - 1) * 100);
      return finish(raw, c.closeTime, state.partialDone ? 'RUNNER_STOP' : 'STOP');
    }
    if (!state.partialDone && c.high >= state.takePrice) {
      if (!state.split) {
        mfe = Math.max(mfe, (state.takePrice / entry - 1) * 100);
        return finish(state.takePrice, c.closeTime, 'PAPER_TAKE_ALL');
      }
      fillExit(state, entry, state.partialQty, state.takePrice, c.closeTime, 'PARTIAL_TP');
      mfe = Math.max(mfe, (state.takePrice / entry - 1) * 100);
      state.partialDone = true;
      state.partialAlertPending = true;
      // Cover entry and exit fees for the REMAINING quantity, not just the whole trade.
      const be = Math.ceil((entry * (1 + state.fee) / ((1 - state.slip) * (1 - state.fee))) / state.tick) * state.tick;
      // Unknown low/high ordering: conservatively assume the new stop was touched
      // after TP if it lies anywhere in this candle. Never invent an intrabar path.
      if (c.low <= be) {
        const raw = Math.min(be, c.close);
        mae = Math.min(mae, (raw / entry - 1) * 100);
        return finish(raw, c.closeTime, 'RUNNER_STOP');
      }
      stop = Math.max(stop, be);
    }
    mfe = Math.max(mfe, (c.high / entry - 1) * 100);
    mae = Math.min(mae, (c.low / entry - 1) * 100);
    if (state.partialDone) {
      const peakPrice = entry * (1 + mfe / 100);
      if (peakPrice - c.close >= PAPER_RULES.trailR * state.riskPerUnit) {
        return finish(c.close, c.closeTime, 'MOMENTUM_FADE');
      }
      // New trailing level only takes effect on the NEXT closed candle.
      const trail = floorStep(c.close - PAPER_RULES.trailR * state.riskPerUnit, state.tick);
      if (trail < c.close) stop = Math.max(stop, trail);
    }
    if (c.closeTime - created >= state.timeoutMin * 60_000) return finish(c.close, c.closeTime, 'TIMEOUT');
    checked = c.closeTime;
  }
  return { closed: false, patch: { setup: { ...trade.setup, paperTest: state }, active_sl: stop,
    breakeven_armed: state.partialDone, mfe_pct: mfe, mae_pct: mae, last_checked_bar_close: checked } };
}
