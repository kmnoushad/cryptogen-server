// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER — Two-scanner architecture
//
// Scanner 1: Full Market Scan (every 10 min)
//   → Scans 650+ Binance futures coins
//   → Score 3+ → adds to Supabase watchlist
//
// Scanner 2: Watchlist Scan (every 3 min)
//   → Reads watchlist from Supabase
//   → Multi-scan tracking with confidence building
//   → WATCH → CONFIRMING → READY → BREAKOUT
//   → Order book check to filter fakes
//   → Fires alert to both Telegram channels
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003785044347';
const PREMIUM_CHANNEL = '-1003317305473';
const OWNER_CHAT_ID   = '6896387082';
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

// ── Config ────────────────────────────────────────────────────────────────────
const FULL_MARKET_INTERVAL_MS  = 600000; // 10 min
const WATCHLIST_SCAN_INTERVAL  = 180000; // 3 min
const POLL_INTERVAL_MS         = 30000;  // 30 sec
const ALERT_COOLDOWN_MS        = 1800000;// 30 min
const MIN_VOLUME_USD           = 1000000;// $1M
const MAX_WATCHLIST            = 50;
const MAX_TRACKED              = 15;
const MAX_SCANS                = 8;
const FADE_THRESHOLD_PCT       = 2.0;

// ── Excluded coins ────────────────────────────────────────────────────────────
const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'XAUTUSDT','PAXGUSDT','XAUUSDT','WBTCUSDT','HBARUSDT',
  'BTCDOMUSDT','DEFIUSDT','USDCUSDT','TSLAUSDT','CLUSDT',
]);

// ── State ─────────────────────────────────────────────────────────────────────
const alertHistory = new Map();
const coinTracker  = new Map(); // watchlist tracker
const signalPrices = new Map(); // for fade detection
let   lastUpdateId = 0;
let   fullScanCount     = 0;
let   watchlistScanCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep   = ms  => new Promise(r => setTimeout(r, ms));
const gstNow  = ()  => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log     = (...a) => console.log(`[${gstNow()}]`, ...a);
const canAlert  = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > ALERT_COOLDOWN_MS;
const markAlert = k => alertHistory.set(k, Date.now());

const fmtP = p => p >= 1000
  ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : p >= 1 ? p.toFixed(3) : p.toFixed(5);

const confBar = score => {
  const n = Math.min(Math.round(score), 10);
  let b = '';
  for (let i = 0; i < n; i++)
    b += i < 3 ? '🟥' : i < 5 ? '🟧' : i < 7 ? '🟨' : '🟩';
  return b + '⬛'.repeat(10 - n);
};

// ── Fetch ─────────────────────────────────────────────────────────────────────
const fetchJSON = async (url, timeout = 8000) => {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
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

// Watchlist operations
const getWatchlist = async () => {
  const data = await sb('watchlist?select=symbol,score,direction');
  return data || [];
};

const addToWatchlist = async (symbol, score, direction) => {
  await sb('watchlist', {
    method: 'POST',
    body: JSON.stringify({
      symbol, score, direction, added_by: 'server',
      updated_at: new Date().toISOString(),
    }),
  });
};

const removeFromWatchlist = async (symbol) => {
  await sb(`watchlist?symbol=eq.${symbol}`, { method: 'DELETE' });
};

const updateWatchlistScore = async (symbol, score, direction) => {
  await sb(`watchlist?symbol=eq.${symbol}`, {
    method: 'PATCH',
    body: JSON.stringify({ score, direction, updated_at: new Date().toISOString() }),
  });
};

// User operations
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
const getAllUsers         = async () => (await sb('bot_users?is_active=eq.true&select=chat_id')) || [];
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
const tg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch { /* skip */ }
};

const postSignal = async text => {
  const payload = { parse_mode: 'HTML', disable_web_page_preview: true, text };
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: FREE_CHANNEL, ...payload }),
    });
  } catch { /* skip */ }
  await sleep(300);
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: PREMIUM_CHANNEL, ...payload }),
    });
  } catch { /* skip */ }
};

const addToChannel = async (chatId, channelId) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, user_id: chatId }),
    });
  } catch { /* skip */ }
};

// ── BTC status ────────────────────────────────────────────────────────────────
const getBTCStatus = async () => {
  try {
    const res = await fetchJSON('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
    const btc = res?.result?.list?.[0];
    if (!btc) return null;
    const price = parseFloat(btc.lastPrice), change = parseFloat(btc.price24hPcnt) * 100, funding = parseFloat(btc.fundingRate) * 100;
    let condition, emoji;
    if (change > 2 && funding < 0.01)      { condition = '✅ GOOD — pumping, low funding'; emoji = '🟢'; }
    else if (change > 0 && funding < 0.02) { condition = '🟡 NEUTRAL — stable';            emoji = '🟡'; }
    else if (change < -2)                   { condition = '🔴 CAUTION — dumping';           emoji = '🔴'; }
    else if (funding > 0.03)                { condition = '⚠️ RISKY — funding high';        emoji = '🟠'; }
    else                                    { condition = '🟡 NEUTRAL — monitor';            emoji = '🟡'; }
    return { price, change, funding, condition, emoji };
  } catch { return null; }
};

// ─────────────────────────────────────────────────────────────────────────────
// SCANNER 1 — FULL MARKET SCAN
// Finds new coins to add to watchlist
// ─────────────────────────────────────────────────────────────────────────────
const calcFullMarketScore = ({ change, volume, fundingRate, longShortRatio, volSpike1H }) => {
  let score = 0;
  if (Math.abs(change) < 1)      score += 2;
  else if (Math.abs(change) < 3) score += 1;
  if (volSpike1H >= 3)           score += 2;
  else if (volSpike1H >= 2)      score += 1;
  if (volume >= 20e6)            score += 1;
  else if (volume >= 5e6)        score += 0.5;
  if (fundingRate < -0.005)      score += 1;
  else if (fundingRate < 0.005)  score += 0.5;
  if (longShortRatio < 0.9)      score += 1;
  else if (longShortRatio < 1.1) score += 0.5;
  return Math.round(score * 10) / 10;
};

const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount} starting...`);
  try {
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_')
        && !EXCLUDE.has(t.symbol) && parseFloat(t.quoteVolume) >= MIN_VOLUME_USD)
      .map(t => ({
        symbol:  t.symbol,
        price:   parseFloat(t.lastPrice),
        change:  parseFloat(t.priceChangePercent),
        volume:  parseFloat(t.quoteVolume),
      }))
      .filter(t => Math.abs(t.change) < 8)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 60); // top 60 by volume

    // Get current watchlist from Supabase
    const currentWatchlist = await getWatchlist();
    const currentSymbols   = currentWatchlist.map(r => r.symbol);
    let added = 0;

    for (const coin of valid) {
      await sleep(400);
      let fundingRate = 0, longShortRatio = 1, volSpike1H = 0;

      try {
        const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`);
        fundingRate = parseFloat(f.lastFundingRate) * 100;
      } catch { }

      try {
        const klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=1h&limit=5`);
        if (klines.length >= 3) {
          const lv = parseFloat(klines[klines.length - 1][5]);
          const pv = klines.slice(0, -1).map(k => parseFloat(k[5]));
          const av = pv.reduce((a, b) => a + b, 0) / pv.length;
          volSpike1H = av > 0 ? lv / av : 0;
        }
      } catch { }

      try {
        const ls = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`);
        longShortRatio = parseFloat(ls[0]?.longShortRatio || 1);
      } catch { }

      const score = calcFullMarketScore({
        change: coin.change, volume: coin.volume,
        fundingRate, longShortRatio, volSpike1H,
      });

      if (score >= 3 && !currentSymbols.includes(coin.symbol)) {
        if (currentSymbols.length + added < MAX_WATCHLIST) {
          const direction = fundingRate < 0 && longShortRatio < 1.1
            ? 'LONG'
            : fundingRate > 0.015 && longShortRatio > 1.15
            ? 'SHORT'
            : 'WATCH';
          await addToWatchlist(coin.symbol, score, direction);
          currentSymbols.push(coin.symbol);
          added++;
          log(`✅ Added to watchlist: ${coin.symbol} score:${score}`);
        }
      }
    }

    log(`🌍 Full Market Scan #${fullScanCount} done — Added ${added} coins — Watchlist: ${currentSymbols.length}`);
    await tg(OWNER_CHAT_ID, `🌍 Full scan #${fullScanCount} done — +${added} new coins — Watchlist: ${currentSymbols.length} total`);
  } catch (err) { log('Full scan error:', err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// SCANNER 2 — WATCHLIST SCAN
// Monitors watchlist coins, builds confidence, fires alerts
// ─────────────────────────────────────────────────────────────────────────────
const calcConfidence = state => {
  let score = 0;
  const h = state.history;
  if (h.length < 2) return 3;
  const fundings = h.map(s => s.funding);
  if (state.direction === 'LONG' ? fundings.every(f => f < 0.005) : fundings.every(f => f > 0.01)) score += 2; else score += 0.5;
  const ois = h.map(s => s.oi);
  if (ois.every((oi, i) => i === 0 || oi >= ois[i - 1])) score += 2;
  const lsRatios = h.map(s => s.ls);
  if (state.direction === 'LONG'
    ? lsRatios[lsRatios.length - 1] < lsRatios[0]
    : lsRatios[lsRatios.length - 1] > lsRatios[0]) score += 1.5;
  const prices = h.map(s => s.price);
  if (state.direction === 'LONG'
    ? prices[prices.length - 1] > prices[0]
    : prices[prices.length - 1] < prices[0]) score += 1.5;
  const avgVol = h.map(s => s.vol).reduce((a, b) => a + b, 0) / h.length;
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

const buildAlert = (coin, state, btcStatus, type = 'BREAKOUT') => {
  const isLong = state.direction === 'LONG';
  const dirEmoji = isLong ? '🟢' : '🔴';
  const dir = isLong ? '📈 LONG' : '📉 SHORT';
  const entry = coin.price;
  const atr = entry * 0.015;
  const sl  = isLong ? entry - atr : entry + atr;
  const tp1 = isLong ? entry + atr     : entry - atr;
  const tp2 = isLong ? entry + atr * 2 : entry - atr * 2;
  const tp3 = isLong ? entry + atr * 3 : entry - atr * 3;
  const bar = confBar(state.confidence);
  const btcLine = btcStatus
    ? `${btcStatus.emoji} BTC: $${btcStatus.price.toLocaleString()} ${btcStatus.change > 0 ? '+' : ''}${btcStatus.change.toFixed(2)}% — ${btcStatus.condition}`
    : '';
  const histLines = state.history.slice(-3).map((h, i) => {
    const label = ['1st','2nd','3rd'][i] || `${i+1}th`;
    const ok = isLong ? (h.funding < 0.005 ? '✅' : '⚠️') : (h.funding > 0.01 ? '✅' : '⚠️');
    const oiChange = state.history[0]?.oi > 0
      ? ((h.oi - state.history[0].oi) / state.history[0].oi * 100).toFixed(1)
      : '0.0';
    return `  ${label}: Fund ${h.funding.toFixed(3)}% ${ok} | OI ${oiChange}% | Vol ${h.vol.toFixed(1)}x`;
  }).join('\n');

  const disclaimer = `━━━━━━━━━━━━━━━\n⚠️ <i>DYOR — Not financial advice. Always use a stop loss. Trade at your own risk.</i>`;

  if (type === 'BREAKOUT') return `
${dirEmoji} NEXIO — ${dir} SIGNAL
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')}
📊 Confidence: ${state.confidence}/10
${bar}
━━━━━━━━━━━━━━━
📋 SCAN HISTORY (${state.scanCount} scans confirmed):
${histLines}
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
${disclaimer}
  `.trim();

  if (type === 'WATCH') return `
👀 NEXIO — WATCH ALERT
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')} — Building ${state.confidence}/10
${bar}
━━━━━━━━━━━━━━━
${isLong ? '🔄 Accumulation — whales loading quietly\n📈 Waiting for breakout confirmation' : '🔄 Distribution — whales unloading\n📉 Waiting for breakdown confirmation'}
━━━━━━━━━━━━━━━
💰 Price:    $${fmtP(entry)}
💸 Funding:  ${coin.funding?.toFixed(3)}%
⚖️ L/S:      ${coin.ls?.toFixed(2) || '—'}
━━━━━━━━━━━━━━━
⏳ DO NOT ENTER YET
🎯 Watch for breakout above $${fmtP(isLong ? entry * 1.005 : entry * 0.995)}
⏰ ${gstNow()} GST
📊 bybit.com/trade/usdt/${coin.symbol}
${disclaimer}
  `.trim();

  if (type === 'FADING') return `
⚠️ NEXIO — SIGNAL FADING
━━━━━━━━━━━━━━━
🪙 ${coin.symbol.replace('USDT','')}
❌ Momentum reversed — setup cancelled
${state.entryPrice ? `📍 Was at: $${fmtP(state.entryPrice)} → Now: $${fmtP(entry)}\n⚡ Exit or tighten stop immediately` : '⚡ Do NOT enter'}
⏰ ${gstNow()} GST
${disclaimer}
  `.trim();

  return '';
};

const buildPriorityList = btcStatus => {
  const sorted = getSortedTracker();
  if (!sorted.length) return null;
  const btcLine = btcStatus
    ? `${btcStatus.emoji} BTC: $${btcStatus.price.toLocaleString()} ${btcStatus.change > 0 ? '+' : ''}${btcStatus.change.toFixed(2)}%`
    : '';
  const lines = sorted.slice(0, 10).map((s, i) => {
    const rank      = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir       = s.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const stateLabel = s.state === 'READY'      ? '🔥 HIGH CONF'
                     : s.state === 'CONFIRMING' ? '⚡ CONFIRMED'
                     : '👀 WATCHING';
    return `${rank} ${dir} <b>${s.symbol.replace('USDT','')}</b> — ${stateLabel} ${s.confidence}/10\n     ${confBar(s.confidence)}`;
  }).join('\n');
  return `
📊 <b>NEXIO PRIORITY LIST</b>
━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━
${btcLine}
⏰ ${gstNow()} GST
🔥HIGH CONF = enter now | ⚡CONFIRMED = watch closely | 👀WATCHING = building
━━━━━━━━━━━━━━━
⚠️ <i>DYOR — Not financial advice. Always use a stop loss. Trade at your own risk.</i>
  `.trim();
};

const runWatchlistScan = async () => {
  watchlistScanCount++;
  log(`👁 Watchlist Scan #${watchlistScanCount} starting...`);
  try {
    const watchlist    = await getWatchlist();
    const btcStatus    = await getBTCStatus();
    const btcDumping   = btcStatus && btcStatus.change < -1.5;
    const symbols      = watchlist.map(r => r.symbol);

    if (!symbols.length) {
      log('Watchlist empty — skipping watchlist scan');
      return;
    }

    let alertsFired = 0;

    for (const symbol of symbols) {
      await sleep(400);
      let price = 0, funding = 0, longShortRatio = 1, currentOI = 0, volSpike = 0, price15mChange = 0, klines = [];

      try {
        const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
        price = parseFloat(t.price);
      } catch { }
      try {
        const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        funding = parseFloat(f.lastFundingRate) * 100;
      } catch { }
      try {
        klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=8`);
        if (klines.length >= 4) {
          const lv = parseFloat(klines[klines.length-1][5]);
          const pv = klines.slice(0,-1).map(k => parseFloat(k[5]));
          const av = pv.reduce((a,b) => a+b, 0) / pv.length;
          volSpike = av > 0 ? lv / av : 0;
          const o = parseFloat(klines[klines.length-1][1]);
          const c = parseFloat(klines[klines.length-1][4]);
          price15mChange = o > 0 ? ((c - o) / o) * 100 : 0;
        }
      } catch { }
      try {
        const ls = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
        longShortRatio = parseFloat(ls[0]?.longShortRatio || 1);
      } catch { }
      try {
        const oi = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
        currentOI = parseFloat(oi.openInterest);
      } catch { }

      if (!price) continue;

      // Determine direction
      const isLong  = funding < 0.005 && longShortRatio < 1.1;
      const isShort = funding > 0.015 && longShortRatio > 1.15;
      if (!isLong && !isShort) {
        // Score dropped — remove from watchlist
        coinTracker.delete(symbol);
        await removeFromWatchlist(symbol);
        log(`❌ Removed: ${symbol} — no longer meets criteria`);
        continue;
      }

      const direction = isLong ? 'LONG' : 'SHORT';

      // Update direction in Supabase
      await updateWatchlistScore(symbol, 0, direction);

      // ── Order book check ──────────────────────────────────────────────────
      let obGo = true;
      try {
        const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
        const bids = ob.bids.map(b => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
        const asks = ob.asks.map(a => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
        const nearBids = bids.filter(b => b.price >= price * 0.98);
        const nearAsks = asks.filter(a => a.price <= price * 1.02);
        const totalBid = nearBids.reduce((s,b) => s + b.qty * b.price, 0);
        const totalAsk = nearAsks.reduce((s,a) => s + a.qty * a.price, 0);
        const ratio    = totalAsk > 0 ? totalBid / totalAsk : 1;
        const bigSell  = asks.reduce((m,a) => a.qty*a.price > m.size ? {price:a.price,size:a.qty*a.price} : m, {price:0,size:0});
        const sellProx = bigSell.price > 0 ? ((bigSell.price - price) / price) * 100 : 99;
        if (isLong && sellProx < 1.5 && bigSell.size > 50000 && ratio < 0.7) obGo = false;
        const bigBuy   = bids.reduce((m,b) => b.qty*b.price > m.size ? {price:b.price,size:b.qty*b.price} : m, {price:0,size:0});
        const buyProx  = bigBuy.price > 0 ? ((price - bigBuy.price) / price) * 100 : 99;
        if (!isLong && buyProx < 1.5 && bigBuy.size > 50000 && ratio > 1.3) obGo = false;
      } catch { }

      const tracked = coinTracker.get(symbol);

      // Direction flip → fade
      if (tracked && direction !== tracked.direction) {
        tracked.state = 'FADING';
        if (tracked.entryPrice) {
          await postSignal(buildAlert({ symbol, price, funding, ls: longShortRatio }, tracked, btcStatus, 'FADING'));
        }
        coinTracker.delete(symbol);
        continue;
      }

      if (tracked && tracked.scanCount >= MAX_SCANS) {
        coinTracker.delete(symbol);
        continue;
      }

      // Breakout check
      const isBreakout = volSpike >= 1.5
        && (isLong ? price15mChange >= 0.2 : price15mChange <= -0.2)
        && obGo && !btcDumping;

      if (isBreakout && tracked && tracked.scanCount >= 1 && tracked.confidence >= 3) {
        const alertKey = `breakout_${symbol}`;
        if (canAlert(alertKey) && alertsFired < 5) {
          tracked.entryPrice = price;
          tracked.state = 'BREAKOUT';
          await postSignal(buildAlert({ symbol, price, funding, ls: longShortRatio }, tracked, btcStatus, 'BREAKOUT'));
          markAlert(alertKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now() });
          coinTracker.delete(symbol);
          alertsFired++;
          log(`🚀 BREAKOUT: ${symbol} ${direction} conf:${tracked.confidence}`);
          // Update score in Supabase
          await updateWatchlistScore(symbol, tracked.confidence, direction);
          continue;
        }
      }

      // Loading check
      const isLoading = klines.length >= 6 && (() => {
        const c  = klines.slice(-6);
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
        updateTracker(symbol, { price, funding, oi: currentOI, ls: longShortRatio, vol: volSpike }, direction);
        const state = coinTracker.get(symbol);
        log(`📊 ${symbol} ${direction} conf:${state.confidence} scan:${state.scanCount} state:${state.state}`);

        // WATCH alert on 2nd scan with good confidence
        if (state.scanCount === 2 && state.confidence >= 4) {
          const watchKey = `watch_${symbol}`;
          if (canAlert(watchKey)) {
            await postSignal(buildAlert({ symbol, price, funding, ls: longShortRatio }, state, btcStatus, 'WATCH'));
            markAlert(watchKey);
          }
        }
      }

      // Fade detection for previously alerted coins
      const sig = signalPrices.get(symbol);
      if (sig) {
        const chg = sig.direction === 'LONG'
          ? ((sig.price - price) / sig.price) * 100
          : ((price - sig.price) / sig.price) * 100;
        if (chg >= FADE_THRESHOLD_PCT) {
          await postSignal(`⚠️ NEXIO — MOMENTUM FADING\n━━━━━━━━━━━━━━━\n🪙 ${symbol.replace('USDT','')}\n📉 Dropped ${chg.toFixed(1)}% from signal\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n━━━━━━━━━━━━━━━\n⚡ Exit or tighten stop\n⏰ ${gstNow()} GST\n━━━━━━━━━━━━━━━\n⚠️ <i>DYOR — Not financial advice. Always use a stop loss.</i>`);
          signalPrices.delete(symbol);
        }
      }
    }

    // Priority list every 3 watchlist scans — both channels
    if (watchlistScanCount % 3 === 0 && coinTracker.size > 0) {
      const msg = buildPriorityList(btcStatus);
      if (msg) await postSignal(msg);
    }

    // Scan summary — only to owner, not channels
    const ready    = getSortedTracker().filter(c => c.state === 'READY').length;
    const confirm  = getSortedTracker().filter(c => c.state === 'CONFIRMING').length;
    const watching = getSortedTracker().filter(c => c.state === 'WATCHING').length;
    const summary = `
🔍 Scan #${watchlistScanCount} | ⏰ ${gstNow()}
👁 Watchlist: ${symbols.length} | Tracking: ${coinTracker.size}
🔥 Ready: ${ready} | ⚡ Conf: ${confirm} | 👀 Watch: ${watching}
${ready > 0 ? '🚨 Breakout imminent!' : coinTracker.size > 0 ? '⏳ Building...' : '😴 Quiet market'}
    `.trim();
    await tg(OWNER_CHAT_ID, summary);

    log(`👁 Watchlist scan #${watchlistScanCount} done — Tracked: ${coinTracker.size} | Alerts: ${alertsFired}`);
  } catch (err) { log('Watchlist scan error:', err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
const handleCommand = async msg => {
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
Smart crypto trading signals — 24/7.

📊 Free: @NexioSignals
👑 Premium: Nexio Prime

/subscribe — Upgrade ($${PRICE_USD}/mo)
/status — Your account
/help — All commands
🐆 Nexio — Trade smarter
    `.trim());
  }
  else if (text === '/subscribe') {
    await tg(chatId, `
💳 <b>Subscribe to Nexio Prime</b>
━━━━━━━━━━━━━━━
Send <b>$${PRICE_USD} USDT</b> on <b>TRC20</b> to:
<code>${USDT_ADDRESS}</code>
⚠️ TRC20 ONLY
After sending: <code>/txid YOUR_TXID</code>
Activated within 1 hour 🐆
    `.trim());
  }
  else if (text.startsWith('/txid')) {
    const txid = text.replace('/txid','').trim();
    if (!txid) { await tg(chatId, '⚠️ Example: <code>/txid abc123...</code>'); return; }
    await savePayment(chatId, username, txid);
    await tg(chatId, `⏳ Payment received! TXID: <code>${txid.slice(0,20)}...</code>\nActivation within 1 hour 🐆`);
    await tg(OWNER_CHAT_ID, `💰 <b>NEW PAYMENT!</b>\n👤 @${username||chatId}\n💵 $${PRICE_USD} USDT\n🔗 <code>${txid}</code>\n<a href="https://tronscan.org/#/transaction/${txid}">Verify</a>\n/activate ${chatId}`);
  }
  else if (text === '/status') {
    const all     = await getAllUsers();
    const premium = await getPremiumUsers();
    const wl      = await getWatchlist();
    await tg(chatId, `
📊 <b>Nexio Status</b>
━━━━━━━━━━━━━━━
👤 Account: ${user?.is_premium ? '👑 Prime' : '🆓 Free'}
🤖 Server: Online ✅
👥 Users: ${all.length} | 👑 Prime: ${premium.length}
👁 Watchlist: ${wl.length} coins
📊 Tracking: ${coinTracker.size} candidates
🔍 Full scans: ${fullScanCount} | Watchlist scans: ${watchlistScanCount}
⏰ ${gstNow()} GST
    `.trim());
  }
  else if (text === '/watchlist') {
    const wl = await getWatchlist();
    if (!wl.length) { await tg(chatId, '👁 Watchlist is empty'); return; }
    const lines = wl.slice(0, 20).map((r, i) => `${i+1}. ${r.symbol.replace('USDT','')} — score ${r.score || '?'} ${r.direction || ''}`).join('\n');
    await tg(chatId, `👁 <b>Watchlist (${wl.length} coins)</b>\n━━━━━━━━━━━━━━━\n${lines}`);
  }
  else if (text === '/tracking') {
    const sorted = getSortedTracker();
    if (!sorted.length) { await tg(chatId, '📊 No coins being tracked yet'); return; }
    const lines = sorted.map((s, i) => `${i+1}. ${s.symbol.replace('USDT','')} — ${s.state} ${s.confidence}/10 (${s.scanCount} scans)`).join('\n');
    await tg(chatId, `📊 <b>Tracking (${sorted.length})</b>\n━━━━━━━━━━━━━━━\n${lines}`);
  }
  else if (text === '/help') {
    await tg(chatId, `
📖 <b>Nexio Commands</b>
━━━━━━━━━━━━━━━
/start — Welcome
/subscribe — Upgrade to Prime
/txid — Submit payment
/status — Server status
/watchlist — View watchlist
/tracking — View tracked coins
/test — Test alert pipeline
/help — This message
🐆 Nexio
    `.trim());
  }

  // Test — anyone can use
  if (text === '/test') {
    await tg(chatId, '🔧 Sending test to both channels...');
    await postSignal(`🧪 NEXIO — TEST\n━━━━━━━━━━━━━━━\n✅ Bot alive\n📊 Watchlist scanner active\n🌍 Full market scanner active\n⏰ ${gstNow()} GST\n🐆 Nexio is watching`);
    await tg(chatId, '✅ Test sent to both channels!');
  }

  // Admin only
  if (chatId === OWNER_CHAT_ID) {
    if (text === '/fullscan') { await tg(chatId, '🌍 Running full market scan...'); runFullMarketScan(); }
    if (text === '/scan')     { await tg(chatId, '👁 Running watchlist scan...');   runWatchlistScan(); }

    if (text.startsWith('/activate')) {
      const targetId = text.replace('/activate','').trim();
      if (!targetId) { await tg(chatId, '⚠️ Usage: /activate <chatId>'); return; }
      await setPremium(targetId);
      await addToChannel(parseInt(targetId), PREMIUM_CHANNEL);
      await tg(targetId, `👑 <b>Welcome to Nexio Prime!</b>\n✅ Payment verified!\nYou now receive all premium signals 🐆`);
      await tg(chatId, `✅ ${targetId} activated!`);
    }
    if (text === '/pending') {
      const pending = await getPendingPayments();
      if (!pending.length) { await tg(chatId, '✅ No pending'); return; }
      let m = `⏳ <b>Pending (${pending.length})</b>\n`;
      for (const p of pending) m += `\n👤 ${p.email||p.user_id}\n<code>${p.txid?.slice(0,20)}...</code>\n<a href="https://tronscan.org/#/transaction/${p.txid}">Verify</a>\n/activate ${p.user_id}\n`;
      await tg(chatId, m);
    }
    if (text.startsWith('/broadcast')) {
      const bMsg = text.replace('/broadcast','').trim();
      if (!bMsg) { await tg(chatId, '⚠️ Usage: /broadcast <msg>'); return; }
      const users = await getAllUsers();
      for (const u of users) { await tg(u.chat_id, `📢 <b>Nexio Update</b>\n\n${bMsg}`); await sleep(100); }
      await tg(chatId, `✅ Sent to ${users.length} users`);
    }
    if (text === '/users') {
      const all = await getAllUsers(), premium = await getPremiumUsers();
      await tg(chatId, `👥 Total: ${all.length} | 👑 Prime: ${premium.length} | 💰 $${(premium.length * PRICE_USD).toFixed(2)}/mo`);
    }
  }
};

// ── Poll for bot messages ─────────────────────────────────────────────────────
const pollUsers = async () => {
  try {
    const data = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=20&timeout=0`);
    if (!data?.ok || !data.result?.length) return;
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      if (update.message) await handleCommand(update.message);
    }
  } catch (err) { log('Poll error:', err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const start = async () => {
  log('🚀 Nexio server starting...');
  await tg(OWNER_CHAT_ID, `
🟢 <b>Nexio Server Started</b>
━━━━━━━━━━━━━━━
🌍 Full Market Scan: every 10 min
👁 Watchlist Scan: every 3 min
📊 Both channels: same signals
⏰ ${gstNow()} GST
━━━━━━━━━━━━━━━
Admin: /fullscan /scan /pending /users /activate /broadcast /watchlist /tracking /test
  `.trim());

  // Start polling
  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();

  // Run full market scan immediately then every 10 min
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);

  // Wait 1 min then start watchlist scan every 3 min
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
};

start();
