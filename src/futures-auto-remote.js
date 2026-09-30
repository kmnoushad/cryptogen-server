import { FuturesAutoStore, futuresScope } from './futures-auto-store.js';
import { escapeHtml } from './util.js';
export class FuturesAutoRemote {
  constructor({ cfg, env = process.env }) {
    this.store = new FuturesAutoStore(cfg); this.environment = env.FUTURES_AUTO_ENVIRONMENT ?? 'testnet';
  }
  async status() {
    try {
      const scope = futuresScope(this.environment);
      const [control, rows] = await Promise.all([this.store.control(scope), this.store.get('nexio_futures_worker_status', [['scope', `eq.${scope}`], ['select', '*']])]);
      const s = rows[0], age = s ? Date.now() - Date.parse(s.updated_at) : Infinity;
      return `FUTURES AUTO — EXTERNAL ${escapeHtml(this.environment.toUpperCase())}\nRequested entries: ${control.paused ? 'PAUSED' : 'enabled'}\n` +
        `Worker: ${age >= 0 && age < 60000 ? 'heartbeat received' : 'OFFLINE / STALE — execution unconfirmed'}\n` +
        (s ? escapeHtml(s.report) : 'No separate Futures worker has reported yet.');
    } catch { return 'Futures auto unavailable. Set FUTURES_AUTO_ENVIRONMENT and install sql/futures_auto.sql. Check the separate AWS worker.'; }
  }
  async control(action) {
    try { await this.store.setControl(futuresScope(this.environment), action);
      return `Futures ${action} requested. Check worker acknowledgement with /futuresauto and the separate Binance subaccount.`;
    } catch { return 'Futures control request failed; no exchange confirmation. Check the separate subaccount directly.'; }
  }
}
