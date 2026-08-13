import test from 'node:test';
import assert from 'node:assert/strict';
import { AlphaFastMover } from '../src/alpha-mover.js';

const cfg = {
  enableAlphaFastMover: true,
  alphaMoverPollMs: 90_000,
  alphaMoverMin10mPct: 3.0,
  alphaMoverMin30mPct: 6.0,
  alphaMoverMax24hChangePct: 60,
  alphaMoverCooldownMin: 60,
  alphaMoverMaxAlertsPerHour: 4,
  alphaMoverMaxRiskScore: 5,
  alphaMoverMinLiquidityUsd: 150_000,
  alphaMinVolumeUsd: 200_000,
  alphaMinHolders: 800,
};

const T0 = 1_700_000_000_000;

const rawToken = (overrides = {}) => ({
  chainId: '56',
  chainName: 'BSC',
  contractAddress: '0x0000000000000000000000000000000000000abc',
  alphaId: 'ALPHA_MOVE',
  symbol: 'MOVE',
  name: 'Move Token',
  price: '1.0',
  percentChange24h: '5',
  volume24h: '500000',
  liquidity: '400000',
  marketCap: '5000000',
  holders: '2000',
  hotTag: false,
  listingTime: 0,
  ...overrides,
});

const goodSecurity = {
  rating: 'NO_CRITICAL_FLAGS', riskScore: 0, hardBlock: false,
  critical: [], warnings: [], metrics: {}, checkedAt: T0,
};

const harness = ({
  security = goodSecurity,
  securityThrows = false,
  insertResult = true,
  insertThrows = false,
  paused = false,
  config = cfg,
} = {}) => {
  let clock = T0;
  let feed = [];
  const events = [];
  const messages = [];
  const securityCalls = [];
  const radar = new AlphaFastMover({
    cfg: config,
    store: {
      insertEvent: async event => {
        if (insertThrows) throw new Error('database down');
        events.push(event);
        return insertResult;
      },
    },
    telegram: { send: async message => { messages.push(message); } },
    fetcher: async () => ({ data: feed }),
    assessSecurity: async token => {
      securityCalls.push(token.symbol);
      if (securityThrows) throw new Error('provider down');
      return security;
    },
    isPaused: () => paused,
    now: () => clock,
    sleepImpl: async () => {},
  });
  return {
    radar, events, messages, securityCalls,
    setFeed: tokens => { feed = tokens; },
    advance: ms => { clock += ms; },
  };
};

test('10m window triggers an ALPHA_FAST_MOVER alert and persists before sending', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  assert.equal(h.messages.length, 0); // no history yet — never fabricate a reference

  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.035' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /\[ALPHA\] FAST MOVER/);
  assert.match(h.messages[0], /\+3\.50% in 10m/);
  assert.match(h.messages[0], /MOVE/);
  assert.match(h.messages[0], /DYOR/);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].event_type, 'ALPHA_FAST_MOVER');
  assert.match(h.events[0].event_key, /^alpha-mover:56:0x0000000000000000000000000000000000000abc:\d+$/);
  assert.equal(h.events[0].payload.windowMin, 10);
  assert.equal(h.radar.metrics.triggers, 1);
  assert.equal(h.radar.metrics.alerts, 1);
  assert.deepEqual(h.securityCalls, ['MOVE']);
});

test('30m window triggers when the 10m move is below threshold', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(20 * 60_000);
  h.setFeed([rawToken({ price: '1.062' })]);
  await h.radar.pollOnce();
  assert.equal(h.messages.length, 0); // +6.2% vs 20m ago is neither window

  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.063' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /in 30m/);
  assert.equal(h.events[0].payload.windowMin, 30);
});

test('stale reference (older than two poll intervals) never fabricates a trigger', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  // 13m20s later: the 10m reference target is 200s after the only point,
  // beyond the 2×90s staleness cap; the 30m window has no reference at all.
  h.advance(800_000);
  h.setFeed([rawToken({ price: '1.20' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
});

test('hard floor gates skip untracked tokens', async () => {
  const h = harness();
  const cases = [
    rawToken({ contractAddress: '0x01', symbol: 'NOPRICE', price: '0' }),
    rawToken({ contractAddress: '0x02', symbol: 'LOWLIQ', liquidity: '100000' }),
    rawToken({ contractAddress: '0x03', symbol: 'LOWVOL', volume24h: '100000' }),
    rawToken({ contractAddress: '0x04', symbol: 'LOWHOLD', holders: '100' }),
  ];
  h.setFeed(cases);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed(cases.map(token => ({ ...token, price: token.symbol === 'NOPRICE' ? '0' : '2.0' })));
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
  assert.equal(h.radar.health().tracked, 0);
});

test('24h change window gates: too late (>=60) or dumping (<=-20) never trigger', async () => {
  const h = harness();
  const late = rawToken({ contractAddress: '0x10', symbol: 'LATE', percentChange24h: '60' });
  const dumping = rawToken({ contractAddress: '0x11', symbol: 'DUMP', percentChange24h: '-20' });
  h.setFeed([late, dumping]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([
    { ...late, price: '2.0' },
    { ...dumping, price: '2.0' },
  ]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
});

test('soft confirmation: liquidity bleed vs 30m reference suppresses the trigger', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0', liquidity: '400000' })]);
  await h.radar.pollOnce();
  h.advance(20 * 60_000);
  h.setFeed([rawToken({ price: '1.0', liquidity: '380000' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04', liquidity: '380000' })]); // -5% liq vs 30m ref
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
});

test('soft confirmation: decreasing holders vs previous point suppresses the trigger', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0', holders: '2000' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04', holders: '1900' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
});

test('per-token cooldown suppresses a second trigger inside the window', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();
  assert.equal(h.messages.length, 1);

  h.advance(90_000);
  h.setFeed([rawToken({ price: '1.06' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 1);
  assert.equal(h.radar.metrics.suppressed.cooldown, 1);
  assert.equal(h.radar.metrics.alerts, 1);
});

test('global hourly cap suppresses alerts beyond the limit', async () => {
  const h = harness();
  const tokens = [1, 2, 3, 4, 5].map(i =>
    rawToken({ contractAddress: `0x${i}`, symbol: `T${i}` }));
  h.setFeed(tokens.map(token => ({ ...token, price: '1.0' })));
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed(tokens.map(token => ({ ...token, price: '1.04' })));
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 4); // cap is 4/hour
  assert.equal(h.radar.metrics.alerts, 4);
  assert.equal(h.radar.metrics.suppressed.cap, 1);
});

test('engine pause suppresses the alert before the security screen', async () => {
  const h = harness({ paused: true });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.radar.metrics.suppressed.paused, 1);
  assert.deepEqual(h.securityCalls, []); // no wasted on-chain call while paused
});

test('hardBlock security result is silent', async () => {
  const h = harness({
    security: { ...goodSecurity, rating: 'BLOCKED', hardBlock: true, riskScore: 10, critical: ['honeypot detected'] },
  });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.radar.metrics.blocked, 1);
});

test('risk score above the ceiling is silent', async () => {
  const h = harness({
    security: { ...goodSecurity, rating: 'POSSIBLE_RUG', riskScore: 6 },
  });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.radar.metrics.blocked, 1);
});

test('POSSIBLE_RUG/CAUTION ratings still alert but carry the warning label', async () => {
  const h = harness({
    security: { ...goodSecurity, rating: 'POSSIBLE_RUG', riskScore: 4 },
  });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /⚠️ POSSIBLE RUG/);
  assert.equal(h.radar.metrics.alerts, 1);
});

test('security provider failure is fail-safe: no alert, error counted, next cycle recovers', async () => {
  const h = harness({ securityThrows: true });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.radar.metrics.errors, 1);
  assert.equal(h.radar.lastError, 'provider down');

  h.radar.assessSecurity = async () => goodSecurity;
  h.advance(90_000);
  h.setFeed([rawToken({ price: '1.05' })]);
  await h.radar.pollOnce();
  assert.equal(h.messages.length, 1);
});

test('dedup hit (insertEvent → false) suppresses the telegram send', async () => {
  const h = harness({ insertResult: false });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.events.length, 1); // persistence was attempted first
  assert.equal(h.radar.metrics.dedupSkipped, 1);
  assert.equal(h.radar.metrics.alerts, 0);
});

test('database error never silences the alert', async () => {
  const h = harness({ insertThrows: true });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 1);
  assert.equal(h.radar.metrics.alerts, 1);
  assert.equal(h.radar.metrics.dedupSkipped, 0);
});

test('fetch failure is counted and pollOnce resolves without throwing', async () => {
  const h = harness();
  h.radar.fetcher = async () => { throw new Error('alpha feed down'); };
  const result = await h.radar.pollOnce();
  assert.equal(result.error, 'alpha feed down');
  assert.equal(h.radar.metrics.errors, 1);
  assert.equal(h.radar.lastError, 'alpha feed down');
  assert.equal(h.radar.metrics.polls, 0);
});

test('health reports enabled/lastPollAt/tracked/metrics/lastError', async () => {
  const h = harness();
  const before = h.radar.health();
  assert.equal(before.enabled, true);
  assert.equal(before.lastPollAt, null);
  assert.equal(before.tracked, 0);
  assert.equal(before.lastError, null);
  assert.ok(before.metrics);

  h.setFeed([rawToken()]);
  await h.radar.pollOnce();
  const after = h.radar.health();
  assert.equal(after.lastPollAt, new Date(T0).toISOString());
  assert.equal(after.tracked, 1);
  assert.equal(after.metrics.polls, 1);
});

test('disabled config short-circuits pollOnce and start', async () => {
  const h = harness({ config: { ...cfg, enableAlphaFastMover: false } });
  h.setFeed([rawToken()]);
  const result = await h.radar.pollOnce();
  assert.deepEqual(result, { skipped: 'disabled' });
  h.radar.start();
  assert.equal(h.radar.timer, null);
  assert.equal(h.radar.health().enabled, false);
});

test('a second pollOnce during an in-flight poll returns the skip result', async () => {
  const h = harness();
  h.setFeed([rawToken()]);
  h.radar.fetcher = async () => {
    await new Promise(resolve => setImmediate(resolve)); // keep the poll in flight for one macrotask
    return { data: [rawToken()] };
  };
  const first = h.radar.pollOnce();
  const second = await h.radar.pollOnce(); // overlaps the in-flight poll
  assert.deepEqual(second, { skipped: 'already running' });
  assert.equal(h.radar.metrics.polls, 0); // the skip is not counted as a poll

  assert.deepEqual(await first, { processed: 1 });
  assert.equal(h.radar.metrics.polls, 1);
  assert.equal(h.radar.polling, false); // guard cleared by the finally block

  const third = await h.radar.pollOnce(); // next poll runs normally again
  assert.deepEqual(third, { processed: 1 });
  assert.equal(h.radar.metrics.polls, 2);
});

test('expired cooldown entries are pruned during the poll', async () => {
  const h = harness();
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();
  assert.equal(h.messages.length, 1);
  assert.equal(h.radar.cooldowns.size, 1);

  h.advance(61 * 60_000); // past the 60-minute cooldown
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();
  assert.equal(h.radar.cooldowns.size, 0); // stale entry pruned
});

test('dedup-skipped alerts do not burn hourly-cap slots', async () => {
  const h = harness({ insertResult: false });
  const tokens = [1, 2, 3, 4, 5].map(i =>
    rawToken({ contractAddress: `0x${i}`, symbol: `T${i}` }));
  h.setFeed(tokens.map(token => ({ ...token, price: '1.0' })));
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed(tokens.map(token => ({ ...token, price: '1.04' })));
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.dedupSkipped, 5);
  assert.equal(h.radar.metrics.suppressed.cap, 0); // cap (4/hour) never engaged
  assert.equal(h.radar.alertTimestamps.length, 0);
});

test('a failed telegram send counts an error and does not burn an hourly slot', async () => {
  const h = harness();
  h.radar.telegram = { send: async () => { throw new Error('telegram down'); } };
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  h.advance(10 * 60_000);
  h.setFeed([rawToken({ price: '1.04' })]);
  await h.radar.pollOnce();

  assert.equal(h.radar.metrics.errors, 1);
  assert.equal(h.radar.lastError, 'telegram down');
  assert.equal(h.radar.metrics.alerts, 0);
  assert.equal(h.radar.alertTimestamps.length, 0); // no slot burned

  // The pre-send cooldown still stops tick-level retrigger (unchanged behavior).
  h.advance(90_000);
  h.setFeed([rawToken({ price: '1.05' })]);
  await h.radar.pollOnce();
  assert.equal(h.radar.metrics.suppressed.cooldown, 1);
});

test('reference staleness cap is clamped to 5 minutes regardless of poll interval', async () => {
  const h = harness({ config: { ...cfg, alphaMoverPollMs: 600_000 } });
  h.setFeed([rawToken({ price: '1.0' })]);
  await h.radar.pollOnce();
  // 16m later: the 10m reference target is 6m after the only point — inside the
  // unclamped 2×10m cap but outside the 5-minute clamp; the 30m window has no reference.
  h.advance(16 * 60_000);
  h.setFeed([rawToken({ price: '1.10' })]);
  await h.radar.pollOnce();

  assert.equal(h.messages.length, 0);
  assert.equal(h.radar.metrics.triggers, 0);
});

test('start is idempotent and stop clears the timer', async () => {
  const h = harness();
  h.setFeed([rawToken()]);
  h.radar.start();
  const timer = h.radar.timer;
  assert.ok(timer);
  h.radar.start(); // idempotent — same timer, no double loop
  assert.equal(h.radar.timer, timer);
  h.radar.stop();
  assert.equal(h.radar.timer, null);
  await new Promise(resolve => setTimeout(resolve, 5)); // let the in-flight first poll settle
  assert.equal(h.radar.metrics.errors, 0);
});
