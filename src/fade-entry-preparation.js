// Read-only warm-up. Never stores account state, orders, quotes, leases or risk decisions.
export class FadeEntryPreparation {
  constructor({ exchange, eventGate, now }) {
    Object.assign(this, { exchange, eventGate, now });
    this.cache = new Map(); this.pending = new Map(); this.warming = new Set(); this.metrics = {};
  }
  async read(key, ttl, load) {
    const cached = this.cache.get(key), age = cached ? this.now()-cached.startedAt : Infinity;
    if (age >= 0 && age < ttl) { this.metrics[key] = { ms: 0, cached: true, ageMs: age }; return cached.value; }
    if (this.pending.has(key)) return this.pending.get(key);
    const startedAt = this.now();
    const pending = Promise.resolve().then(load).then(value => {
      this.cache.delete(key); this.cache.set(key, { value, startedAt });
      while (this.cache.size > 64) { const oldest=this.cache.keys().next().value; this.cache.delete(oldest); delete this.metrics[oldest]; }
      this.metrics[key] = { ms: this.now()-startedAt, cached: false };
      return value;
    }).catch(e => { this.cache.delete(key); throw e; })
      .finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
    this.pending.set(key,pending); return pending;
  }
  info() { return this.read('contracts',60000,()=>this.exchange.info()); }
  fees(s) { return this.read(`fees:${s}`,60000,()=>this.exchange.fees(s)); }
  oi(s) { return this.read(`OI:${s}`,15000,()=>this.exchange.openInterestHistory(s)); }
  funding(s) { return this.read(`funding:${s}`,2000,()=>this.exchange.funding(s)); }
  btc() { return this.read('BTC candles',2000,()=>this.exchange.btcCandles()); }
  async event() {
    // Warm the calendar loader, then reevaluate its window at entry time.
    await this.read('calendar warm-up',60000,()=>this.eventGate.check());
    return this.eventGate.check();
  }
  warm(symbol) {
    const key = symbol ?? 'global';
    if (this.warming.has(key) || this.warming.size >= 2) return;
    this.warming.add(key);
    const reads = [this.info(),this.btc(),this.read('calendar warm-up',60000,()=>this.eventGate.check())];
    if (symbol) reads.push(this.fees(symbol),this.oi(symbol),this.funding(symbol));
    void Promise.allSettled(reads).finally(()=>this.warming.delete(key));
  }
}
