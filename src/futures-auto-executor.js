import { MOMENTUM_VERSION, validMomentum, momentumReentry, volatilityStop, atr } from './momentum-live-policy.js';
import { closedSeries } from './futures-auto-strategy.js';
import { STRUCTURE_VERSION, insideGap, reentryDecision, protectiveStop, classifyStructuralExit } from './structure-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { nativeStopCovers } from './native-stop-proof.js';
import { FadeExecutor } from './fade-executor.js';
import { FadeExchange, decimal, down, fadeFilters, ExchangeError } from './fade-orders.js';
import { planFuturesAutoTrade, FUTURES_AUTO_LIMITS } from './futures-auto-policy.js';
import { readFadeRisk, readFadeIncome } from './fade-risk.js';
import { formatRiskStatus, newerRiskStatus } from './risk-status.js';
import { recordDailyGate, formatDailyGates, futuresFundingBlock } from './daily-gates.js';
import { futuresScope } from './futures-auto-store.js';
import { escapeHtml } from './util.js';
import { entryQuality } from './entry-quality.js';
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
  candles(symbol, interval, limit = 121) { return this.request('GET', '/fapi/v1/klines', { symbol, interval, limit }, false); }
  ticker24h() { return this.request('GET', '/fapi/v1/ticker/24hr', {}, false); }
  placeDirectionalStop(symbol, id, price, side, quantity) {
    return this.request('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol, side,
      positionSide: 'BOTH', type: 'STOP_MARKET', triggerPrice: decimal(price),
      ...(quantity == null ? { closePosition: 'true' } : { reduceOnly: 'true', quantity: decimal(quantity) }),
      workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: id });
  }
}
// Reuse only the lease/fence, balance reads and owned-order cleanup plumbing.
// Directional entry, stops, targets and controls are independent of fade.
export class FuturesAutoExecutor extends FadeExecutor {
  constructor(options) { super(options); this.scope = futuresScope(this.cfg.environment); this.reason = 'Awaiting first scan'; this.scanReasons = {}; this.universeSummary = 'Universe not scanned'; }
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
  async reconcile(audit = true, entrySnapshot = null) {
    const snapshot = await super.reconcile(audit, entrySnapshot);
    // Bound optional historical work; current positions are protected first.
    const pending = this.row.state.jobs.filter(j => j.phase === 'CLOSED'
      && j.policyVersion === MOMENTUM_VERSION && !j.momentumExitVerified && !j.noFillVerified
      && this.now() - (j.outcomeCheckAt ?? 0) >= 30000)
      .sort((a,b) => (a.outcomeCheckAt ?? 0) - (b.outcomeCheckAt ?? 0))[0];
    if (pending) {
      pending.outcomeCheckAt = this.now();
      if (pending.noOrderSent || pending.actions?.e?.rejected || pending.filledQty === 0) {
        // Re-run the identity/flat/order cleanup proof, including old zero fills.
        await this.manage(pending);
      } else await this.verifyMomentumOutcome(pending);
    }
    return snapshot;
  }
  status() {
    const jobs = this.row?.state.jobs.filter(active) ?? [], b = this.balanceSnapshot;
    const counts = new Map();
    for (const reason of Object.values(this.scanReasons)) {
      const gate = String(reason).split('; ').at(-1); counts.set(gate, (counts.get(gate) ?? 0) + 1);
    }
    const gates = [...counts].sort((a,b) => b[1]-a[1]).slice(0,3).map(([r,n]) => `${n} ${r.slice(0,150)}`).join(' · ');
    return `FUTURES AUTO — ${this.cfg.environment.toUpperCase()} · separate account\n` +
      `${!this.cfg.enabled ? 'New entries disabled; protection active' : this.row?.state.paused !== false ? 'Entries paused' : 'Enabled'} · ${jobs.length}/5 active intents\n` +
      `Last entry/scan: ${this.reason}\n` +
      formatRiskStatus(this.riskStatus, this.now()) + formatDailyGates(this) +
      `Universe: ${this.universeSummary}\n` +
      (this.scanStats ? `Scan: ${this.scanStats.scanned} checked · ${this.scanStats.confirmed} confirmed · ${this.scanStats.attempted} execution checks · ${this.scanStats.expired} expired · ${this.scanStats.dataErrors} data errors · ${((this.scanStats.completedAt ?? this.now()) - this.scanStats.startedAt) / 1000}s\n` : '') +
      (this.lastEntryAttempt ? `Last execution check: ${escapeHtml(this.lastEntryAttempt.symbol)} · ${escapeHtml(this.lastEntryAttempt.reason)} · ${new Date(this.lastEntryAttempt.at).toISOString()}\n` : '') +
      (gates ? `Top scan reasons: ${escapeHtml(gates)}\n` : '') +
      (this.cfg.momentumStrategy ? 'Detection: momentum base/pullback LONG; climax breakdown SHORT; full-universe price ranking\n' : this.cfg.structureStrategy ? 'Detection: swing sweep + delta MSS + fresh FVG; max 2 reduced-risk re-entries\n' : 'Detection: legacy breakout/retest\n') +
      (this.cfg.momentumStrategy ? 'Quality: $5M daily volume; LONG age 14d / SHORT 3d; no fixed daily-gain ceiling\n' : 'Long quality: age/liquidity/activity + 24h move bounds; no scam guarantee\n') +
      'LONG + SHORT · isolated 2x · max $150 notional each\n' +
      'Entry quality: modeled costs ≤25% of stop risk · no chasing\n' +
      (this.cfg.momentumStrategy ? 'New momentum trades: no fixed TP · native stop + 2x 5m ATR trail · BE after 1R · 4h hold\n' : 'Structure trades: target 1.5R · BE +0.5R · 4h hold\n') +
      'Aggregate risk ≤3% equity · margin ≤50% equity\nDaily 2% loss/giveback lock · three-loss cooldown 2h\n' +
      jobs.map(j => `${j.symbol} ${j.direction} · ${j.phase} · stop ${j.plan.stop} · ${j.policyVersion===MOMENTUM_VERSION?'volatility trail':'target '+j.plan.target}`).join('\n') +
      (b ? `\nWallet $${b.wallet.toFixed(2)} · Equity $${b.equity.toFixed(2)} · Available $${b.available.toFixed(2)}\nBalance updated: ${new Date(b.updatedAt).toISOString()}` : '\nBalance awaiting verified account read') +
      `\nLast reconciliation: ${this.lastCheck ?? 'not completed'}${this.lastError ? '\nError: ' + this.lastError : ''}\n` +
      Object.entries(this.scanReasons).slice(0, 6).map(([s, r]) => `${escapeHtml(s)}: ${escapeHtml(String(r).slice(0,120))}`).join('\n') +
      (Object.keys(this.scanReasons).length > 6 ? `\n… ${Object.keys(this.scanReasons).length - 6} more scan results` : '') +
      '\n/futurespause /futuresresume /futurescloseall';
  }
  async failed(error) {
    recordDailyGate(this, 'infrastructure', error.message, '', { id: Math.floor(this.now()/60000), outcome: 'error' });
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
    if (a?.rejected && kind === 'stop' && params.quantity != null && job.stopId !== a.id) {
      if (this.now() < (a.retryAt ?? 0)) throw Error('Stop replacement repair backoff');
      if ((a.attempt ?? 0) >= 2) throw Error('Stop replacement repair exhausted; prior protection retained');
      const attempt = (a.attempt ?? 0) + 1;
      job.actions[`${key}_rejected${attempt}`] = a;
      delete job.actions[key]; a = null;
      params = { ...params, repairAttempt: attempt };
    }
    if (!a) {
      const attempt = params.repairAttempt ?? 0;
      params = { ...params }; delete params.repairAttempt;
      a = job.actions[key] = { id: `nx-${job.id}-${key}${attempt ? 'r'+attempt : ''}`, kind, params, intendedAt: this.now(), attempt };
      await this.save();
      try { placed = await this.mutate(() => kind === 'stop'
        ? this.exchange.placeDirectionalStop(job.symbol, a.id, a.params.triggerPrice, exitSide(job), a.params.quantity)
        : this.exchange.place({ symbol: job.symbol, newClientOrderId: a.id, ...params })); }
      catch (e) { if (e instanceof ExchangeError && e.status < 500) { a.rejected = true; a.retryAt = this.now()+5000; await this.save(); throw e; } }
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
    const existing = Object.entries(job.actions).find(([,a]) => a.id === job.stopId && a.kind === 'stop' && Number(a.params.triggerPrice) === price);
    const position = await this.position(job), quantity = Math.abs(Number(position?.positionAmt));
    if (!(quantity > 0 && quantity <= job.filledQty + 1e-8)) throw Error('Stop awaits verified owned position');
    const replacement = !!job.stopId && !existing;
    const key = existing?.[0] ?? ((replacement ? 'r' : 's') + hash(decimal(price)).slice(0,8));
    const params = existing?.[1].params ?? { triggerPrice: price, ...(replacement ? { quantity: decimal(quantity), reduceOnly: 'true' } : {}) };
    let r;
    try {
      r = await this.submit(job, key, 'stop', params);
      if (!nativeStopCovers(r, job.actions[key], { symbol: job.symbol, side: exitSide(job), quantity,
        price, tick: job.filters.tick, step: job.filters.step })) throw Error('Native stop not confirmed');
    } catch (e) { e.stopReplacement = replacement; throw e; }
    const changed = job.stopId !== job.actions[key].id || job.plan.stop !== price;
    job.stopId = job.actions[key].id; job.plan.stop = price;
    if (changed) try { await this.save(); } catch (e) { e.stopReplacement = replacement; throw e; }
  }
  async retainDirectionalStop(job) {
    const action = Object.values(job.actions).find(a => a.id === job.stopId && a.kind === 'stop');
    if (!action) return false;
    const position = await this.position(job), quantity = Math.abs(Number(position?.positionAmt));
    if (!(quantity > 0 && quantity <= job.filledQty + 1e-8)) return false;
    const stop = await this.exchange.algo(job.stopId);
    return nativeStopCovers(stop, action, { symbol: job.symbol, side: exitSide(job), quantity,
      price: Number(action.params.triggerPrice), tick: job.filters.tick, step: job.filters.step });
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
      if (Number(job.filledQty) > 0) throw Error('Unsent/rejected intent conflicts with a recorded fill');
      if (await this.position(job)) throw Error('Rejected entry has unexpected position');
      await this.cancelOwned(job);
      const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
      if ([...orders, ...algos].some(o => this.ownsOrder(o, [job]))) throw Error('Unsent entry has pending bot orders');
      job.filledQty = 0; job.noFillVerified = true;
      job.phase = 'CLOSED'; job.closedAt ??= this.now(); await this.save(); return;
    }
    const entry = await this.exchange.order(job.symbol, job.actions.e.id);
    if (entry.clientOrderId !== job.actions.e.id || entry.symbol !== job.symbol
      || entry.side !== (job.direction === 'LONG' ? 'BUY' : 'SELL')) throw Error('Entry identity mismatch');
    const filled = Number(entry.executedQty), average = Number(entry.avgPrice);
    if (!Number.isFinite(filled) || filled < 0 || filled > Number(job.actions.e.params.quantity) + 1e-8) throw Error('Entry fill unknown');
    if (entry.status === 'FILLED' && filled === 0) throw Error('Filled entry reports zero quantity');
    job.filledQty = filled;
    if (!terminal(entry.status)) { await this.mutate(() => this.exchange.cancel(job.symbol, job.actions.e.id)); throw Error('Entry settling; unfilled remainder canceled'); }
    const p = await this.position(job);
    if (!p) {
      job.structuralStopExit = await classifyStructuralExit(this.exchange, job);
      await this.cancelOwned(job);
      const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
      if ([...orders, ...algos].some(o => this.ownsOrder(o, [job]))) throw Error('Flat position has pending bot orders');
      job.phase = 'CLOSED'; job.closedAt ??= this.now();
      if (filled === 0) { job.noFillVerified = true; job.closeReason = 'ENTRY_ZERO_FILL_VERIFIED'; }
      else job.closeReason ??= 'EXCHANGE_EXIT_UNCLASSIFIED';
      await this.save();
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
      await this.ensureStop(job, job.plan.stop);
      const quote = await this.exchange.book(job.symbol), price = Number(job.direction === 'LONG' ? quote.bidPrice : quote.askPrice);
      if (!(price > 0)) throw Error('Exit quote unavailable');
      if (job.direction === 'LONG' ? price <= job.plan.stop : price >= job.plan.stop) { await this.close(job, 'STOP_PRICE_REACHED'); return; }
      if (job.policyVersion === MOMENTUM_VERSION) {
        // Reuse only this management pass's owned-position snapshot. Stop
        // verification and replacements still read position independently.
        if (Math.abs(Math.abs(Number(p.positionAmt)) - filled) > job.filters.step / 2) throw Error('Momentum position changed outside bot orders');
        const net = job.direction === 'LONG' ? filled * (price * (1-job.fee-.0005)-average*(1+job.fee))
          : filled * (average*(1-job.fee)-price*(1+job.fee+.0005));
        try {
          if (!job.trailContext || this.now()-job.trailContext.at >= 60000 || job.trailContext.at>this.now()) {
            const bars = closedSeries(await this.exchange.candles(job.symbol,'5m'),300000,this.now());
            job.trailContext = { at:this.now(), atr:atr(bars), bar:bars.at(-1).end };
          }
        } catch (error) { error.protectedDataFailure=true; throw error; }
        const next=volatilityStop(job,price,net,job.trailContext.atr);
        if(next!==job.plan.stop)await this.ensureStop(job,next);
        job.phase='OPEN';await this.cancelOwned(job,[job.stopId]);await this.save();return;
      }
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
      if (job.policyVersion === STRUCTURE_VERSION) {
        const next = protectiveStop(job, price, net);
        if (next !== job.plan.stop) await this.ensureStop(job, next);
        await this.save();
      } else if (net >= job.plan.plannedLossUsd * FUTURES_BREAKEVEN_R && (job.direction === 'LONG' ? price > be && be > job.plan.stop : price < be && be < job.plan.stop)) await this.ensureStop(job, be);
      const changed = job.phase !== 'OPEN'; job.phase = 'OPEN';
      await this.cancelOwned(job, [job.stopId, job.actions.tp.id]); if (changed) await this.save();
    } catch (e) {
      // A request budget/cooldown is not evidence a previously accepted native
      // stop disappeared. Preserve it and block entries until monitoring resumes.
      // Missing/rejected stops and actual risk breaches still take the close path.
      if (job.stopId && (e.requestSent===false || e.status===429 || e.status===418 || e.code===-1003)) {
        throw Error(`Futures monitoring deferred on ${job.symbol}; previously confirmed native stop retained: ${e.message}`);
      }
      if ((e.stopReplacement || e.protectedDataFailure) && job.stopId && !job.closeRequested && await this.retainDirectionalStop(job).catch(() => false)) {
        job.monitoringFault = { at: this.now(), reason: String(e.message).slice(0,300), stop: 'native stop verified' };
        try { await this.save(); } catch { /* Retry diagnostics; preserve exchange protection. */ }
        throw Error(`Futures monitoring deferred on ${job.symbol}; verified native stop retained: ${e.message}`);
      }
      job.protectionFailure = { at: this.now(), code: e.code ?? null, status: e.status ?? null,
        reason: String(e.message).replace(/https?:\/\/\S+/g, '[URL redacted]').slice(0,300) };
      try { await this.close(job, 'PROTECTION_FAILURE'); } catch { await this.emergencyFlatten(job); }
      throw Error(`Futures protection issue on ${job.symbol}; emergency close requested: ${e.message}`);
    }
  }
  async verifyMomentumOutcome(job) {
    if (job.policyVersion !== MOMENTUM_VERSION || !(job.filledQty>0) || job.protectionFailure) return;
    const side=exitSide(job), valid=o=>o?.symbol===job.symbol && o.side===side && o.status==='FILLED'
      && Math.abs(Number(o.executedQty)-job.filledQty)<job.filters.step/2 && (truth(o.reduceOnly)||truth(o.closePosition));
    let verified=false;
    try {
      if (job.stopId) try {
        const a=Object.values(job.actions).find(a=>a.kind==='stop'&&a.id===job.stopId),o=await this.exchange.algo(job.stopId);
        if(a&&o.clientAlgoId===a.id&&o.symbol===job.symbol&&o.side===side&&(o.orderType??o.type)==='STOP_MARKET'
          &&Math.abs(Number(o.triggerPrice)-Number(a.params.triggerPrice))<=job.filters.tick/2&&/^\d+$/.test(String(o.actualOrderId??''))) {
          const fill=await this.exchange.request('GET','/fapi/v1/order',{symbol:job.symbol,orderId:o.actualOrderId});
          verified=String(fill.orderId)===String(o.actualOrderId)&&valid(fill);
        }
      } catch { /* A missing/canceled native stop does not hide a journaled bot exit. */ }
      // A bot close is verifiable regardless of why it was requested. Manual
      // exchange closes have no owned exit ID and remain blocked.
      if(!verified)for(const [k,a] of Object.entries(job.actions).filter(([k])=>/^x\d+$/.test(k))){
        const fill=await this.exchange.order(job.symbol,a.id);if(fill.clientOrderId===a.id&&valid(fill))verified=true;
      }
      if(!verified)return;
      const rows=(await readFadeIncome(this.exchange,job.createdAt,this.now())).filter(r=>r.symbol===job.symbol&&r.asset==='USDT'&&Number(r.time)>=job.createdAt&&Number(r.time)<=job.closedAt+60000&&['REALIZED_PNL','COMMISSION','FUNDING_FEE'].includes(r.incomeType));
      if(!rows.some(r=>r.incomeType==='REALIZED_PNL')||!rows.some(r=>r.incomeType==='COMMISSION')||rows.some(r=>!Number.isFinite(Number(r.income))))return;
      job.momentumExitVerified=true;job.verifiedNet=rows.reduce((v,r)=>v+Number(r.income),0);await this.save();
    } catch { /* Delayed or missing exchange evidence blocks re-entry. */ }
  }
  async onSignal(symbol, signal) {
    if (!this.cfg.enabled || this.busy || this.stopped) return;
    this.reason = `${symbol}: execution checks started`;
    this.busy = true;
    try {
      await this.ready(); await this.reconcile();
      if (this.row.state.paused || !await this.authorizeEntry()) { this.reason = 'Entries paused'; return; }
      const momentum = this.cfg.momentumStrategy === true;
      const mq = signal.marketQuality;
      if (!signal.allowed || signal.symbol !== symbol || !/^[A-Z0-9]+USDT$/.test(symbol)
        || !['LONG', 'SHORT'].includes(signal.direction) || !Number.isFinite(signal.barCloseTime)
        || signal.barCloseTime > this.now() || this.now() - signal.barCloseTime > 90000) throw Error('Invalid or stale directional signal');
      if (!mq || !Number.isFinite(Number(mq.checkedAt)) || this.now() - Number(mq.checkedAt) > 90000
        || Number(mq.checkedAt) > this.now() || !(Number(mq.quoteVolume) >= 5_000_000)
        || !(Number(mq.trades) >= 1000) || !(Number(mq.listingAgeDays) >= 3)) {
        this.reason = `${symbol}: missing/stale broad-universe quality check`; return;
      }
      if (signal.direction === 'LONG' && !momentum && (mq.longAllowed !== true || !(Number(mq.quoteVolume) >= 20_000_000)
        || !(Number(mq.trades) >= 5000) || !(Number(mq.listingAgeDays) >= 14)
        || !(Number(mq.changePct) >= -20 && Number(mq.changePct) <= 25))) {
        this.reason = `${symbol}: long quality gate blocked`; this.scanReasons[symbol] = this.reason; return;
      }
      if (momentum && (mq.listingAgeDays < (signal.direction==='LONG'?14:3) || !validMomentum(signal,signal.entry,this.now()))) { this.reason='Momentum proof or listing-age gate failed'; return; }
      if (!momentum && this.cfg.structureStrategy && !insideGap(signal, signal.entry)) { this.reason = 'Structure proof missing'; return; }
      const jobs = this.row.state.jobs, id = hash(`${this.scope}:${symbol}:${signal.direction}:${signal.breakoutTime}`);
      if(momentum){const previous=jobs.filter(j=>j.symbol===symbol&&j.phase==='CLOSED').sort((a,b)=>b.createdAt-a.createdAt)[0];if(previous&&this.now()-previous.closedAt<6*3600000&&!previous.momentumExitVerified)await this.verifyMomentumOutcome(previous);}
      const reentry = momentum ? momentumReentry(jobs,symbol,signal,this.now()) : this.cfg.structureStrategy ? reentryDecision(jobs, symbol, signal.direction, signal, this.now()) : { allowed: true, riskScale: 1, attempt: 0, rootAt: this.now() };
      if (!reentry.allowed) { this.reason = reentry.reason; return; }
      if (jobs.some(j => j.id === id || j.symbol === symbol && (active(j) || !momentum && !this.cfg.structureStrategy && this.now() - j.closedAt < 1800000))) { this.reason = 'Duplicate signal or symbol cooldown'; return; }
      if (jobs.filter(active).length >= 5) { this.reason = 'Five-position cap reached'; return; }
      const account = await this.accountState(), equity = this.balanceSnapshot?.equity;
      const risk = await readFadeRisk(this.exchange, jobs, equity, this.now());
      this.riskStatus = newerRiskStatus(this.riskStatus, { ...risk, checkedAt: risk.checkedAt ?? this.now() });
      const event = await this.eventGate.check();
      if (!risk.allowed || !event.allowed) { this.reason = (!risk.allowed ? risk : event).reason; return; }
      const funding = await this.exchange.funding(symbol);
      const fundingBlock = futuresFundingBlock(funding, symbol, this.now());
      if (fundingBlock) { this.reason = fundingBlock; return; }
      const info = (await this.exchange.info()).symbols.find(s => s.symbol === symbol);
      if (info?.status !== 'TRADING' || info.quoteAsset !== 'USDT' || info.contractType !== 'PERPETUAL') throw Error('Contract unavailable');
      const filters = fadeFilters(info), rates = await this.exchange.fees(symbol), fee = Math.max(Number(rates.takerCommissionRate), Number(rates.makerCommissionRate));
      await this.mutate(() => this.exchange.isolate(symbol));
      const book = await this.exchange.book(symbol), quoteAt = this.now(), bid = Number(book.bidPrice), ask = Number(book.askPrice);
      const entry = signal.direction === 'LONG' ? ask : bid;
      if (!(bid > 0 && ask >= bid) || (ask / bid - 1) > .0005 || Math.abs(entry / signal.entry - 1) > .0015) { this.reason = 'Entry extended or spread too wide'; return; }
      if(momentum&&!validMomentum(signal,entry,this.now())){this.reason='Momentum price band expired or exceeded';return;}
      if (!momentum && this.cfg.structureStrategy && !insideGap(signal, entry)) { this.reason = 'Price outside fresh FVG'; return; }
      // Round toward entry, so exchange ticks never widen the structural stop.
      const stop = signal.direction === 'LONG' ? up(signal.stop, filters.tick) : down(signal.stop, filters.tick);
      const baseRisk = Math.min(5, equity * .01);
      const attemptRisk = Math.min(baseRisk, reentry.rootBudget ?? baseRisk) * reentry.riskScale;
      const plan = planFuturesAutoTrade({ limits: { ...FUTURES_AUTO_LIMITS, maxStopUsd: attemptRisk }, direction: signal.direction, entry, stop, equity,
        available: this.balanceSnapshot.available, open: jobs.filter(active).map(j => ({ riskUsd: j.plan.plannedLossUsd, marginUsd: j.plan.marginUsd })),
        feeRate: fee, qtyStep: filters.step, minQty: filters.min, minNotional: filters.notional });
      if (!plan.allowed) { this.reason = plan.reason; return; }
      const quality = entryQuality({ direction: signal.direction, entry, stop, reference: signal.entry, fee });
      if (!quality.allowed) { this.reason = `${symbol}: ${quality.reason}`; this.scanReasons[symbol] = this.reason; return; }
      if (plan.qty > filters.max || stop < filters.minPrice || stop > filters.maxPrice) throw Error('Planned size/stop violates filters');
      if(momentum){
        const depthAt=this.now(), depth=await this.exchange.depth(symbol),levels=signal.direction==='LONG'?depth.asks:depth.bids;
        const cap=signal.direction==='LONG'?Math.min(signal.entryMax,entry*1.0015):Math.max(signal.entryMin,entry*.9985);
        if(!Array.isArray(levels)||levels.some(x=>!Number.isFinite(Number(x[0]))||!Number.isFinite(Number(x[1]))||Number(x[0])<=0||Number(x[1])<0)||this.now()-depthAt>2000||Number.isFinite(Number(depth.T??depth.E))&&(this.now()-Number(depth.T??depth.E)>2000||Number(depth.T??depth.E)>this.now()+1000)) { this.reason='Momentum depth unavailable/stale';return; }
        const availableQty=levels.filter(x=>signal.direction==='LONG'?Number(x[0])<=cap:Number(x[0])>=cap).reduce((v,x)=>v+Number(x[1]),0);
        if(availableQty<2*plan.qty){this.reason='Momentum executable depth below twice order size';return;}
      }
      const job = { id, symbol, direction: signal.direction, signal, phase: 'SUBMITTING', createdAt: this.now(),
        ...((momentum || this.cfg.structureStrategy) ? { policyVersion: momentum ? MOMENTUM_VERSION : STRUCTURE_VERSION, reentryAttempt: reentry.attempt, campaignStartedAt: reentry.rootAt, campaignRiskBudget: reentry.rootBudget ?? baseRisk } : {}),
        structuralStop: stop, riskBudget: plan.riskBudget, fee, filters, plan, actions: {} };
      job.actions.e = { id: `nx-${id}-e`, kind: 'order', intendedAt: this.now(),
        params: { side: signal.direction === 'LONG' ? 'BUY' : 'SELL',
          ...((momentum || this.cfg.structureStrategy) ? { type: 'LIMIT', timeInForce: 'FOK',
            price: decimal(signal.direction === 'LONG' ? down(Math.min(momentum ? signal.entryMax : signal.fvg.high, entry * 1.0015), filters.tick) : up(Math.max(momentum ? signal.entryMin : signal.fvg.low, entry * .9985), filters.tick)) }
            : { type: 'MARKET' }), quantity: decimal(plan.qty), newOrderRespType: 'RESULT' } };
      jobs.push(job); await this.save();
      // A fresh control and fence immediately before a write. No retries on an
      // uncertain entry response; restart recovers strictly by its durable ID.
      let authorized;
      try { authorized = await this.authorizeEntry(); }
      catch (e) { job.noOrderSent = true; await this.save(); throw e; }
      if (!authorized || this.stopped || this.now() - quoteAt > 5000) {
        job.noOrderSent = true; await this.manage(job); this.reason = 'Entry expired/paused before send'; return;
      }
      await this.fence();
      try { await this.exchange.place({ symbol, newClientOrderId: job.actions.e.id, ...job.actions.e.params }); }
      catch (e) {
        if (e.requestSent === false) {
          job.noOrderSent=true;job.closeReason='REQUEST_NOT_SENT';
          await this.manage(job);this.reason=e.message;return;
        }
        if (e instanceof ExchangeError && e.status < 500) { job.actions.e.rejected = true; await this.save(); }
      }
      await this.manage(job);
      this.lastError = null; this.reason = `${symbol} ${signal.direction}: ${job.phase}`;
      if (active(job)) await this.notify(`🤖 FUTURES AUTO ${this.cfg.environment.toUpperCase()}: ${symbol} ${signal.direction}\nFilled ${job.filledQty} · stop ${job.plan.stop} · ${momentum ? 'volatility trail; no fixed TP' : 'target '+job.plan.target+' (1.5R)'}\n/futuresauto`);
    } catch (e) { await this.failed(e); this.reason = e.message; }
    finally {
      recordDailyGate(this, 'execution', this.reason, symbol, { id: signal?.barCloseTime ?? signal?.breakoutTime ?? this.now(),
        outcome: /: (OPEN|RUNNER)$/.test(this.reason) ? 'accepted' : 'blocked' });
      this.lastEntryAttempt = { symbol, at: this.now(), reason: this.reason };
      this.scanReasons[symbol] = this.reason; this.busy = false;
    }
  }
}
