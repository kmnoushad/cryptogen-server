import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GoldPaperAccount } from '../src/gold/paper-account.js';

const configFor = (stateFile) => ({
  stateFile,
  paperStartBalance: 100,
  paperRiskPct: 0.01,
  paperDailyLossUsd: 3,
  contractOzPerLot: 100,
  brokerMinimumLot: 0.01,
  estimatedSpreadUsd: 0,
  estimatedSlippageUsd: 0,
});

test('paper account opens and closes a simulated target without broker execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gold-paper-'));
  try {
    const account = new GoldPaperAccount(configFor(join(directory, 'state.json')));
    await account.load();
    const trade = account.open({ direction: 'LONG', entry: 2_500, stop: 2_490, target1: 2_510, target2: 2_520 }, 1_000);
    assert.ok(trade);
    assert.equal(trade.initialRiskUsd, 1);
    const first = account.applyBar({ time: 2_000, open: 2_500, high: 2_511, low: 2_499, close: 2_508 });
    assert.equal(first[0].reason, 'TARGET_1');
    const second = account.applyBar({ time: 3_000, open: 2_510, high: 2_521, low: 2_509, close: 2_520 });
    assert.equal(second[0].reason, 'TARGET_2');
    assert.equal(account.summary().closed, 1);
    assert.ok(account.summary().balance > 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('paper account applies conservative stop-first ordering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gold-paper-'));
  try {
    const account = new GoldPaperAccount(configFor(join(directory, 'state.json')));
    await account.load();
    account.open({ direction: 'LONG', entry: 2_500, stop: 2_490, target1: 2_510, target2: 2_520 }, 1_000);
    const events = account.applyBar({ time: 2_000, open: 2_500, high: 2_521, low: 2_489, close: 2_505 });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'STOP');
    assert.ok(account.summary().balance < 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

