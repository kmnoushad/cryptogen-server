import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPumpFade, PumpFadeRadar } from '../src/pump-fade.js';

const now = Date.parse('2026-09-14T14:30:20Z');
function fixture() {
  const start = Math.floor(now / 60000) * 60000 - 90 * 60000;
  const c = Array.from({ length: 90 }, (_, i) => {
    const p = i < 70 ? 100 + i * 0.12 : 108;
    return [start + i * 60000, p, p + 0.1, p - 0.1, p, 100,
      start + (i + 1) * 60000 - 1, 10000, 100, 60, i >= 87 ? 4000 : 6000];
  });
  c[76][2] = 110; c[76][4] = 109;
  c[84][2] = 109.8; c[84][4] = 109;
  c[89][1] = 108; c[89][2] = 108.1; c[89][3] = 107.4; c[89][4] = 107.5;
  return c;
}
test('repeated rejected highs, prior pump, fading flow and price roll-over produce warning evidence', () => {
  const s = detectPumpFade(fixture(), now);
  assert.ok(s);
  assert.equal(s.resistance, 110);
  assert.equal(s.buyPct, 40);
  assert.equal(s.priorBuyPct, 60);
  assert.ok(s.pumpPct >= 5);
});
test('single failed high does not qualify', () => {
  const c = fixture(); c[84][2] = 109; c[84][4] = 109;
  assert.equal(detectPumpFade(c, now), null);
});
test('strong buying, successful new high and already-large dump suppress warnings', () => {
  const strong = fixture(); for (const c of strong) c[10] = 6500;
  assert.equal(detectPumpFade(strong, now), null);
  const breakout = fixture(); breakout[84][2] = 112; breakout[84][4] = 111;
  assert.equal(detectPumpFade(breakout, now), null);
  const dump = fixture(); dump[89][3] = 100; dump[89][4] = 101;
  assert.equal(detectPumpFade(dump, now), null);
});
test('stale, missing, malformed or open bars cannot create a warning', () => {
  assert.equal(detectPumpFade(fixture(), now + 120000), null);
  const gap = fixture(); gap.splice(60, 1);
  assert.equal(detectPumpFade(gap, now), null);
  const malformed = fixture(); malformed[89][10] = 11000;
  assert.equal(detectPumpFade(malformed, now), null);
  const c = fixture(); const live = [...c.at(-1)]; live[0] += 60000; live[6] += 60000;
  live[3] = 90; live[4] = 90; c.push(live);
  assert.equal(detectPumpFade(c, now).price, 107.5);
});
function radarFixture({ duplicate = false, paused = false, failSend = false } = {}) {
  const messages = [], events = [];
  let requests = 0;
  const radar = new PumpFadeRadar({ cfg: { enablePumpFadeAlerts: true }, now: () => now,
    isPaused: () => paused,
    binance: { exchangeInfo: async () => ({ symbols: [{ symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' }] }),
      ticker24h: async () => [{ symbol: 'ETHUSDT', priceChangePercent: '80', quoteVolume: '50000000' }],
      klines: async () => { requests++; return fixture(); } },
    store: { insertEvent: async e => { events.push(e); return !duplicate; },
      createTrade: () => { throw new Error('must never trade'); } },
    telegram: { send: async m => { if (failSend) throw new Error('offline'); messages.push(m); } } });
  return { radar, messages, events, requests: () => requests };
}
test('80% gainers can warn without long BTC gate; cooldown avoids repeated sends and no trades created', async () => {
  const x = radarFixture(); await x.radar.poll(); await x.radar.poll();
  assert.equal(x.messages.length, 1);
  assert.match(x.messages[0], /DOWNSIDE RISK INCREASING/);
  assert.match(x.messages[0], /not a guaranteed fall/);
  assert.equal(x.events[0].event_type, 'FUTURES_PUMP_FADE_WARNING');
  assert.equal(x.requests(), 1);
});
test('persisted duplicate suppresses replay after restart', async () => {
  const x = radarFixture({ duplicate: true }); await x.radar.poll();
  assert.equal(x.messages.length, 0);
});
test('pause, disabled mode and stop prevent polling', async () => {
  const x = radarFixture({ paused: true }); await x.radar.poll();
  assert.equal(x.requests(), 0);
  const y = radarFixture(); y.radar.cfg.enablePumpFadeAlerts = false; await y.radar.poll();
  assert.equal(y.requests(), 0);
  const z = radarFixture(); z.radar.stop(); await z.radar.poll(); assert.equal(z.requests(), 0);
});
test('delivery errors are visible and release polling guard', async () => {
  const x = radarFixture({ failSend: true }); await x.radar.poll();
  assert.equal(x.radar.health().errors, 1);
  assert.equal(x.radar.health().lastError, 'offline');
  assert.equal(x.radar.running, false);
});

test('low liquidity, exclusions and hourly cap prevent candle requests', async () => {
  const low = radarFixture();
  low.radar.binance.ticker24h = async () => [{ symbol: 'ETHUSDT', priceChangePercent: '80', quoteVolume: '1000' }];
  await low.radar.poll(); assert.equal(low.requests(), 0);
  const excluded = radarFixture(); excluded.radar.excluded.add('ETHUSDT');
  await excluded.radar.poll(); assert.equal(excluded.requests(), 0);
  const capped = radarFixture(); capped.radar.sent = Array(6).fill(now);
  await capped.radar.poll(); assert.equal(capped.requests(), 0);
});
test('stop during candle retrieval prevents alert delivery', async () => {
  const x = radarFixture();
  x.radar.binance.klines = async () => { x.radar.stop(); return fixture(); };
  await x.radar.poll(); assert.equal(x.messages.length, 0); assert.equal(x.events.length, 0);
});
