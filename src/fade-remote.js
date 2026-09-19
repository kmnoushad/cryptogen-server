import { escapeHtml } from './util.js';

export class FadeRemote {
  constructor({ cfg, store }) { this.cfg = cfg; this.store = store; }
  scope() {
    if (!['testnet', 'live'].includes(this.cfg.fadeEnvironment)) throw Error('Set FADE_ENVIRONMENT to testnet or live');
    return `${this.cfg.fadeEnvironment}:primary`;
  }
  health() { return { external: true, localExecution: false }; }
  async publish(symbol, signal) {
    // Written only after Telegram delivery. Original informational events cannot execute.
    await this.store.insertEvent({
      event_key: `fade-worker-v1:${symbol}:${signal.peakTime}`,
      event_type: 'FADE_WORKER_SIGNAL_V1', symbol,
      payload: { ...signal, model: 'pump-fade-v1' },
    });
  }
  async status() {
    try {
      const scope = this.scope();
      const [control, rows] = await Promise.all([
        this.store.fadeControl(scope),
        this.store.get('nexio_fade_worker_status', [['scope', `eq.${scope}`], ['select', '*']]),
      ]);
      const status = rows[0];
      const age = status ? Date.now() - Date.parse(status.updated_at) : Infinity;
      const fresh = age >= 0 && age < 60000;
      return `🤖 <b>FADE AUTO — EXTERNAL ${this.cfg.fadeEnvironment.toUpperCase()}</b>\n` +
        `Requested entries: ${control.paused ? 'PAUSED' : 'enabled'}${control.close_requested ? ' · close requested' : ''}\n` +
        `Worker: ${fresh ? 'heartbeat received' : 'OFFLINE / STALE — execution state unconfirmed'}\n` +
        (status ? escapeHtml(status.report) : 'No worker has reported yet.') +
        '\nCommands are requests; check worker acknowledgement and Binance.\n/fadepause /faderesume /fadecloseall';
    } catch { return 'External fade status unavailable. Check FADE_ENVIRONMENT and run sql/fade_worker.sql. Railway alerts remain independent.'; }
  }
  async control(action) {
    try {
      await this.store.fadeSetControl(this.scope(), action);
      return `Fade ${action} requested in Supabase. Pending worker processing; not an exchange confirmation. Check /fadeauto.`;
    } catch { return 'Fade control request failed; no confirmation. Check Binance directly and worker/database configuration.'; }
  }
}
