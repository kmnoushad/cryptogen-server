import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadLagRecorder } from '../src/gold/leadlag-recorder.js';

test('research recorder samples each venue independently and persists events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexio-leadlag-'));
  try {
    const recorder = new LeadLagRecorder({ dir, sampleMs: 250 });
    const at = Date.parse('2026-11-03T16:00:00.000Z');
    recorder.tick('MT5', { bid: 4000, ask: 4000.1, exchangeTs: at, receivedTs: at });
    recorder.tick('MT5', { bid: 4001, ask: 4001.1, exchangeTs: at+100, receivedTs: at+100 });
    recorder.tick('BINANCE', { bid: 4000, ask: 4000.1, exchangeTs: at, receivedTs: at });
    recorder.tick('MT5', { bid: 4002, ask: 4002.1, exchangeTs: at+300, receivedTs: at+300 });
    recorder.event('signal', { leader: 'MT5', follower: 'BINANCE' });
    const files = readdirSync(dir);
    assert.ok(files.includes('2026-11-03.jsonl'));
    const quotes = readFileSync(join(dir, '2026-11-03.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(quotes.length, 3);
    assert.deepEqual(quotes.map(x => x.venue), ['MT5','BINANCE','MT5']);
    assert.equal(quotes[1].type, 'quote');
    assert.ok(files.some(x => x.endsWith('.jsonl')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
