// ─────────────────────────────────────────────────────────────────────────────
// CRYPTOGEN — 24/7 Telegram Alert Server
// Deploy to Railway.app for free — runs independently of any device
// Scans Binance every 5 min — sends alerts to all Telegram subscribers
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = '8645549182:AAH1IYpACYQShbuGtZkwJt5F6rMhAFlbMjg';
const OWNER_CHAT_ID      = '6896387082';
const SUPABASE_URL       = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_ANON_KEY  = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';
const SCAN_INTERVAL_MS   = 300000;  // 5 minutes
const ALERT_COOLDOWN_MS  = 1800000; // 30 minutes per coin
const MIN_SCORE          = 4;       // minimum score to alert
const MIN_VOLUME_USD     = 1000000; // $1M minimum volume

// ── State ─────────────────────────────────────────────────────────────────────
const alertHistory  = new Map();
const prevOI        = new Map();
const prevFunding   = new Map();
let   lastUpdateId  = 0;
let   scanCount     = 0;

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

const canAlert = (key) => {
  const last = alertHistory.get(key);
  return !last || Date.now() - last > ALERT_COOLDOWN_MS;
};
const markAlerted = (key) => alertHistory.set(key, Date.now());

// ── Fetch wrapper ─────────────────────────────────────────────────────────────
const fetchJSON = async (url, timeout = 8000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

// ── Supabase helpers ──────────────────────────────────────────────────────────
const supabaseFetch = async (path, options = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type':  'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) return null;
  return res.json();
};

const getBotUsers = async () => {
  try {
    const data = await supabaseFetch('bot_users?is_active=eq.true&select=chat_id');
    const ids  = (data || []).map(u => u.chat_id);
    if (!ids.includes(OWNER_CHAT_ID)) ids.push(OWNER_CHAT_ID);
    return ids;
  } catch {
    return [OWNER_CHAT_ID];
  }
};

const saveUser = async (chatId, username, firstName) => {
  await supabaseFetch('bot_users', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      chat_id:    String(chatId),
      username:   username   || '',
      first_name: firstName  || '',
      is_active:  true,
    }),
  });
};

// ── Telegram helpers ──────────────────────────────────────────────────────────
const sendToOne = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { /* skip */ }
};

const broadcast = async (message) => {
  const users = await getBotUsers();
  log(`Broadcasting to ${users.length} users`);
  for (const chatId of users) {
    await sendToOne(chatId, message);
    await sleep(50);
  }
};

// ── Poll for new Telegram users ───────────────────────────────────────────────
const pollUsers = async () => {
  try {
    const data = await fetchJSON(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=20&timeout=0`
    );
    if (!data?.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;

      const chatId    = String(msg.chat?.id);
      const username  = msg.from?.username  || '';
      const firstName = msg.from?.first_name || '';
      const text      = msg.text || '';

      await saveUser(chatId, username, firstName);
      log(`New message from @${username || chatId}: ${text}`);

      if (text === '/start') {
        await sendToOne(chatId, `
🚀 <b>Welcome to CryptoGen!</b>
━━━━━━━━━━━━━━━
You're now subscribed to live trading alerts:

🎯 High score coins (${MIN_SCORE}+)
🐋 Whale footprint detection
⚡ Liquidity sweep signals

Alerts fire automatically 24/7 — just watch this chat! 📊

<b>Commands:</b>
/start — Subscribe
/stop — Unsubscribe
/status — Bot status
/stats — Scan statistics

<b>CryptoGen</b> — Smart crypto scanner 🐆
        `.trim());
      }

      if (text === '/stop') {
        await supabaseFetch(`bot_users?chat_id=eq.${chatId}`, {
          method:  'PATCH',
          body: JSON.stringify({ is_active: false }),
        });
        await sendToOne(chatId, '✅ Unsubscribed from CryptoGen alerts. Send /start to resubscribe.');
      }

      if (text === '/status') {
        const users = await getBotUsers();
        await sendToOne(chatId, `
📊 <b>CryptoGen Status</b>
━━━━━━━━━━━━━━━
🤖 Server: <b>Online ✅</b>
👥 Subscribers: <b>${users.length}</b>
🔍 Scans completed: <b>${scanCount}</b>
⏱ Scan interval: <b>5 minutes</b>
📊 Min score: <b>${MIN_SCORE}+</b>
⏰ Time: <b>${gstNow()} GST</b>
        `.trim());
      }

      if (text === '/stats') {
        await sendToOne(chatId, `
📈 <b>CryptoGen Scanner Stats</b>
━━━━━━━━━━━━━━━
🔍 Total scans: <b>${scanCount}</b>
⏰ Last scan: <b>${gstNow()} GST</b>
🎯 Alert threshold: score <b>${MIN_SCORE}+</b>
⏱ Cooldown: <b>30 min per coin</b>
💹 Min volume: <b>$${(MIN_VOLUME_USD/1e6).toFixed(0)}M</b>
        `.trim());
      }
    }
  } catch (err) {
    log('Poll error:', err.message);
  }
};

// ── Scoring ───────────────────────────────────────────────────────────────────
const calcScore = ({ change, volume, fundingRate, longShortRatio, volSpike1H, oiSpikePct }) => {
  let score = 0;

  // Price flat = not already pumped
  if (Math.abs(change) < 1)      score += 2;
  else if (Math.abs(change) < 3) score += 1;

  // Volume spike 1H
  if (volSpike1H >= 3)      score += 2;
  else if (volSpike1H >= 2) score += 1;

  // Volume overall
  if (volume >= 20e6)      score += 1;
  else if (volume >= 5e6)  score += 0.5;

  // Funding negative
  if (fundingRate < -0.005)      score += 1;
  else if (fundingRate < 0)      score += 0.5;

  // L/S ratio — shorts dominating
  if (longShortRatio < 0.9)      score += 1;
  else if (longShortRatio < 1.0) score += 0.5;

  // OI spike
  if (oiSpikePct >= 3)      score += 1;
  else if (oiSpikePct >= 1) score += 0.5;

  return Math.round(score * 10) / 10;
};

// ── Main scan ─────────────────────────────────────────────────────────────────
const runScan = async () => {
  scanCount++;
  log(`Starting scan #${scanCount}...`);

  try {
    // Step 1 — fetch all tickers from Bybit (no regional blocks)
    const res     = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear');
    const tickers = res?.result?.list || [];

    const valid = tickers
      .filter(t =>
        t.symbol.endsWith('USDT') &&
        !t.symbol.includes('_') &&
        !EXCLUDE.has(t.symbol) &&
        parseFloat(t.turnover24h) >= MIN_VOLUME_USD
      )
      .map(t => ({
        symbol:  t.symbol,
        price:   parseFloat(t.lastPrice),
        change:  parseFloat(t.price24hPcnt) * 100,
        volume:  parseFloat(t.turnover24h),
        funding: parseFloat(t.fundingRate) * 100,
      }))
      .filter(t => Math.abs(t.change) < 8)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 80);

    log(`Fetched ${valid.length} candidates from Bybit`);

    // Step 2 — enrich top candidates
    const alerts = [];

    for (const coin of valid) {
      await sleep(350);

      let volSpike1H     = 0;
      let longShortRatio = 1;
      let oiSpikePct     = 0;

      // 1H klines for volume spike
      try {
        const klRes  = await fetchJSON(
          `https://api.bybit.com/v5/market/kline?category=linear&symbol=${coin.symbol}&interval=60&limit=6`
        );
        const klines = klRes?.result?.list || [];
        if (klines.length >= 4) {
          const latestVol = parseFloat(klines[0][5]);
          const prevVols  = klines.slice(1).map(k => parseFloat(k[5]));
          const avgVol    = prevVols.reduce((a, b) => a + b, 0) / prevVols.length;
          volSpike1H      = avgVol > 0 ? latestVol / avgVol : 0;
        }
      } catch { /* skip */ }

      // L/S ratio
      try {
        const lsRes       = await fetchJSON(
          `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${coin.symbol}&period=1h&limit=1`
        );
        const lsData      = lsRes?.result?.list?.[0];
        longShortRatio    = lsData ? parseFloat(lsData.buyRatio) / (parseFloat(lsData.sellRatio) || 1) : 1;
      } catch { /* skip */ }

      // OI
      try {
        const oiRes  = await fetchJSON(
          `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${coin.symbol}&intervalTime=5min&limit=2`
        );
        const oiList = oiRes?.result?.list || [];
        if (oiList.length >= 2) {
          const curr  = parseFloat(oiList[0].openInterest);
          const prev  = parseFloat(oiList[1].openInterest);
          oiSpikePct  = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
          prevOI.set(coin.symbol, curr);
        }
      } catch { /* skip */ }

      const score = calcScore({
        change:        coin.change,
        volume:        coin.volume,
        fundingRate:   coin.funding,
        longShortRatio,
        volSpike1H,
        oiSpikePct,
      });

      if (score >= MIN_SCORE && canAlert(`score_${coin.symbol}`)) {
        alerts.push({ ...coin, score, fundingRate: coin.funding, longShortRatio, volSpike1H, oiSpikePct });
        markAlerted(`score_${coin.symbol}`);
      }
    }

    log(`Scan #${scanCount} complete — ${alerts.length} alerts`);

    // Step 3 — send alerts
    for (const coin of alerts.slice(0, 5)) {
      const dirEmoji = coin.fundingRate < 0 && coin.longShortRatio < 1 ? '📈 LONG' : '👀 WATCH';
      const msg = `
🎯 <b>SIGNAL DETECTED</b>
━━━━━━━━━━━━━━━
${dirEmoji} <b>${coin.symbol.replace('USDT', '')}</b> — Score: <b>${coin.score}/10</b>
💰 Price: <b>$${coin.price}</b>
💸 Funding: <b>${coin.fundingRate.toFixed(3)}%</b>
🔊 1H Vol Spike: <b>${coin.volSpike1H.toFixed(1)}x</b>
📦 OI Change: <b>${coin.oiSpikePct > 0 ? '+' : ''}${coin.oiSpikePct.toFixed(1)}%</b>
⚖️ L/S: <b>${coin.longShortRatio.toFixed(2)}</b>
⏰ <b>${gstNow()} GST</b>
━━━━━━━━━━━━━━━
<a href="https://www.bybit.com/trade/usdt/${coin.symbol}">📊 Open on Bybit</a>
      `.trim();

      await broadcast(msg);
      await sleep(1000);
    }

  } catch (err) {
    log('Scan error:', err.message);
  }
};

// ── Start server ──────────────────────────────────────────────────────────────
const start = async () => {
  log('🚀 CryptoGen server starting...');

  // Send startup message to owner
  await sendToOne(OWNER_CHAT_ID, `
🟢 <b>CryptoGen Server Started</b>
━━━━━━━━━━━━━━━
✅ Scanner: Online
⏱ Interval: Every 5 minutes
📊 Min score: ${MIN_SCORE}+
⏰ Started: ${gstNow()} GST
  `.trim());

  // Poll users every 30 seconds
  setInterval(pollUsers, 30000);
  pollUsers();

  // Run scan immediately then every 5 min
  await runScan();
  setInterval(runScan, SCAN_INTERVAL_MS);
};

start();
