// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER — 24/7 Crypto Signal Server
// Free tier → Nexio Signals channel
// Premium tier → Nexio Prime channel
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN        = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const OWNER_CHAT_ID    = '6896387082';
const FREE_CHANNEL_ID  = '-1003785044347';
const PRIME_CHANNEL_ID = '-1003317305473';
const USDT_ADDRESS     = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD        = 9.99;
const SUPABASE_URL     = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY     = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

const SCAN_INTERVAL_MS  = 300000;
const FREE_COOLDOWN_MS  = 1800000;
const PRIME_COOLDOWN_MS = 600000;
const FREE_MIN_SCORE    = 4;
const PRIME_MIN_SCORE   = 3;
const MIN_VOLUME_USD    = 1000000;

const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'XAUTUSDT','PAXGUSDT','XAUUSDT','WBTCUSDT','HBARUSDT',
  'BTCDOMUSDT','DEFIUSDT','USDCUSDT','TSLAUSDT','CLUSDT',
]);

const freeAlertHistory  = new Map();
const primeAlertHistory = new Map();
let   lastUpdateId      = 0;
let   scanCount         = 0;

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const gstNow = ()  => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log = (...args) => console.log(`[${gstNow()} GST]`, ...args);

const canAlert   = (map, key, ms) => { const l = map.get(key); return !l || Date.now() - l > ms; };
const markAlert  = (map, key)     => map.set(key, Date.now());

const fetchJSON = async (url, timeout = 8000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
};

const sb = async (path, options = {}) => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal',
        ...options.headers,
      },
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};

const getUser        = async (id)  => { const d = await sb(`bot_users?chat_id=eq.${id}&select=*`); return d?.[0] || null; };
const saveUser       = async (id, u, f) => sb('bot_users', { method: 'POST', headers: { 'Prefer': 'resolution=merge-duplicates' }, body: JSON.stringify({ chat_id: String(id), username: u||'', first_name: f||'', is_active: true }) });
const activateUser   = async (id)  => sb(`bot_users?chat_id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ is_premium: true, payment_status: 'active', activated_at: new Date().toISOString() }) });
const getPending     = async ()    => await sb('bot_users?payment_status=eq.pending&select=*') || [];
const getAllUsers     = async ()    => await sb('bot_users?select=*') || [];

const sendMsg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { }
};

const calcScore = ({ change, volume, fundingRate, longShortRatio, volSpike1H, oiSpikePct }) => {
  let s = 0;
  if (Math.abs(change) < 1) s += 2; else if (Math.abs(change) < 3) s += 1;
  if (volSpike1H >= 3) s += 2; else if (volSpike1H >= 2) s += 1;
  if (volume >= 20e6) s += 1; else if (volume >= 5e6) s += 0.5;
  if (fundingRate < -0.005) s += 1; else if (fundingRate < 0) s += 0.5;
  if (longShortRatio < 0.9) s += 1; else if (longShortRatio < 1.0) s += 0.5;
  if (oiSpikePct >= 3) s += 1; else if (oiSpikePct >= 1) s += 0.5;
  return Math.round(s * 10) / 10;
};

const formatSignal = (coin, isPrime = false) => {
  const dir   = coin.fundingRate < 0 && coin.longShortRatio < 1 ? '📈 LONG' : '👀 WATCH';
  const badge = isPrime ? '👑 <b>NEXIO PRIME</b>' : '🎯 <b>SIGNAL</b>';
  return `
${badge}
━━━━━━━━━━━━━━━
${dir} <b>${coin.symbol.replace('USDT','')}</b> — Score: <b>${coin.score}/10</b>
💰 Price: <b>$${coin.price}</b>
💸 Funding: <b>${coin.fundingRate.toFixed(3)}%</b>
🔊 1H Vol: <b>${coin.volSpike1H.toFixed(1)}x</b>
📦 OI: <b>${coin.oiSpikePct > 0 ? '+' : ''}${coin.oiSpikePct.toFixed(1)}%</b>
⚖️ L/S: <b>${coin.longShortRatio.toFixed(2)}</b>
⏰ <b>${gstNow()} GST</b>
━━━━━━━━━━━━━━━
<a href="https://www.bybit.com/trade/usdt/${coin.symbol}">📊 Bybit</a>
  `.trim();
};

const runScan = async () => {
  scanCount++;
  log(`Scan #${scanCount}...`);
  try {
    const res     = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear');
    const tickers = res?.result?.list || [];
    const valid   = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_') && !EXCLUDE.has(t.symbol) && parseFloat(t.turnover24h) >= MIN_VOLUME_USD)
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.price24hPcnt)*100, volume: parseFloat(t.turnover24h), funding: parseFloat(t.fundingRate||0)*100 }))
      .filter(t => Math.abs(t.change) < 8)
      .sort((a,b) => b.volume - a.volume)
      .slice(0, 80);

    log(`${valid.length} candidates`);
    const freeAlerts = [], primeAlerts = [];

    for (const coin of valid) {
      await sleep(350);
      let volSpike1H = 0, longShortRatio = 1, oiSpikePct = 0;

      try {
        const kl = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${coin.symbol}&interval=60&limit=6`);
        const ks = kl?.result?.list || [];
        if (ks.length >= 4) {
          const lv = parseFloat(ks[0][5]);
          const pv = ks.slice(1).map(k => parseFloat(k[5]));
          const av = pv.reduce((a,b) => a+b, 0) / pv.length;
          volSpike1H = av > 0 ? lv/av : 0;
        }
      } catch { }

      try {
        const ls = await fetchJSON(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${coin.symbol}&period=1h&limit=1`);
        const d  = ls?.result?.list?.[0];
        longShortRatio = d ? parseFloat(d.buyRatio)/(parseFloat(d.sellRatio)||1) : 1;
      } catch { }

      try {
        const oi = await fetchJSON(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${coin.symbol}&intervalTime=5min&limit=2`);
        const ol = oi?.result?.list || [];
        if (ol.length >= 2) oiSpikePct = ((parseFloat(ol[0].openInterest)-parseFloat(ol[1].openInterest))/parseFloat(ol[1].openInterest))*100;
      } catch { }

      const score    = calcScore({ change: coin.change, volume: coin.volume, fundingRate: coin.funding, longShortRatio, volSpike1H, oiSpikePct });
      const coinData = { ...coin, score, fundingRate: coin.funding, longShortRatio, volSpike1H, oiSpikePct };

      if (score >= PRIME_MIN_SCORE && canAlert(primeAlertHistory, coin.symbol, PRIME_COOLDOWN_MS)) { primeAlerts.push(coinData); markAlert(primeAlertHistory, coin.symbol); }
      if (score >= FREE_MIN_SCORE  && canAlert(freeAlertHistory,  coin.symbol, FREE_COOLDOWN_MS))  { freeAlerts.push(coinData);  markAlert(freeAlertHistory,  coin.symbol); }
    }

    log(`Free: ${freeAlerts.length}, Prime: ${primeAlerts.length}`);
    for (const c of primeAlerts.slice(0,8)) { await sendMsg(PRIME_CHANNEL_ID, formatSignal(c, true));  await sleep(500); }
    for (const c of freeAlerts.slice(0,5))  { await sendMsg(FREE_CHANNEL_ID,  formatSignal(c, false)); await sleep(500); }

  } catch (err) { log('Scan error:', err.message); }
};

const pollUsers = async () => {
  try {
    const data = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&limit=20&timeout=0`);
    if (!data?.ok || !data.result?.length) return;

    for (const update of data.result) {
      lastUpdateId   = update.update_id;
      const msg      = update.message;
      if (!msg) continue;
      const chatId   = String(msg.chat?.id);
      const username = msg.from?.username  || '';
      const fname    = msg.from?.first_name || '';
      const text     = (msg.text || '').trim();

      await saveUser(chatId, username, fname);

      if (text === '/start') {
        await sendMsg(chatId, `👋 <b>Welcome to Nexio!</b>\n━━━━━━━━━━━━━━━\nSmart crypto signals 24/7.\n\n📢 <b>Free:</b> /signals\n👑 <b>Premium:</b> /prime\n📋 <b>Help:</b> /help`);
      }

      if (text === '/signals') {
        await sendMsg(chatId, `📢 <b>Nexio Signals — Free</b>\n━━━━━━━━━━━━━━━\n👉 https://t.me/nexioSignals\n\nScore 4+ signals delivered automatically.\n\nUpgrade for more: /prime`);
      }

      if (text === '/prime') {
        await sendMsg(chatId, `👑 <b>Nexio Prime — $${PRICE_USD}/month</b>\n━━━━━━━━━━━━━━━\n✅ Score 3+ signals\n✅ Faster alerts\n✅ Whale detection\n✅ Private channel\n\n<b>To subscribe:</b>\n1️⃣ Send <b>$${PRICE_USD} USDT TRC20</b> to:\n<code>${USDT_ADDRESS}</code>\n\n2️⃣ Submit TXID:\n/pay YOUR_TXID\n\n⚠️ TRC20 only.`);
      }

      if (text.startsWith('/pay ')) {
        const txid = text.replace('/pay ','').trim();
        if (txid.length < 10) { await sendMsg(chatId, '❌ Invalid TXID.'); continue; }
        await sb(`bot_users?chat_id=eq.${chatId}`, { method: 'PATCH', body: JSON.stringify({ payment_txid: txid, payment_status: 'pending', payment_date: new Date().toISOString() }) });
        await sendMsg(chatId, `⏳ <b>Payment Submitted!</b>\nTXID: <code>${txid.slice(0,20)}...</code>\n\nWe'll activate within <b>1 hour</b>.`);
        await sendMsg(OWNER_CHAT_ID, `💰 <b>NEW PAYMENT!</b>\n👤 @${username} (${chatId})\n🔗 <code>${txid}</code>\n✅ <a href="https://tronscan.org/#/transaction/${txid}">Verify</a>\n\n/activate ${chatId}`);
      }

      if (text.startsWith('/activate ') && chatId === OWNER_CHAT_ID) {
        const targetId = text.replace('/activate ','').trim();
        await activateUser(targetId);
        await sendMsg(targetId, `🎉 <b>Welcome to Nexio Prime!</b>\n━━━━━━━━━━━━━━━\n✅ Account activated!\n\n👉 https://t.me/+xct9p5ep021hY2U8\n\nWelcome to the inner circle. 🐆`);
        await sendMsg(OWNER_CHAT_ID, `✅ User ${targetId} activated!`);
      }

      if (text === '/status') {
        const user = await getUser(chatId);
        const tier = user?.is_premium ? '👑 Prime' : '🆓 Free';
        await sendMsg(chatId, `📊 <b>Your Status</b>\n━━━━━━━━━━━━━━━\nTier: <b>${tier}</b>\n⏰ ${gstNow()} GST\n${user?.is_premium ? '✅ Prime active' : '💡 Upgrade: /prime'}`);
      }

      if (text === '/stats' && chatId === OWNER_CHAT_ID) {
        const all     = await getAllUsers();
        const premium = all.filter(u => u.is_premium);
        const pending = all.filter(u => u.payment_status === 'pending');
        await sendMsg(OWNER_CHAT_ID, `📈 <b>Nexio Stats</b>\n━━━━━━━━━━━━━━━\n👥 Total: <b>${all.length}</b>\n👑 Prime: <b>${premium.length}</b>\n⏳ Pending: <b>${pending.length}</b>\n💰 Revenue: <b>$${(premium.length*PRICE_USD).toFixed(2)}/mo</b>\n🔍 Scans: <b>${scanCount}</b>\n⏰ ${gstNow()} GST`);
      }

      if (text === '/pending' && chatId === OWNER_CHAT_ID) {
        const pending = await getPending();
        if (!pending.length) { await sendMsg(OWNER_CHAT_ID, '✅ No pending payments.'); continue; }
        for (const u of pending) {
          await sendMsg(OWNER_CHAT_ID, `⏳ @${u.username} (${u.chat_id})\n<code>${u.payment_txid}</code>\n<a href="https://tronscan.org/#/transaction/${u.payment_txid}">Verify</a>\n/activate ${u.chat_id}`);
        }
      }

      if (text === '/help') {
        const isOwner = chatId === OWNER_CHAT_ID;
        await sendMsg(chatId, `/start /signals /prime /pay TXID /status${isOwner ? '\n\n👑 Admin:\n/stats /pending /activate ID' : ''}`);
      }
    }
  } catch (err) { log('Poll error:', err.message); }
};

const start = async () => {
  log('🚀 Nexio server starting...');
  await sendMsg(OWNER_CHAT_ID, `🟢 <b>Nexio Server Started</b>\n✅ Online\n📢 Free: Nexio Signals\n👑 Prime: Nexio Prime\n⏰ ${gstNow()} GST`);
  setInterval(pollUsers, 30000);
  await pollUsers();
  await runScan();
  setInterval(runScan, SCAN_INTERVAL_MS);
};

start();
