import { createHash, randomUUID } from 'node:crypto';
import { FadeExecutor } from './fade-executor.js';
import { FadeExchange, decimal, down, fadeFilters, ExchangeError } from './fade-orders.js';
import { planFuturesAutoTrade } from './futures-auto-policy.js';
import { readFadeRisk } from './fade-risk.js';
import { futuresScope } from './futures-auto-store.js';
import { FUTURES_AUTO_SYMBOLS } from './futures-auto-strategy.js';
import { escapeHtml } from './util.js';
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const active = j => j.phase !== 'CLOSED';
const terminal = s => ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(s);
const truth = x => x === true || x === 'true';
const up = (n, tick) => Number((Math.ceil(n / tick - 1e-9) * tick).toFixed(12));
const exitSide = j => j.direction === 'LONG' ? 'SELL' : 'BUY';
export const FUTURES_TARGET_R = 1.5, FUTURES_BREAKEVEN_R = 1, FUTURES_MAX_HOLD_MS = 4 * 3600000;
export function futuresExitPlan(direction, entry, qty, stop, fee, tick, targetR = FUTURES_TARGET_R) {
  const long = direction === 'LONG';
  if (!['LONG', 'SHORT'].includes(direction) || ![entry, qty, stop, fee, tick].every(Number.isFinite)
    || !(entry > 0 && qty > 0 && stop > 0 && fee >= 0 && fee <= .01 && tick > 0)
    || (long ? stop >= entry : stop <= entry)) throw Error('Invalid actual-fill exit plan');
  const loss = qty * (long ? entry * (1 + fee) - stop * (1 - fee - .0005)
    : stop * (1 + fee + .0005) - entry * (1 - fee));
  // Net profit at target = targetR x modeled loss (both after fees/slippage).
  const raw = long ? (targetR * loss / qty + entry * (1 + fee)) / (1 - fee - .0005)
    : (entry * (1 - fee) - targetR * loss / qty) / (1 + fee + .0005);
  const target = long ? up(raw, tick) : down(raw, tick);
  const breakEven = long ? up(entry * (1 + fee) / (1 - fee - .0005), tick)
    : down(entry * (1 - fee) / (1 + fee + .0005), tick);
  if (!(loss > 0 && target > 0)) throw Error('Actual-fill target unavailable');
  return { entry, qty, stop, target, breakEven, plannedLossUsd: loss, marginUsd: qty * entry / 2 };
}
export class FuturesAutoExchange extends FadeExchange {
  candles(symbol, interval) { return this.request('GET', '/fapi/v1/klines', { symbol, interval, limit: 121 }, false); }
  placeDirectionalStop(symbol, id, price, side) {
    return this.request('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side,
      positionSide: 'BOTH', type: 'STOP_MARKET', triggerPrice: decimal(price), closePosition: 'true',
      workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: id });
  }
}
// Reuse only the lease/fence, balance reads and owned-order cleanup plumbing.
// Directional entry, stops, targets and controls are independent of fade.
export class FuturesAutoExecutor extends FadeExecutor {
  constructor(options) { super(options); this.scope = futuresScope(this.cfg.environment); this.reason = 'Awaiting first scan'; this.scanReasons = {}; }
  enabled() { return true; } // Entry-disable never turns off protection/recovery.
  captureBalance(account) {
    const usdt = account.assets?.find(a => a.asset === 'USDT');
    const fields = [account.totalWalletBalance ?? usdt?.walletBalance,
      account.totalUnrealizedProfit ?? usdt?.unrealizedProfit,
      account.totalMarginBalance ?? usdt?.marginBalance,
      account.availableBalance ?? usdt?.availableBalance,
      account.totalInitialMargin ?? usdt?.initialMargin];
    if (fields.some(x => x === undefined || x === null || x === '' || !Number.isFinite(Number(x)))) {
      this.balanceSnapshot = null; throw Error('Futures balance data unavailable');
    }
    super.captureBalance(account);
  }
  async ready() {
    await super.ready();
    const fingerprint = hash(this.cfg.binanceApiKey);
    if (this.row.state.keyFingerprint && this.row.state.keyFingerprint !== fingerprint) throw Error('API key differs from pinned Futures account; inspect before migrating keys');
    if (!this.row.state.keyFingerprint) { this.row.state.keyFingerprint = fingerprint; await this.save(); }
  }
  status() {
    const jobs = this.row?.state.jobs.filter(active) ?? [], b = this.balanceSnapshot;
    return `FUTURES AUTO — ${this.cfg.environment.toUpperCase()} · separate account\n` +
      `${!this.cfg.enabled ? 'New entries disabled; protection active' : this.row?.state.paused !== false ? 'Entries paused' : 'Enabled'} · ${jobs.length}/5 active intents\n` +
      `Last entry/scan: ${this.reason}\n` +
      'Detection: pipeline v2 · early WATCH + confirmation age/cost diagnostics\n' +
      'LONG + SHORT · isolated 2x · max $150 notional each\n' +
      'Target 1.5R net · break-even at +1R · 4h max hold · stop ≤ min($5, 1% equity)\n' +
      'Aggregate risk ≤3% equity · margin ≤50% equity\nDaily 2% loss/giveback lock · two-loss cooldown 4h\n' +
      jobs.map(j => `${j.symbol} ${j.direction} · ${j.phase} · stop ${j.plan.stop} · target ${j.plan.target}`).join('\n') +
      (b ? `\nWallet $${b.wallet.toFixed(2)} · Equity $${b.equity.toFixed(2)} · Available $${b.available.toFixed(2)}\nBalance updated: ${new Date(b.updatedAt).toISOString()}` : '\nBalance awaiting verified account read') +
      `\nLast reconciliation: ${this.lastCheck ?? 'not completed'}${this.lastError ? '\nError: ' + this.lastError : ''}\n` +
      Object.entries(this.scanReasons).map(([s, r]) => `${s}: ${r}`).join('\n') +
      '\n/futurespause /futuresresume /futurescloseall';
  }
  async failed(error) {
    this.lastError = error.message;
    if (this.now() - this.lastNotice > 60000) {
      this.lastNotice = this.now();
      await this.notify(`⚠️ FUTURES AUTO: ${escapeHtml(error.message)}\nNew entries withheld; check /futuresauto and the separate Binance subaccount.`);
    }
  }
  ownsOrder(o, jobs) {
    const id = o.clientOrderId ?? o.clientAlgoId;
    return jobs.some(j => j.symbol === o.symbol && (Object.values(j.actions ?? {}).some(a => a.id === id)
      || (String(id).startsWith(`nx-${j.id}-z`) && o.side === exitSide(j) && truth(o.reduceOnly))));
  }
  async position(job) {
    const rows = await this.exchange.positions();
    if (!Array.isArray(rows)) throw Error('Position snapshot unavailable');
    const p = rows.find(p => p.symbol === job.symbol && Number(p.positionAmt) !== 0);
    if (p && (p.positionSide !== 'BOTH' || !Number.isFinite(Number(p.positionAmt))
      || (job.direction === 'LONG' ? Number(p.positionAmt) <= 0 : Number(p.positionAmt) >= 0))) throw Error('Unexpected position direction; manual inspection required');
    return p;
  }
  async submit(job, key, kind, params) {
    let a = job.actions[key], placed;
    if (!a) {
      a = job.actions[key] = { id: `nx-${job.id}-${key}`, kind, params, intendedAt: this.now() };
      await this.save();
      try { placed = await this.mutate(() => kind === 'stop'
        ? this.exchange.placeDirectionalStop(job.symbol, a.id, params.triggerPrice, exitSide(job))
        : this.exchange.place({ symbol: job.symbol, newClientOrderId: a.id, ...params })); }
      catch (e) { if (e instanceof ExchangeError && e.status < 500) { a.rejected = true; await this.save(); throw e; } }
    }
    if (a.rejected) throw Error('Previously rejected order; no blind retry');
    let order = kind === 'stop' ? placed : null;
    if (!order) {
      for (let i = 0; i < 4; i++) {
        try { order = kind === 'stop' ? await this.exchange.algo(a.id) : await this.exchange.order(job.symbol, a.id); break; }
        catch (e) { if (e.code !== -2013 || this.now() - a.intendedAt > 10000 || i === 3) throw e; await this.wait(250 * 2 ** i); }
      }
    }
    if ((kind === 'stop' ? order?.clientAlgoId : order?.clientOrderId) !== a.id || order.symbol !== job.symbol) throw Error('Exchange order identity mismatch');
    return order;
  }
  async ensureStop(job, price) {
    const key = 's' + hash(decimal(price)).slice(0, 8);
    const r = await this.submit(job, key, 'stop', { triggerPrice: price });
    if (r.algoStatus !== 'NEW' || r.side !== exitSide(job) || !truth(r.closePosition)
      || (r.orderType ?? r.type) !== 'STOP_MARKET' || Math.abs(Number(r.triggerPrice) - price) > job.filters.tick / 2) throw Error('Native stop not confirmed');
    const changed = job.stopId !== job.actions[key].id || job.plan.stop !== price;
    job.stopId = job.actions[key].id; job.plan.stop = price; if (changed) await this.save();
  }
  async emergencyFlatten(job) {
    const p = await this.position(job); if (!p) return;
    const qty = Math.abs(Number(p.positionAmt));
    if (!(job.filledQty > 0) || qty > job.filledQty + 1e-8) throw Error('Emergency exit ownership not verified');
    await this.exchange.place({ symbol: job.symbol, side: exitSide(job), type: 'MARKET', reduceOnly: 'true',
      quantity: decimal(qty), newClientOrderId: `nx-${job.id}-z${hash(randomUUID()).slice(0, 8)}`, newOrderRespType: 'RESULT' });
  }
  async close(job, reason) {
    job.closeRequested = true; job.closeReason = reason; await this.save();
    const p = await this.position(job); if (!p) return;
    const qty = Math.abs(Number(p.positionAmt));
    if (!(job.filledQty > 0) || qty > job.filledQty + 1e-8) throw Error('Cannot close unowned quantity');
    // Remove only our reduce-only profit order before flattening (avoid -2022).
    const orders = await this.exchange.orders(job.symbol);
    for (const o of orders.filter(o => this.ownsOrder(o, [job]) && truth(o.reduceOnly))) {
      await this.mutate(() => this.exchange.cancel(job.symbol, o.clientOrderId));
    }
    const exits = Object.entries(job.actions).filter(([k]) => k.startsWith('x'));
    const prior = exits.at(-1)?.[1];
    if (prior) {
      let o; try { o = await this.exchange.order(job.symbol, prior.id); } catch { /* Only reduce-only exit retries are allowed. */ }
      if ((!o || !terminal(o.status)) && this.now() - prior.intendedAt < 10000) return;
    }
    await this.submit(job, `x${exits.length}`, 'order', { side: exitSide(job), type: 'MARKET', reduceOnly: 'true', quantity: decimal(qty), newOrderRespType: 'RESULT' });
  }
  async manage(job) {
    if (!job.actions.e) throw Error('Entry journal missing');
    if (job.actions.e.rejected || job.noOrderSent) {
      // Only definite rejection / verified unsent intent can be retired.
      if (await this.position(job)) throw Error('Rejected entry has unexpected position');
      job.phase = 'CLOSED'; job.closedAt = this.now(); await this.save(); return;
    }
    const entry = await this.exchange.order(job.symbol, job.actions.e.id);
    if (entry.clientOrderId !== job.actions.e.id || entry.symbol !== job.symbol
      || entry.side !== (job.direction === 'LONG' ? 'BUY' : 'SELL')) throw Error('Entry identity mismatch');
    const filled = Number(entry.executedQty), average = Number(entry.avgPrice);
    if (!Number.isFinite(filled) || filled < 0 || filled > Number(job.actions.e.params.quantity) + 1e-8) throw Error('Entry fill unknown');
    job.filledQty = filled;
    if (!terminal(entry.status)) { await this.mutate(() => this.exchange.cancel(job.symbol, job.actions.e.id)); throw Error('Entry settling; unfilled remainder canceled'); }
    const p = await this.position(job);
    if (!p) {
      await this.cancelOwned(job);
      const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
      if ([...orders, ...algos].some(o => this.ownsOrder(o, [job]))) throw Error('Flat position has pending bot orders');
      job.phase = 'CLOSED'; job.closedAt = this.now(); await this.save();
      await this.notify(`FUTURES AUTO ${job.symbol} ${job.direction}: position flat; bot orders cleared. /futuresauto`); return;
    }
    if (!(filled > 0) || Math.abs(Number(p.positionAmt)) > filled + 1e-8) throw Error('Position exceeds verified fill');
    try {
      if (!job.actualFillPlanned) {
        const plan = futuresExitPlan(job.direction, average, filled, job.structuralStop, job.fee, job.filters.tick);
        if (plan.plannedLossUsd > job.riskBudget + 1e-7 || filled * average > 150.01
          || plan.target < job.filters.minPrice || plan.target > job.filters.maxPrice) throw Error('Actual fill exceeds budget/filters');
        job.plan = plan; job.actualFillPlanned = true; await this.save();
      }
      if (job.closeRequested) { await this.close(job, job.closeReason ?? 'OWNER_CLOSE'); return; }
      // Time stop: a breakout that has not worked within the hold window is
      // closed rather than left open accruing funding (v6.9.37).
      if (this.now() - job.createdAt > FUTURES_MAX_HOLD_MS) { await this.close(job, 'MAX_HOLD_TIME'); return; }
      const quote = await this.exchange.book(job.symbol), price = Number(job.direction === 'LONG' ? quote.bidPrice : quote.askPrice);
      if (!(price > 0)) throw Error('Exit quote unavailable');
      if (job.direction === 'LONG' ? price <= job.plan.stop : price >= job.plan.stop) { await this.close(job, 'STOP_PRICE_REACHED'); return; }
      await this.ensureStop(job, job.plan.stop);
      const tp = await this.submit(job, 'tp', 'order', { side: exitSide(job), type: 'LIMIT', timeInForce: 'GTC', reduceOnly: 'true',
        quantity: decimal(filled), price: decimal(job.plan.target) });
      if (tp.side !== exitSide(job) || !truth(tp.reduceOnly) || Number(tp.origQty) !== filled
        || Math.abs(Number(tp.price) - job.plan.target) > job.filters.tick / 2) throw Error('Profit order not confirmed');
      const tpFilled = Number(tp.executedQty);
      if (!Number.isFinite(tpFilled) || tpFilled < 0 || tpFilled > filled) throw Error('Profit fill unknown');
      if (terminal(tp.status) && tp.status !== 'FILLED') throw Error('Profit order rejected/canceled');
      const current = await this.position(job); if (!current) return;
      if (Math.abs(Math.abs(Number(current.positionAmt)) - (filled - tpFilled)) > job.filters.step / 2) throw Error('Position changed outside bot orders');
      const net = job.direction === 'LONG' ? filled * (price * (1 - job.fee - .0005) - average * (1 + job.fee))
        : filled * (average * (1 - job.fee) - price * (1 + job.fee + .0005));
      // Once a full 1R is earned, protect at cost-adjusted entry (was 0.5R,
      // which turned most early winners into scratches; v6.9.37).
      const be = job.plan.breakEven;
      if (net >= job.plan.plannedLossUsd * FUTURES_BREAKEVEN_R && (job.direction === 'LONG' ? price > be && be > job.plan.stop : price < be && be < job.plan.stop)) await this.ensureStop(job, be);
      const changed = job.phase !== 'OPEN'; job.phase = 'OPEN';
      await this.cancelOwned(job, [job.stopId, job.actions.tp.id]); if (changed) await this.save();
    } catch (e) {
      try { await this.close(job, 'PROTECTION_FAILURE'); } catch { await this.emergencyFlatten(job); }
      throw Error(`Futures protection issue on ${job.symbol}; emergency close requested: ${e.message}`);
    }
  }
  async onSignal(symbol, signal) {
    if (!this.cfg.enabled || this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.ready(); await this.reconcile();
      if (this.row.state.paused || !await this.authorizeEntry()) { this.reason = 'Entries paused'; return; }
      if (!signal.allowed || signal.symbol !== symbol || !FUTURES_AUTO_SYMBOLS.includes(symbol)
        || !['LONG', 'SHORT'].includes(signal.direction) || !Number.isFinite(signal.barCloseTime)
        || signal.barCloseTime > this.now() || this.now() - signal.barCloseTime > 90000) throw Error('Invalid or stale directional signal');
      const jobs = this.row.state.jobs, id = hash(`${this.scope}:${symbol}:${signal.direction}:${signal.breakoutTime}`);
      if (jobs.some(j => j.id === id || j.symbol === symbol && (active(j) || this.now() - j.closedAt < 1800000))) { this.reason = 'Duplicate signal or symbol cooldown'; return; }
      if (jobs.filter(active).length >= 5) { this.reason = 'Five-position cap reached'; return; }
      const account = await this.accountState(), equity = this.balanceSnapshot?.equity;
      const risk = await readFadeRisk(this.exchange, jobs, equity, this.now());
      const event = await this.eventGate.check();
      if (!risk.allowed || !event.allowed) { this.reason = (!risk.allowed ? risk : event).reason; return; }
      const funding = await this.exchange.funding(symbol), rate = Number(funding.lastFundingRate);
      if (funding.symbol !== symbol || !Number.isFinite(rate) || Math.abs(rate) >= .0008
        || !Number.isFinite(Number(funding.time)) || this.now() - Number(funding.time) > 90000 || Number(funding.time) > this.now()
        || !Number.isFinite(Number(funding.nextFundingTime)) || Number(funding.nextFundingTime) - this.now() < 900000) { this.reason = 'Funding stale, crowded or settlement near'; return; }
      const info = (await this.exchange.info()).symbols.find(s => s.symbol === symbol);
      if (info?.status !== 'TRADING' || info.quoteAsset !== 'USDT' || info.contractType !== 'PERPETUAL') throw Error('Contract unavailable');
      const filters = fadeFilters(info), rates = await this.exchange.fees(symbol), fee = Math.max(Number(rates.takerCommissionRate), Number(rates.makerCommissionRate));
      await this.mutate(() => this.exchange.isolate(symbol));
      const book = await this.exchange.book(symbol), quoteAt = this.now(), bid = Number(book.bidPrice), ask = Number(book.askPrice);
      const entry = signal.direction === 'LONG' ? ask : bid;
      if (!(bid > 0 && ask >= bid) || (ask / bid - 1) > .0005 || Math.abs(entry / signal.entry - 1) > .0015) { this.reason = 'Entry extended or spread too wide'; return; }
      // Round toward entry, so exchange ticks never widen the structural stop.
      const stop = signal.direction === 'LONG' ? up(signal.stop, filters.tick) : down(signal.stop, filters.tick);
      const plan = planFuturesAutoTrade({ direction: signal.direction, entry, stop, equity,
        available: this.balanceSnapshot.available, open: jobs.filter(active).map(j => ({ riskUsd: j.plan.plannedLossUsd, marginUsd: j.plan.marginUsd })),
        feeRate: fee, qtyStep: filters.step, minQty: filters.min, minNotional: filters.notional });
      if (!plan.allowed) { this.reason = plan.reason; return; }
      if (plan.qty > filters.max || stop < filters.minPrice || stop > filters.maxPrice) throw Error('Planned size/stop violates filters');
      const job = { id, symbol, direction: signal.direction, signal, phase: 'SUBMITTING', createdAt: this.now(),
        structuralStop: stop, riskBudget: plan.riskBudget, fee, filters, plan, actions: {} };
      job.actions.e = { id: `nx-${id}-e`, kind: 'order', intendedAt: this.now(),
        params: { side: signal.direction === 'LONG' ? 'BUY' : 'SELL', type: 'MARKET', quantity: decimal(plan.qty), newOrderRespType: 'RESULT' } };
      jobs.push(job); await this.save();
      // A fresh control and fence immediately before a write. No retries on an
      // uncertain entry response; restart recovers strictly by its durable ID.
      let authorized;
      try { authorized = await this.authorizeEntry(); }
      catch (e) { job.noOrderSent = true; await this.save(); throw e; }
      if (!authorized || this.stopped || this.now() - quoteAt > 5000) {
        job.noOrderSent = true; job.phase = 'CLOSED'; job.closedAt = this.now(); await this.save(); this.reason = 'Entry expired/paused before send'; return;
      }
      await this.fence();
      try { await this.exchange.place({ symbol, newClientOrderId: job.actions.e.id, ...job.actions.e.params }); }
      catch (e) { if (e instanceof ExchangeError && e.status < 500) { job.actions.e.rejected = true; await this.save(); } }
      await this.manage(job);
      this.lastError = null; this.reason = `${symbol} ${signal.direction}: ${job.phase}`;
      if (active(job)) await this.notify(`🤖 FUTURES AUTO ${this.cfg.environment.toUpperCase()}: ${symbol} ${signal.direction}\nFilled ${job.filledQty} · stop ${job.plan.stop} · target ${job.plan.target} (1.5R)\n/futuresauto`);
    } catch (e) { await this.failed(e); this.reason = e.message; }
    finally { this.busy = false; }
  }
}
