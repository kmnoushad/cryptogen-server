import { keyOf } from './alpha.js';
import { escapeHtml, formatPrice, log, pctChange } from './util.js';

const LISTING_WINDOW_MS = 15 * 60_000;
const MAX_ALERT_AGE_MS = 30_000;

function breakout(history, token, observedAt, pollMs) {
  if (history.length < 3) return null;
  const first = history[0];
  const last = history.at(-1);
  const samples = [...history, { t: observedAt }];
  const maxGap = Math.min(60_000, 2 * pollMs);
  if (samples.slice(1).some((point, i) => point.t <= samples[i].t || point.t - samples[i].t > maxGap)) return null;

  const high = Math.max(...history.map(point => point.price));
  const low = Math.min(...history.map(point => point.price));
  const movePct = pctChange(high, token.price);
  if (pctChange(low, high) > 1.5 || movePct < 2 || movePct > 5) return null;
  if (pctChange(Math.max(first.liquidity, last.liquidity), token.liquidity) < -3) return null;

  // Alpha list snapshots expose rolling 24h volume. Its change is a proxy,
  // since trades can also age out of the rolling window.
  const baseline = (last.volume24h - first.volume24h) / (last.t - first.t);
  const latest = (token.volume24h - last.volume24h) / (observedAt - last.t);
  if (!(baseline > 0) || latest < 2 * baseline) return null;
  return { high, movePct, volumeProxyRatio: latest / baseline };
}

export class AlphaEarlyWatch {
  constructor({ cfg, store, telegram, now, passesFloors, isPaused, isEventGuarded }) {
    Object.assign(this, { cfg, store, telegram, now, passesFloors, isPaused, isEventGuarded });
    this.tokens = new Map();
    this.seeded = false;
    this.watchTimes = [];
    this.metrics = { listings: 0, watches: 0, stale: 0, errors: 0 };
  }

  async observe(tokens, observedAt) {
    const listings = [];
    const watches = [];
    const keys = new Set();
    for (const token of tokens) {
      const key = keyOf(token);
      if (keys.has(key)) continue;
      keys.add(key);
      let state = this.tokens.get(key);
      if (!state) {
        state = { firstSeenAt: this.seeded ? observedAt : null, history: [] };
        this.tokens.set(key, state);
      }
      state.lastSeenAt = observedAt;
      const timestamp = token.listingTime;
      const listedAt = timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
      const hasTimestamp = Number.isFinite(listedAt) && listedAt > 0;
      const freshListing = hasTimestamp && observedAt >= listedAt && observedAt - listedAt < LISTING_WINDOW_MS;
      const freshDiscovery = !hasTimestamp && state.firstSeenAt !== null && observedAt - state.firstSeenAt < LISTING_WINDOW_MS;
      if (token.price > 0 && !state.listingHandled && (freshListing || freshDiscovery)) {
        listings.push({ token, state, key, listedAt: freshListing ? listedAt : null });
      }
      if (!this.passesFloors(token)) {
        state.history = [];
        continue;
      }
      const move = breakout(state.history, token, observedAt, this.cfg.alphaMoverPollMs);
      if (move && observedAt >= (state.watchUntil ?? 0) && token.change24h < this.cfg.alphaMoverMax24hChangePct) {
        watches.push({ token, state, key, move });
      }
      state.history.push({ t: observedAt, price: token.price, liquidity: token.liquidity, volume24h: token.volume24h });
      if (state.history.length > 3) state.history.shift();
    }
    // An empty feed is not a discovery baseline.
    if (tokens.length) this.seeded = true;
    for (const [key, state] of this.tokens) {
      if (observedAt - state.lastSeenAt > 24 * 60 * 60_000) this.tokens.delete(key);
    }

    this.watchTimes = this.watchTimes.filter(at => observedAt - at < 60 * 60_000);
    const watchSlots = Math.max(0, this.cfg.alphaMoverMaxAlertsPerHour - this.watchTimes.length);
    const selected = [
      ...watches.sort((a, b) => b.move.volumeProxyRatio - a.move.volumeProxyRatio).slice(0, Math.min(4, watchSlots)),
      ...listings.slice(0, 4),
    ];
    await Promise.all(selected.map(candidate => this.send(candidate, observedAt)));
  }

  async send({ token, state, key, listedAt, move }, observedAt) {
    if (move && (this.isPaused() || this.isEventGuarded())) return;
    const kind = move ? 'ALPHA_EARLY_PUMP_WATCH' : 'ALPHA_LISTING_NOTICE';
    const cooldownMs = this.cfg.alphaMoverCooldownMin * 60_000;
    const eventKey = move ? `alpha-early-watch:${key}:${Math.floor(observedAt / cooldownMs)}` : `alpha-listing:${key}`;
    const label = move ? 'EARLY PUMP WATCH' : listedAt ? 'NEW ALPHA LISTING' : 'FIRST SEEN ON ALPHA';
    try {
      const claimed = await this.store.insertEvent({
        event_key: eventKey,
        event_type: kind,
        symbol: `[ALPHA] ${token.symbol}`,
        payload: { observedAt, listedAt: listedAt ?? null, price: token.price, key, move: move ?? null },
      });
      if (move) state.watchUntil = observedAt + cooldownMs;
      else state.listingHandled = true;
      if (claimed === false) return;
      const sendAt = this.now();
      const ageMs = sendAt - observedAt;
      if (ageMs >= MAX_ALERT_AGE_MS || (move && (this.isPaused() || this.isEventGuarded()))) {
        this.metrics.stale++;
        log(`Alpha notice expired ${kind} ${key} observedAt=${observedAt} ageMs=${ageMs}`);
        return;
      }
      const detail = move
        ? `Range high $${formatPrice(move.high)} · +${move.movePct.toFixed(2)}% above range\nRolling-volume acceleration proxy ${move.volumeProxyRatio.toFixed(1)}×\n`
        : listedAt ? `Feed listing time ${new Date(listedAt).toISOString()}\n` : '';
      await this.telegram.send(
        `<b>[ALPHA] ${label} · ${escapeHtml(token.symbol)}</b>\n` +
        `${escapeHtml(token.chainName)} · <code>${escapeHtml(token.contractAddress)}</code>\n` +
        detail +
        `Observed price $${formatPrice(token.price)} · snapshot age ${(ageMs / 1000).toFixed(1)}s\n` +
        'Watch only · on-chain safety unverified',
      );
      if (move) {
        this.watchTimes.push(observedAt);
        this.metrics.watches++;
      } else {
        this.metrics.listings++;
      }
      log(`Alpha notice sent ${kind} ${key} observedAt=${observedAt} sendAt=${sendAt} acknowledgedAt=${this.now()} price=${token.price}`);
    } catch (error) {
      this.metrics.errors++;
      log(`Alpha notice failed ${kind} ${key} observedAt=${observedAt} error=${error.name}`);
    }
  }
}
