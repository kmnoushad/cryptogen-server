// Append-only research records. No trading or exchange APIs.
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export class LeadLagRecorder {
  constructor({ dir, sampleMs = 250 } = {}) {
    if (!dir) throw new Error('Research directory required');
    this.dir = dir;
    this.sampleMs = sampleMs;
    this.last = new Map();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  write(type, value, at = Date.now()) {
    if (!Number.isFinite(at)) return;
    const date = new Date(at).toISOString().slice(0, 10);
    const file = join(this.dir, date + '.jsonl');
    appendFileSync(file, JSON.stringify({ type, recordedAt: at, ...value }) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  tick(venue, { bid, ask, exchangeTs, receivedTs }) {
    const previous = this.last.get(venue) ?? -Infinity;
    if (receivedTs - previous < this.sampleMs) return;
    this.last.set(venue, receivedTs);
    this.write('quote', { venue, bid, ask, exchangeTs, receivedTs }, receivedTs);
  }
  event(type, value) {
    this.write(type, value);
  }
}
