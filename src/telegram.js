import { requestJson } from './http.js';
import { escapeHtml, formatPrice, gstTime, log, sleep } from './util.js';

export class Telegram {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = `https://api.telegram.org/bot${cfg.botToken}`;
    this.offset = 0;
    this.stopping = false;
  }

  async send(text, chatId = this.cfg.ownerChatId) {
    const result = await requestJson(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      timeoutMs: 10_000,
      retries: 0,
    });
    if (!result?.ok) throw new Error(`Telegram rejected sendMessage: ${JSON.stringify(result).slice(0, 200)}`);
    return result.result;
  }

  signalMessage(trade, btc) {
    const s = trade.setup ?? {};
    return `🧪 <b>NEXIO v6 PAPER — RETEST LONG</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🪙 <b>${escapeHtml(trade.symbol.replace('USDT', ''))}</b>\n` +
      `💰 Entry: <b>$${formatPrice(trade.entry)}</b>\n` +
      `🛑 Stop: $${formatPrice(trade.initial_sl)}\n` +
      `🎯 TP1: $${formatPrice(trade.tp1)} · TP2: $${formatPrice(trade.tp2)}\n\n` +
      `Closed 1m breakout → controlled retest → taker-buy reclaim\n` +
      `Flow ${(Number(s.buyRatio1) * 100).toFixed(0)}% buy · OI ${Number(s.oiChangePct).toFixed(2)}%\n` +
      `Spread ${Number(s.spreadBps).toFixed(1)} bps · Net R:R 1:${Number(s.netRR).toFixed(2)}\n` +
      `BTC ${escapeHtml(btc.regime)} · ${btc.oneHourReturn >= 0 ? '+' : ''}${btc.oneHourReturn.toFixed(2)}%/1h\n\n` +
      `<i>Paper signal only. No setup removes trading risk.</i>\n` +
      `⏰ ${gstTime()} GST`;
  }

  outcomeMessage(trade) {
    const icon = trade.outcome === 'WIN' ? '✅' : trade.outcome === 'LOSS' ? '❌' : '➖';
    return `${icon} <b>${escapeHtml(trade.symbol.replace('USDT', ''))} ${escapeHtml(trade.exit_reason)}</b>\n` +
      `Net: ${Number(trade.net_pnl_pct) >= 0 ? '+' : ''}${Number(trade.net_pnl_pct).toFixed(2)}% · ` +
      `R: ${Number(trade.r_multiple) >= 0 ? '+' : ''}${Number(trade.r_multiple).toFixed(2)}R\n` +
      `MFE +${Number(trade.mfe_pct).toFixed(2)}% · MAE ${Number(trade.mae_pct).toFixed(2)}%\n` +
      `⏰ ${gstTime()} GST`;
  }

  async pollLoop(handler) {
    while (!this.stopping) {
      try {
        const data = await requestJson(`${this.base}/getUpdates?${new URLSearchParams({
          offset: String(this.offset), limit: '20', timeout: '20', allowed_updates: JSON.stringify(['message']),
        })}`, { timeoutMs: 30_000, retries: 1 });
        for (const update of data?.result ?? []) {
          this.offset = Math.max(this.offset, Number(update.update_id) + 1);
          if (update.message?.text) await handler(update.message);
        }
      } catch (error) {
        log(`Telegram poll error: ${error.message}`);
        await sleep(2_000);
      }
    }
  }

  stop() {
    this.stopping = true;
  }
}
