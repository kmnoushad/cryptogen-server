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
const FREE_MIN_SCORE      = 4;       // free channel threshold
const PREMIUM_MIN_SCORE   = 3;       // premium channel threshold
const MIN_VOLUME_USD      = 1000000; // $1M min volume
const MAX_ALERTS_PER_SCAN = 5;

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
const sleep  = ms  => new Promise(r => setTimeout(r, ms));
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

const getUser         = async chatId  => (await sb(`bot_users?chat_id=eq.${chatId}`))?.[0];
const saveUser        = async (chatId, username, firstName) => sb('bot_users', {
  method: 'POST',
  body: JSON.stringify({ chat_id: String(chatId), username: username||'', first_name: firstName||'', is_active: true }),
});
const setPremium      = async chatId  => sb(`bot_users?chat_id=eq.${chatId}`, {
  method: 'PATCH',
  body: JSON.stringify({ is_premium: true, premium_since: new Date().toISOString() }),
});
const getPremiumUsers = async ()      => (await sb('bot_users?is_premium=eq.true&is_active=eq.true&select=chat_id')) || [];
const getAllUsers      = async ()      => (await sb('bot_users?is_active=eq.true&select=chat_id'))                   || [];
const savePayment     = async (chatId, email, txid) => sb('subscriptions', {
  method: 'POST',
  body: JSON.stringify({
    user_id: chatId, email, txid,
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

// Post to channel
const postToChannel = async (channelId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* skip */ }
};

// ── Scoring ───────────────────────────────────────────────────────────────────
const calcScore = ({ change, volume, fundingRate, longShortRatio, volSpike1H, oiSpikePct }) => {
  let score = 0;
  if (Math.abs(change) < 1)       score += 2;
  else if (Math.abs(change) < 3)  score += 1;
  if (volSpike1H >= 3)            score += 2;
  else if (volSpike1H >= 2)       score += 1;
  if (volume >= 20e6)             score += 1;
  else if (volume >= 5e6)         score += 0.5;
  if (fundingRate < -0.005)       score += 1;
  else if (fundingRate < 0)       score += 0.5;
  if (longShortRatio < 0.9)       score += 1;
  else if (longShortRatio < 1.0)  score += 0.5;
  if (oiSpikePct >= 3)            score += 1;
  else if (oiSpikePct >= 1)       score += 0.5;
  return Math.round(score * 10) / 10;
};

// ── Bot commands ──────────────────────────────────────────────────────────────
const handleCommand = async (msg) => {
  const chatId    = String(msg.chat?.id);
  const username  = msg.from?.username  || '';
  const firstName = msg.from?.firstName || msg.from?.first_name || '';
  const text      = (msg.text || '').trim();

  await saveUser(chatId, username, firstName);
  const user = await getUser(chatId);

  // /start
  if (text === '/start') {
    await tg(chatId, `
👋 <b>Welcome to Nexio!</b>
━━━━━━━━━━━━━━━
Smart crypto trading signals — delivered 24/7.

📊 <b>Free:</b> Join Nexio Signals for basic alerts
👑 <b>Premium:</b> Upgrade to Nexio Prime for all signals

Commands:
/signals — Join free signals channel
/premium — Upgrade to Nexio Prime
/subscribe — Subscribe to premium ($${PRICE_USD}/month)
/status — Your account status
/help — All commands

<b>Nexio</b> — Trade smarter 🐆
    `.trim());
  }

  // /signals — join free channel
  else if (text === '/signals') {
    await tg(chatId, `
📊 <b>Nexio Signals — Free Channel</b>
━━━━━━━━━━━━━━━
Join our free signals channel:
👉 https://t.me/nexioSignals

You'll receive:
🎯 High score signals (${FREE_MIN_SCORE}+)
⏰ Alerts every 5 minutes
📊 Direct Bybit chart links

For advanced signals → /premium
    `.trim());
  }

  // /premium — show premium benefits
  else if (text === '/premium') {
    const isPremium = user?.is_premium;
    if (isPremium) {
      await tg(chatId, `
👑 <b>You are already Nexio Prime!</b>
━━━━━━━━━━━━━━━
✅ All signals (score ${PREMIUM_MIN_SCORE}+)
✅ Whale footprint alerts
✅ Liquidity sweep alerts
✅ Priority delivery
✅ No cooldown delays

Enjoying the signals? Share with friends! 🐆
      `.trim());
    } else {
      await tg(chatId, `
👑 <b>Nexio Prime — Premium Signals</b>
━━━━━━━━━━━━━━━
Everything in free PLUS:

✅ Lower threshold — score ${PREMIUM_MIN_SCORE}+ (more signals)
✅ Whale footprint detection 🐋
✅ Liquidity sweep alerts ⚡
✅ Priority delivery
✅ Private channel access

💵 Only <b>$${PRICE_USD}/month</b> USDT

Ready to upgrade? → /subscribe
      `.trim());
    }
  }

  // /subscribe — payment flow
  else if (text === '/subscribe') {
    await tg(chatId, `
💳 <b>Subscribe to Nexio Prime</b>
━━━━━━━━━━━━━━━
Send exactly <b>$${PRICE_USD} USDT</b> on <b>TRC20 network</b> to:

<code>${USDT_ADDRESS}</code>

⚠️ TRC20 network ONLY. Other networks = lost funds.

After sending:
Reply with your TXID like this:
<code>/txid YOUR_TRANSACTION_ID</code>

We'll verify and activate within 1 hour.
      `.trim());
  }

  // /txid — payment verification
  else if (text.startsWith('/txid')) {
    const txid = text.replace('/txid', '').trim();
    if (!txid) {
      await tg(chatId, '⚠️ Please provide your TXID. Example:\n<code>/txid abc123def456...</code>');
      return;
    }
    await savePayment(chatId, username, txid);
    await tg(chatId, `
⏳ <b>Payment Received!</b>
━━━━━━━━━━━━━━━
TXID: <code>${txid.slice(0, 20)}...</code>

We'll verify on Tronscan and activate your Nexio Prime within <b>1 hour</b>.

You'll receive a confirmation message here. 🐆
    `.trim());

    // Notify owner
    await tg(OWNER_CHAT_ID, `
💰 <b>NEW PAYMENT RECEIVED!</b>
━━━━━━━━━━━━━━━
👤 User: @${username || chatId}
💵 Amount: $${PRICE_USD} USDT
🔗 TXID: <code>${txid}</code>
✅ <a href="https://tronscan.org/#/transaction/${txid}">Verify on Tronscan</a>

To activate: /activate ${chatId}
    `.trim());
  }

  // /status — account status
  else if (text === '/status') {
    const allUsers     = await getAllUsers();
    const premiumUsers = await getPremiumUsers();
    const isPremium    = user?.is_premium;
    await tg(chatId, `
📊 <b>Your Nexio Status</b>
━━━━━━━━━━━━━━━
👤 Account: <b>${isPremium ? '👑 Prime' : '🆓 Free'}</b>
🤖 Server: <b>Online ✅</b>
👥 Total users: <b>${allUsers.length}</b>
👑 Prime members: <b>${premiumUsers.length}</b>
🔍 Scans today: <b>${scanCount}</b>
⏰ Time: <b>${gstNow()} GST</b>
${!isPremium ? '\nUpgrade to Prime → /subscribe' : ''}
    `.trim());
  }

  // /stats
  else if (text === '/stats') {
    await tg(chatId, `
📈 <b>Nexio Scanner Stats</b>
━━━━━━━━━━━━━━━
🔍 Total scans: <b>${scanCount}</b>
⏰ Last scan: <b>${gstNow()} GST</b>
🎯 Free threshold: score <b>${FREE_MIN_SCORE}+</b>
👑 Prime threshold: score <b>${PREMIUM_MIN_SCORE}+</b>
⏱ Scan interval: <b>5 minutes</b>
⏱ Cooldown: <b>30 min/coin</b>
    `.trim());
  }

  // /help
  else if (text === '/help') {
    await tg(chatId, `
📖 <b>Nexio Commands</b>
━━━━━━━━━━━━━━━
/start — Welcome message
/signals — Join free channel
/premium — Prime benefits
/subscribe — Upgrade to Prime
/txid — Submit payment TXID
/status — Your account status
/stats — Scanner statistics
/help — This message

🐆 Nexio — Trade smarter
    `.trim());
  }

  // ── Admin only commands ──────────────────────────────────────────────────
  if (chatId === OWNER_CHAT_ID) {

    // /activate <chatId> — activate premium user
    if (text.startsWith('/activate')) {
      const targetId = text.replace('/activate', '').trim();
      if (!targetId) { await tg(chatId, '⚠️ Usage: /activate <chatId>'); return; }
      await setPremium(targetId);
      // Add to premium channel
      await addToChannel(parseInt(targetId), PREMIUM_CHANNEL);
      // Notify user
      await tg(targetId, `
👑 <b>Welcome to Nexio Prime!</b>
━━━━━━━━━━━━━━━
Your payment has been verified ✅
You now have access to all premium signals!

Join your exclusive channel:
👉 https://t.me/+xct9p5ep021hY2U8

Enjoy the edge! 🐆
      `.trim());
      await tg(chatId, `✅ User ${targetId} activated as Prime!`);
    }

    // /pending — show pending payments
    if (text === '/pending') {
      const pending = await getPendingPayments();
      if (!pending.length) { await tg(chatId, '✅ No pending payments'); return; }
      let msg = `⏳ <b>Pending Payments (${pending.length})</b>\n━━━━━━━━━━━━━━━\n`;
      for (const p of pending) {
        msg += `\n👤 ${p.email || p.user_id}\n🔗 TXID: <code>${p.txid?.slice(0,20)}...</code>\n✅ <a href="https://tronscan.org/#/transaction/${p.txid}">Verify</a>\n/activate ${p.user_id}\n`;
      }
      await tg(chatId, msg);
    }

    // /broadcast <message> — send to all users
    if (text.startsWith('/broadcast')) {
      const broadcastMsg = text.replace('/broadcast', '').trim();
      if (!broadcastMsg) { await tg(chatId, '⚠️ Usage: /broadcast <message>'); return; }
      const users = await getAllUsers();
      for (const u of users) {
        await tg(u.chat_id, `📢 <b>Nexio Update</b>\n\n${broadcastMsg}`);
        await sleep(100);
      }
      await tg(chatId, `✅ Broadcast sent to ${users.length} users`);
    }

    // /users — show all users
    if (text === '/users') {
      const all     = await getAllUsers();
      const premium = await getPremiumUsers();
      await tg(chatId, `
👥 <b>Nexio Users</b>
━━━━━━━━━━━━━━━
Total active: <b>${all.length}</b>
👑 Prime: <b>${premium.length}</b>
🆓 Free: <b>${all.length - premium.length}</b>
💰 Monthly revenue: <b>$${(premium.length * PRICE_USD).toFixed(2)}</b>
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
  } catch (err) {
    log('Poll error:', err.message);
  }
};

// ── Main scan ─────────────────────────────────────────────────────────────────
const runScan = async () => {
  scanCount++;
  log(`Starting scan #${scanCount}...`);

  try {
    // Fetch all tickers from Binance Futures
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');

    const valid = tickers
      .filter(t =>
        t.symbol.endsWith('USDT') &&
        !t.symbol.includes('_') &&
        !EXCLUDE.has(t.symbol) &&
        parseFloat(t.quoteVolume) >= MIN_VOLUME_USD
      )
      .map(t => ({
        symbol:  t.symbol,
        price:   parseFloat(t.lastPrice),
        change:  parseFloat(t.priceChangePercent),
        volume:  parseFloat(t.quoteVolume),
        funding: 0, // fetched per coin below
      }))
      .filter(t => Math.abs(t.change) < 8)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 80);

    log(`Fetched ${valid.length} candidates from Binance Futures`);

    const freeAlerts    = [];
    const premiumAlerts = [];

    for (const coin of valid) {
      await sleep(350);

      let volSpike1H     = 0;
      let longShortRatio = 1;
      let oiSpikePct     = 0;

      // Funding rate
      try {
        const fData    = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`);
        coin.funding   = parseFloat(fData.lastFundingRate) * 100;
      } catch { /* skip */ }

      // 1H klines for volume spike
      try {
        const klines    = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=1h&limit=6`);
        if (klines.length >= 4) {
          const latestVol = parseFloat(klines[klines.length - 1][5]);
          const prevVols  = klines.slice(0, -1).map(k => parseFloat(k[5]));
          const avgVol    = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
          volSpike1H      = avgVol > 0 ? latestVol / avgVol : 0;
        }
      } catch { /* skip */ }

      // L/S ratio
      try {
        const lsData      = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`);
        longShortRatio    = parseFloat(lsData[0]?.longShortRatio || 1);
      } catch { /* skip */ }

      // OI spike
      try {
        const oiData   = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`);
        const currOI   = parseFloat(oiData.openInterest);
        const lastOI   = prevOI.get(coin.symbol) || currOI;
        oiSpikePct     = lastOI > 0 ? ((currOI - lastOI) / lastOI) * 100 : 0;
        prevOI.set(coin.symbol, currOI);
      } catch { /* skip */ }

      const score = calcScore({
        change: coin.change, volume: coin.volume,
        fundingRate: coin.funding, longShortRatio,
        volSpike1H, oiSpikePct,
      });

      const key = `score_${coin.symbol}`;
      if (!canAlert(key)) continue;

      const coinData = { ...coin, score, longShortRatio, volSpike1H, oiSpikePct };

      if (score >= PREMIUM_MIN_SCORE) {
        premiumAlerts.push(coinData);
        if (score >= FREE_MIN_SCORE) freeAlerts.push(coinData);
        markAlert(key);
      }
    }

    log(`Scan #${scanCount} — Free: ${freeAlerts.length} Premium: ${premiumAlerts.length}`);

    // ── Post to Premium channel (score 3+) ──
    for (const coin of premiumAlerts.slice(0, MAX_ALERTS_PER_SCAN)) {
      const dir = coin.funding < 0 && coin.longShortRatio < 1 ? '📈 LONG' : '👀 WATCH';
      const msg = `
👑 <b>NEXIO PRIME SIGNAL</b>
━━━━━━━━━━━━━━━
${dir} <b>${coin.symbol.replace('USDT','')}</b> — Score: <b>${coin.score}/10</b>
💰 Price: <b>$${coin.price}</b>
💸 Funding: <b>${coin.funding.toFixed(3)}%</b>
🔊 Vol Spike: <b>${coin.volSpike1H.toFixed(1)}x</b>
📦 OI: <b>${coin.oiSpikePct > 0 ? '+' : ''}${coin.oiSpikePct.toFixed(1)}%</b>
⚖️ L/S: <b>${coin.longShortRatio.toFixed(2)}</b>
⏰ <b>${gstNow()} GST</b>
━━━━━━━━━━━━━━━
<a href="https://www.bybit.com/trade/usdt/${coin.symbol}">📊 Open Chart</a>
      `.trim();
      await postToChannel(PREMIUM_CHANNEL, msg);
      await sleep(500);
    }

    // ── Post to Free channel (score 4+ only) ──
    for (const coin of freeAlerts.slice(0, 3)) { // max 3 for free
      const dir = coin.funding < 0 && coin.longShortRatio < 1 ? '📈 LONG' : '👀 WATCH';
      const msg = `
🎯 <b>NEXIO SIGNAL</b>
━━━━━━━━━━━━━━━
${dir} <b>${coin.symbol.replace('USDT','')}</b>
💰 Price: <b>$${coin.price}</b>
💸 Funding: <b>${coin.funding.toFixed(3)}%</b>
⏰ <b>${gstNow()} GST</b>
━━━━━━━━━━━━━━━
<a href="https://www.bybit.com/trade/usdt/${coin.symbol}">📊 Open Chart</a>

👑 Get full signals → @NexioAlertBot
      `.trim();
      await postToChannel(FREE_CHANNEL, msg);
      await sleep(500);
    }

  } catch (err) {
    log('Scan error:', err.message);
  }
};

// ── Start ─────────────────────────────────────────────────────────────────────
const start = async () => {
  log('🚀 Nexio server starting...');

  await tg(OWNER_CHAT_ID, `
🟢 <b>Nexio Server Started</b>
━━━━━━━━━━━━━━━
✅ Scanner: Online
📊 Free channel: Nexio Signals
👑 Premium channel: Nexio Prime
⏱ Scan interval: 5 minutes
🎯 Free threshold: ${FREE_MIN_SCORE}+
👑 Prime threshold: ${PREMIUM_MIN_SCORE}+
⏰ Started: ${gstNow()} GST

Admin commands:
/pending — pending payments
/users — user stats
/activate <id> — activate user
/broadcast <msg> — message all users
  `.trim());

  // Start polling
  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();

  // Start scanning
  await runScan();
  setInterval(runScan, SCAN_INTERVAL_MS);
};

start();
