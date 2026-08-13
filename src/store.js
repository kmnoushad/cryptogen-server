import { HttpError, requestJson } from './http.js';
import { consecutiveLosses, dubaiDayBounds, sleep } from './util.js';

// PostgREST "table missing" signatures: 404 from the REST router, PGRST205
// (table not in schema cache), 42P01 (undefined table).
export const isBtcTableMissingError = error =>
  error instanceof HttpError
  && (error.status === 404 || /PGRST205|42P01/.test(String(error.body ?? '')));

export class Store {
  constructor(cfg) {
    this.base = `${cfg.supabaseUrl}/rest/v1`;
    this.alphaEnabled = cfg.enableAlphaSignals;
    this.headers = {
      apikey: cfg.supabaseKey,
      authorization: `Bearer ${cfg.supabaseKey}`,
      'content-type': 'application/json',
    };
  }

  url(table, entries = []) {
    const query = new URLSearchParams(entries);
    return `${this.base}/${table}${query.size ? `?${query}` : ''}`;
  }

  get(table, entries = []) {
    return requestJson(this.url(table, entries), { headers: this.headers, timeoutMs: 10_000 });
  }

  async health() {
    const checks = [this.get('nexio_trades', [['select', 'id,exit_alert_sent'], ['limit', '1']])];
    if (this.alphaEnabled) {
      checks.push(this.get('nexio_alpha_tokens', [['select', 'chain_id'], ['limit', '1']]));
      checks.push(this.get('nexio_alpha_trades', [['select', 'id,exit_alert_sent'], ['limit', '1']]));
    }
    await Promise.all(checks);
    return true;
  }

  async createTrade(trade) {
    try {
      const rows = await requestJson(this.url('nexio_trades'), {
        method: 'POST',
        headers: { ...this.headers, prefer: 'return=representation' },
        body: JSON.stringify(trade),
        timeoutMs: 10_000,
        retries: 0,
      });
      if (!Array.isArray(rows) || !rows[0]) throw new Error('Supabase did not return the created trade');
      return { created: true, trade: rows[0] };
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) return { created: false, conflict: true };
      throw error;
    }
  }

  async updateTrade(id, patch) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const rows = await requestJson(this.url('nexio_trades', [['id', `eq.${id}`]]), {
          method: 'PATCH',
          headers: { ...this.headers, prefer: 'return=representation' },
          body: JSON.stringify(patch),
          timeoutMs: 10_000,
          retries: 0,
        });
        return Array.isArray(rows) ? rows[0] : null;
      } catch (error) {
        lastError = error;
        if (attempt === 0 && (!(error instanceof HttpError) || error.status >= 500 || error.status === 429)) {
          await sleep(500);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  listOpenTrades() {
    return this.get('nexio_trades', [
      ['status', 'eq.OPEN'],
      ['select', '*'],
      ['order', 'created_at.asc'],
    ]);
  }

  recentClosed(limit = 200) {
    return this.get('nexio_trades', [
      ['status', 'eq.CLOSED'],
      ['select', '*'],
      ['order', 'closed_at.desc'],
      ['limit', String(limit)],
    ]);
  }

  pendingTradeOutcomeAlerts(limit = 20) {
    return this.get('nexio_trades', [
      ['status', 'eq.CLOSED'],
      ['exit_alert_sent', 'eq.false'],
      ['select', '*'],
      ['order', 'closed_at.asc'],
      ['limit', String(limit)],
    ]);
  }

  async insertEvent(event) {
    try {
      await requestJson(this.url('nexio_events'), {
        method: 'POST',
        headers: { ...this.headers, prefer: 'return=minimal' },
        body: JSON.stringify(event),
        timeoutMs: 8_000,
        retries: 0,
      });
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) return false;
      throw error;
    }
  }

  // v6.9.6 BTC recorder (additive). Same PostgREST pattern as insertEvent but
  // NEVER throws: recording is best-effort and must not disturb trading. On a
  // table-missing reply it flags btcSnapshotsTableMissing so the recorder can
  // warn once and disable itself (run sql/btc_snapshots.sql).
  async insertBtcSnapshot(row) {
    try {
      await requestJson(this.url('btc_snapshots'), {
        method: 'POST',
        headers: { ...this.headers, prefer: 'return=minimal' },
        body: JSON.stringify(row),
        timeoutMs: 8_000,
        retries: 0,
      });
      return true;
    } catch (error) {
      if (isBtcTableMissingError(error)) this.btcSnapshotsTableMissing = true;
      this.lastBtcSnapshotError = error.message;
      return false;
    }
  }

  async deleteEvent(eventKey) {
    await requestJson(this.url('nexio_events', [['event_key', `eq.${eventKey}`]]), {
      method: 'DELETE',
      headers: { ...this.headers, prefer: 'return=minimal' },
      timeoutMs: 8_000,
      retries: 0,
    });
    return true;
  }

  loadAlphaStates() {
    return this.get('nexio_alpha_tokens', [
      ['select', '*'],
      ['order', 'last_seen_at.desc'],
      ['limit', '1000'],
    ]);
  }

  async upsertAlphaStates(rows) {
    if (!Array.isArray(rows) || !rows.length) return [];
    return requestJson(this.url('nexio_alpha_tokens', [
      ['on_conflict', 'chain_id,contract_address'],
    ]), {
      method: 'POST',
      headers: { ...this.headers, prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
      timeoutMs: 20_000,
      retries: 0,
    });
  }

  async createAlphaTrade(trade) {
    try {
      const rows = await requestJson(this.url('nexio_alpha_trades'), {
        method: 'POST',
        headers: { ...this.headers, prefer: 'return=representation' },
        body: JSON.stringify(trade),
        timeoutMs: 10_000,
        retries: 0,
      });
      if (!Array.isArray(rows) || !rows[0]) throw new Error('Supabase did not return the Alpha trade');
      return { created: true, trade: rows[0] };
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) return { created: false, conflict: true };
      throw error;
    }
  }

  async updateAlphaTrade(id, patch) {
    const rows = await requestJson(this.url('nexio_alpha_trades', [['id', `eq.${id}`]]), {
      method: 'PATCH',
      headers: { ...this.headers, prefer: 'return=representation' },
      body: JSON.stringify(patch),
      timeoutMs: 10_000,
      retries: 0,
    });
    return Array.isArray(rows) ? rows[0] : null;
  }

  listOpenAlphaTrades() {
    return this.get('nexio_alpha_trades', [
      ['status', 'eq.OPEN'],
      ['select', '*'],
      ['order', 'created_at.asc'],
    ]);
  }

  recentClosedAlpha(limit = 200) {
    return this.get('nexio_alpha_trades', [
      ['status', 'eq.CLOSED'],
      ['select', '*'],
      ['order', 'closed_at.desc'],
      ['limit', String(limit)],
    ]);
  }

  pendingAlphaOutcomeAlerts(limit = 20) {
    return this.get('nexio_alpha_trades', [
      ['status', 'eq.CLOSED'],
      ['exit_alert_sent', 'eq.false'],
      ['select', '*'],
      ['order', 'closed_at.asc'],
      ['limit', String(limit)],
    ]);
  }

  futuresGateSummaries(hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60_000).toISOString();
    return this.get('nexio_events', [
      ['event_type', 'eq.FUTURES_GATE_SUMMARY'],
      ['created_at', `gte.${since}`],
      ['select', 'payload,created_at'],
      ['order', 'created_at.desc'],
      ['limit', '100'],
    ]);
  }

  async auditSnapshot(limit = 200) {
    const [futures, alpha] = await Promise.all([this.recentClosed(limit), this.recentClosedAlpha(limit)]);
    const summarize = (rows, pnlKey) => {
      const wins = rows.filter(row => row.outcome === 'WIN').length;
      const losses = rows.filter(row => row.outcome === 'LOSS').length;
      const scratches = rows.filter(row => row.outcome === 'SCRATCH' || row.outcome === 'TIMEOUT').length;
      const pnl = rows.reduce((sum, row) => sum + Number(row[pnlKey] ?? 0), 0);
      return { total: rows.length, wins, losses, scratches, pnl };
    };
    return {
      futures: { ...summarize(futures, 'net_pnl_pct'), rows: futures },
      alpha: { ...summarize(alpha, 'pnl_pct'), rows: alpha },
    };
  }

  async riskSnapshot(cfg, now = new Date()) {
    const day = dubaiDayBounds(now);
    const weekStart = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
    const [openedToday, closedToday, weekly, open, recent] = await Promise.all([
      this.get('nexio_trades', [
        ['created_at', `gte.${day.start}`], ['created_at', `lt.${day.end}`],
        ['status', 'neq.CANCELLED'], ['select', 'id,status,created_at'],
      ]),
      this.get('nexio_trades', [
        ['status', 'eq.CLOSED'], ['closed_at', `gte.${day.start}`], ['closed_at', `lt.${day.end}`],
        ['select', 'net_pnl_pct,outcome,closed_at'],
      ]),
      this.get('nexio_trades', [
        ['status', 'eq.CLOSED'], ['closed_at', `gte.${weekStart}`], ['select', 'net_pnl_pct'],
      ]),
      this.get('nexio_trades', [['status', 'eq.OPEN'], ['select', 'id']]),
      this.get('nexio_trades', [
        ['status', 'eq.CLOSED'], ['select', 'outcome,closed_at'], ['order', 'closed_at.desc'], ['limit', '20'],
      ]),
    ]);

    const dailyPnlPct = closedToday.reduce((sum, trade) => sum + Number(trade.net_pnl_pct ?? 0), 0);
    const weeklyPnlPct = weekly.reduce((sum, trade) => sum + Number(trade.net_pnl_pct ?? 0), 0);
    const losses = consecutiveLosses(recent);
    const consecutiveLossBlock = losses >= cfg.maxConsecutiveLosses
      && recent[0]?.closed_at >= day.start
      && recent[0]?.closed_at < day.end;
    const reasons = [];
    if (openedToday.length >= cfg.maxTradesPerDay) reasons.push(`daily trade cap ${openedToday.length}/${cfg.maxTradesPerDay}`);
    if (dailyPnlPct <= cfg.dailyStopPct) reasons.push(`daily stop ${dailyPnlPct.toFixed(2)}%`);
    if (dailyPnlPct >= cfg.dailyTargetPct) reasons.push(`daily target secured ${dailyPnlPct.toFixed(2)}%`);
    if (weeklyPnlPct <= cfg.weeklyStopPct) reasons.push(`weekly stop ${weeklyPnlPct.toFixed(2)}%`);
    if (consecutiveLossBlock) reasons.push(`${losses} consecutive losses today`);
    if (open.length >= cfg.maxOpenTrades) reasons.push(`open-trade cap ${open.length}/${cfg.maxOpenTrades}`);
    return {
      allowed: reasons.length === 0,
      reasons,
      day: day.label,
      tradesToday: openedToday.length,
      dailyPnlPct,
      weeklyPnlPct,
      consecutiveLosses: losses,
      openTrades: open.length,
    };
  }

  async symbolCooldown(symbol, cfg, now = Date.now()) {
    const rows = await this.get('nexio_trades', [
      ['symbol', `eq.${symbol}`],
      ['status', 'eq.CLOSED'],
      ['select', 'outcome,exit_reason,closed_at'],
      ['order', 'closed_at.desc'],
      ['limit', '1'],
    ]);
    const last = rows[0];
    if (!last || last.outcome !== 'LOSS') return { blocked: false, minutesLeft: 0 };
    const ageMin = (now - new Date(last.closed_at).getTime()) / 60_000;
    const minutesLeft = Math.ceil(cfg.symbolLossCooldownMin - ageMin);
    return {
      blocked: minutesLeft > 0,
      minutesLeft: Math.max(0, minutesLeft),
      reason: last.exit_reason,
    };
  }

  async statistics(limit = 200) {
    const trades = await this.recentClosed(limit);
    const wins = trades.filter(t => t.outcome === 'WIN');
    const losses = trades.filter(t => t.outcome === 'LOSS');
    const scratches = trades.filter(t => t.outcome === 'SCRATCH');
    const pnl = trades.map(t => Number(t.net_pnl_pct ?? 0));
    const r = trades.map(t => Number(t.r_multiple ?? 0));
    const grossProfit = pnl.filter(x => x > 0).reduce((sum, x) => sum + x, 0);
    const grossLoss = Math.abs(pnl.filter(x => x < 0).reduce((sum, x) => sum + x, 0));
    return {
      total: trades.length,
      wins: wins.length,
      losses: losses.length,
      scratches: scratches.length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      netPnlPct: pnl.reduce((sum, x) => sum + x, 0),
      expectancyR: r.length ? r.reduce((sum, x) => sum + x, 0) / r.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    };
  }
}
