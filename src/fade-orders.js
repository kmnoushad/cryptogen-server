import { createHmac } from 'node:crypto';

export class ExchangeError extends Error {
  constructor(status, code) { super(`Binance request failed (HTTP ${status}, code ${code ?? 'unknown'})`); this.code = code; this.status = status; }
}

// No generic URL overrides, logging of signed requests, or mutation retries.
export class FadeExchange {
  constructor({ key, secret, environment = 'testnet', fetcher = fetch, now = () => Date.now() }) {
    if (!['testnet', 'live'].includes(environment)) throw Error('Invalid fade exchange environment');
    Object.assign(this, { key, secret, fetcher, now });
    this.base = environment === 'live' ? 'https://fapi.binance.com' : 'https://demo-fapi.binance.com';
    this.offset = 0;
  }
  async request(method, path, params = {}, signed = true) {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    if (signed) {
      if (!this.key || !this.secret) throw Error('Fade Binance credentials missing');
      query.set('timestamp', String(Math.trunc(this.now() + this.offset)));
      query.set('recvWindow', '5000');
      query.set('signature', createHmac('sha256', this.secret).update(query.toString()).digest('hex'));
    }
    let response;
    try {
      response = await this.fetcher(`${this.base}${path}${query.size ? '?' + query : ''}`, {
        method, headers: signed ? { 'X-MBX-APIKEY': this.key } : {}, signal: AbortSignal.timeout(7000),
      });
    } catch { throw Error(`Binance ${method} ${path}: response unknown; reconcile before retry`); }
    let body;
    try { body = await response.json(); } catch { throw Error('Binance returned an unreadable response'); }
    if (!response.ok) throw new ExchangeError(response.status, body?.code);
    return body;
  }
  async syncTime() {
    const before = this.now(); const data = await this.request('GET', '/fapi/v1/time', {}, false);
    if (!Number.isFinite(data.serverTime)) throw Error('Invalid exchange time');
    this.offset = data.serverTime - (before + this.now()) / 2;
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
  placeStop(symbol, id, price) {
    return this.request('POST', '/fapi/v1/algoOrder', { algoType: 'CONDITIONAL', symbol,
      side: 'BUY', positionSide: 'BOTH', type: 'STOP_MARKET', triggerPrice: decimal(price),
      closePosition: 'true', workingType: 'CONTRACT_PRICE', priceProtect: 'false', clientAlgoId: id });
  }
  cancel(symbol, id) { return this.request('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: id }); }
  cancelStop(id) { return this.request('DELETE', '/fapi/v1/algoOrder', { clientAlgoId: id }); }
  async isolate(symbol) {
    try { await this.request('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
    catch (e) { if (e.code !== -4046) throw e; }
    const r = await this.request('POST', '/fapi/v1/leverage', { symbol, leverage: 2 });
    if (Number(r.leverage) !== 2) throw Error('Could not confirm 2x leverage');
    const configs = await this.request('GET', '/fapi/v1/symbolConfig', { symbol });
    const config = configs.find(x => x.symbol === symbol);
    if (config?.marginType !== 'ISOLATED' || Number(config.leverage) !== 2) throw Error('Isolated 2x margin not confirmed');
  }
}

export const decimal = n => Number(n).toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
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

export function structuralFadeStop(resistance, f) {
  if (!(resistance > 0)) throw Error('Fade resistance missing');
  const stop = down(resistance - f.tick, f.tick);
  if (!(stop > f.minPrice && stop < resistance && stop <= f.maxPrice)) throw Error('Fade stop cannot fit below resistance');
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

export function entryPlan({ signal, bid, ask, info, fee, available, equity, now = Date.now() }) {
  const f = fadeFilters(info);
  if (!(bid > 0 && ask >= bid && signal.price > 0 && signal.resistance > ask && equity > 0)
    || (ask / bid - 1) * 10000 > 10 || Math.abs(bid / signal.price - 1) > 0.0015
    || 1 - bid / signal.resistance > 0.01
    || !(now >= signal.barCloseTime && now - signal.barCloseTime <= 90000)) throw Error('Stale, extended or illiquid fade entry');
  const stop = structuralFadeStop(signal.resistance, f);
  if (!(stop > ask)) throw Error('Fade invalidation already reached; entry skipped');
  const perUnitRisk = modeledFadeLoss(bid, stop, 1, fee);
  if (!(perUnitRisk > 0)) throw Error('Fade stop cannot cover execution costs');
  const riskBudget = equity * 0.005;
  // Bound quantity by 0.5% of verified equity, available isolated margin and notional.
  const qty = down(Math.min(riskBudget / perUnitRisk, 150 / bid, Math.max(0, available - 10) * 2 / bid, f.max), f.step);
  const p = exitPlan(bid, qty, fee, f, stop);
  if (qty < f.min || qty * bid < f.notional || p.riskDollars > riskBudget + 1e-7) throw Error('Insufficient budget for structural stop');
  return p;
}
