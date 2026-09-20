export const workerStalled = (worker, now = Date.now(), limit = 45000) => worker.busy
  && Number.isFinite(worker.tickStartedAt) && now - worker.tickStartedAt > limit;

// Serial polling; one Telegram poller stays on Railway. No scanners run here.
export class FadeWorkerLoop {
  constructor({ executor, store, now = () => Date.now() }) {
    Object.assign(this, { executor, store, now });
    this.startedAt = now(); this.seen = new Map(); this.busy = false;
    this.tickStartedAt = null; this.lastCompletedAt = this.startedAt;
    this.control = { paused: true }; this.stopped = false;
    executor.isPaused = () => this.stopped || this.control.paused || this.control.close_requested;
    executor.authorizeEntry = async () => {
      this.control = await store.fadeControl(executor.scope);
      return !this.stopped && !this.control.paused && !this.control.close_requested;
    };
  }
  stop() { this.stopped = true; this.executor.stop(); }
  valid(event) {
    const s = event.payload;
    const created = Date.parse(event.created_at);
    return event.event_type === 'FADE_WORKER_SIGNAL_V1'
      && /^[A-Z0-9]+USDT$/.test(event.symbol ?? '') && s?.model === 'pump-fade-v1'
      && Number.isFinite(created) && created >= this.startedAt && created <= this.now()
      && Number.isFinite(s.barCloseTime) && this.now() - s.barCloseTime >= 0
      && this.now() - s.barCloseTime <= 90000
      && Number.isFinite(s.peakTime) && s.peakTime < s.barCloseTime
      && Number.isFinite(s.price) && s.price > 0
      && Number.isFinite(s.resistance) && s.resistance > s.price;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true; this.tickStartedAt = this.now();
    let error = null;
    try {
      // Protect existing positions even when the signal/control channel fails.
      await this.executor.run();
      if (this.executor.enabled()) {
        this.control = await this.store.fadeControl(this.executor.scope);
        if (this.control.close_requested) await this.executor.control('close');
        else if (this.executor.row && this.executor.row.state.paused !== this.control.paused) {
          await this.executor.control(this.control.paused ? 'pause' : 'resume');
        }
        const events = await this.store.fadeSignals(Math.max(this.startedAt, this.now() - 90000));
        for (const event of events) {
          if (this.stopped) break;
          if (!this.valid(event) || this.seen.has(event.event_key)) continue;
          // Skip, never queue a catch-up entry, if paused or full. Journal dedups across workers.
          this.seen.set(event.event_key, this.now());
          const resumedAt = Date.parse(this.control.updated_at ?? new Date(this.startedAt).toISOString());
          if (!this.control.paused && !this.control.close_requested && Date.parse(event.created_at) >= resumedAt) {
            await this.executor.onSignal(event.symbol, event.payload);
          }
        }
        for (const [key, time] of this.seen) if (this.now() - time > 120000) this.seen.delete(key);
      }
    } catch (e) { error = e; this.control = { paused: true }; }
    finally {
      try {
        await this.store.fadeHeartbeat(this.executor.scope,
          this.executor.status().replace(/<[^>]*>/g, '') + (error ? '\nSignal/control channel unavailable; new entries blocked.' : ''));
      } catch { /* An absent heartbeat is surfaced by Railway as stale. */ }
      this.lastCompletedAt = this.now(); this.tickStartedAt = null;
      this.busy = false;
    }
  }
}
