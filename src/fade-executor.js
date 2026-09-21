import { createHash, randomUUID } from 'node:crypto';
import { decimal, down, entryPlan, ExchangeError, exitPlan } from './fade-orders.js';
import { fadeBtcGate } from './fade-btc-gate.js';
import { escapeHtml } from './util.js';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const open = j => j.phase !== 'CLOSED';
const terminal = s => ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(s);
const truth = x => x === true || x === 'true';
const dollars = value => `$${Number(value).toFixed(2)}`;
const signedDollars = value => `${Number(value) >= 0 ? '+' : '-'}$${Math.abs(Number(value)).toFixed(2)}`;

export class FadeExecutor {
  constructor({ cfg, exchange, store, telegram, isPaused = () => false, authorizeEntry = async () => true,
    now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    Object.assign(this, { cfg, exchange, store, telegram, isPaused, authorizeEntry, now, wait });
    this.owner = randomUUID(); this.scope = `${cfg.fadeEnvironment ?? 'testnet'}:primary`;
    this.busy = false; this.stopped = false; this.timer = null; this.row = null;
    this.lastError = null; this.lastCheck = null; this.lastNotice = 0;
    this.lastAudit = -Infinity; this.auditError = null;
    this.balanceSnapshot = null; this.incomeSnapshot = null; this.lastIncomeAttempt = -Infinity;
    this.incomeInFlight = null; this.btcGate = null;
  }
  enabled() { return this.cfg.enableFadeExecution === true; }
  async notify(message) { try { await this.telegram.send(message); } catch { /* Orders remain monitored if Telegram fails. */ } }
  async ready() {
    if (!this.enabled()) throw Error('Fade execution disabled');
    if (this.cfg.fadeEnvironment === 'live' && this.cfg.fadeLiveAcknowledgement !== 'I_ACCEPT_LIVE_FADE_ORDERS') throw Error('Live activation acknowledgement missing');
    await this.exchange.syncTime();
    const row = await this.store.fadeLease(this.scope, this.owner);
    if (!Array.isArray(row.state?.jobs)) throw Error('Invalid fade runtime state');
    this.row = row;
  }
  async fence() {
    const row = await this.store.fadeLease(this.scope, this.owner);
    if (!this.row || row.revision !== this.row.revision) throw Error('Fade state changed; reconciliation required');
  }
  async save() {
    await this.fence();
    const state = this.row.state;
    const saved = await this.store.fadeSave(this.scope, this.owner, this.row.revision, state);
    this.row = { ...saved, state }; // Keep active job references attached during a cycle.
  }
  async mutate(action) { await this.fence(); return action(); }
  health() { return { enabled: this.enabled(), environment: this.cfg.fadeEnvironment ?? 'testnet',
    paused: this.row?.state.paused ?? true, active: this.row?.state.jobs.filter(open).length ?? 0,
    lastCheck: this.lastCheck, lastError: this.lastError, balance: this.balanceSnapshot }; }
  balanceReport() {
    const b = this.balanceSnapshot;
    if (!b) return '💰 FADE BALANCE\nBalance snapshot unavailable; worker is awaiting a verified Binance account read.';
    if (this.now() - b.updatedAt > 120000) return `💰 FADE BALANCE\nBalance snapshot stale since ${new Date(b.updatedAt).toISOString()}; check Binance directly.`;
    const baseline = Number(this.cfg.fadeStartBalanceUsdt ?? 100);
    const progress = b.equity - baseline;
    const pct = progress / baseline * 100;
    const flow = this.incomeSnapshot;
    return '💰 FADE BALANCE\n' +
      `Wallet ${dollars(b.wallet)} · Open PnL ${signedDollars(b.unrealized)} · Equity ${dollars(b.equity)}\n` +
      `Available ${dollars(b.available)} · Margin in use ${dollars(b.initialMargin)}\n` +
      `Progress vs ${dollars(baseline)}: ${signedDollars(progress)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n` +
      (flow
        ? `Last 7d: realized ${signedDollars(flow.realized)} · commission ${signedDollars(flow.commission)} · funding ${signedDollars(flow.funding)} · net ${signedDollars(flow.net)}\n`
        : 'Last 7d exchange flows: awaiting refresh\n') +
      `Balance updated: ${new Date(b.updatedAt).toISOString()}\n` +
      'Deposits or withdrawals change baseline progress.';
  }
  status() {
    const h = this.health();
    return `🤖 <b>FADE AUTO — ${escapeHtml(h.environment.toUpperCase())}</b>\n` +
      `${h.enabled ? h.paused ? 'Entries paused' : 'Enabled' : 'Disabled'} · ${h.active}/3 active intents\n` +
      `BTC entry gate: ${this.btcGate ? escapeHtml(this.btcGate.reason) + ' · last entry check ' + new Date(this.btcGate.checkedAt).toISOString() : 'awaiting entry check'}\n` +
      'Budget cap $250 · isolated 2x · max $150 notional each\n' +
      'Planned stop loss $5 · 75% exit targets approximately $3 net · 25% runner\n' +
      'Runner: fee-adjusted break-even, then 0.75% trailing stop\n' +
      (this.row?.state.jobs.filter(open).map(j => `${escapeHtml(j.symbol)} · ${escapeHtml(j.phase)}${j.plan ? ` · stop ${j.plan.stop} · partial target ${j.plan.target}` : ''}`).join('\n') ?? '') +
      `\n${this.balanceReport()}\n\nLast reconciliation: ${h.lastCheck ?? 'not completed'}\n${h.lastError ? '⚠️ ' + escapeHtml(h.lastError) : ''}\n` +
      '/fadepause stops new entries; protection continues. /fadecloseall closes bot-owned positions.\n' +
      'Realized profit/loss can differ due to fills, fees and funding.';
  }
  start() {
    if (!this.enabled() || this.timer) return;
    void this.run(); this.timer = setInterval(() => { void this.run(); }, 5000); this.timer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  async failed(error) {
    this.lastError = error.message;
    if (this.now() - this.lastNotice > 60000) {
      this.lastNotice = this.now(); await this.notify(`⚠️ FADE AUTO: ${escapeHtml(error.message)}\nNew entries withheld until reconciliation succeeds. Inspect /fadeauto and Binance.`);
    }
  }
  async run() {
    if (!this.enabled() || this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.ready(); await this.reconcile(this.now() - this.lastAudit >= 60000);
      // Reporting is optional and must never delay reconciliation, protection or heartbeats.
      void this.refreshIncome();
      this.lastError = null; this.lastCheck = new Date(this.now()).toISOString();
    }
    catch (e) { await this.failed(e); }
    finally { this.busy = false; }
  }
  async control(action) {
    if (!this.enabled()) return 'Fade execution is disabled on the worker.';
    if (this.busy) return 'Reconciliation is running; retry this command shortly.';
    this.busy = true;
    try {
      await this.ready();
      if (action === 'pause' || action === 'close') this.row.state.paused = true;
      if (action === 'resume') { await this.reconcile(); this.row.state.paused = false; }
      if (action === 'close') for (const j of this.row.state.jobs.filter(open)) j.closeRequested = true;
      await this.save();
      if (action === 'close') await this.reconcile();
      return this.status();
    } catch (e) { await this.failed(e); return `FADE AUTO: ${e.message}`; }
    finally { this.busy = false; }
  }
  async accountState() {
    const [mode, assets, permissions, account, positions, orders, algos] = await Promise.all([
      this.exchange.mode(), this.exchange.assetsMode(), this.exchange.accountPermissions(),
      this.exchange.account(), this.exchange.positions(), this.exchange.orders(), this.exchange.algos(),
    ]);
    if (mode.dualSidePosition !== false || assets.multiAssetsMargin !== false) throw Error('Fade execution requires One-way and Single-Asset mode; no account modes were changed');
    if (permissions.canTrade !== true) throw Error('Account trading is unavailable');
    if (!Array.isArray(account.assets) || !Array.isArray(positions) || !Array.isArray(orders) || !Array.isArray(algos)) throw Error('Account state unavailable');
    this.captureBalance(account);
    const active = positions.filter(p => Number(p.positionAmt) !== 0);
    if (active.some(p => !Number.isFinite(Number(p.positionAmt)))) throw Error('Invalid position quantities');
    return { account, positions: active, orders, algos };
  }
  captureBalance(account) {
    const usdt = account.assets?.find(a => a.asset === 'USDT');
    const wallet = Number(account.totalWalletBalance ?? usdt?.walletBalance);
    const unrealized = Number(account.totalUnrealizedProfit ?? usdt?.unrealizedProfit ?? 0);
    const equity = Number(account.totalMarginBalance ?? usdt?.marginBalance ?? wallet + unrealized);
    const available = Number(account.availableBalance ?? usdt?.availableBalance);
    const initialMargin = Number(account.totalInitialMargin ?? usdt?.initialMargin ?? 0);
    if ([wallet, unrealized, equity, available, initialMargin].every(Number.isFinite)) {
      this.balanceSnapshot = { wallet, unrealized, equity, available, initialMargin, updatedAt: this.now() };
    }
  }
  refreshIncome() {
    if (this.incomeInFlight || this.now() - this.lastIncomeAttempt < 300000) return this.incomeInFlight;
    this.lastIncomeAttempt = this.now();
    const pending = Promise.resolve().then(() => this.exchange.income()).then(rows => {
      if (!Array.isArray(rows)) throw Error('Income history unavailable');
      const sums = { REALIZED_PNL: 0, COMMISSION: 0, FUNDING_FEE: 0 };
      for (const row of rows) {
        if (row.asset !== 'USDT' || !(row.incomeType in sums)) continue;
        const amount = Number(row.income);
        if (!Number.isFinite(amount)) throw Error('Invalid income history amount');
        sums[row.incomeType] += amount;
      }
      this.incomeSnapshot = { realized: sums.REALIZED_PNL, commission: sums.COMMISSION,
        funding: sums.FUNDING_FEE, net: sums.REALIZED_PNL + sums.COMMISSION + sums.FUNDING_FEE,
        updatedAt: this.now() };
    }).catch(() => { /* Balance reporting must never interfere with execution or protection. */ })
      .finally(() => { if (this.incomeInFlight === pending) this.incomeInFlight = null; });
    this.incomeInFlight = pending;
    return pending;
  }
  ownsOrder(o, jobs) {
    const id = o.clientOrderId ?? o.clientAlgoId;
    return jobs.some(j => j.symbol === o.symbol && (Object.values(j.actions ?? {}).some(a => a.id === id)
      || (String(id).startsWith(`nf-${j.id}-z`) && o.side === 'BUY' && truth(o.reduceOnly))));
  }
  async reconcile(audit = true) {
    const jobs = this.row.state.jobs.filter(open);
    // Never adopt, cancel or close a manual/other-bot position.
    if (audit) {
      const snapshot = await this.accountState();
      this.auditError = snapshot.positions.some(p => !jobs.some(j => j.symbol === p.symbol))
        ? 'Unmanaged position detected; dedicated account required'
        : [...snapshot.orders, ...snapshot.algos].some(o => !this.ownsOrder(o, jobs))
          ? 'Unmanaged order detected; dedicated account required' : null;
      this.lastAudit = this.now();
    }
    let firstError = this.auditError ? Error(this.auditError) : null;
    for (const job of jobs) {
      try { await this.manage(job); }
      catch (e) { firstError ??= e; }
    }
    if (firstError) throw firstError;
  }
  async submit(job, key, kind, params) {
    let a = job.actions[key];
    let placed;
    if (!a) {
      a = job.actions[key] = { id: `nf-${job.id}-${key}`, kind, params, intendedAt: this.now() };
      await this.save(); // Intent durable BEFORE any exchange mutation.
      try {
        placed = await this.mutate(() => kind === 'stop'
          ? this.exchange.placeStop(job.symbol, a.id, params.triggerPrice)
          : this.exchange.place({ symbol: job.symbol, newClientOrderId: a.id, ...params }));
      } catch (e) {
        // A signed 4xx response is a definite rejection. Network/5xx failures
        // remain ambiguous and are reconciled by durable ID, never resubmitted.
        if (e instanceof ExchangeError && e.status < 500) throw e;
      }
    }
    let order = kind === 'stop' && placed ? placed : null;
    if (!order) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          order = kind === 'stop' ? await this.exchange.algo(a.id) : await this.exchange.order(job.symbol, a.id);
          break;
        } catch (e) {
          // Binance may briefly return NO_SUCH_ORDER while a newly accepted
          // conditional order becomes visible to its query endpoint.
          const recent = this.now() - a.intendedAt <= 10000;
          if (e?.code !== -2013 || !recent || attempt === 3) throw e;
          await this.wait(250 * (2 ** attempt));
        }
      }
    }
    if (!order || (kind === 'stop' ? order.clientAlgoId : order.clientOrderId) !== a.id || order.symbol !== job.symbol) throw Error('Exchange order identity mismatch');
    return order;
  }
  async position(job) {
    const positions = await this.exchange.positions();
    if (!Array.isArray(positions)) throw Error('Position snapshot missing');
    const p = positions.find(p => p.symbol === job.symbol && Number(p.positionAmt) !== 0);
    if (p && (p.positionSide !== 'BOTH' || !(Number(p.positionAmt) < 0))) throw Error('Unexpected position direction; manual inspection required');
    return p;
  }
  async cancelOwned(job, except = []) {
    const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
    for (const o of orders.filter(o => this.ownsOrder(o, [job]) && !except.includes(o.clientOrderId))) {
      await this.mutate(() => this.exchange.cancel(job.symbol, o.clientOrderId));
    }
    for (const o of algos.filter(o => this.ownsOrder(o, [job]) && !except.includes(o.clientAlgoId))) {
      await this.mutate(() => this.exchange.cancelStop(o.clientAlgoId));
    }
  }
  async close(job, reason) {
    job.closeRequested = true; job.closeReason = reason; await this.save();
    const p = await this.position(job); if (!p) return;
    const qty = Math.abs(Number(p.positionAmt));
    if (!(job.filledQty > 0) || qty > job.filledQty + 1e-8) throw Error('Cannot close unowned quantity');
    // Repeated reduce-only closes cannot open/reverse a position. Query each
    // attempted close before creating another after a terminal partial fill.
    const key = `x${Object.keys(job.actions).filter(k => k.startsWith('x')).length}`;
    const previous = Object.entries(job.actions).filter(([k]) => k.startsWith('x')).at(-1);
    if (previous) {
      let o;
      try { o = await this.exchange.order(job.symbol, previous[1].id); } catch { /* Fresh position plus reduce-only makes an exit retry safe. */ }
      if ((!o || !terminal(o.status)) && this.now() - previous[1].intendedAt < 10000) return;
    }
    await this.submit(job, key, 'order', { side: 'BUY', type: 'MARKET', reduceOnly: 'true', quantity: decimal(qty), newOrderRespType: 'RESULT' });
  }
  async emergencyFlatten(job) {
    // Last resort if persistence/lease fails after a verified entry fill but
    // before protection. Only REDUCE a freshly checked owned short.
    const p = await this.position(job); if (!p) return;
    const qty = Math.abs(Number(p.positionAmt));
    if (!(job.filledQty > 0) || qty > job.filledQty + 1e-8) throw Error('Emergency exit ownership not verified');
    await this.exchange.place({ symbol: job.symbol, positionSide: 'BOTH', side: 'BUY', type: 'MARKET',
      reduceOnly: 'true', quantity: decimal(qty), newClientOrderId: `nf-${job.id}-z${hash(randomUUID()).slice(0, 8)}`, newOrderRespType: 'RESULT' });
  }
  async ensureStop(job, price) {
    const key = 's' + hash(decimal(price)).slice(0, 8);
    const result = await this.submit(job, key, 'stop', { triggerPrice: price });
    if (result.algoStatus !== 'NEW' || result.side !== 'BUY' || !truth(result.closePosition)
      || Math.abs(Number(result.triggerPrice) - price) > job.plan.filters.tick / 2
      || (result.orderType ?? result.type) !== 'STOP_MARKET') throw Error('Protective stop not confirmed');
    job.stopId = job.actions[key].id; job.plan.stop = price;
    await this.save();
  }
  async manage(job) {
    const entry = await this.exchange.order(job.symbol, job.actions.e.id);
    if (entry.clientOrderId !== job.actions.e.id || entry.symbol !== job.symbol || entry.side !== 'SELL') throw Error('Entry identity mismatch');
    const filled = Number(entry.executedQty);
    if (!Number.isFinite(filled) || filled < 0) throw Error('Entry fill amount unknown');
    job.filledQty = filled;
    // A MARKET entry should settle immediately; any live remainder is canceled
    // before calculating protection for a partial fill.
    if (!terminal(entry.status)) {
      await this.mutate(() => this.exchange.cancel(job.symbol, job.actions.e.id));
      throw Error('Entry still settling; canceled unfilled remainder');
    }
    const p = await this.position(job);
    if (!p) {
      await this.cancelOwned(job);
      const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
      if ([...orders, ...algos].some(o => this.ownsOrder(o, [job]))) throw Error('Closed position still has pending orders');
      job.phase = 'CLOSED'; job.closedAt = this.now(); await this.save();
      await this.notify(`FADE AUTO ${escapeHtml(job.symbol)}: position flat; bot orders cleared. Check Binance realized PnL for fees/funding.`);
      return;
    }
    const qty = Math.abs(Number(p.positionAmt));
    if (!(filled > 0) || qty > filled + 1e-8) throw Error('Position size exceeds verified bot fill');
    const average = Number(entry.avgPrice);
    try {
      if (!(average > 0)) throw Error('Entry fill price unknown');
      if (!job.plan || job.plan.entry !== average || job.plan.qty !== filled) {
        job.plan = exitPlan(average, filled, job.fee, job.filters); await this.save();
      }
      if (job.closeRequested) { await this.close(job, job.closeReason ?? 'OWNER_CLOSE'); return; }
      const book = await this.exchange.book(job.symbol);
      const ask = Number(book.askPrice);
      if (!(ask > 0)) throw Error('Exit quote unavailable');
      if (ask >= job.plan.stop) { await this.close(job, 'STOP_PRICE_REACHED'); return; }
      // Install protection first. Profit booking never takes precedence over SL.
      await this.ensureStop(job, job.plan.stop);
      const tp = await this.submit(job, 'tp', 'order', { side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
        reduceOnly: 'true', quantity: decimal(job.plan.partial), price: decimal(job.plan.target) });
      if (tp.side !== 'BUY' || !truth(tp.reduceOnly) || Number(tp.origQty) !== job.plan.partial) throw Error('Profit order not confirmed');
      const partialFilled = Number(tp.executedQty);
      if (!Number.isFinite(partialFilled) || partialFilled < 0) throw Error('Partial fill amount unknown');
      if (terminal(tp.status) && tp.status !== 'FILLED') throw Error('Profit order canceled/rejected; closing remaining position');
      const current = await this.position(job);
      if (!current) return; // Native exit filled while we queried; next cycle clears residual orders.
      if (Math.abs(Math.abs(Number(current.positionAmt)) - (filled - partialFilled)) > job.filters.step / 2) throw Error('Position changed outside bot orders');
      if (tp.status === 'FILLED') {
        job.phase = 'RUNNER';
        job.lowAsk = Math.min(job.lowAsk ?? ask, ask);
        const nextStop = down(Math.min(job.plan.stop, job.plan.breakEven, job.lowAsk * 1.0075), job.filters.tick);
        if (ask >= nextStop) { await this.close(job, 'RUNNER_STOP_REACHED'); return; }
        if (nextStop < job.plan.stop - job.filters.tick / 2) await this.ensureStop(job, nextStop);
      } else job.phase = 'OPEN';
      // New stop is verified before previous stops are canceled; reduce-only
      // TP and close-all BUY stop cannot reverse the position if they race.
      await this.cancelOwned(job, [job.stopId, job.actions.tp.id]); await this.save();
    } catch (e) {
      // Failed protection or changed exit state: request an immediate flatten.
      try { await this.close(job, 'PROTECTION_FAILURE'); }
      catch { await this.emergencyFlatten(job); }
      throw Error(`Protection/reconciliation issue on ${job.symbol}; emergency close requested: ${e.message}`);
    }
  }
  async checkBtcGate() {
    try {
      const [rows, book] = await Promise.all([this.exchange.btcCandles(), this.exchange.book('BTCUSDT')]);
      this.btcGate = fadeBtcGate(rows, book, this.now());
    } catch {
      this.btcGate = { allowed: false, reason: 'BTC data unavailable; short gate closed', checkedAt: this.now() };
    }
    return this.btcGate.allowed;
  }
  async onSignal(symbol, signal) {
    if (!this.enabled() || this.busy || this.stopped || this.isPaused()) return;
    this.busy = true;
    try {
      if (!await this.authorizeEntry()) return;
      await this.ready(); await this.reconcile();
      if (this.row.state.paused) return;
      if (!await this.checkBtcGate()) return;
      const jobs = this.row.state.jobs;
      if (jobs.filter(open).length >= 3 || jobs.some(j => j.symbol === symbol && (open(j) || this.now() - j.closedAt < 1800000))) return;
      const id = hash(`${this.scope}:${symbol}:${signal.peakTime}`);
      if (jobs.some(j => j.id === id)) return;
      let snapshot = await this.accountState();
      if (snapshot.positions.length >= 3) return;
      const usdt = snapshot.account.assets?.find(a => a.asset === 'USDT');
      if (!usdt || !(Number(usdt.availableBalance) > 10)) throw Error('Insufficient USDT balance');
      const totalNotional = snapshot.positions.reduce((s, p) => s + Math.abs(Number(p.notional)), 0);
      if (!Number.isFinite(totalNotional) || totalNotional + 150 > 450.01) throw Error('Fade notional budget exhausted');
      const info = (await this.exchange.info()).symbols.find(s => s.symbol === symbol);
      if (!info || info.status !== 'TRADING' || info.quoteAsset !== 'USDT' || info.contractType !== 'PERPETUAL') throw Error('Contract unavailable for execution');
      const rates = await this.exchange.fees(symbol);
      const fee = Math.max(Number(rates.takerCommissionRate), Number(rates.makerCommissionRate), 0);
      if (!Number.isFinite(fee) || fee > 0.01) throw Error('Commission rate unavailable');
      await this.mutate(() => this.exchange.isolate(symbol));
      snapshot = await this.accountState();
      if (snapshot.positions.some(p => p.symbol === symbol)) throw Error('Symbol already has a position');
      const book = await this.exchange.book(symbol), quoteAt = this.now();
      const plan = entryPlan({ signal, bid: Number(book.bidPrice), ask: Number(book.askPrice), info, fee,
        available: Number(snapshot.account.assets.find(a => a.asset === 'USDT')?.availableBalance), now: this.now() });
      const job = { id, symbol, phase: 'SUBMITTING', signal, fee, filters: plan.filters, createdAt: this.now(), actions: {}, plan };
      jobs.push(job);
      // The journal is persisted inside submit before the signed entry request.
      const originalPlace = this.exchange.place.bind(this.exchange);
      // Freshness check is local to this entry, without replacing the client.
      job.actions.e = { id: `nf-${id}-e`, kind: 'order', intendedAt: this.now(),
        params: { side: 'SELL', type: 'MARKET', quantity: decimal(plan.qty), newOrderRespType: 'RESULT' } };
      await this.save();
      await this.fence();
      let authorized;
      try { authorized = await this.authorizeEntry() && await this.checkBtcGate(); }
      catch {
        job.phase = 'CLOSED'; job.closedAt = this.now(); job.closeReason = 'CONTROL_UNAVAILABLE_BEFORE_SEND';
        await this.save();
        throw Error('Control unavailable before entry; no order sent');
      }
      await this.fence();
      if (!authorized || this.stopped || this.isPaused() || this.now() - quoteAt > 5000 || this.now() - signal.barCloseTime > 90000) {
        job.phase = 'CLOSED'; job.closedAt = this.now(); job.closeReason = 'ENTRY_EXPIRED_BEFORE_SEND'; await this.save(); return;
      }
      try { await originalPlace({ symbol, positionSide: 'BOTH', newClientOrderId: job.actions.e.id, ...job.actions.e.params }); }
      catch { /* Ambiguous writes only reconcile by ID. */ }
      await this.manage(job);
      if (open(job)) await this.notify(`🤖 FADE AUTO ${escapeHtml(this.cfg.fadeEnvironment.toUpperCase())}: ${escapeHtml(symbol)} SHORT\nFilled ${job.filledQty} · ${escapeHtml(job.phase)}\n/fadeauto`);
      this.lastError = null;
    } catch (e) { await this.failed(e); }
    finally { this.busy = false; }
  }
}
