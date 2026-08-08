import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvmToken, assessSolanaToken, assessSuiToken } from '../src/onchain-risk.js';

test('EVM honeypot and blocked selling are hard entry blocks', () => {
  const risk = assessEvmToken({
    is_open_source: '1',
    is_honeypot: '1',
    cannot_sell_all: '1',
    sell_tax: '1',
    holders: [],
    lp_holders: [],
  });
  assert.equal(risk.hardBlock, true);
  assert.equal(risk.rating, 'BLOCKED');
  assert.match(risk.critical.join(' '), /honeypot/);
  assert.match(risk.critical.join(' '), /selling/);
});

test('EVM mutable tax and unlocked concentration are labelled possible rug', () => {
  const risk = assessEvmToken({
    is_open_source: '1',
    is_honeypot: '0',
    cannot_sell_all: '0',
    slippage_modifiable: '1',
    holders: [{ percent: '0.35', is_locked: '0', tag: '' }],
    lp_holders: [{ percent: '0.75', is_locked: '0', tag: '' }],
  });
  assert.equal(risk.hardBlock, false);
  assert.equal(risk.rating, 'POSSIBLE_RUG');
  assert.ok(risk.riskScore >= 3);
});

test('Solana mint or freeze authority blocks an Alpha entry', () => {
  const risk = assessSolanaToken({
    mintable: { status: '1' },
    freezable: { status: '1' },
    holders: [],
    lp_holders: [],
  });
  assert.equal(risk.hardBlock, true);
  assert.match(risk.critical.join(' '), /mint authority/);
  assert.match(risk.critical.join(' '), /freeze authority/);
});

test('Sui blacklist capability blocks an Alpha entry', () => {
  const risk = assessSuiToken({
    blacklist: { value: '1' },
    mintable: { value: '0' },
    holders: [],
  });
  assert.equal(risk.hardBlock, true);
  assert.match(risk.critical.join(' '), /blacklist/);
});
