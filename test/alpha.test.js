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

test('Alpha QUALIFIED stays silent and only passed IGNITION is sent', async () => {
  const messages = [];
  const events = [];
  const store = {
    insertEvent: async event => { events.push(event); return true; },
  };
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
