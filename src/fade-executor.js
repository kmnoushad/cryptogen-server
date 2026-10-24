import { configuredNightBlock, fadeNightBlocked } from './fade-night-block.js';
import { STRUCTURE_VERSION, insideGap, reentryDecision, protectiveStop, classifyStructuralExit } from './structure-policy.js';
import { closedSeries, trendDirection } from './futures-auto-strategy.js';
import { detectStructure } from './structure-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { nativeStopCovers, cancelWithAbsenceProof } from './native-stop-proof.js';
import { decimal, down, entryPlan, fadeDepthGate, ExchangeError, FadeEntrySkipped, exitPlan, structuralFadeStop } from './fade-orders.js';
import { fadeBtcGate, fadeSpikeBtcGate } from './fade-btc-gate.js';
import { fadeAdverseQuote, fadeAdverseEntryBlocked } from './fade-adverse.js';
import { FadeEventGate, fadePositioningGate } from './fade-entry-gates.js';
import { fadeRiskDecision, gstDayStart, readFadeIncome, readFadeRisk, weeklyLockSummary } from './fade-risk.js';
import { formatRiskStatus, newerRiskStatus } from './risk-status.js';
import { dailyGateState, loadDailyGates, recordDailyGate, formatDailyGates } from './daily-gates.js';
import { escapeHtml } from './util.js';
import { entryQuality } from './entry-quality.js';
import { definiteOrderRejection, rejectionDelay, safeFault } from './fade-order-state.js';
import { archiveCandidate, archiveJob, jobDigest } from './fade-job-archive.js';
import { FadeEntryPreparation } from './fade-entry-preparation.js';

const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const open = j => j.phase !== 'CLOSED';
class MissingProtection extends Error {}
const terminal = s => ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'REJECTED'].includes(s);
const truth = x => x === true || x === 'true';
const dollars = value => `$${Number(value).toFixed(2)}`;
const signedDollars = value => `${Number(value) >= 0 ? '+' : '-'}$${Math.abs(Number(value)).toFixed(2)}`;

export class FadeExecutor {
  constructor({ cfg, exchange, store, telegram, isPaused = () => false, authorizeEntry = async () => true,
    now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), eventGate = null }) {
    Object.assign(this, { cfg, exchange, store, telegram, isPaused, authorizeEntry, now, wait });
    this.owner = randomUUID(); this.scope = `${cfg.fadeEnvironment ?? 'testnet'}:primary`;
    this.busy = false; this.stopped = false; this.timer = null; this.row = null;
    this.lastError = null; this.lastCheck = null; this.lastNotice = 0;
    this.lastAudit = -Infinity; this.auditError = null;
    this.balanceSnapshot = null; this.incomeSnapshot = null; this.lastIncomeAttempt = -Infinity;
    this.incomeInFlight = null; this.btcGate = null; this.lastRiskNotice = null;
    this.eventGate = eventGate ?? new FadeEventGate({ cfg, now });
    this.preparation = cfg.fadeEntrySource === 'spike' ? new FadeEntryPreparation({ exchange, eventGate: this.eventGate, now }) : null;
    this.safetyTimings = {};
    this.entrySafety = { allowed: false, reason: 'Entry safety awaiting verification' };
  }
  enabled() { return this.cfg.enableFadeExecution === true; }
  async notify(message) {
    // Delivery is informational. Never hold the protection loop on Telegram retries.
    void Promise.resolve().then(() => this.telegram.send(message)).catch(() => {});
  }
  async ready() {
    if (!this.enabled()) throw Error('Fade execution disabled');
    if (this.cfg.fadeEnvironment === 'live' && this.cfg.fadeLiveAcknowledgement !== 'I_ACCEPT_LIVE_FADE_ORDERS') throw Error('Live activation acknowledgement missing');
    await loadDailyGates(this);
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
    dailyGateState(this);
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
      (flow && this.now() - flow.updatedAt <= 900000
        ? `Last 7d: realized ${signedDollars(flow.realized)} · commission ${signedDollars(flow.commission)} · funding ${signedDollars(flow.funding)} · net ${signedDollars(flow.net)}\n`
        : 'Last 7d exchange flows: awaiting refresh\n') +
      `Balance updated: ${new Date(b.updatedAt).toISOString()}\n` +
      'Deposits or withdrawals change baseline progress.';
  }
  status() {
    const h = this.health();
    return `🤖 <b>FADE AUTO — ${escapeHtml(h.environment.toUpperCase())}</b>\n` +
      `${h.enabled ? h.paused ? 'Entries paused' : 'Enabled' : 'Disabled'} · ${h.active}/3 active intents\n` +
      `Entry source: ${this.cfg.fadeEntrySource ?? 'legacy'}${this.spikeHealth ? ' · ' + escapeHtml(this.spikeHealth()) : ''}\n` +
      `BTC entry gate: ${this.btcGate ? escapeHtml(this.btcGate.reason) + ' · last entry check ' + new Date(this.btcGate.checkedAt).toISOString() : 'awaiting entry check'}\n` +
      `Last entry safety result: ${escapeHtml(this.entrySafety.reason)} · checked ${Number.isFinite(this.entrySafetyCheckedAt) ? new Date(this.entrySafetyCheckedAt).toISOString() : 'not checked since restart'}\n` +
      formatRiskStatus(this.riskStatus, this.now()) + formatDailyGates(this) +
      (this.lastEntryAttempt ? `Last execution check: ${escapeHtml(this.lastEntryAttempt.symbol)} · ${escapeHtml(this.lastEntryAttempt.reason)} · ${new Date(this.lastEntryAttempt.at).toISOString()}\n` : '') +
      (this.lastEntryAttempt?.timings ? `Entry timing: ${this.lastEntryAttempt.elapsedMs}ms total · send age ${this.lastEntryAttempt.sentSignalAgeMs ?? 'not sent'}${this.lastEntryAttempt.sentSignalAgeMs === null ? '' : 'ms'} · ${Object.entries(this.lastEntryAttempt.timings).map(([k,v]) => `${k} ${v}ms`).join(', ')}\n` : '') +
      (this.lastEntryAttempt?.timings ? `Safety reads: ${Object.entries(this.safetyTimings).map(([k,v]) => `${k} ${v}ms`).join(', ')}\n` : '') +
      'Entry: price-capped FOK · fresh bid depth ≥2× size\n' +
      'Entry quality: modeled costs ≤25% of stop risk · no chasing\n' +
      `Fade setup gate: ${fadeAdverseEntryBlocked(this.row?.state.jobs ?? [], this.now()) ? 'HOLD — active short near planned stop' : 'clear'}\n` +
      'New entries: isolated 2x · max $150 notional · 0.5% equity modeled stop risk\n' +
      'Daily 2% loss/giveback lock (GST reset) · three-loss cooldown 2h · ' + weeklyLockSummary() + '\n' +
      'New entries: 75% exit targets ≥1.5R modeled net · 25% runner\n' +
      'New structure trades: BE +0.5R, 0.25R ratchet from +1R · runner 0.5 ATR; legacy +1R/0.75%\n' +
      (this.row?.state.jobs.filter(open).map(j => {
        const near = j.lastQuoteAt && this.now() - j.lastQuoteAt < 60000
          ? fadeAdverseQuote(j, j.lastObservedAsk) : null;
        return `${escapeHtml(j.symbol)} · ${escapeHtml(j.phase)}${j.plan ? ` · stop ${j.plan.stop} · partial target ${j.plan.target}` : ''}` +
          (near?.state === 'NEAR_STOP' ? ` · ⚠️ ask ${j.lastObservedAsk} near stop (${(near.used * 100).toFixed(0)}% of entry-to-stop distance)` : '');
      }).join('\n') ?? '') +
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
    recordDailyGate(this, 'infrastructure', error.message, '', { id: Math.floor(this.now()/60000), outcome: 'error' });
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
      await this.maintainArchive();
      this.lastError = null; this.lastCheck = new Date(this.now()).toISOString();
    }
    catch (e) { await this.failed(e); }
    finally { this.busy = false; }
  }
  async maintainArchive() {
    // Fade only. Futures has its own journal and audit implementation.
    if (!this.scope.endsWith(':primary') || !this.store.insertEvent || !this.store.get
      || this.row.state.jobs.some(open)) return;
    if (this.archiveReady) {
      const proof = this.archiveReady;
      const job = this.row.state.jobs.find(j => j.id === proof.id);
      if (job && archiveCandidate(this.row.state.jobs, this.now())?.id === job.id && jobDigest(job) === proof.digest) {
        const before = this.row.state.jobs;
        this.row.state.jobs = before.filter(j => j !== job);
        try { await this.save(); }
        catch (e) { this.row.state.jobs = before; throw e; }
      }
      this.archiveReady = null;
    }
    if (this.archiveInFlight || this.now() - (this.archiveAttemptAt ?? -Infinity) < 60000) return;
    const job = archiveCandidate(this.row.state.jobs, this.now());
    if (!job) return;
    this.archiveAttemptAt = this.now();
    // Archive I/O never holds the protection cycle. Only its later fenced
    // acknowledgement can prune the live journal, one closed job per minute.
    this.archiveInFlight = archiveJob(this.store, this.scope, job)
      .then(proof => { this.archiveReady = proof; })
      .catch(() => { console.error('Fade archive deferred; runtime history retained'); })
      .finally(() => { this.archiveInFlight = null; });
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
    const capturedAt = this.now();
    const pending = Promise.resolve().then(() => readFadeIncome(this.exchange, capturedAt - 7 * 86400000, capturedAt))
      .then(async rows => {
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
      // Optional background observation: never delay native stop reconciliation.
      // Signal-time checks still read fresh risk data immediately before orders.
      const b = this.balanceSnapshot;
      if (b && capturedAt - b.updatedAt <= 120000 && this.row?.state?.jobs) {
        const decision = fadeRiskDecision({ rows, jobs: this.row.state.jobs, equity: b.equity, now: capturedAt });
        this.riskStatus = newerRiskStatus(this.riskStatus, { ...decision, checkedAt: capturedAt });
        if (decision.allowed && /^Rolling seven-day/.test(this.entrySafety.reason)) {
          this.entrySafety = { allowed: false, reason: 'Timed risk limits clear; awaiting signal-specific checks' };
        }
        if (!decision.allowed && /^(Daily net loss|Rolling seven-day|Daily realized profit giveback|Three consecutive losses)/.test(decision.reason)) {
          this.entrySafety = decision;
          this.entrySafetyCheckedAt = capturedAt;
          const key = `${gstDayStart(capturedAt)}:${decision.reason}`;
          if (key !== this.lastRiskNotice) {
            this.lastRiskNotice = key;
            await this.notify(`⚠️ FADE AUTO: ${escapeHtml(decision.reason)}. New entries blocked; existing position protection continues. /fadeauto`);
          }
        }
      }
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
  async reconcile(audit = true, entrySnapshot = null) {
    let auditSnapshot;
    const jobs = this.row.state.jobs.filter(open);
    // Never adopt, cancel or close a manual/other-bot position.
    if (audit) {
      const snapshot = auditSnapshot = entrySnapshot ?? await this.accountState();
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
    // With no bot jobs, reconciliation made no exchange writes. Reuse its
    // just-verified account snapshot in this same entry attempt, never across polls.
    return jobs.length === 0 ? auditSnapshot : undefined;
  }
  async initialProtection(job) {
    const a = job.actions[job.initialStopKey];
    if (!a || a.kind !== 'stop' || !(job.filledQty > 0)) throw Error('Initial protection intent unavailable');
    let stop;
    // Same-process entry proceeds straight to protection. Restart first looks
    // up its durable ID; only a definite absence permits the close-only POST.
    if (!this.initialPermits?.delete(job.id)) {
      try { stop = await this.exchange.algo(a.id); }
      catch (e) { if (e.code !== -2013) throw e; }
    }
    if (!stop) {
      try { stop = await this.exchange.placeStop(job.symbol, a.id, a.params.triggerPrice); }
      catch (e) {
        if (definiteOrderRejection(e)) { a.state='REJECTED'; a.rejection={code:e.code,at:this.now()}; throw e; }
        stop = await this.exchange.algo(a.id); // Never assume a lost acknowledgement failed.
      }
    }
    if (stop?.clientAlgoId !== a.id || stop.symbol !== job.symbol || stop.algoStatus !== 'NEW'
      || stop.side !== 'BUY' || !truth(stop.closePosition) || (stop.orderType ?? stop.type) !== 'STOP_MARKET'
      || (stop.positionSide && stop.positionSide !== 'BOTH')
      || !Number.isFinite(Number(stop.triggerPrice))
      || Math.abs(Number(stop.triggerPrice)-a.params.triggerPrice)>job.filters.tick/2)
      throw new MissingProtection('Initial native stop not confirmed');
    a.state='ACCEPTED'; job.stopId=a.id;
  }
  async recoverAbsentEntry(job) {
    const since = Number(job.actions.e.intendedAt ?? job.createdAt), now=this.now();
    if (!Number.isFinite(since) || now-since<60000) return null;
    if (now-since>=7*86400000-5000) throw Error('Unresolved entry is outside complete seven-day history; operator reconciliation required');
    if (!this.exchange.allOrders || !this.exchange.trades) return null;
    if (now-(job.absenceProof?.at ?? 0)<5000) return null;
    const [positions,orders,algos,history,trades] = await Promise.all([
      this.exchange.positions(),this.exchange.orders(job.symbol),this.exchange.algos(job.symbol),
      this.exchange.allOrders(job.symbol,since-5000,now),this.exchange.trades(job.symbol,since-5000,now)]);
    if (![positions,orders,algos,history,trades].every(Array.isArray) || history.length>=1000 || trades.length>=1000)
      throw Error('Entry reconciliation history incomplete');
    const found=history.find(o=>o.clientOrderId===job.actions.e.id && o.symbol===job.symbol);
    if (found) return found;
    if (positions.some(p=>p.symbol===job.symbol && (!Number.isFinite(Number(p.positionAmt)) || Number(p.positionAmt)!==0))
      || [...orders,...algos].some(o=>o.symbol===job.symbol) || trades.length) {
      job.absenceProof=null; await this.save();
      throw Error('Entry absence cannot be confirmed from exchange position/order/fill history');
    }
    const previous=job.absenceProof;
    job.absenceProof={at:now,count:(previous?.count??0)+1,firstAt:previous?.firstAt??now,
      evidence:'order -2013; flat; no open ordinary/algo orders; complete order/fill window empty for this entry'};
    if(job.absenceProof.count>=3 && now-job.absenceProof.firstAt>=10000) {
      job.phase='CLOSED';job.closedAt=now;job.filledQty=0;job.closeReason='ENTRY_ABSENCE_RECONCILED';
    }
    await this.save(); return job.phase==='CLOSED' ? 'CLOSED' : null;
  }
  async recoverAbsentExit(job, a, kind) {
    const now=this.now(), since=Number(a.intendedAt);
    if (!Number.isFinite(since) || now-since<60000 || now-since>=7*86400000-5000
      || now-(a.absenceProof?.at??0)<5000 || a.id===job.stopId) return null;
    if (!this.exchange.allOrders || !this.exchange.algoHistory || !this.exchange.trades) return null;
    const [position,orders,algos,history,trades]=await Promise.all([
      this.position(job),this.exchange.orders(job.symbol),this.exchange.algos(job.symbol),
      kind==='stop'?this.exchange.algoHistory(job.symbol,since-5000,now):this.exchange.allOrders(job.symbol,since-5000,now),
      this.exchange.trades(job.symbol,since-5000,now)]);
    if (![orders,algos,history,trades].every(Array.isArray) || history.length>=1000 || trades.length>=1000)
      throw Error('Exit reconciliation history incomplete');
    const found=history.find(o=>(kind==='stop'?o.clientAlgoId:o.clientOrderId)===a.id && o.symbol===job.symbol);
    if(found)return found;
    const qty=Math.abs(Number(position?.positionAmt));
    if (!position || !(qty>0 && qty<=job.filledQty+1e-8)
      || [...orders,...algos].some(o=>(o.clientOrderId??o.clientAlgoId)===a.id)
      || trades.some(t=>t.side!=='SELL')) {
      a.absenceProof=null;await this.save();return null;
    }
    const proof=a.absenceProof;
    a.absenceProof={at:now,count:(proof?.count??0)+1,firstAt:proof?.firstAt??now};
    if(a.absenceProof.count>=3 && now-a.absenceProof.firstAt>=10000){
      a.state='REJECTED';a.rejection={code:'ABSENCE_RECONCILED',at:now};a.retryAt=now;
    }
    await this.save();return null;
  }
  async submit(job, key, kind, params) {
    let a = job.actions[key];
    let placed;
    if (a?.state === 'REJECTED') {
      if (this.now() < a.retryAt) throw Error(`Exit repair backoff: ${key}`);
      if ((a.attempt ?? 0) >= 2) { const e=Error(`Exit repair exhausted: ${key}`);e.mustExit=true;throw e; }
      // Revalidate against current owned exposure and quote before retrying a
      // definitely rejected exit. Unknown submissions never enter this path.
      const [position,book] = await Promise.all([this.position(job),this.exchange.book(job.symbol)]);
      const qty=Math.abs(Number(position?.positionAmt)), ask=Number(book.askPrice);
      if (!position || !(qty>0 && qty<=job.filledQty+1e-8 && ask>0)) throw Error('Exit repair awaits verified position/quote');
      if (kind==='stop' && ask>=Number(params.triggerPrice)) {
        const e=Error('Requested protective stop already crossed during repair');e.mustExit=true;throw e;
      }
      if (kind==='order' && Number(params.quantity)>qty+job.filters.step/2) throw Error('Exit repair quantity changed; reconcile fills first');
      const prior=a, attempt=(a.attempt??0)+1;
      job.actions[`${key}_rejected${attempt}`]=prior;
      a=job.actions[key]={id:`nf-${job.id}-${key}r${attempt}`,kind,params,intendedAt:this.now(),attempt,state:'PREPARED'};
      await this.save();
    }
    if (!a) {
      a = job.actions[key] = { id: `nf-${job.id}-${key}`, kind, params, intendedAt: this.now(), state:'PREPARED',attempt:0 };
      await this.save(); // Intent durable BEFORE any exchange mutation.
    }
    // Newly prepared exit intents are safe to send here. Accepted/unknown
    // intents are lookup-only. A restart of PREPARED first resolves by ID.
    if (a.state === 'PREPARED') {
      try {
        const existing=kind==='stop' ? await this.exchange.algo(a.id) : await this.exchange.order(job.symbol,a.id);
        if (existing) { a.state='ACCEPTED'; placed=existing; }
      } catch(e) { if (e.code !== -2013) throw e; }
      if (!placed) {
        // Exit is reduce-only / close-position and scoped to a verified fill.
        // Fence before writing; a lease outage retains any earlier native stop.
        try {
          a.state='UNKNOWN'; await this.save();
          placed = await this.mutate(() => kind === 'stop'
            ? this.exchange.placeStop(job.symbol, a.id, a.params.triggerPrice, a.params.quantity)
            : this.exchange.place({ symbol: job.symbol, newClientOrderId: a.id, ...params }));
          a.state='ACCEPTED';
        } catch(e) {
          if (definiteOrderRejection(e)) {
            a.state='REJECTED';a.rejection={code:e.code,status:e.status,at:this.now()};a.retryAt=this.now()+rejectionDelay(e);
            // Never lose a definite rejection merely because later reads fail.
            try { await this.save(); } catch { /* Native stop policy handles persistence failure. */ }
            throw e;
          }
        }
      }
    }
    let order = placed ?? null;
    if (!order) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          order = kind === 'stop' ? await this.exchange.algo(a.id) : await this.exchange.order(job.symbol, a.id);
          break;
        } catch (e) {
          // Binance may briefly return NO_SUCH_ORDER while a newly accepted
          // conditional order becomes visible to its query endpoint.
          const recent = this.now() - a.intendedAt <= 10000;
          if (e?.code !== -2013 || !recent || attempt === 3) {
            if(e?.code===-2013) order=await this.recoverAbsentExit(job,a,kind);
            if(order)break;throw e;
          }
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
      await cancelWithAbsenceProof(() => this.mutate(() => this.exchange.cancel(job.symbol, o.clientOrderId)),
        () => this.exchange.order(job.symbol, o.clientOrderId));
    }
    for (const o of algos.filter(o => this.ownsOrder(o, [job]) && !except.includes(o.clientAlgoId))) {
      await cancelWithAbsenceProof(() => this.mutate(() => this.exchange.cancelStop(o.clientAlgoId)),
        () => this.exchange.algo(o.clientAlgoId));
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
    const existing = Object.entries(job.actions).find(([,a]) => a.id === job.stopId && a.kind === 'stop' && Number(a.params.triggerPrice) === price);
    const position = await this.position(job), quantity = Math.abs(Number(position?.positionAmt));
    if (!(quantity > 0 && quantity <= job.filledQty + 1e-8)) throw Error('Stop awaits verified owned position');
    const replacement = !!job.stopId && !existing;
    const key = existing?.[0] ?? ((replacement ? 'r' : 's') + hash(decimal(price)).slice(0,8));
    const params = existing?.[1].params ?? { triggerPrice: price, ...(replacement ? { quantity: decimal(quantity), reduceOnly: 'true' } : {}) };
    let result;
    try {
      result = await this.submit(job, key, 'stop', params);
      if (['REJECTED','CANCELED','EXPIRED'].includes(result.algoStatus) && job.actions[key].id !== job.stopId) {
        const action=job.actions[key];action.state='REJECTED';
        action.rejection={code:result.algoStatus,at:this.now()};action.retryAt=this.now()+5000;
        try { await this.save(); } catch { /* Retain prior native stop; retry journal later. */ }
      }
      if (!nativeStopCovers(result, job.actions[key], { symbol: job.symbol, side: 'BUY', quantity,
        price, tick: job.filters.tick, step: job.filters.step })) throw new MissingProtection('Protective stop not confirmed');
    } catch (e) { e.stopQueryId = job.actions[key]?.id; throw e; }
    const changed = job.stopId !== job.actions[key].id || job.plan.stop !== price;
    job.stopId = job.actions[key].id; job.plan.stop = price;
    if (changed) await this.save();
  }
  async consistentPartial(job, first, filled) {
    let tp = first;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tp.clientOrderId !== job.actions.tp.id || tp.symbol !== job.symbol || tp.side !== 'BUY'
        || !truth(tp.reduceOnly) || Number(tp.origQty) !== job.plan.partial)
        throw Error('Profit order not confirmed');
      const partialFilled = Number(tp.executedQty);
      if (!Number.isFinite(partialFilled) || partialFilled < 0 || partialFilled > job.plan.partial + 1e-8)
        throw Error('Partial fill amount unknown');
      if (terminal(tp.status) && tp.status !== 'FILLED') {
        if (partialFilled===0) {
          const action=job.actions.tp;
          action.state='REJECTED';action.rejection={code:tp.status,at:this.now()};action.retryAt=this.now()+5000;
          await this.save();
          throw Error('Zero-fill profit order terminated; bounded replacement scheduled');
        }
        // A terminal partially filled target needs different remaining sizing.
        // Do not loop or submit the original quantity again. Exit owned residual.
        const e=Error('Partially filled target terminated; close owned residual');e.mustExit=true;throw e;
      }
      const current = await this.position(job);
      if (!current) return null;
      if (Math.abs(Number(current.positionAmt)) > filled + 1e-8) throw Error('Position size exceeds verified bot fill');
      if (Math.abs(Math.abs(Number(current.positionAmt)) - (filled - partialFilled)) <= job.filters.step / 2)
        return { tp, partialFilled };
      // Order and position endpoints are not an atomic snapshot. Refresh the
      // order after observing a changed position; never POST another target.
      if (attempt < 2) tp = await this.exchange.order(job.symbol, job.actions.tp.id);
    }
    throw Error('Position/target snapshots not yet consistent; reconciliation required');
  }
  async retainNativeStop(job, error) {
    if (!job.stopId || !job.plan) return false;
    if (error.stopQueryId === job.stopId && (error instanceof MissingProtection || error.code === -2013)) return false;
    const action = Object.values(job.actions).find(a => a.id === job.stopId && a.kind === 'stop');
    if (!action || !(Number(action.params.triggerPrice) > 0)) return false;
    let stop;
    try { stop = await this.exchange.algo(job.stopId); }
    catch (e) {
      if (e.code === -2013) return false; // Explicitly missing, not a monitoring timeout.
      // Previously verified native stop: uncertain reads block entries, not a
      // blind market exit. Retry its verification on the next protection cycle.
      job.monitoringFault = { at: this.now(), reason: safeFault(error), stop: 'verification unavailable' };
      return true;
    }
    const price = Number(stop?.triggerPrice);
    const position = await this.position(job), quantity = Math.abs(Number(position?.positionAmt));
    if (!(quantity > 0 && quantity <= job.filledQty + 1e-8) || !nativeStopCovers(stop, action,
      { symbol: job.symbol, side: 'BUY', quantity, price: Number(action.params.triggerPrice), tick: job.filters.tick, step: job.filters.step })
      || price > (job.structuralStop ?? structuralFadeStop(job.signal.resistance, job.filters)) + job.filters.tick / 2) return false;
    job.monitoringFault = { at: this.now(), reason: safeFault(error), stop: 'native stop verified' };
    return true;
  }
  async manage(job, confirmedEntry = null) {
    if (job.entryDispatch === 'PREPARED') {
      // This state is durable before dispatch is armed. No entry POST is legal
      // until SENDING has been persisted, so a restart here can safely retire it.
      job.phase = 'CLOSED'; job.closedAt = this.now(); job.filledQty = 0;
      job.closeReason = 'UNSENT_ENTRY_RECOVERED'; await this.save(); return;
    }
    if (job.entryDispatch === 'REJECTED') {
      job.phase = 'CLOSED'; job.closedAt ??= this.now(); job.filledQty = 0;
      job.closeReason = 'ENTRY_REJECTED'; await this.save(); return;
    }
    let entry = confirmedEntry;
    if (!entry) {
      try { entry = await this.exchange.order(job.symbol, job.actions.e.id); }
      catch (e) {
        if (e.code === -2013 && !(job.filledQty > 0)) {
          const recovered = await this.recoverAbsentEntry(job);
          if (recovered === 'CLOSED') return;
          if (recovered) entry = recovered;
        }
        if (!entry) throw e;
      }
    }
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
      job.structuralStopExit = await classifyStructuralExit(this.exchange, job);
      await this.cancelOwned(job);
      const [orders, algos] = await Promise.all([this.exchange.orders(job.symbol), this.exchange.algos(job.symbol)]);
      if ([...orders, ...algos].some(o => this.ownsOrder(o, [job]))) throw Error('Closed position still has pending orders');
      job.phase = 'CLOSED'; job.closedAt = this.now(); await this.save();
      await this.notify(`FADE AUTO ${escapeHtml(job.symbol)}: position flat; bot orders cleared. Check Binance realized PnL for fees/funding.`);
      return;
    }
    const qty = Math.abs(Number(p.positionAmt));
    if (!(filled > 0) || qty > filled + 1e-8) throw Error('Position size exceeds verified bot fill');
    let monitoring = false, initialConfirmed = false;
    try {
      if (!job.stopId && job.initialStopKey) {
        // Initial protection is a close-position order against the verified
        // owned fill, with its ID/price already durable before entry. Like
        // emergencyFlatten, it must not wait for database recovery.
        await this.initialProtection(job);
        initialConfirmed = true; monitoring = true;
      }
      // Keep a verified native stop active while Binance fill history catches up.
      monitoring = !!job.stopId;
      const average = await this.entryAverage(job, entry, filled);
      if (!job.plan || job.plan.entry !== average || job.plan.qty !== filled || !(job.plan.riskDollars > 0)) {
        // Preserve the structural invalidation across partial fills/restarts.
        // Legacy jobs with wider stops tighten to below resistance before proceeding.
        const stop = Math.min(job.plan?.stop ?? Infinity, job.structuralStop ?? structuralFadeStop(job.signal.resistance, job.filters));
        monitoring = false;
        job.plan = exitPlan(average, filled, job.fee, job.filters, stop);
        if (Number.isFinite(job.riskBudget) && job.plan.riskDollars > job.riskBudget + 1e-7) {
          monitoring = false; throw Error('Actual entry fill exceeded equity risk budget');
        }
        monitoring = true;
        await this.save();
      }
      monitoring = !job.closeRequested;
      if (job.closeRequested) { await this.close(job, job.closeReason ?? 'OWNER_CLOSE'); return; }
      // Verify/install the native stop before optional quotes or target monitoring.
      if (!initialConfirmed) await this.ensureStop(job, job.plan.stop);
      const book = await this.exchange.book(job.symbol);
      const ask = Number(book.askPrice);
      if (!(ask > 0)) throw Error('Exit quote unavailable');
      if (ask >= job.plan.stop) { monitoring = false; await this.close(job, 'STOP_PRICE_REACHED'); return; }
      job.lastObservedAsk = ask; job.lastQuoteAt = this.now();
      const tp = await this.submit(job, 'tp', 'order', { side: 'BUY', type: 'LIMIT', timeInForce: 'GTC',
        reduceOnly: 'true', quantity: decimal(job.plan.partial), price: decimal(job.plan.target) });
      const settled = await this.consistentPartial(job, tp, filled);
      if (!settled) return; // Native exit filled; next cycle clears residual orders.
      const { partialFilled } = settled;
      if (settled.tp.status === 'FILLED') {
        job.phase = 'RUNNER';
        job.lowAsk = Math.min(job.lowAsk ?? ask, ask);
        const nextStop = down(Math.min(job.plan.stop, job.plan.breakEven, job.policyVersion === STRUCTURE_VERSION ? job.lowAsk + job.signal.structure.atr * .5 : job.lowAsk * 1.0075), job.filters.tick);
        if (ask >= nextStop) { monitoring = false; await this.close(job, 'RUNNER_STOP_REACHED'); return; }
        if (nextStop < job.plan.stop - job.filters.tick / 2) await this.ensureStop(job, nextStop);
      } else {
        job.phase = 'OPEN';
        const adverse = fadeAdverseQuote(job, ask);
        job.adverseChecks = adverse?.state === 'NEAR_STOP' ? Math.min(3, (job.adverseChecks ?? 0) + 1) : 0;
        if (job.adverseChecks === 3 && !job.adverseNoticeSent) {
          job.adverseNoticeSent = true;
          await this.save();
          await this.notify(`⚠️ FADE AUTO ${escapeHtml(job.symbol)}: short is close to its planned stop (${(adverse.used * 100).toFixed(0)}% of entry-to-stop distance). Native stop remains active; no hedge opened. Check Binance.`);
        }
        const netAfterCosts = filled * (average - ask) - filled * average * job.fee
          - filled * ask * (job.fee + 0.0005);
        if (partialFilled === 0) job.peakOpenNet = Math.max(job.peakOpenNet ?? 0, netAfterCosts);
        if (job.policyVersion === STRUCTURE_VERSION && partialFilled === 0) {
          const next = protectiveStop(job, ask, netAfterCosts);
          if (next !== job.plan.stop) await this.ensureStop(job, next);
        } else if (job.policyVersion !== STRUCTURE_VERSION && netAfterCosts >= 1.0 * job.plan.riskDollars && ask < job.plan.breakEven
          && job.plan.breakEven < job.plan.stop - job.filters.tick / 2) {
          await this.ensureStop(job, job.plan.breakEven);
        }
      }
      // New stop is verified before previous stops are canceled; reduce-only
      // TP and close-all BUY stop cannot reverse the position if they race.
      await this.cancelOwned(job, [job.stopId, job.actions.tp.id]);
      delete job.monitoringFault; await this.save();
    } catch (e) {
      if (monitoring && !e.mustExit && await this.retainNativeStop(job, e)) {
        console.error('Fade monitoring deferred:', JSON.stringify({ symbol: job.symbol, ...job.monitoringFault }));
        // A failed journal must not recursively turn a protected position into
        // a market exit. The error still blocks all fresh entry reconciliation.
        try { await this.save(); } catch { /* Retry durable diagnostics next cycle. */ }
        throw Error(`Monitoring deferred on ${job.symbol}; ${job.monitoringFault.stop}: ${e.message}`);
      }
      // Persist fault context with the emergency-close intent; never log credentials or request URLs.
      job.protectionFailure = { at: this.now(), operation: e.operation ?? 'protection/reconciliation', code: e.code ?? null, status: e.status ?? null,
        reason: String(e.message).replace(/https?:\/\/\S+/g, '[URL redacted]').slice(0, 300) };
      console.error('Fade protection failure:', JSON.stringify({ symbol: job.symbol, ...job.protectionFailure }));
      // Failed protection or changed exit state: request an immediate flatten.
      try { await this.close(job, 'PROTECTION_FAILURE'); }
      catch { await this.emergencyFlatten(job); }
      throw Error(`Protection/reconciliation issue on ${job.symbol}; emergency close requested: ${e.message}`);
    }
  }
  async entryAverage(job, entry, filled) {
    const reported = Number(entry.avgPrice);
    if (Number.isFinite(reported) && reported > 0) return reported;
    if (typeof this.exchange.trades !== 'function') throw Error('Entry fill price unavailable; native stop retained');
    const start = Number(job.actions.e?.intendedAt ?? job.createdAt);
    if (!Number.isFinite(start)) throw Error('Entry fill timestamp unavailable; native stop retained');
    const rows = await this.exchange.trades(job.symbol, Math.max(0, start - 2000), this.now());
    if (!Array.isArray(rows) || rows.length >= 1000) throw Error('Entry fill history incomplete; native stop retained');
    const orderId = Number(entry.orderId);
    const fills = rows.filter(row => Number(row.orderId) === orderId
      && (row.buyer === false || row.side === 'SELL'));
    let quantity = 0, quote = 0;
    for (const fill of fills) {
      const q = Number(fill.qty), px = Number(fill.price), quoteQty = Number(fill.quoteQty);
      if (!(q > 0) || !Number.isFinite(q) || !(px > 0) || !Number.isFinite(px))
        throw Error('Entry fill history malformed; native stop retained');
      quantity += q;
      quote += Number.isFinite(quoteQty) && quoteQty > 0 ? quoteQty : q * px;
    }
    if (Math.abs(quantity - filled) > Math.max(1e-8, filled * 1e-8) || !(quote > 0))
      throw Error('Entry fill price unavailable; native stop retained');
    return quote / quantity;
  }
  async checkBtcGate(signal) {
    try {
      const [rows, book] = await Promise.all([this.preparation ? this.preparation.btc() : this.exchange.btcCandles(), this.exchange.book('BTCUSDT')]);
      this.btcGate = signal?.model === 'spike-fade-ticks-v1'
        ? fadeSpikeBtcGate(rows, book, this.now()) : fadeBtcGate(rows, book, this.now());
    } catch {
      this.btcGate = { allowed: false, reason: 'BTC data unavailable; short gate closed', checkedAt: this.now() };
    }
    return this.btcGate.allowed;
  }
  async checkEntrySafety(symbol, equity, jobs) {
    this.entrySafetyCheckedAt = this.now();
    if (this.cfg.fadeEnvironment === 'live' && this.cfg.fadeV2DemoAcceptance !== 'I_TESTED_FADE_V2_ON_DEMO'
      && this.cfg.fadeUntestedLiveAcknowledgement !== 'I_ACCEPT_UNTESTED_FADE_V2_LIVE') {
      this.entrySafety = { allowed: false, reason: 'Live entries require tested-demo OR explicit untested-live acknowledgement' }; return false;
    }
    try {
      // Independent read-only checks overlap; inspect all outcomes before proceeding.
      const timed = async (key, action) => {
        const start = this.now();
        try { return await action(); } finally { this.safetyTimings[key] = this.now()-start; }
      };
      const results = await Promise.allSettled([
        timed('risk income',()=>readFadeRisk(this.exchange, jobs, equity, this.now())),
        timed('event calendar',()=>this.preparation ? this.preparation.event() : this.eventGate.check()),
        timed('OI history',()=>this.preparation ? this.preparation.oi(symbol) : this.exchange.openInterestHistory(symbol)),
        timed('funding',()=>this.preparation ? this.preparation.funding(symbol) : this.exchange.funding(symbol))]);
      if (results.some(r => r.status !== 'fulfilled')) throw Error('Safety read failed');
      const [risk, event, oi, funding] = results.map(r => r.value);
      this.riskStatus = newerRiskStatus(this.riskStatus, { ...risk, checkedAt: risk.checkedAt ?? this.now() });
      if (!risk.allowed) { this.entrySafety = risk; return false; }
      if (!event.allowed) { this.entrySafety = event; return false; }
      const positioning = fadePositioningGate(oi, funding, symbol, this.now());
      if (!positioning.allowed) recordDailyGate(this, 'positioning', positioning.reason, symbol, { id: Math.floor(this.now()/10000) });
      this.entrySafety = positioning.allowed ? { allowed: true, reason: 'Risk, events, OI and funding clear' } : positioning;
      return this.entrySafety.allowed;
    } catch {
      this.entrySafety = { allowed: false, reason: 'Risk, event or positioning source unavailable' }; return false;
    }
  }
  async onSignal(symbol, signal) {
    const startedAt = this.now(), timings = {}; let orderSentAt = null;
    const timed = async (stage, action) => {
      const start = this.now();
      try { return await action(); } finally { timings[stage] = this.now()-start; }
    };
    const record = reason => {
      recordDailyGate(this, 'execution', reason, symbol, { id: signal?.detectedAt ?? signal?.barCloseTime ?? startedAt,
        outcome: reason === 'Execution checks started' ? 'info' : /Order reconciliation: (OPEN|RUNNER)/.test(reason) ? 'accepted' : 'blocked' });
      this.lastEntryAttempt = { symbol, at: this.now(), reason,
      elapsedMs: this.now()-startedAt, signalAgeMs: this.now()-signal?.barCloseTime,
      sentSignalAgeMs: orderSentAt === null ? null : orderSentAt-signal?.barCloseTime, timings: { ...timings } }; };
    if (!this.enabled() || this.busy || this.stopped || this.isPaused()) { record('Entries disabled, paused, stopped or reconciliation busy'); return; }
    { const night = fadeNightBlocked(this.now(), configuredNightBlock()); if (night) { record(night); return; } } // Preserve v6.9.67 night-entry block
    const spike = signal?.model === 'spike-fade-ticks-v1';
    if (this.cfg.fadeEntrySource === 'spike' && !spike) { record('Wrong entry source'); return; }
    if (spike && (this.cfg.fadeEntrySource !== 'spike' || !this.spikeAuthorize?.(symbol, signal))) { record('Spike authorization rejected; inspect stream candidate reason'); return; }
    record('Execution checks started');
    this.busy = true;
    try {
      if (spike) this.preparation?.warm(symbol);
      if (!await this.authorizeEntry()) { record('Remote pause/close request'); return; }
      let audited;
      if (spike) {
        // Read-only account audit and lease acquisition overlap. Never mutate
        // until both complete and the audit is checked against the leased jobs.
        const start = await timed('lease/account',()=>Promise.allSettled([this.ready(),this.accountState()]));
        for (const result of start) if (result.status === 'rejected') throw result.reason;
        audited = await timed('reconcile',()=>this.reconcile(true,start[1].value));
      } else {
        await timed('lease', () => this.ready());
        audited = await timed('reconcile', () => this.reconcile());
      }
      if (this.now() < (this.row.state.entryRetryAt ?? 0)) { record('Exchange entry backoff active'); return; }
      if (this.row.state.paused) { record('Entries paused'); return; }
      const jobs = this.row.state.jobs;
      if (fadeAdverseEntryBlocked(jobs, this.now())) {
        this.entrySafety = { allowed: false, reason: 'Active fade short nearing its stop; new entries withheld until recovery' };
        record(this.entrySafety.reason); return;
      }
      let structure;
      if (this.cfg.structureStrategy) {
        const rows = await Promise.all(['1m','15m','1h'].map(interval =>
          this.exchange.request('GET', '/fapi/v1/klines', { symbol, interval, limit: 121 }, false)));
        const at = this.now();
        const m1 = closedSeries(rows[0], 60000, at), m15 = closedSeries(rows[1], 900000, at), h1 = closedSeries(rows[2], 3600000, at);
        if (trendDirection(m15) !== 'SHORT' || trendDirection(h1) === 'LONG') { record('Fade structure trend not SHORT / opposing 1h'); return; }
        structure = detectStructure(m1, 'SHORT', at);
        if (!structure.allowed) { record(structure.reason); return; }
        signal = { ...signal, structure };
      }
      const reentry = this.cfg.structureStrategy ? reentryDecision(jobs, symbol, 'SHORT', structure, this.now())
        : { allowed: true, riskScale: 1, attempt: 0, rootAt: this.now() };
      if (!reentry.allowed) { record(reentry.reason); return; }
      if (jobs.filter(open).length >= 3 || jobs.some(j => j.symbol === symbol && (open(j) || (!this.cfg.structureStrategy && j.filledQty !== 0 && this.now() - j.closedAt < 1800000)))) { record('Three-position cap or symbol cooldown'); return; }
      const id = hash(`${this.scope}:${symbol}:${structure?.sweepTime ?? signal.peakTime}`);
      if (jobs.some(j => j.id === id)) { record('Duplicate signal'); return; }
      let snapshot = audited ?? await timed('account', () => this.accountState());
      if (snapshot.positions.length >= 3) { record('Exchange three-position cap'); return; }
      const usdt = snapshot.account.assets?.find(a => a.asset === 'USDT');
      if (!usdt || !(Number(usdt.availableBalance) > 10)) throw Error('Insufficient USDT balance');
      const equity = Number(snapshot.account.totalMarginBalance ?? usdt.marginBalance);
      if (!(equity > 0)) throw Error('Account equity unavailable');
      const results = await timed('safety/metadata', () => Promise.allSettled([
        this.checkBtcGate(signal), Promise.resolve(true),
        this.preparation ? this.preparation.info() : this.exchange.info(),
        this.preparation ? this.preparation.fees(symbol) : this.exchange.fees(symbol)]));
      if (results.some(r => r.status !== 'fulfilled')) throw Error('Entry metadata read unavailable');
      const [btcAllowed, safetyAllowed, contracts, rates] = results.map(r => r.value);
      if (!btcAllowed) { record(this.btcGate?.reason ?? 'BTC gate rejected'); return; }
      if (!safetyAllowed) { record(this.entrySafety.reason); return; }
      const totalNotional = snapshot.positions.reduce((s, p) => s + Math.abs(Number(p.notional)), 0);
      if (!Number.isFinite(totalNotional) || totalNotional + 150 > 450.01) throw Error('Fade notional budget exhausted');
      const info = contracts.symbols.find(s => s.symbol === symbol);
      if (!info || info.status !== 'TRADING' || info.quoteAsset !== 'USDT' || info.contractType !== 'PERPETUAL') throw Error('Contract unavailable for execution');
      const fee = Math.max(Number(rates.takerCommissionRate), Number(rates.makerCommissionRate), 0);
      if (!Number.isFinite(fee) || fee > 0.01) throw Error('Commission rate unavailable');
      await timed('isolate', () => this.mutate(() => this.exchange.isolate(symbol)));
      snapshot = await timed('post-isolate account', () => this.accountState());
      if (snapshot.positions.some(p => p.symbol === symbol)) throw Error('Symbol already has a position');
      const book = await timed('quote', () => this.exchange.book(symbol)), quoteAt = this.now();
      if (structure && !insideGap(structure, Number(book.bidPrice))) { record('Fade price outside fresh FVG'); return; }
      const baseRisk = Math.min(5, equity * .005);
      const attemptRisk = Math.min(baseRisk, reentry.rootBudget ?? baseRisk) * reentry.riskScale;
      const plan = entryPlan({ riskCap: attemptRisk, signal, bid: Number(book.bidPrice), ask: Number(book.askPrice), info, fee,
        available: Number(snapshot.account.assets.find(a => a.asset === 'USDT')?.availableBalance), equity, now: this.now() });
      const quality = entryQuality({ direction: 'SHORT', entry: plan.entry, stop: plan.stop, reference: signal.price, fee });
      if (!quality.allowed) { this.entrySafety = { allowed: false, reason: `Entry skipped: ${quality.reason}` }; record(this.entrySafety.reason); return; }
      const depth = await timed('entry depth', () => this.exchange.depth(symbol));
      fadeDepthGate(depth, plan, this.now());
      const job = { id, symbol, phase: 'SUBMITTING', signal, fee, filters: plan.filters,
        ...(structure ? { policyVersion: STRUCTURE_VERSION, direction: 'SHORT', structuralStop: plan.stop, reentryAttempt: reentry.attempt, campaignStartedAt: reentry.rootAt, campaignRiskBudget: reentry.rootBudget ?? baseRisk } : {}),
        entryDispatch: 'PREPARED', filledQty: 0, riskBudget: attemptRisk, createdAt: this.now(), actions: {}, plan };
      jobs.push(job);
      // The journal is persisted inside submit before the signed entry request.
      const originalPlace = this.exchange.place.bind(this.exchange);
      // Freshness check is local to this entry, without replacing the client.
      job.actions.e = { id: `nf-${id}-e`, kind: 'order', intendedAt: this.now(),
        params: { side: 'SELL', type: 'LIMIT', timeInForce: 'FOK', price: decimal(plan.limitPrice), quantity: decimal(plan.qty), newOrderRespType: 'RESULT' } };
      job.initialStopKey = 's' + hash(decimal(plan.stop)).slice(0, 8);
      job.actions[job.initialStopKey] = { id: `nf-${id}-${job.initialStopKey}`, kind:'stop',
        params:{triggerPrice:plan.stop}, intendedAt:this.now(), state:'PREPARED', initial:true };
      await timed('journal', () => this.save());
      await this.fence();
      let authorized;
      try {
        const final = await timed('final safety', () => Promise.allSettled([this.authorizeEntry(),
          this.checkBtcGate(signal), this.checkEntrySafety(symbol, equity, jobs.filter(j => j !== job))]));
        if (final.some(r => r.status !== 'fulfilled')) throw Error('Final control/safety unavailable');
        authorized = final.every(r => r.value === true);
      }
      catch {
        job.phase = 'CLOSED'; job.closedAt = this.now(); job.closeReason = 'CONTROL_UNAVAILABLE_BEFORE_SEND';
        await this.save();
        throw Error('Control unavailable before entry; no order sent');
      }
      if (!authorized) {
        job.phase='CLOSED';job.closedAt=this.now();job.closeReason='ENTRY_GATE_CHANGED_BEFORE_SEND';
        await this.save();
        record(!this.entrySafety.allowed ? this.entrySafety.reason : this.btcGate?.allowed===false ? this.btcGate.reason : 'Remote pause/close request');
        return;
      }
      // Persist the dispatch boundary. A crash after this point is ambiguous
      // and remains reserved; never guess that an absent order means unsent.
      job.entryDispatch = 'SENDING'; await timed('dispatch journal', () => this.save());
      await this.fence();
      if (!authorized || this.stopped || this.isPaused() || this.now() - quoteAt > 5000
        || this.now() - signal.barCloseTime > (spike ? 10000 : 90000)
        || (spike && !this.spikeAuthorize?.(symbol, signal))) {
        job.phase = 'CLOSED'; job.closedAt = this.now(); job.closeReason = 'ENTRY_EXPIRED_BEFORE_SEND'; await this.save(); record('Entry expired or gate changed before order send'); return;
      }
      orderSentAt = this.now();
      let acceptedEntry;
      try { acceptedEntry = await originalPlace({ symbol, positionSide: 'BOTH', newClientOrderId: job.actions.e.id, ...job.actions.e.params }); }
      catch (e) {
        if (definiteOrderRejection(e)) {
          job.entryDispatch = 'REJECTED'; job.phase = 'CLOSED'; job.closedAt = this.now();
          this.row.state.entryRetryAt = this.now() + rejectionDelay(e);
          job.closeReason = 'ENTRY_REJECTED'; job.entryRejection = { code: e.code, status: e.status, at: this.now() };
          await this.save(); record(`Entry rejected by Binance (${e.code}); no fill`); return;
        }
        // Network/unknown responses retain the durable ID and slot. No second POST.
      }
      this.initialPermits ??= new Set(); this.initialPermits.add(job.id);
      await this.manage(job, acceptedEntry?.clientOrderId === job.actions.e.id && acceptedEntry?.executedQty !== undefined ? acceptedEntry : null);
      this.initialPermits?.delete(job.id);
      if (open(job)) await this.notify(`🤖 FADE AUTO ${escapeHtml(this.cfg.fadeEnvironment.toUpperCase())}: ${escapeHtml(symbol)} SHORT\nFilled ${job.filledQty} · ${escapeHtml(job.phase)}\n/fadeauto`);
      this.lastError = null; record(`Order reconciliation: ${job.phase}`);
    } catch (e) {
      record(e.message);
      if (e instanceof FadeEntrySkipped) this.entrySafety = { allowed: false, reason: `Entry skipped: ${e.message}` };
      else await this.failed(e);
    }
    finally { this.initialPermits?.clear(); this.busy = false; }
  }
}
