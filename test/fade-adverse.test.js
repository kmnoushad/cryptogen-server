import test from 'node:test';
import assert from 'node:assert/strict';
import { fadeAdverseQuote, fadeAdverseEntryBlocked } from '../src/fade-adverse.js';

test('warns only as a short approaches its existing stop; runner and invalid quotes are ignored', () => {
  const job = { phase: 'OPEN', plan: { entry: 100, stop: 101 } };
  assert.equal(fadeAdverseQuote(job, 100.74).state, 'CLEAR');
  assert.equal(fadeAdverseQuote(job, 100.75).state, 'NEAR_STOP');
  assert.equal(fadeAdverseQuote(job, 101).state, 'STOP_REACHED');
  assert.equal(fadeAdverseQuote({ ...job, phase: 'RUNNER' }, 100.9), null);
  assert.equal(fadeAdverseQuote(job, NaN), null);
});

test('fresh sustained adverse move blocks only new entries until quote recovers', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const job = { phase: 'OPEN', plan: { entry: 100, stop: 101 },
    adverseChecks: 3, lastObservedAsk: 100.8, lastQuoteAt: now - 5000 };
  assert.equal(fadeAdverseEntryBlocked([job], now), true);
  assert.equal(fadeAdverseEntryBlocked([{ ...job, lastObservedAsk: 100.5 }], now), false);
  assert.equal(fadeAdverseEntryBlocked([{ ...job, adverseChecks: 2 }], now), false);
  assert.equal(fadeAdverseEntryBlocked([{ ...job, lastQuoteAt: now - 61000 }], now), false);
});
