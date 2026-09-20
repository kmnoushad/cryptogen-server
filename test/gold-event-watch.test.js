import assert from 'node:assert/strict';
import test from 'node:test';
import { assessGoldEvent } from '../src/gold/event-watch.js';

test('trusted geopolitical escalation is labeled bullish and trusted report', () => {
  const event = assessGoldEvent({
    title: 'Iran missile attack hits oil facility in Gulf',
    url: 'https://www.reuters.com/world/example',
    seendate: '20260920T180000Z',
  });
  assert.equal(event.pressure, 'BULLISH');
  assert.equal(event.confidence, 'HIGH');
  assert.equal(event.status, 'CONFIRMED REPORT FROM TRUSTED SOURCE');
});

test('claimed escalation is explicitly marked not independently confirmed', () => {
  const event = assessGoldEvent({
    title: 'Group claims missile attack on Saudi oil facility',
    url: 'https://apnews.com/article/example',
  });
  assert.equal(event.pressure, 'BULLISH');
  assert.match(event.status, /NOT INDEPENDENTLY CONFIRMED/);
});

test('ordinary low-impact headline is suppressed', () => {
  const event = assessGoldEvent({
    title: 'Local company opens a new office',
    url: 'https://example.com/story',
  });
  assert.equal(event, null);
});

test('hawkish Fed headline is labeled bearish', () => {
  const event = assessGoldEvent({
    title: 'Federal Reserve turns hawkish and signals rate hike',
    url: 'https://www.federalreserve.gov/newsevents/example.htm',
  });
  assert.equal(event.pressure, 'BEARISH');
});
