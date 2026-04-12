// ─────────────────────────────────────────────────────────────────────────────
// NEXIO — 24/7 Trading Signal Server
// Free: Nexio Signals channel (basic alerts)
// Premium: Nexio Prime channel (all alerts, priority)
// Payment: USDT TRC20 manual verification
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN         = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL      = '-1003785044347';   // Nexio Signals
const PREMIUM_CHANNEL   = '-1003317305473';   // Nexio Prime
const OWNER_CHAT_ID     = '6896387082';       // Noushad
const USDT_ADDRESS      = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD         = 9.99;
const SUPABASE_URL      = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY      = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

// ── Scanner config ────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS    = 300000;  // 5 min
const POLL_INTERVAL_MS    = 30000;   // 30 sec
const ALERT_COOLDOWN_MS   = 1800000; // 30 min
const FREE_MIN_SCORE      = 4;
const PREMIUM_MIN_SCORE   = 3.5;
const MIN_VOLUME_USD      = 1000000; // $1M min volume
const MAX_ALERTS_PER_SCAN = 5;
const FADE_THRESHOLD_PCT  = 2.0;

// ── Track signal prices for fade detection ────────────────────────────────────
const signalPrices = new Map();

// ── State ─────────────────────────────────────────────────────────────────────
const alertHistory = new Map();
const prevOI       = new Map();
let   lastUpdateId = 0;
let   scanCount    = 0;

// ── Excluded coins ────────────────────────────────────────────────────────────
const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'XAUTUSDT','PAXGUSDT','XAUUSDT','WBTCUSDT','HBARUSDT',
  'BTCDOMUSDT','DEFIUSDT','USDCUSDT','TSLAUSDT','CLUSDT',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const gstNow = ()  => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log = (...args) => console.log(`[${gstNow()} GST]`, ...args);

const canAlert  = key => !alertHistory.has(key) || Date.now() - alertHistory.get(key) > ALERT_COOLDOWN_MS;
const markAlert = key => alertHistory.set(key, Date.now());

// ── Fetch helpers ─────────────────────────────────────────────────────────────
const fetchJSON = async (url, timeout = 8000) => {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

// ── Supabase ──────────────────────────────────────────────────────────────────
const sb = async (path, options = {}) => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates',
        ...options.headers,
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};

const getUser            = async chatId => (await sb(`bot_users?chat_id=eq.${chatId}`))?.[0];
const saveUser           = async (chatId, username, firstName) => sb('bot_users', {
  method: 'POST',
  body: JSON.stringify({ chat_id: String(chatId), username: username||'', first_name: firstName||'', is_active: true }),
});
const setPremium         = async chatId => sb(`bot_users?chat_id=eq.${chatId}`, {
  method: 'PATCH',
  body: JSON.stringify({ is_premium: true, premium_since: new Date().toISOString() }),
});
const getPremiumUsers    = async () => (await sb('bot_users?is_premium=eq.true&is_active=eq.true&select=chat_id')) || [];
const getAllUsers         = async () => (await sb('bot_users?is_active=eq.true&select=chat_id'))                   || [];
const savePayment        = async (chatId, username, txid) => sb('subscriptions', {
  method: 'POST',
  body: JSON.stringify({
    user_id: chatId, email: username, txid,
    plan: 'premium', status: 'pending',
    amount_paid: PRICE_USD, currency: 'USDT',
    created_at: new Date().toISOString(),
  }),
});
const getPendingPayments = async () => (await sb('subscriptions?status=eq.pending&select=*')) || [];

// ── Telegram ──────────────────────────────────────────────────────────────────
const tg = async (chatId, text, extra = {}) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
  } catch { /* skip */ }
};

const addToChannel = async (chatId, channelId) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, user_id: chatId }),
    });
  } catch { /* skip */ }
};

// ── Post to BOTH channels (same signal for now) ───────────────────────────────
const postSignal = async (text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: FREE_CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* skip */ }
  await sleep(200);
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: PREMIUM_CHANNEL, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* skip */ }
};

// ── Get BTC status ────────────────────────────────────────────────────────────
const getBTCStatus = async () => {
  try {
    const res = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
    const btc = res?.result?.list?.[0];
    if (!btc) return null;
    const price   = parseFloat(btc.lastPrice);
    const change  = parseFloat(btc.price24hPcnt) * 100;
    const funding = parseFloat(btc.fundingRate) * 100;
    let condition, emoji;
    if (change > 2 && funding < 0.01)      { condition = '✅ GOOD — BTC pumping, low funding'; emoji = '🟢'; }
    else if (change > 0 && funding < 0.02) { condition = '🟡 NEUTRAL — BTC stable';            emoji = '🟡'; }
    else if (change < -2)                   { condition = '🔴 CAUTION — BTC dumping';           emoji = '🔴'; }
    else if (funding > 0.03)                { condition = '⚠️ RISKY — BTC funding too high';    emoji = '🟠'; }
    else                                    { condition = '🟡 NEUTRAL — Monitor BTC';            emoji = '🟡'; }
    return { price, change, funding, condition, emoji };
  } catch { return null; }
};

// ── Coin tracker ──────────────────────────────────────────────────────────────
const coinTracker = new Map();
const MAX_TRACKED = 10;
const MAX_SCANS   = 8;

const confBar = (score) => {
  const filled = Math.min(Math.round(score), 10);
  const empty  = 10 - filled;
  let bar = '';
  for (let i = 0; i < filled; i++) {
    if (i < 3)      bar += '🟥';
    else if (i < 5) bar += '🟧';
    else if (i < 7) bar += '🟨';
    else            bar += '🟩';
  }
  bar += '⬛'.repeat(empty);
  return bar;
};

const fmtP = p => p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

const calcConfidence = (state) => {
  let score = 0;
  const h = state.history;
  if (h.length < 2) return 3;
  const fundings = h.map(s => s.funding);
  const fundingConsistent = state.direction === 'LONG'
    ? fundings.every(f => f < 0)
    : fundings.every(f => f > 0.005);
  if (fundingConsistent) score += 2; else score += 0.5;
  const ois = h.map(s => s.oi);
  const oiGrowing = ois.every((oi, i) => i === 0 || oi >= ois[i-1]);
  if (oiGrowing) score += 2;
  const lsRatios = h.map(s => s.ls);
  const lsMoving = state.direction === 'LONG'
    ? lsRatios[lsRatios.length-1] < lsRatios[0]
    : lsRatios[lsRatios.length-1] > lsRatios[0];
  if (lsMoving) score += 1.5;
  const prices = h.map(s => s.price);
  const priceMoving = state.direction === 'LONG'
    ? prices[prices.length-1] > prices[0]
    : prices[prices.length-1] < prices[0];
  if (priceMoving) score += 1.5;
  const vols = h.map(s => s.vol);
  const avgVol = vols.reduce((a,b) => a+b, 0) / vols.length;
  if (avgVol < 1.3) score += 1;
  score += Math.min(h.length * 0.5, 2);
  return Math.min(parseFloat(score.toFixed(1)), 10);
};

const updateTracker = (symbol, scanData, direction) => {
  const existing = coinTracker.get(symbol);
  const snapshot = { price: scanData.price, funding: scanData.funding, oi: scanData.oi, ls: scanData.ls, vol: scanData.vol, time: Date.now() };
  if (!existing) {
    coinTracker.set(symbol, { symbol, direction, state: 'WATCHING', scanCount: 1, firstSeen: Date.now(), history: [snapshot], basePrice: scanData.price, confidence: 3 });
  } else {
    existing.history.push(snapshot);
    existing.scanCount++;
    existing.confidence = calcConfidence(existing);
    if (existing.scanCount >= 3 && existing.confidence >= 6)      existing.state = 'READY';
    else if (existing.scanCount >= 2 && existing.confidence >= 4) existing.state = 'CONFIRMING';
    if (direction !== existing.direction) existing.state = 'FADING';
    coinTracker.set(symbol, existing);
  }
};

const getSortedTracker = () => [...coinTracker.values()]
  .filter(c => c.state !== 'FADING')
  .sort((a, b) => b.confidence - a.confidence);

// ── Build alert messages ──────────────────────────────────────────────────────
const buildAlert = (coin, state, btcStatus, type = 'BREAKOUT') => {
  const isLong   = state.direction === 'LONG';
  const dirEmoji = isLong ? '🟢' : '🔴';
  const dir      = isLong ? '📈 LONG' : '📉 SHORT';
  const conf     = state.confidence;
  const bar      = confBar(conf);
  const entry    = coin.price;
  const atr      = entry * 0.015;
  const sl       = isLong ? entry - atr : entry + atr;
  const tp1      = isLong ? entry + atr     : entry - atr;
  const tp2      = isLong ? entry + atr * 2 : entry - atr * 2;
  const tp3      = isLong ? entry + atr * 3 : entry - atr * 3;
  const btcLine  = btcStatus
    ? `${btcStatus.emoji} BTC: $${btcStatus.price.toLocaleString()} (${btcStatus.change > 0?'+':''}${btcStatus.change.toFixed(2)}%) — ${btcStatus.condition}`
    : '';
  const historyLines = state.history.slice(-3).map((h, i) => {
    const label = i === 0 ? '1st' : i === 1 ? '2nd' : '3rd';
    const trend = isLong ? (h.funding < -0.01 ? '✅' : '⚠️') : (h.funding > 0.01 ? '✅' : '⚠️');
    return `  ${label}: Fund ${h.funding.toFixed(3)}% ${trend} | OI ${h.oi > 0 ? '+' : ''}${((h.oi - (state.history[0]?.oi||h.oi)) / (state.history[0]?.oi||1) * 100).toFixed(1)}% | Vol ${h.vol.toFixed(1)}x`;
  }).join('\n');

  if (type === 'BREAKOUT') return `
${dirEmoji} NEXIO — ${dir} SIGNAL
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')}
📊 Confidence: ${conf}/10
${bar}
━━━━━━━━━━━━━━━
📋 SCAN HISTORY (${state.scanCount} scans):
${historyLines}
━━━━━━━━━━━━━━━
💰 Entry:  $${fmtP(entry)}
🛑 SL:     $${fmtP(sl)} (1.5%)
🎯 TP1:    $${fmtP(tp1)} (+1.5%)
🎯 TP2:    $${fmtP(tp2)} (+3.0%)
🎯 TP3:    $${fmtP(tp3)} (+4.5%)
━━━━━━━━━━━━━━━
${btcLine}
⏰ ${gstNow()} GST
📊 bybit.com/trade/usdt/${coin.symbol}
  `.trim();

  if (type === 'WATCH') return `
👀 NEXIO — WATCH ALERT
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')} — Building ${conf}/10
${bar}
━━━━━━━━━━━━━━━
${isLong ? '🔄 Accumulation detected — whales loading\n📈 Waiting for breakout to confirm LONG' : '🔄 Distribution detected — whales unloading\n📉 Waiting for breakdown to confirm SHORT'}
━━━━━━━━━━━━━━━
💰 Price: $${fmtP(entry)}
💸 Funding: ${coin.funding?.toFixed(3)}%
⚖️ L/S: ${coin.ls?.toFixed(2) || '—'}
━━━━━━━━━━━━━━━
⏳ DO NOT ENTER YET — set alert at $${fmtP(isLong ? entry * 1.005 : entry * 0.995)}
⏰ ${gstNow()} GST
📊 bybit.com/trade/usdt/${coin.symbol}
  `.trim();

  if (type === 'FADING') return `
⚠️ NEXIO — SIGNAL FADING
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')}
❌ Momentum reversed
${isLong ? '📉 Was LONG — now weakening' : '📈 Was SHORT — now weakening'}
━━━━━━━━━━━━━━━
${state.entryPrice ? `📍 Entry: $${fmtP(state.entryPrice)} → Now: $${fmtP(entry)}\n⚡ Exit or tighten stop` : '⚡ Do NOT enter — setup cancelled'}
⏰ ${gstNow()} GST
  `.trim();

  return '';
};

const buildPriorityList = (btcStatus) => {
  const sorted = getSortedTracker();
  if (!sorted.length) return null;
  const btcLine = btcStatus
    ? `${btcStatus.emoji} BTC: $${btcStatus.price.toLocaleString()} ${btcStatus.change>0?'+':''}${btcStatus.change.toFixed(2)}% — ${btcStatus.condition}`
    : '';
  const lines = sorted.slice(0, 10).map((s, i) => {
    const rank  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir   = s.direction === 'LONG' ? '📈' : '📉';
    const state = s.state === 'READY' ? '🔥READY' : s.state === 'CONFIRMING' ? '⚡CONF' : '👀WATCH';
    return `${rank} ${dir} ${s.symbol.replace('USDT','')} — ${state} — ${s.confidence}/10 ${confBar(s.confidence)}`;
  }).join('\n');
  return `
📊 NEXIO PRIORITY LIST
━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━
${btcLine}
⏰ ${gstNow()} GST
  `.trim();
};

// ── Bot commands ──────────────────────────────────────────────────────────────
const handleCommand = async (msg) => {
  const chatId    = String(msg.chat?.id);
  const username  = msg.from?.username || '';
  const firstName = msg.from?.first_name || '';
  const text      = (msg.text || '').trim();
  await saveUser(chatId, username, firstName);
  const user = await getUser(chatId);

  if (text === '/start') {
    await tg(chatId, `
👋 <b>Welcome to Nexio!</b>
━━━━━━━━━━━━━━━
Smart crypto trading signals — delivered 24/7.

📊 <b>Free:</b> Join Nexio Signals for basic alerts
👑 <b>Premium:</b> Upgrade to Nexio Prime for all signals

/signals — Join free signals channel
/premium — Upgrade to Nexio Prime
/subscribe — Subscribe ($${PRICE_USD}/month)
/status — Your account status
/help — All commands

<b>Nexio</b> — Trade smarter 🐆
    `.trim());
  }

  else if (text === '/signals') {
    await tg(chatId, `
📊 <b>Nexio Signals — Free Channel</b>
━━━━━━━━━━━━━━━
Join our free signals channel:
👉 https://t.me/nexioSignals

You'll receive:
🎯 High confidence signals
⏰ Alerts every 5 minutes
📊 Direct Bybit chart links

For advanced signals → /premium
    `.trim());
  }

  else if (text === '/premium') {
    const isPremium = user?.is_premium;
    await tg(chatId, isPremium ? `
👑 <b>You are Nexio Prime!</b>
━━━━━━━━━━━━━━━
✅ All signals active
✅ Whale footprint alerts
✅ Liquidity sweep alerts
✅ Priority delivery
Enjoying it? Share with friends! 🐆
    `.trim() : `
👑 <b>Nexio Prime — Premium Signals</b>
━━━━━━━━━━━━━━━
✅ All signals (lower threshold)
✅ Whale footprint detection 🐋
✅ Liquidity sweep alerts ⚡
✅ WATCH → CONFIRM → BREAKOUT system
✅ Priority delivery

💵 Only <b>$${PRICE_USD}/month</b> USDT
→ /subscribe
    `.trim());
  }

  else if (text === '/subscribe') {
    await tg(chatId, `
💳 <b>Subscribe to Nexio Prime</b>
━━━━━━━━━━━━━━━
Send exactly <b>$${PRICE_USD} USDT</b> on <b>TRC20 network</b> to:

<code>${USDT_ADDRESS}</code>

⚠️ TRC20 network ONLY.

After sending reply with:
<code>/txid YOUR_TRANSACTION_ID</code>

Activated within 1 hour. 🐆
    `.trim());
  }

  else if (text.startsWith('/txid')) {
    const txid = text.replace('/txid', '').trim();
    if (!txid) { await tg(chatId, '⚠️ Example:\n<code>/txid abc123def456...</code>'); return; }
    await savePayment(chatId, username, txid);
    await tg(chatId, `⏳ <b>Payment Received!</b>\nTXID: <code>${txid.slice(0,20)}...</code>\nActivation within <b>1 hour</b>. 🐆`);
    await tg(OWNER_CHAT_ID, `
💰 <b>NEW PAYMENT!</b>
━━━━━━━━━━━━━━━
👤 @${username || chatId}
💵 $${PRICE_USD} USDT
🔗 TXID: <code>${txid}</code>
✅ <a href="https://tronscan.org/#/transaction/${txid}">Verify on Tronscan</a>
/activate ${chatId}
    `.trim());
  }

  else if (text === '/status') {
    const allUsers     = await getAllUsers();
    const premiumUsers = await getPremiumUsers();
    await tg(chatId, `
📊 <b>Nexio Status</b>
━━━━━━━━━━━━━━━
👤 Account: <b>${user?.is_premium ? '👑 Prime' : '🆓 Free'}</b>
🤖 Server: <b>Online ✅</b>
👥 Total users: <b>${allUsers.length}</b>
👑 Prime members: <b>${premiumUsers.length}</b>
🔍 Scans today: <b>${scanCount}</b>
⏰ ${gstNow()} GST
${!user?.is_premium ? '\n→ /subscribe to upgrade' : ''}
    `.trim());
  }

  else if (text === '/stats') {
    await tg(chatId, `
📈 <b>Nexio Scanner Stats</b>
━━━━━━━━━━━━━━━
🔍 Total scans: <b>${scanCount}</b>
📊 Tracking: <b>${coinTracker.size}/${MAX_TRACKED} coins</b>
🔥 Ready signals: <b>${getSortedTracker().filter(c=>c.state==='READY').length}</b>
⏰ ${gstNow()} GST
    `.trim());
  }

  else if (text === '/help') {
    await tg(chatId, `
📖 <b>Nexio Commands</b>
━━━━━━━━━━━━━━━
/start — Welcome
/signals — Free channel
/premium — Prime benefits
/subscribe — Upgrade
/txid — Submit payment TXID
/status — Your status
/stats — Scanner stats
/help — This message
🐆 Nexio
    `.trim());
  }

  // ── Admin commands ────────────────────────────────────────────────────────
  if (chatId === OWNER_CHAT_ID) {

    if (text.startsWith('/activate')) {
      const targetId = text.replace('/activate', '').trim();
      if (!targetId) { await tg(chatId, '⚠️ Usage: /activate <chatId>'); return; }
      await setPremium(targetId);
      await addToChannel(parseInt(targetId), PREMIUM_CHANNEL);
      await tg(targetId, `
👑 <b>Welcome to Nexio Prime!</b>
━━━━━━━━━━━━━━━
✅ Payment verified
You now receive all premium signals!
Enjoy the edge! 🐆
      `.trim());
      await tg(chatId, `✅ User ${targetId} activated as Prime!`);
    }

    if (text === '/pending') {
      const pending = await getPendingPayments();
      if (!pending.length) { await tg(chatId, '✅ No pending payments'); return; }
      let msg = `⏳ <b>Pending (${pending.length})</b>\n━━━━━━━━━━━━━━━\n`;
      for (const p of pending) {
        msg += `\n👤 ${p.email || p.user_id}\n🔗 <code>${p.txid?.slice(0,20)}...</code>\n<a href="https://tronscan.org/#/transaction/${p.txid}">Verify</a>\n/activate ${p.user_id}\n`;
      }
      await tg(chatId, msg);
    }

    if (text.startsWith('/broadcast')) {
      const broadcastMsg = text.replace('/broadcast', '').trim();
      if (!broadcastMsg) { await tg(chatId, '⚠️ Usage: /broadcast <message>'); return; }
      const users = await getAllUsers();
      for (const u of users) { await tg(u.chat_id, `📢 <b>Nexio Update</b>\n\n${broadcastMsg}`); await sleep(100); }
      await tg(chatId, `✅ Sent to ${users.length} users`);
    }

    if (text === '/users') {
      const all     = await getAllUsers();
      const premium = await getPremiumUsers();
      await tg(chatId, `
👥 <b>Nexio Users</b>
━━━━━━━━━━━━━━━
Total: <b>${all.length}</b>
👑 Prime: <b>${premium.length}</b>
🆓 Free: <b>${all.length - premium.length}</b>
💰 Revenue: <b>$${(premium.length * PRICE_USD).toFixed(2)}/mo</b>
      `.trim());
    }
  }
};

// ── Poll for new messages ─────────────────────────────────────────────────────
const pollUsers = async () => {
  try {
    const data = await fetchJSON(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=20&timeout=0`
    );
    if (!data?.ok || !data.result?.length) return;
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) await handleCommand(update.message);
    }
  } catch (err) { log('Poll error:', err.message); }
};

// ── Main scan ─────────────────────────────────────────────────────────────────
const runScan = async () => {
  scanCount++;
  log(`Starting scan #${scanCount}...`);
  try {
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !EXCLUDE.has(t.symbol) && parseFloat(t.quoteVolume) >= MIN_VOLUME_USD)
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), funding: 0 }))
      .filter(t => Math.abs(t.change) < 15)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 80);

    log(`Fetched ${valid.length} candidates`);
    const btcStatus  = await getBTCStatus();
    const btcDumping = btcStatus && btcStatus.change < -1.5;

    for (const coin of valid) {
      await sleep(400);
      let longShortRatio = 1, currentOI = 0, volSpike = 0, price15mChange = 0, klines = [];

      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); coin.funding = parseFloat(f.lastFundingRate) * 100; } catch {}
      try {
        klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=8`);
        if (klines.length >= 4) {
          const lv = parseFloat(klines[klines.length-1][5]);
          const pv = klines.slice(0,-1).map(k => parseFloat(k[5]));
          const av = pv.reduce((a,b) => a+b, 0) / pv.length;
          volSpike = av > 0 ? lv / av : 0;
          const o = parseFloat(klines[klines.length-1][1]), c = parseFloat(klines[klines.length-1][4]);
          price15mChange = o > 0 ? ((c - o) / o) * 100 : 0;
        }
      } catch {}
      try { const ls = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); longShortRatio = parseFloat(ls[0]?.longShortRatio || 1); } catch {}
      try { const oi = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(oi.openInterest); prevOI.set(coin.symbol, currentOI); } catch {}

      const isLong  = coin.funding < 0.005 && longShortRatio < 1.1;
      const isShort = coin.funding > 0.015 && longShortRatio > 1.15;
      if (!isLong && !isShort) continue;

      const direction = isLong ? 'LONG' : 'SHORT';
      const scanData  = { price: coin.price, funding: coin.funding, oi: currentOI, ls: longShortRatio, vol: volSpike };
      const tracked   = coinTracker.get(coin.symbol);

      // Fade check
      if (tracked && direction !== tracked.direction) {
        tracked.state = 'FADING';
        if (tracked.entryPrice) {
          await postSignal(buildAlert({ ...coin, ls: longShortRatio }, tracked, btcStatus, 'FADING'));
        }
        coinTracker.delete(coin.symbol);
        continue;
      }
      if (tracked && tracked.scanCount >= MAX_SCANS) { coinTracker.delete(coin.symbol); continue; }

      // Breakout check — fire if vol spike + price moving + not btc dumping
      const isBreakout = volSpike >= 1.5 && (isLong ? price15mChange >= 0.2 : price15mChange <= -0.2) && !btcDumping;

      if (isBreakout && tracked && tracked.scanCount >= 1 && tracked.confidence >= 3) {
        const alertKey = `breakout_${coin.symbol}`;
        if (canAlert(alertKey)) {
          tracked.entryPrice = coin.price;
          tracked.state = 'BREAKOUT';
          await postSignal(buildAlert({ ...coin, ls: longShortRatio }, tracked, btcStatus, 'BREAKOUT'));
          markAlert(alertKey);
          signalPrices.set(coin.symbol, { price: coin.price, direction, firedAt: Date.now() });
          coinTracker.delete(coin.symbol);
          log(`🚀 BREAKOUT: ${coin.symbol} ${direction} conf:${tracked.confidence}`);
          continue;
        }
      }

      // Loading / accumulation check
      const isLoading = klines.length >= 6 && (() => {
        const c = klines.slice(-6);
        const hi = Math.max(...c.map(x => parseFloat(x[2])));
        const lo = Math.min(...c.map(x => parseFloat(x[3])));
        return lo > 0 ? ((hi - lo) / lo) * 100 < 3.0 && volSpike < 1.5 : false;
      })();

      if (isLoading || tracked) {
        if (!tracked && coinTracker.size >= MAX_TRACKED) {
          const sorted = getSortedTracker();
          const lowest = sorted[sorted.length - 1];
          if (lowest && lowest.confidence < 4) coinTracker.delete(lowest.symbol);
          else continue;
        }
        updateTracker(coin.symbol, scanData, direction);
        const state = coinTracker.get(coin.symbol);
        log(`📊 TRACKED: ${coin.symbol} ${direction} conf:${state.confidence} scan:${state.scanCount}`);
        if (state.scanCount === 2 && state.confidence >= 4) {
          const watchKey = `watch_${coin.symbol}`;
          if (canAlert(watchKey)) {
            await postSignal(buildAlert({ ...coin, ls: longShortRatio }, state, btcStatus, 'WATCH'));
            markAlert(watchKey);
          }
        }
      }

      // Fade detection for previously alerted coins
      const sig = signalPrices.get(coin.symbol);
      if (sig) {
        const chg = sig.direction === 'LONG'
          ? ((sig.price - coin.price) / sig.price) * 100
          : ((coin.price - sig.price) / sig.price) * 100;
        if (chg >= FADE_THRESHOLD_PCT) {
          await postSignal(`⚠️ NEXIO — MOMENTUM FADING\n━━━━━━━━━━━━━━━\n🪙 ${coin.symbol.replace('USDT','')}\n📉 Dropped ${chg.toFixed(1)}% from signal\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(coin.price)}\n━━━━━━━━━━━━━━━\n⚡ Exit or tighten stop\n⏰ ${gstNow()} GST`);
          signalPrices.delete(coin.symbol);
        }
      }
    }

    // Priority list every 3 scans to BOTH channels
    if (scanCount % 3 === 0 && coinTracker.size > 0) {
      const priorityMsg = buildPriorityList(btcStatus);
      if (priorityMsg) await postSignal(priorityMsg);
    }

    log(`Scan #${scanCount} done — Tracked: ${coinTracker.size}/${MAX_TRACKED}`);
  } catch (err) { log('Scan error:', err.message); }
};

// ── Start ─────────────────────────────────────────────────────────────────────
const start = async () => {
  log('🚀 Nexio server starting...');
  await tg(OWNER_CHAT_ID, `
🟢 <b>Nexio Server Started</b>
━━━━━━━━━━━━━━━
✅ Scanner: Online
📊 Both channels: Same signals
⏱ Scan: 5 min | Poll: 30s
⏰ ${gstNow()} GST

Admin: /pending /users /activate /broadcast
  `.trim());

  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runScan();
  setInterval(runScan, SCAN_INTERVAL_MS);
};

start();
