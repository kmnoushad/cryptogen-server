import { Store } from './store.js';
import { requestJson } from './http.js';
export const futuresScope = environment => {
  if (!['live', 'testnet'].includes(environment)) throw Error('Invalid Futures environment');
  return `${environment}:directional`;
};
export class FuturesAutoStore extends Store {
  async rpc(name, body) {
    const rows = await requestJson(`${this.base}/rpc/${name}`, { method: 'POST', headers: this.headers,
      body: JSON.stringify(body), retries: 0, timeoutMs: 7000 });
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('Futures execution lease/revision unavailable');
    return rows[0];
  }
  fadeLease(scope, owner) { return this.rpc('nexio_futures_lease', { p_scope: scope, p_owner: owner }); }
  fadeSave(scope, owner, revision, state) { return this.rpc('nexio_futures_save', { p_scope: scope, p_owner: owner, p_revision: revision, p_state: state }); }
  async control(scope) {
    const rows = await this.get('nexio_futures_control', [['scope', `eq.${scope}`], ['select', '*']]);
    if (!Array.isArray(rows) || rows.length !== 1) throw Error('Futures control migration missing');
    return rows[0];
  }
  setControl(scope, action) { return this.rpc('nexio_futures_control_set', { p_scope: scope, p_action: action }); }
  heartbeat(scope, report) {
    return requestJson(this.url('nexio_futures_worker_status', [['on_conflict', 'scope']]), {
      method: 'POST', headers: { ...this.headers, prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ scope, report, updated_at: new Date().toISOString() }), retries: 0, timeoutMs: 7000 });
  }
}
