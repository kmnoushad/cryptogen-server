import { requestJson } from './http.js';
import { escapeHtml, formatPrice, gstTime, log, sleep } from './util.js';

const confidenceBar = score => {
  const filled = Math.max(0, Math.min(10, Math.round(Number(score) || 0)));
  let result = '';
  for (let i = 0; i < 10; i++) {
    result += i >= filled ? '⬛' : i < 3 ? '🟥' : i < 5 ? '🟧' : i < 7 ? '🟨' : '🟩';
  }
  return result;
};

const usd = value => Number(value || 0) >= 1_000_000
  ? `$${(Number(value) / 1_000_000).toFixed(1)}M`
  : `$${Math.round(Number(value || 0) / 1_000)}k`;

const alphaRiskLabel = security => {
  if (!security || security.rating === 'BLOCKED') return '🚨 BLOCKED / POSSIBLE RUG';
  if (security.rating === 'POSSIBLE_RUG') return '🟠 POSSIBLE RUG';
  if (security.rating === 'CAUTION') return '🟡 CAUTION';
  return '🟢 NO CRITICAL FLAGS FOUND';
};

const securityLines = security => {
  if (!security) return '🚨 On-chain result unavailable';
  const items = [...(security.critical ?? []), ...(security.warnings ?? [])].slice(0, 4);
  return items.length ? items.map(item => `• ${escapeHtml(item)}`).join('\n') : '• Honeypot/sell/mint/freeze checks: no critical flag found';
};

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
    const score = Number(trade.setup_score ?? 0);
    return `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n` +
      `<b>🔥 [FUTURES] NEXIO FIRE — 📈 LONG</b>\n` +
      `<b>${escapeHtml(trade.symbol.replace('USDT', ''))} · ${escapeHtml(String(s.setupType ?? 'BREAKOUT').replaceAll('_', ' '))}</b>\n` +
      `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n` +
      `<b>💰 ENTRY: $${formatPrice(trade.entry)}</b>\n` +
      `<b>🛑 STOP:  $${formatPrice(trade.initial_sl)}</b>\n` +
      `<b>🎯 TP1:   $${formatPrice(trade.tp1)}</b>\n` +
      `<b>🎯 TP2:   $${formatPrice(trade.tp2)}</b>\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 Confidence: <b>${score.toFixed(1)}/10</b>\n${confidenceBar(score)}\n` +
      `✅ Closed breakout → ${escapeHtml(String(s.retestType ?? 'STANDARD').replaceAll('_', ' ').toLowerCase())} → reclaim\n` +
      `🟢 Taker buyers ${(Number(s.buyRatio1) * 100).toFixed(0)}% · OI ${Number(s.oiChangePct).toFixed(2)}%\n` +
      `💧 Depth ${usd(Number(s.bidDepthUsd))}/${usd(Number(s.askDepthUsd))} · spread ${Number(s.spreadBps).toFixed(1)} bps\n` +
      `📐 Book ${Number(s.depthImbalance ?? 1).toFixed(2)}x · estimated impact ${Number(s.entryImpactBps ?? 0).toFixed(1)} bps\n` +
      `⚖️ Net R:R 1:${Number(s.netRR).toFixed(2)} · manipulation ${Number(s.manipulationScore ?? 0)}/10\n` +
      `₿ BTC ${escapeHtml(btc.regime)} · ${btc.oneHourReturn >= 0 ? '+' : ''}${btc.oneHourReturn.toFixed(2)}%/1h\n\n` +
      `<i>${this.cfg.paperMode ? 'PAPER SIGNAL' : 'ALERT ONLY'} · No setup guarantees profit · SL always set</i>\n` +
      `⏰ ${gstTime()} GST`;
  }

  alphaIgnitionMessage(token, qualification, move, security) {
    const entry = token.price;
    const sl = entry * 0.97;
    const tp1 = entry * 1.05;
    const tp2 = entry * 1.08;
    const tp3 = entry * 1.12;
    const riskLabel = alphaRiskLabel(security);
    return `🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀\n` +
      `<b>🚀 [ALPHA] IGNITION — ${escapeHtml(token.symbol)}</b>\n` +
      `<b>${escapeHtml(token.chainName)} · MANUAL ENTRY</b>\n` +
      `🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀\n\n` +
      `<b>💰 ENTRY: ~$${formatPrice(entry)}</b>\n` +
      `<b>🛑 STOP:   $${formatPrice(sl)} (-3%)</b>\n` +
      `<b>🎯 TP1:    $${formatPrice(tp1)} (+5%)</b>\n` +
      `<b>🎯 TP2:    $${formatPrice(tp2)} (+8%)</b>\n` +
      `<b>🎯 TP3:    $${formatPrice(tp3)} (+12%)</b>\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 Setup: ${qualification.score}/10\n${confidenceBar(qualification.score)}\n` +
      `⚡ +${move.pricePct.toFixed(1)}% since qualification · liquidity ${move.liquidityPct >= 0 ? '+' : ''}${move.liquidityPct.toFixed(1)}%\n` +
      `💧 ${usd(token.liquidity)} liquidity · ${usd(token.volume24h)} volume · 👥${Math.round(token.holders).toLocaleString()}\n` +
      `🔐 <b>${riskLabel}</b> · risk ${security.riskScore}/10\n` +
      `${securityLines(security)}\n\n` +
      `<b>${security.rating === 'POSSIBLE_RUG' ? '⚠️ POSSIBLE RUG: TINY SIZE OR SKIP.' : '⚠️ Alpha remains high risk: tiny size and take profit fast.'}</b>\n` +
      `<i>Manual Binance Alpha trade · on-chain scan is not a guarantee</i>\n` +
      `⏰ ${gstTime()} GST`;
  }

  alphaOutcomeMessage(trade, liquidityPct = 0) {
    const pnl = Number(trade.pnl_pct ?? 0);
    const icon = trade.outcome === 'WIN' ? '✅' : trade.outcome === 'LOSS' ? '❌' : '➖';
    const action = trade.exit_reason === 'TP1' ? 'Take profit now; do not let the winner reverse.'
      : trade.exit_reason === 'STOP' ? 'Stop reached—close the position.'
      : trade.exit_reason === 'LIQUIDITY_EXIT' ? 'Liquidity is leaving—exit immediately.'
      : trade.exit_reason === 'MOMENTUM_FADE' ? 'Momentum faded from its peak—lock the remaining profit.'
      : 'Six-hour window ended—close and reassess.';
    return `${icon} <b>[ALPHA] ${escapeHtml(trade.symbol)} — ${escapeHtml(trade.exit_reason)}</b>\n` +
      `Entry $${formatPrice(trade.entry)} → $${formatPrice(trade.exit_price)}\n` +
      `Result: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% · Peak +${Number(trade.max_gain_pct ?? 0).toFixed(2)}%\n` +
      `Liquidity: ${liquidityPct >= 0 ? '+' : ''}${Number(liquidityPct).toFixed(1)}% from entry\n` +
      `<b>${escapeHtml(action)}</b>\n` +
      `⏰ ${gstTime()} GST`;
  }

  outcomeMessage(trade) {
    const icon = trade.outcome === 'WIN' ? '✅' : trade.outcome === 'LOSS' ? '❌' : '➖';
    const action = trade.exit_reason === 'TP1' ? 'TP1 reached—take profit and close the paper position.'
      : trade.exit_reason === 'STOP' || trade.exit_reason === 'BREAKEVEN_STOP' ? 'Stop reached—close the position.'
      : trade.exit_reason === 'MOMENTUM_FADE' ? 'Momentum faded—lock the remaining profit now.'
      : trade.exit_reason === 'MANIPULATION_EXIT' ? 'Liquidity/manipulation risk changed—exit now.'
      : 'Time limit reached—close and reassess.';
    return `${icon} <b>${escapeHtml(trade.symbol.replace('USDT', ''))} ${escapeHtml(trade.exit_reason)}</b>\n` +
      `Net: ${Number(trade.net_pnl_pct) >= 0 ? '+' : ''}${Number(trade.net_pnl_pct).toFixed(2)}% · ` +
      `R: ${Number(trade.r_multiple) >= 0 ? '+' : ''}${Number(trade.r_multiple).toFixed(2)}R\n` +
      `MFE +${Number(trade.mfe_pct).toFixed(2)}% · MAE ${Number(trade.mae_pct).toFixed(2)}%\n` +
      `<b>${escapeHtml(action)}</b>\n` +
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
