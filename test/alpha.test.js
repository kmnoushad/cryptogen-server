import test from 'node:test';
import assert from 'node:assert/strict';
import { AlphaRadar } from '../src/alpha.js';

const cfg = {
  enableAlphaSignals: true,
  alphaScanIntervalMs: 240_000,
  alphaMinLiquidityUsd: 150_000,
  alphaMinVolumeUsd: 200_000,
  alphaMinHolders: 800,
  alphaMaxPossibleRugScore: 2,
  alphaMaxOnchainChecksPerScan: 20,
};

const tokenAt = (price, liquidity = 400_000) => ({
  chainId: '8453',
  chainName: 'Base',
  contractAddress: '0x0000000000000000000000000000000000000001',
  alphaId: 'ALPHA_TEST',
  symbol: 'TEST',
  name: 'Test',
  price,
  change24h: 3,
  volume24h: 800_000,
  liquidity,
  marketCap: 5_000_000,
  holders: 2_000,
  hotTag: false,
  listingTime: 0,
});

const goodSecurity = {
  rating: 'NO_CRITICAL_FLAGS', riskScore: 0, hardBlock: false,
  critical: [], warnings: [], metrics: {}, checkedAt: Date.now(),
};

const storeDouble = events => {
  const trades = [];
  return {
    insertEvent: async event => { events.push(event); return true; },
    createAlphaTrade: async trade => {
      const created = { id: `alpha-${trades.length + 1}`, status: 'OPEN', outcome: null,
        created_at: new Date().toISOString(), ...trade };
      trades.push(created);
      return { created: true, trade: created };
    },
    updateAlphaTrade: async (id, patch) => {
      const index = trades.findIndex(trade => trade.id === id);
      if (index < 0) return null;
      trades[index] = { ...trades[index], ...patch };
      return trades[index];
    },
    listOpenAlphaTrades: async () => trades.filter(trade => trade.status === 'OPEN'),
    pendingAlphaOutcomeAlerts: async () => trades.filter(trade => trade.status === 'CLOSED' && !trade.exit_alert_sent),
    trades,
  };
};

test('Alpha QUALIFIED stays silent and only passed IGNITION is sent', async () => {
  const messages = [];
  const events = [];
  const store = storeDouble(events);
  const telegram = {
    send: async message => { messages.push(message); },
    alphaIgnitionMessage: token => `[ALPHA] IGNITION ${token.symbol}`,
  };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();

  await radar.processToken(tokenAt(1.000), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.010), start + 480_000);
  assert.equal(radar.active()[0]?.state, 'QUALIFIED');
  assert.equal(messages.length, 0);
  assert.equal(events.some(event => event.event_type === 'ALPHA_QUALIFIED_SILENT'), true);

  await radar.processToken(tokenAt(1.025), start + 720_000);
  assert.deepEqual(messages, ['[ALPHA] IGNITION TEST']);
  assert.equal(radar.active()[0]?.state, 'IGNITED');
  assert.equal(store.trades.length, 1);
  assert.equal(store.trades[0].alert_sent, true);
});

test('critical Alpha risk is filtered silently', async () => {
  const messages = [];
  const events = [];
  const store = { insertEvent: async event => { events.push(event); return true; } };
  const telegram = { send: async message => messages.push(message), alphaIgnitionMessage: () => 'should not send' };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => ({
    rating: 'BLOCKED', riskScore: 10, hardBlock: true,
    critical: ['honeypot detected'], warnings: [], metrics: {}, checkedAt: Date.now(),
  });
  const start = Date.now();

  await radar.processToken(tokenAt(1.000), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.010), start + 480_000);

  assert.equal(messages.length, 0);
  assert.equal(events.some(event => event.event_type === 'ALPHA_RISK_FILTERED'), true);
});

test('issued Alpha entry is monitored and sends a deterministic stop instruction', async () => {
  const messages = [];
  const events = [];
  const store = storeDouble(events);
  const created = await store.createAlphaTrade({
    event_key: 'alpha:test', chain_id: '8453', chain_name: 'Base',
    contract_address: tokenAt(1).contractAddress, symbol: 'TEST', entry: 1,
    initial_sl: 0.97, active_sl: 0.97, tp1: 1.05, tp2: 1.08, tp3: 1.12,
    entry_liquidity: 400_000, current_liquidity: 400_000,
    peak_price: 1, lowest_price: 1, current_price: 1,
    max_gain_pct: 0, max_drawdown_pct: 0, setup_score: 8,
  });
  created.trade.created_at = new Date(Date.now() - 30 * 60_000).toISOString();
  const telegram = {
    send: async message => messages.push(message),
    alphaOutcomeMessage: trade => `[ALPHA] ${trade.exit_reason} ${trade.symbol}`,
  };
  const radar = new AlphaRadar({ cfg, store, telegram });

  await radar.manageOpenTrades([tokenAt(0.965)], Date.now());

  assert.equal(store.trades[0].status, 'CLOSED');
  assert.equal(store.trades[0].outcome, 'LOSS');
  assert.equal(store.trades[0].exit_reason, 'STOP');
  assert.equal(store.trades[0].exit_alert_sent, true);
  assert.deepEqual(messages, ['[ALPHA] STOP TEST']);
});

test('qualified Alpha token dequalifies when it no longer passes the entry universe', async () => {
  const events = [];
  const store = storeDouble(events);
  const telegram = { send: async () => {}, alphaIgnitionMessage: () => 'unused' };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();
  await radar.processToken(tokenAt(1), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.01), start + 480_000);
  assert.equal(radar.active().length, 1);

  const weak = tokenAt(1.011);
  weak.volume24h = 100_000;
  await radar.processToken(weak, start + 720_000, { entryEligible: false });
  assert.equal(radar.active().length, 0);
  assert.equal(radar.states.values().next().value.state, 'SEEDED');
});

test('v6.9.3 runner fix: QUALIFIED survives change24h >= 40 while hard floors hold', async () => {
  const events = [];
  const store = storeDouble(events);
  const telegram = {
    send: async () => {},
    alphaIgnitionMessage: token => `[ALPHA] IGNITION ${token.symbol}`,
  };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();
  await radar.processToken(tokenAt(1.000), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.010), start + 480_000);
  assert.equal(radar.active()[0]?.state, 'QUALIFIED');

  // The token goes vertical: change24h crosses the +40 heat cap. Entry is no
  // longer eligible, but every hard floor still passes — the QUALIFIED state
  // and its ignition window must survive (previously demoted to SEEDED).
  const runner = { ...tokenAt(1.012), change24h: 45 };
  await radar.processToken(runner, start + 720_000, { entryEligible: false });
  assert.equal(radar.active()[0]?.state, 'QUALIFIED');
  assert.ok(radar.states.values().next().value.qualifiedAt);
});

test('v6.9.3 runner fix: QUALIFIED runner past +40 can still complete IGNITION', async () => {
  const messages = [];
  const events = [];
  const store = storeDouble(events);
  const telegram = {
    send: async message => { messages.push(message); },
    alphaIgnitionMessage: token => `[ALPHA] IGNITION ${token.symbol}`,
  };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();
  await radar.processToken(tokenAt(1.000), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.010), start + 480_000);
  assert.equal(radar.active()[0]?.state, 'QUALIFIED');

  const runner = { ...tokenAt(1.025), change24h: 45 };
  await radar.processToken(runner, start + 720_000, { entryEligible: false });
  assert.equal(radar.active()[0]?.state, 'IGNITED');
  assert.deepEqual(messages, ['[ALPHA] IGNITION TEST']);
  assert.equal(store.trades.length, 1);
});

test('v6.9.3 runner fix: heat cap still blocks NEW SEEDED to QUALIFIED transitions', async () => {
  const events = [];
  const store = storeDouble(events);
  const telegram = { send: async () => {}, alphaIgnitionMessage: () => 'unused' };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();
  const hot = (price, change24h) => ({ ...tokenAt(price), change24h });
  await radar.processToken(hot(1.000, 41), start);
  await radar.processToken(hot(1.005, 42), start + 240_000);
  await radar.processToken(hot(1.010, 45), start + 480_000);

  // Perfect setup score, but change24h >= 40 — conservative entry preserved.
  assert.equal(radar.active().length, 0);
  assert.equal(radar.states.values().next().value.state, 'SEEDED');
  assert.equal(events.some(event => event.event_type === 'ALPHA_QUALIFIED_SILENT'), false);
});

test('v6.9.3 runner fix: demotion still happens when a hard floor fails', async () => {
  const events = [];
  const store = storeDouble(events);
  const telegram = { send: async () => {}, alphaIgnitionMessage: () => 'unused' };
  const radar = new AlphaRadar({ cfg, store, telegram });
  radar.security = async () => goodSecurity;
  const start = Date.now();
  await radar.processToken(tokenAt(1.000), start);
  await radar.processToken(tokenAt(1.005), start + 240_000);
  await radar.processToken(tokenAt(1.010), start + 480_000);
  assert.equal(radar.active()[0]?.state, 'QUALIFIED');

  // Holders hard floor fails while change24h is still modest: demote.
  // (A liquidity collapse would hit the earlier LIQUIDITY_DRAIN → BLOCKED
  // branch instead; that pre-existing protection is unchanged.)
  const drained = { ...tokenAt(1.011), holders: 100 };
  await radar.processToken(drained, start + 720_000, { entryEligible: false });
  assert.equal(radar.active().length, 0);
  assert.equal(radar.states.values().next().value.state, 'SEEDED');
});
