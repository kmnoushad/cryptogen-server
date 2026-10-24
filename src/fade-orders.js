import { requestDeadline } from './request-deadline.js';
import { createRequestBudget } from './binance-request-budget.js';
import { createHmac } from 'node:crypto';

export class ExchangeError extends Error {
  constructor(status, code, message) {
    const timing = code === -1021 && typeof message === 'string'
      ? (message.includes('ahead') ? '; timestamp ahead of server' : '; timestamp outside receive window') : '';
    super(`Binance request failed (HTTP ${status}, code ${code ?? 'unknown'})${timing}`);
    this.code = code; this.status = status;
  }
}

// No generic URL overrides, logging of signed requests, or mutation retries.
export class FadeExchange {
  constructor({ key, secret, environment = 'testnet', fetcher = fetch, now = () => Date.now(), budget, timeoutMs = 7000 }) {
    if (!['testnet', 'live'].includes(environment)) throw Error('Invalid fade exchange environment');
    Object.assign(this, { key, secret, fetcher, now, timeoutMs });
    this.budget = budget === undefined ? createRequestBudget(environment) : budget;
    this.blockedUntil = 0;
    this.base = environment === 'live' ? 'https://fapi.binance.com' : 'https://demo-fapi.binance.com';
    this.offset = 0; this.timeSyncedAt = null; this.timeSyncInFlight = null; this.timeSample = null;
  }
  async request(method, path, params = {}, signed = true) {
    if (this.now() < this.blockedUntil) {
      const error = new ExchangeError(429, -1003); error.retryAfterMs = this.blockedUntil-this.now(); error.requestSent=false; throw error;
    }
    if (this.budget) {
      try { await this.budget.before(method,path,params); }
      catch(error) { error.requestSent=false; throw error; }
    }
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    if (signed) {
      if (!this.key || !this.secret) throw Error('Fade Binance credentials missing');
      query.set('timestamp', String(Math.trunc(this.now() + this.offset)));
      query.set('recvWindow', '5000');
      query.set('signature', createHmac('sha256', this.secret).update(query.toString()).digest('hex'));
    }
    let response, body;
    try {
      ({response, body} = await requestDeadline(async signal => {
        const response = await this.fetcher(`${this.base}${path}${query.size ? '?' + query : ''}`, {
          method, headers: signed ? { 'X-MBX-APIKEY': this.key } : {}, signal,
        });
        // Record header-only rate limits even if the error body subsequently hangs.
        if ([429,418].includes(response.status)) {
          const retry=Number(response.headers?.get?.('retry-after'));
          this.blockedUntil=Math.max(this.blockedUntil,this.now()+(retry>0?retry*1000:response.status===418?180000:60000)+1000);
          if(this.budget)await this.budget.observe(response,null);
        }
        const body = await response.json();
        return {response,body};
      }, this.timeoutMs));
    } catch { throw Error(`Binance ${method} ${path}: response unknown; reconcile before retry`); }
    if(this.budget)await this.budget.observe(response,body);
    if (!response.ok) {
      // Do not retry signed writes. Invalidate the clock estimate for the next cycle.
      if (body?.code === -1021) this.timeSyncedAt = null;
      if ([429,418].includes(response.status) || body?.code===-1003) this.blockedUntil=Math.max(this.blockedUntil,this.now()+60000);
      const error = new ExchangeError(response.status, body?.code, body?.msg);
      const retry = Number(response.headers?.get?.('retry-after'));
      if (Number.isFinite(retry) && retry > 0) error.retryAfterMs = Math.min(retry * 1000, 86400000);
      throw error;
    }
    return body;
  }
  async syncTime() {
    const age = this.timeSyncedAt === null ? Infinity : this.now() - this.timeSyncedAt;
    if (age >= 0 && age < 60000) return;
    if (this.timeSyncInFlight) return this.timeSyncInFlight;
    this.timeSyncInFlight = (async () => {
      const samples=[];
      // Probe sequentially: a cold DNS/TLS read can be slow while a subsequent
      // connection reuse is timely. Do not create three competing handshakes.
      for(let attempt=0;attempt<3;attempt++) {
        const before=this.now();
        try {
          const data=await this.request('GET','/fapi/v1/time',{},false);
          const after=this.now(),rtt=after-before;
          const valid=Number.isFinite(data?.serverTime)&&rtt>=0&&rtt<=1500;
          samples.push({roundTripMs:rtt,valid});this.clockSamples=samples;
          if(!valid)continue;
          this.offset=data.serverTime-(before+after)/2-100;
          this.timeSyncedAt=this.now();
          this.timeSample={roundTripMs:rtt,offsetMs:this.offset,sampledAt:this.timeSyncedAt};
          return;
        } catch(error) {
          samples.push({roundTripMs:this.now()-before,valid:false,status:error.status??null,code:error.code??null});this.clockSamples=samples;
          if(error.status===429||error.status===418||error.code===-1003||error.requestSent===false)throw error;
        }
      }
      throw Error('No reliable Binance clock sample; reconciliation required; samples '+samples.map(x=>`${x.roundTripMs}ms${x.status?' HTTP '+x.status:''}`).join(', '));
    })();
    try { await this.timeSyncInFlight; } finally { this.timeSyncInFlight = null; }
  }
  account() { return this.request('GET', '/fapi/v3/account'); }
  // Account Information V3 intentionally omits the canTrade permission flag.
  // Keep V3 for balances, and query V2 separately before any execution flow.
  accountPermissions() { return this.request('GET', '/fapi/v2/account'); }
  income(params = {}) { return this.request('GET', '/fapi/v1/income', { limit: 1000, ...params }); }
  positions() { return this.request('GET', '/fapi/v3/positionRisk'); }
  mode() { return this.request('GET', '/fapi/v1/positionSide/dual'); }
  assetsMode() { return this.request('GET', '/fapi/v1/multiAssetsMargin'); }
  info() { return this.request('GET', '/fapi/v1/exchangeInfo', {}, false); }
  btcCandles() { return this.request('GET', '/fapi/v1/klines', { symbol: 'BTCUSDT', interval: '1m', limit: 121 }, false); }
  openInterestHistory(symbol) { return this.request('GET', '/futures/data/openInterestHist', { symbol, period: '5m', limit: 5 }, false); }
  funding(symbol) { return this.request('GET', '/fapi/v1/premiumIndex', { symbol }, false); }
  book(symbol) { return this.request('GET', '/fapi/v1/ticker/bookTicker', { symbol }, false); }
  depth(symbol) { return this.request('GET', '/fapi/v1/depth', { symbol, limit: 20 }, false); }
  allOrders(symbol, startTime, endTime) { return this.request('GET', '/fapi/v1/allOrders', { symbol, startTime, endTime, limit: 1000 }); }
  async algoHistory(symbol, startTime, endTime) {
    const data=await this.request('GET','/fapi/v1/allAlgoOrders',{symbol,startTime,endTime,limit:1000});
    const rows=Array.isArray(data)?data:data?.orders;
    if(!Array.isArray(rows))throw Error('Algo history unavailable');return rows;
  }
  trades(symbol, startTime, endTime) { return this.request('GET', '/fapi/v1/userTrades', { symbol, startTime, endTime, limit: 1000 }); }
  fees(symbol) { return this.request('GET', '/fapi/v1/commissionRate', { symbol }); }
  order(symbol, id) { return this.request('GET', '/fapi/v1/order', { symbol, origClientOrderId: id }); }
  algo(id) { return this.request('GET', '/fapi/v1/algoOrder', { clientAlgoId: id }); }
  orders(symbol) { return this.request('GET', '/fapi/v1/openOrders', { symbol }); }
  async algos(symbol) {
    const r = await this.request('GET', '/fapi/v1/openAlgoOrders', { symbol });
    const rows = Array.isArray(r) ? r : r?.orders;
    if (!Array.isArray(rows)) throw Error('Unknown open-algo response'); return rows;
  }
  place(params) { return this.request('POST', '/fapi/v1/order', { positionSide: 'BOTH', ...params }); }
  placeStop(symbol, id, price, quantity) {
    return this.request('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol,
      side: 'BUY', positionSide: 'BOTH', type: 'STOP_MARKET', triggerPrice: decimal(price),
      ...(quantity == null ? { closePosition: 'true' } : { reduceOnly: 'true', quantity: decimal(quantity) }),
      workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: id });
  }
  cancel(symbol, id) { return this.request('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: id }); }
  cancelStop(id) { return this.request('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: id }); }
  async isolate(symbol) {
    // Read current exchange configuration, not a process cache. Most symbols
    // already have the requested settings; avoid two redundant signed writes.
    const before = await this.request('GET', '/fapi/v1/symbolConfig', { symbol });
    if (!Array.isArray(before)) throw Error('Symbol configuration unavailable');
    const current = before.find(x => x.symbol === symbol);
    if (!current) throw Error('Symbol configuration missing');
    if (current.marginType === 'ISOLATED' && Number(current.leverage) === 2) return;
    try { await this.request('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
    catch (e) { if (e.code !== -4046) throw e; }
    const r = await this.request('POST', '/fapi/v1/leverage', { symbol, leverage: 2 });
    if (Number(r.leverage) !== 2) throw Error('Could not confirm 2x leverage');
    const configs = await this.request('GET', '/fapi/v1/symbolConfig', { symbol });
    const config = configs.find(x => x.symbol === symbol);
    if (config?.marginType !== 'ISOLATED' || Number(config.leverage) !== 2) throw Error('Isolated 2x margin not confirmed');
  }
}

export const decimal = n => Number(n).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
export const down = (n, step) => Number((Math.floor(n / step + 1e-9) * step).toFixed(12));

export function fadeFilters(info) {
  const f = Object.fromEntries((info?.filters ?? []).map(x => [x.filterType, x]));
  const lot = f.LOT_SIZE, market = f.MARKET_LOT_SIZE, price = f.PRICE_FILTER;
  if (!lot || !market || !price || !f.MIN_NOTIONAL) throw Error('Required exchange filters missing');
  // Reject unusual incompatible increments instead of rounding into a rejected order.
  const step = Math.max(Number(lot.stepSize), Number(market.stepSize));
  if (!(step > 0) || [Number(lot.stepSize), Number(market.stepSize)].some(s => s > 0 && Math.abs(step / s - Math.round(step / s)) > 1e-8)) throw Error('Incompatible lot increments');
  const result = { step, tick: Number(price.tickSize), min: Math.max(Number(lot.minQty), Number(market.minQty)),
    max: Math.min(Number(lot.maxQty), Number(market.maxQty)), notional: Number(f.MIN_NOTIONAL.notional),
    minPrice: Number(price.minPrice), maxPrice: Number(price.maxPrice) };
  if (Object.values(result).some(x => !Number.isFinite(x) || x < 0) || !result.tick || !result.max) throw Error('Invalid exchange filters');
  return result;
}

// v6.9.37: the stop sits ABOVE the failed high with a 0.3% buffer. One tick
// below the high was stopped out by ordinary retests that never broke it.
export const FADE_STOP_BUFFER = 0.003;
export const FADE_ENTRY_SLIPPAGE = 0.0005; // Reserve 5 bps for a lower short fill; never widen the risk budget.
export function structuralFadeStop(resistance, f) {
  if (!(resistance > 0)) throw Error('Fade resistance missing');
  const stop = Number((Math.ceil(resistance * (1 + FADE_STOP_BUFFER) / f.tick - 1e-9) * f.tick).toFixed(12));
  if (!(stop > f.minPrice && stop > resistance && stop <= f.maxPrice)) throw Error('Fade stop cannot fit above resistance');
  return stop;
}

export function modeledFadeLoss(entry, stop, qty, fee) {
  return qty * (stop * (1 + fee + 0.0005) - entry * (1 - fee));
}

export function exitPlan(entry, qty, fee, f, stop) {
  const partial = down(qty * 0.75, f.step), runner = down(qty - partial, f.step);
  const riskDollars = modeledFadeLoss(entry, stop, qty, fee);
  // The 75% limit must earn at least 1.5x the FULL position's modeled risk,
  // after entry and partial-exit fees. The runner is additional, never assumed.
  const target = down((entry - (riskDollars * 1.5 + entry * qty * fee) / partial) / (1 + fee), f.tick);
  const breakEven = down(entry * (1 - fee) / (1 + fee + 0.0005), f.tick);
  if (![entry, qty, fee, partial, runner, stop, target, breakEven, riskDollars].every(Number.isFinite)
    || qty <= 0 || fee < 0 || fee > 0.01 || partial < f.min || runner < f.min
    || target <= f.minPrice || target >= entry || riskDollars <= 0 || stop <= entry || stop > f.maxPrice
    || partial * target < f.notional || runner * target < f.notional) throw Error('Position too small or invalid for 75%/25% exits');
  return { entry, qty, partial, runner, stop, target, breakEven, riskDollars, fee, filters: f };
}

export class FadeEntrySkipped extends Error {}

export function entryPlan({ signal, bid, ask, info, fee, available, equity, riskCap = Infinity, now = Date.now() }) {
  const f = fadeFilters(info);
  const maxAge = signal.model === 'spike-fade-ticks-v1' ? 10000 : 90000;
  if (!(now >= signal.barCloseTime && now - signal.barCloseTime <= maxAge))
    throw new FadeEntrySkipped(signal.model === 'spike-fade-ticks-v1' ? 'Spike entry older than 10 seconds' : 'Fade entry expired: closed bar older than 90 seconds');
  if (!(bid > 0 && ask >= bid && signal.price > 0 && signal.resistance > ask && equity > 0)) throw Error('Fade entry quote, resistance or equity invalid');
  if ((ask / bid - 1) * 10000 > 10) throw new FadeEntrySkipped('Fade entry spread exceeds 10 bps');
  if (Math.abs(bid / signal.price - 1) > 0.0015) throw new FadeEntrySkipped('Fade entry price moved more than 0.15% since alert');
  if (1 - bid / signal.resistance > 0.01) throw new FadeEntrySkipped('Fade entry more than 1% below failed high; structural stop too far');
  const stop = signal.structure?.strategy === 'sweep-mss-fvg-v1'
    ? Number((Math.ceil(signal.structure.stop / f.tick - 1e-9) * f.tick).toFixed(12))
    : structuralFadeStop(signal.resistance, f);
  if (!(stop > ask)) throw new FadeEntrySkipped('Fade invalidation already reached; entry skipped');
  const limitPrice = Number((Math.ceil(Math.max(bid * (1 - FADE_ENTRY_SLIPPAGE), signal.structure?.fvg?.low ?? 0) / f.tick - 1e-9) * f.tick).toFixed(12));
  const perUnitRisk = modeledFadeLoss(limitPrice, stop, 1, fee);
  if (!(perUnitRisk > 0)) throw Error('Fade stop cannot cover execution costs');
  const riskBudget = Math.min(5, equity * 0.005, riskCap);
  if (!(riskBudget > 0)) throw new FadeEntrySkipped('Invalid risk cap');
  // Bound quantity by 0.5% of verified equity, available isolated margin and notional.
  const qty = down(Math.min(riskBudget / perUnitRisk, 150 / bid, Math.max(0, available - 10) * 2 / bid, f.max), f.step);
  let p;
  try { p = exitPlan(bid, qty, fee, f, stop); }
  catch (error) {
    if (error.message === 'Position too small or invalid for 75%/25% exits')
      throw new FadeEntrySkipped(error.message);
    throw error;
  }
  if (qty < f.min || qty * bid < f.notional || p.riskDollars > riskBudget + 1e-7) throw new FadeEntrySkipped('Insufficient budget for structural stop');
  return { ...p, limitPrice };
}

// Size must fit at least twice inside the currently visible bid liquidity at
// the worst permitted entry price. The FOK limit still enforces that price
// if displayed depth vanishes after this read.
export function fadeDepthGate(depth, plan, now) {
  if (!depth || !Number.isFinite(Number(depth.T)) || now-Number(depth.T) < -1000 || now-Number(depth.T) > 2000
    || !Array.isArray(depth.bids) || !Array.isArray(depth.asks) || !depth.bids.length || !depth.asks.length)
    throw new FadeEntrySkipped('Entry depth missing or stale');
  const bids=depth.bids.map(x=>x.map(Number)), asks=depth.asks.map(x=>x.map(Number));
  if ([...bids,...asks].some(x=>x.length!==2 || !x.every(Number.isFinite) || x[0]<=0 || x[1]<0)
    || bids.some((x,i)=>i && x[0]>bids[i-1][0]) || asks.some((x,i)=>i && x[0]<asks[i-1][0]) || asks[0][0]<bids[0][0])
    throw new FadeEntrySkipped('Entry depth malformed');
  const available=bids.filter(([price])=>price>=plan.limitPrice).reduce((sum,[,qty])=>sum+qty,0);
  if (available < plan.qty*2) throw new FadeEntrySkipped('Insufficient bid depth inside entry price cap');
  return { checkedAt:now, executableQty:available, limitPrice:plan.limitPrice };
}
