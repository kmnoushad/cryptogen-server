// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v2.1 — 9-Layer Intelligence Scanner
//
// LAYER 1  — BTC Momentum Gate (must pass before any alert)
// LAYER 2  — Full coin universe (low + mid cap, pump filter 15%)
// LAYER 3  — Price Compression + OI Buildup (MOST IMPORTANT)
// LAYER 4  — Volume Buildup BEFORE Breakout
// LAYER 5  — Repeated Resistance Testing (Breakout Pressure)
// LAYER 6  — Funding + L/S Confirmation
// LAYER 7  — Trap Risk Filter + Candle Wick Detector (NEW v2.1)
// LAYER 8  — Two-Stage Alert System (WATCH → FIRE)
// LAYER 9  — Momentum Guard (fade/exit detection post-alert)
//
// Min score to alert: 6.5/10
//
// v2.1 NEW: Candle Wick Detector in Layer 7
//   STRONG  body>=60% wick<=25% → VALID SETUP ✅
//   WEAK    body 30-60%         → CAUTION ⚠️
//   FAKE    body<30% wick>60%   → SKIP ❌
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003900595640';
const PREMIUM_CHANNEL = '-1003913881352';
const OWNER_CHAT_ID   = '6896387082';
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

const FULL_MARKET_INTERVAL_MS = 600000;
const WATCHLIST_SCAN_INTERVAL = 180000;
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 500000;
const MAX_WATCHLIST           = 60;
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 2.0;
const MIN_ALERT_SCORE         = 6.5;
const PUMP_EXCLUDE_PCT        = 15.0;

const EXCLUDE = new Set([
  // High cap crypto
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'HBARUSDT','WBTCUSDT',
  // Commodities / gold / oil
  'XAUTUSDT','PAXGUSDT','XAUUSDT','XAGUUSDT','CLUSDT',
  // Stablecoins / index
  'BTCDOMUSDT','DEFIUSDT','USDCUSDT','USDTUSDT',
  // Tokenized US stocks
  'TSLAUSDT','AAPLUSDT','GOOGLUSDT','AMZNUSDT','MSFTUSDT',
  'NVDAUSDT','METAUSDT','COINUSDT','NFLXUSDT','BABAUSDT',
  'AMDUSDT','BRKBUSDT','INTCUSDT','TSMUSDT','TSMAUSDT',
  'UBERUSDT','ABNBUSDT','PYTUSDT','SPYUSDT','QQQUSDT',
  'AركUSDT','PLTRУСDT','PLTRУСDT',
  // Tokenized Asian / other stocks
  'BRKAUSDT','SHOP1USDT','NVDAUSDT',
]);

const MID_CAP = new Set([
  'LINKUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','NEARUSDT',
  'INJUSDT','LDOUSDT','APTUSDT','AAVEUSDT','MKRUSDT',
  'ARBUSDT','OPUSDT','STXUSDT','GMXUSDT','SNXUSDT',
  'COMPUSDT','CRVUSDT','UNIUSDT','ENJUSDT','CHZUSDT',
  'SANDUSDT','MANAUSDT','GALAUSDT','APEUSDT','IMXUSDT',
]);

const alertHistory  = new Map();
const coinTracker   = new Map();
const signalPrices  = new Map();
const resistanceMap = new Map();
let   lastUpdateId  = 0;
let   fullScanCount      = 0;
let   watchlistScanCount = 0;
let   btcGateStatus      = { pass: true, reason: 'Starting up', price: 0, change: 0 };

const sleep   = ms => new Promise(r => setTimeout(r, ms));
const gstNow  = ()  => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log       = (...a) => console.log(`[${gstNow()}]`, ...a);
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

const fetchJSON = async (url, timeout = 8000) => {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
};

const sb = async (path, options = {}) => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
        ...options.headers,
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};

const getWatchlist         = async () => (await sb('watchlist?select=symbol,score,direction')) || [];
const addToWatchlist       = async (symbol, score, direction) => sb('watchlist', {
  method: 'POST',
  body: JSON.stringify({ symbol, score, direction, added_by: 'server', updated_at: new Date().toISOString() }),
});
const removeFromWatchlist  = async symbol => sb(`watchlist?symbol=eq.${symbol}`, { method: 'DELETE' });
const updateWatchlistScore = async (symbol, score, direction) => sb(`watchlist?symbol=eq.${symbol}`, {
  method: 'PATCH',
  body: JSON.stringify({ score, direction, updated_at: new Date().toISOString() }),
});
const getUser         = async chatId => (await sb(`bot_users?chat_id=eq.${chatId}`))?.[0];
const saveUser        = async (chatId, username, firstName) => sb('bot_users', {
  method: 'POST',
  body: JSON.stringify({ chat_id: String(chatId), username: username||'', first_name: firstName||'', is_active: true }),
});
const setPremium      = async chatId => sb(`bot_users?chat_id=eq.${chatId}`, {
  method: 'PATCH',
  body: JSON.stringify({ is_premium: true, premium_since: new Date().toISOString() }),
});
const getAllUsers      = async () => (await sb('bot_users?is_active=eq.true&select=chat_id')) || [];
const getPremiumUsers = async () => (await sb('bot_users?is_premium=eq.true&is_active=eq.true&select=chat_id')) || [];
const savePayment     = async (chatId, username, txid) => sb('subscriptions', {
  method: 'POST',
  body: JSON.stringify({ user_id: chatId, email: username, txid, plan: 'premium', status: 'pending', amount_paid: PRICE_USD, currency: 'USDT', created_at: new Date().toISOString() }),
});
const getPendingPayments = async () => (await sb('subscriptions?status=eq.pending&select=*')) || [];

const tg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { }
};

const postSignal = async text => {
  for (const chatId of [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID]) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
    } catch { }
    await sleep(300);
  }
};

const addToChannel = async (chatId, channelId) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, user_id: chatId }),
    });
  } catch { }
};

// ── LAYER 1: BTC Gate ─────────────────────────────────────────────────────────
const checkBTCGate = async () => {
  try {
    const [klines, ticker, funding] = await Promise.all([
      fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=8'),
      fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
      fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    ]);
    const price     = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const fundRate  = parseFloat(funding.lastFundingRate) * 100;
    const open1H    = parseFloat(klines[klines.length - 4][1]);
    const close1H   = parseFloat(klines[klines.length - 1][4]);
    const change1H  = ((close1H - open1H) / open1H) * 100;
    const latestOpen  = parseFloat(klines[klines.length - 1][1]);
    const latestClose = parseFloat(klines[klines.length - 1][4]);
    const candleGreen = latestClose >= latestOpen;
    let pass = true, reason = '✅ BTC stable';
    if (change1H < -1.5)                      { pass = false; reason = `🔴 BTC dumping ${change1H.toFixed(2)}% in 1H`; }
    else if (fundRate > 0.025)                { pass = false; reason = `⚠️ BTC funding too high ${fundRate.toFixed(3)}%`; }
    else if (!candleGreen && change1H < -0.8) { pass = false; reason = `🟠 BTC bearish momentum`; }
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji };
    return btcGateStatus;
  } catch {
    btcGateStatus = { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0 };
    return btcGateStatus;
  }
};

// ── LAYER 3: Price Compression + OI ──────────────────────────────────────────
const checkCompression = (klines, currentOI, prevOI) => {
  if (klines.length < 6) return { score: 0, compressed: false, oiBuilding: false, tightening: false, range: 99 };
  const recent = klines.slice(-6);
  const highs  = recent.map(k => parseFloat(k[2]));
  const lows   = recent.map(k => parseFloat(k[3]));
  const mid    = (Math.max(...highs) + Math.min(...lows)) / 2;
  const range  = mid > 0 ? ((Math.max(...highs) - Math.min(...lows)) / mid) * 100 : 99;
  const compressed  = range < 4.0;
  const oiBuilding  = prevOI > 0 && currentOI > prevOI * 1.02;
  const ranges      = recent.map(k => parseFloat(k[2]) - parseFloat(k[3]));
  const tightening  = ranges[ranges.length-1] < ranges[0] * 0.7;
  let score = 0;
  if (compressed && oiBuilding) score += 3;
  else if (compressed)          score += 1.5;
  else if (oiBuilding)          score += 1;
  if (tightening)               score += 0.5;
  return { score, compressed, oiBuilding, tightening, range: parseFloat(range.toFixed(2)) };
};

// ── LAYER 4: Volume Buildup ───────────────────────────────────────────────────
const checkVolumeBuild = (klines) => {
  if (klines.length < 6) return { score: 0, building: false, spike: 0, gradual: false };
  const vols    = klines.map(k => parseFloat(k[5]));
  const recent  = vols.slice(-4);
  const base    = vols.slice(0, -4);
  const avgBase = base.reduce((a, b) => a + b, 0) / (base.length || 1);
  const gradual = recent[0] < recent[1] && recent[1] < recent[2];
  const latestSpike = avgBase > 0 ? recent[recent.length-1] / avgBase : 0;
  const closes  = klines.map(k => parseFloat(k[4]));
  const priceChange = closes[0] > 0 ? Math.abs((closes[closes.length-1] - closes[0]) / closes[0]) * 100 : 0;
  const quietAccum = latestSpike >= 1.5 && priceChange < 3;
  let score = 0;
  if (quietAccum)              score += 2;
  else if (latestSpike >= 2)   score += 1.5;
  else if (latestSpike >= 1.5) score += 1;
  if (gradual) score += 0.5;
  return { score, building: quietAccum, spike: parseFloat(latestSpike.toFixed(1)), gradual };
};

// ── LAYER 5: Resistance Testing ───────────────────────────────────────────────
const checkResistanceTesting = (symbol, price, klines) => {
  if (klines.length < 6) return { score: 0, tests: 0, pressure: false, resistanceLevel: price };
  const highs     = klines.map(k => parseFloat(k[2]));
  const maxH      = Math.max(...highs);
  const tolerance = maxH * 0.005;
  const tests     = highs.filter(h => Math.abs(h - maxH) <= tolerance).length;
  const testVols  = klines.filter(k => Math.abs(parseFloat(k[2]) - maxH) <= tolerance).map(k => parseFloat(k[5]));
  const volInc    = testVols.length >= 2 && testVols[testVols.length-1] > testVols[0];
  const prev      = resistanceMap.get(symbol) || { level: maxH, tests: 0 };
  if (Math.abs(maxH - prev.level) / (prev.level || 1) < 0.01) {
    resistanceMap.set(symbol, { level: maxH, tests: Math.max(tests, prev.tests) });
  } else {
    resistanceMap.set(symbol, { level: maxH, tests });
  }
  const totalTests = resistanceMap.get(symbol).tests;
  const pressure   = totalTests >= 3 && volInc;
  let score = 0;
  if (pressure)             score += 2;
  else if (totalTests >= 3) score += 1;
  else if (totalTests >= 2) score += 0.5;
  return { score, tests: totalTests, pressure, resistanceLevel: parseFloat(maxH.toFixed(5)) };
};

// ── LAYER 6: Funding + L/S ────────────────────────────────────────────────────
const checkFundingLS = (funding, ls, direction) => {
  let score = 0;
  if (direction === 'LONG') {
    if (funding < -0.01)      score += 2;
    else if (funding < 0)     score += 1;
    else if (funding < 0.005) score += 0.5;
    if (ls < 0.85)            score += 2;
    else if (ls < 0.95)       score += 1;
    else if (ls < 1.05)       score += 0.5;
  } else {
    if (funding > 0.02)       score += 2;
    else if (funding > 0.01)  score += 1;
    if (ls > 1.3)             score += 2;
    else if (ls > 1.15)       score += 1;
  }
  return { score: Math.min(score, 2), funding, ls };
};

// ── LAYER 7a: Candle Wick Detector (NEW v2.1) ─────────────────────────────────
// Analyses last 3 candles for wick patterns
// STRONG  body>=60% wick<=25% → real move, enter
// WEAK    body 30-60%         → reduce size, caution
// FAKE    body<30% wick>60%   → skip, likely fakeout/rug
const checkCandleQuality = (klines, direction) => {
  if (!klines || klines.length < 2) {
    return { verdict: 'UNKNOWN', bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, details: 'Not enough candles' };
  }
  const recent = klines.slice(-3);
  const results = recent.map(k => {
    const open  = parseFloat(k[1]);
    const high  = parseFloat(k[2]);
    const low   = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const range = high - low;
    if (range === 0) return { bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, isGreen: false };
    const body      = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    return {
      bodyPct:      parseFloat(((body / range) * 100).toFixed(1)),
      upperWickPct: parseFloat(((upperWick / range) * 100).toFixed(1)),
      lowerWickPct: parseFloat(((lowerWick / range) * 100).toFixed(1)),
      isGreen: close >= open,
    };
  });

  const latest    = results[results.length - 1];
  const wickyCount = results.filter(r => r.upperWickPct > 50 || r.bodyPct < 25).length;

  let verdict, emoji, details;

  if (direction === 'LONG') {
    if (latest.bodyPct >= 60 && latest.upperWickPct <= 25 && latest.isGreen) {
      verdict = 'STRONG'; emoji = '✅';
      details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — clean breakout`;
    } else if (latest.upperWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌';
      details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — rejection candle`;
    } else if (wickyCount >= 2) {
      verdict = 'FAKE'; emoji = '❌';
      details = `${wickyCount}/3 wicky candles — repeated rejection`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️';
      details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — weak momentum`;
    }
  } else {
    if (latest.bodyPct >= 60 && latest.lowerWickPct <= 25 && !latest.isGreen) {
      verdict = 'STRONG'; emoji = '✅';
      details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — clean breakdown`;
    } else if (latest.lowerWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌';
      details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — possible reversal`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️';
      details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — weak momentum`;
    }
  }

  return {
    verdict, emoji, details,
    bodyPct:      latest.bodyPct,
    upperWickPct: latest.upperWickPct,
    lowerWickPct: latest.lowerWickPct,
    wickyCount,
    isGreen: latest.isGreen,
  };
};

// ── LAYER 7b: Trap Filter (updated — includes candle quality) ─────────────────
const checkTrapRisk = async (symbol, price, direction, volSpike, oiBuilding, klines = []) => {
  let trapScore = 0;
  const reasons = [];

  // Existing: vol spike without OI
  if (volSpike >= 2 && !oiBuilding) {
    trapScore += 2;
    reasons.push('vol spike no OI confirmation');
  }

  // Existing: order book check
  try {
    const ob      = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`);
    const bids    = ob.bids.map(b => ({ p: parseFloat(b[0]), q: parseFloat(b[1]) }));
    const asks    = ob.asks.map(a => ({ p: parseFloat(a[0]), q: parseFloat(a[1]) }));
    const bidVal  = bids.filter(b => b.p >= price * 0.99).reduce((s, b) => s + b.p * b.q, 0);
    const askVal  = asks.filter(a => a.p <= price * 1.01).reduce((s, a) => s + a.p * a.q, 0);
    const bigSell = asks.reduce((m, a) => a.p * a.q > m.size ? { p: a.p, size: a.p * a.q } : m, { p: 0, size: 0 });
    const sellProx = bigSell.p > 0 ? ((bigSell.p - price) / price) * 100 : 99;
    if (direction === 'LONG' && sellProx < 1.5 && bigSell.size > 30000) {
      trapScore += 2;
      reasons.push(`sell wall ${sellProx.toFixed(1)}% above`);
    }
    if (direction === 'LONG' && askVal > bidVal * 2) {
      trapScore += 1;
      reasons.push('asks dominating bids');
    }
  } catch { }

  // NEW v2.1: Candle wick quality check
  const candle = checkCandleQuality(klines, direction);
  if (candle.verdict === 'FAKE') {
    trapScore += 2;
    reasons.push(`fake candle: ${candle.details}`);
  } else if (candle.verdict === 'WEAK') {
    trapScore += 1;
    reasons.push(`weak candle: ${candle.details}`);
  } else if (candle.verdict === 'STRONG') {
    trapScore = Math.max(0, trapScore - 0.5); // strong candle slightly reduces trap risk
  }

  return { safe: trapScore === 0, trapScore, reasons, candle };
};

// ── Master Score ──────────────────────────────────────────────────────────────
const calcMasterScore = ({ compression, volume, resistance, fundingLS, trap }) => {
  const raw = compression.score + volume.score + resistance.score + fundingLS.score - (trap.trapScore * 0.5);
  return Math.max(0, Math.min(10, parseFloat(raw.toFixed(1))));
};

// ── Alert Messages ────────────────────────────────────────────────────────────
const DISCLAIMER = `━━━━━━━━━━━━━━━\n⚠️ <i>DYOR — Not financial advice. Always use a stop loss. Trade at your own risk.</i>`;

// WATCH alert — shows candle quality warning if wicky
const buildWatchMsg = (symbol, score, direction, layers, btc) => {
  const isLong  = direction === 'LONG';
  const signals = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) signals.push('📦 Price coiling + OI building');
  else if (layers.compression.compressed) signals.push('📦 Price compression detected');
  if (layers.compression.tightening)  signals.push('🎯 Compression tightening — spring loading');
  if (layers.volume.building)         signals.push('🔊 Volume accumulating quietly');
  if (layers.resistance.pressure)     signals.push(`🧱 Resistance tested ${layers.resistance.tests}x — breakout pressure`);
  if (layers.fundingLS.funding < 0)   signals.push(`💸 Funding ${layers.fundingLS.funding.toFixed(3)}% — shorts paying`);
  if (layers.fundingLS.ls < 1)        signals.push(`⚖️ L/S ${layers.fundingLS.ls.toFixed(2)} — shorts dominating`);

  // Candle line
  const candle = layers.trap?.candle;
  const candleLine = candle && candle.verdict !== 'UNKNOWN'
    ? `\n🕯 Candle: ${candle.emoji} ${candle.verdict} — ${candle.details}`
    : '';

  const btcLine = btc ? `${btc.emoji} BTC: $${btc.price?.toLocaleString()} ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(2)}%` : '';
  return `
👀 <b>NEXIO — WATCH ALERT</b>
━━━━━━━━━━━━━━━
${isLong ? '🟢' : '🔴'} <b>${symbol.replace('USDT','')} — ${isLong ? 'LONG' : 'SHORT'} SETUP FORMING</b>
📊 Score: <b>${score}/10</b>  ${confBar(score)}
━━━━━━━━━━━━━━━
${signals.map(s => `• ${s}`).join('\n')}${candleLine}
━━━━━━━━━━━━━━━
⏳ <b>DO NOT ENTER YET — Waiting for breakout</b>
${btcLine}
⏰ ${gstNow()} GST
📊 bybit.com/trade/usdt/${symbol}
${DISCLAIMER}
  `.trim();
};

// FIRE alert — shows full candle verdict with VALID/SKIP verdict
const buildFireMsg = (symbol, price, score, direction, layers, scanCount, btc) => {
  const isLong = direction === 'LONG';
  const atr = price * 0.015;
  const sl  = isLong ? price - atr     : price + atr;
  const tp1 = isLong ? price + atr     : price - atr;
  const tp2 = isLong ? price + atr * 2 : price - atr * 2;
  const tp3 = isLong ? price + atr * 3 : price - atr * 3;

  const confirmations = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) confirmations.push('✅ OI + Price compression confirmed');
  if (layers.compression.tightening) confirmations.push('✅ Compression tightened — spring released');
  if (layers.volume.spike >= 2)       confirmations.push(`✅ Volume ${layers.volume.spike}x breakout candle`);
  if (layers.resistance.pressure)     confirmations.push(`✅ Broke resistance after ${layers.resistance.tests} tests`);
  if (layers.fundingLS.funding < 0)   confirmations.push(`✅ Funding ${layers.fundingLS.funding.toFixed(3)}% negative`);
  if (layers.fundingLS.ls < 1)        confirmations.push(`✅ L/S ${layers.fundingLS.ls.toFixed(2)} — squeeze active`);
  if (scanCount >= 2)                 confirmations.push(`✅ ${scanCount} scans confirmed`);

  // Candle quality block
  const candle = layers.trap?.candle;
  let candleBlock = '';
  if (candle && candle.verdict !== 'UNKNOWN') {
    const verdictLine = candle.verdict === 'STRONG'
      ? `✅ Candle: STRONG — ${candle.details}`
      : candle.verdict === 'WEAK'
      ? `⚠️ Candle: WEAK — ${candle.details}`
      : `❌ Candle: FAKE — ${candle.details}`;

    const wickBar = isLong
      ? `   Body ${candle.bodyPct}% | Upper wick ${candle.upperWickPct}%`
      : `   Body ${candle.bodyPct}% | Lower wick ${candle.lowerWickPct}%`;

    const overallVerdict = candle.verdict === 'STRONG'
      ? '🟢 <b>VALID SETUP — Enter on confirmation</b>'
      : candle.verdict === 'WEAK'
      ? '🟡 <b>CAUTION — Reduce position size</b>'
      : '🔴 <b>SKIP — Likely fakeout</b>';

    candleBlock = `\n━━━━━━━━━━━━━━━\n🕯 <b>Candle Analysis</b>\n${verdictLine}\n${wickBar}\n${overallVerdict}`;
  }

  const btcLine = btc
    ? `${btc.emoji} BTC: $${btc.price?.toLocaleString()} ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(2)}% — ${btc.reason}`
    : '';

  return `
${isLong ? '🟢' : '🔴'} <b>NEXIO SIGNAL — ${isLong ? '📈 LONG' : '📉 SHORT'}</b>
━━━━━━━━━━━━━━━
🪙 <b>${symbol.replace('USDT','')}</b>
📊 Score: <b>${score}/10</b>  ${confBar(score)}
━━━━━━━━━━━━━━━
<b>Confirmations:</b>
${confirmations.join('\n')}
━━━━━━━━━━━━━━━
💰 Entry:  <b>$${fmtP(price)}</b>
🛑 SL:     <b>$${fmtP(sl)}</b> (-1.5%)
🎯 TP1:    <b>$${fmtP(tp1)}</b> (+1.5%)
🎯 TP2:    <b>$${fmtP(tp2)}</b> (+3.0%)
🎯 TP3:    <b>$${fmtP(tp3)}</b> (+4.5%)${candleBlock}
━━━━━━━━━━━━━━━
${btcLine}
⏰ ${gstNow()} GST
📊 bybit.com/trade/usdt/${symbol}
${DISCLAIMER}
  `.trim();
};

const buildPriorityList = (btc) => {
  const sorted = [...coinTracker.values()].filter(c => c.state !== 'FADING' && c.score >= 4).sort((a, b) => b.score - a.score);
  if (!sorted.length) return null;
  const btcLine = btc ? `${btc.emoji} BTC: $${btc.price?.toLocaleString()} ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(2)}%` : '';
  const lines = sorted.slice(0, 10).map((s, i) => {
    const rank  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir   = s.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const label = s.state === 'FIRE' ? '🔥 HIGH CONF' : s.state === 'CONFIRMING' ? '⚡ CONFIRMED' : '👀 WATCHING';
    return `${rank} ${dir} <b>${s.symbol.replace('USDT','')}</b> — ${label} ${s.score}/10\n     ${confBar(s.score)}`;
  }).join('\n');
  return `
📊 <b>NEXIO PRIORITY LIST</b>
━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━
${btcLine}
⏰ ${gstNow()} GST
🔥 HIGH CONF = enter | ⚡ CONFIRMED = watch | 👀 WATCHING = building
${DISCLAIMER}
  `.trim();
};

// ── Scanner 1: Full Market ────────────────────────────────────────────────────
const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount}`);
  try {
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
        if (EXCLUDE.has(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
        if (Math.abs(parseFloat(t.priceChangePercent)) >= PUMP_EXCLUDE_PCT) return false;
        if (/^(TSLA|AAPL|GOOGL|AMZN|MSFT|NVDA|META|NFLX|AMD|COIN|BABA|BRKB|INTC|UBER|SPY|QQQ|ABNB|TSM|PLTR|SHOP|PYPL|SNAP|LYFT|XAU|XAG|PAX)/.test(t.symbol)) return false;
        return true;
      })
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), isMid: MID_CAP.has(t.symbol) }))
      .sort((a, b) => {
        if (a.isMid && !b.isMid) return -1;
        if (!a.isMid && b.isMid) return 1;
        return Math.abs(a.change) - Math.abs(b.change);
      })
      .slice(0, 80);

    const currentWatchlist = await getWatchlist();
    const currentSymbols   = currentWatchlist.map(r => r.symbol);
    let added = 0;

    for (const coin of valid) {
      await sleep(350);
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=12`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      const direction = funding < 0 && ls < 1.1 ? 'LONG' : funding > 0.015 && ls > 1.15 ? 'SHORT' : null;
      if (!direction) continue;

      const score = calcMasterScore({
        compression: checkCompression(klines, currentOI, prevOI),
        volume:      checkVolumeBuild(klines),
        resistance:  checkResistanceTesting(coin.symbol, coin.price, klines),
        fundingLS:   checkFundingLS(funding, ls, direction),
        trap:        { safe: true, trapScore: 0 },
      });

      if (score >= 3.5 && !currentSymbols.includes(coin.symbol) && currentSymbols.length + added < MAX_WATCHLIST) {
        await addToWatchlist(coin.symbol, score, direction);
        currentSymbols.push(coin.symbol);
        added++;
        log(`✅ ${coin.symbol} score:${score} ${direction} ${coin.isMid ? '[MID]' : '[LOW]'}`);
      }
      if (score < 2.5 && currentSymbols.includes(coin.symbol)) {
        await removeFromWatchlist(coin.symbol);
        coinTracker.delete(coin.symbol);
      }
    }

    log(`🌍 Scan #${fullScanCount} done — +${added} added — Watchlist: ${currentSymbols.length}`);
    await tg(OWNER_CHAT_ID, `🌍 Full scan #${fullScanCount}\n+${added} coins | Total: ${currentSymbols.length}\n${btcGateStatus.emoji} BTC ${btcGateStatus.change > 0 ? '+' : ''}${btcGateStatus.change?.toFixed(2)}% | ${btcGateStatus.reason}`);
  } catch (err) { log('Full scan error:', err.message); }
};

// ── Scanner 2: Watchlist ──────────────────────────────────────────────────────
const runWatchlistScan = async () => {
  watchlistScanCount++;
  log(`👁 Watchlist Scan #${watchlistScanCount}`);
  try {
    const btc       = await checkBTCGate();
    const watchlist = await getWatchlist();
    const symbols   = watchlist.map(r => r.symbol);
    if (!symbols.length) { log('Watchlist empty'); return; }

    let alertsFired = 0;

    for (const symbol of symbols) {
      await sleep(400);
      let price = 0, funding = 0, ls = 1, currentOI = 0, prevOI = 0, klines = [];
      try { const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); price = parseFloat(t.price); } catch { }
      if (!price) continue;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=12`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      const isLong  = funding < 0.005 && ls < 1.1;
      const isShort = funding > 0.015 && ls > 1.15;
      if (!isLong && !isShort) { await removeFromWatchlist(symbol); coinTracker.delete(symbol); continue; }
      const direction = isLong ? 'LONG' : 'SHORT';

      const compression = checkCompression(klines, currentOI, prevOI);
      const volume      = checkVolumeBuild(klines);
      const resistance  = checkResistanceTesting(symbol, price, klines);
      const fundingLS   = checkFundingLS(funding, ls, direction);
      // UPDATED: pass klines as 6th argument for candle wick analysis
      const trap        = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);
      const score       = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      const layers      = { compression, volume, resistance, fundingLS, trap };

      log(`📊 ${symbol} ${direction} score:${score} candle:${trap.candle?.verdict || 'N/A'}`);

      const existing = coinTracker.get(symbol);
      const snap = { price, funding, oi: currentOI, ls, vol: volume.spike, score, time: Date.now() };

      if (!existing) {
        coinTracker.set(symbol, { symbol, direction, state: 'WATCHING', scanCount: 1, score, layers, firstSeen: Date.now(), history: [snap], entryPrice: null });
      } else {
        if (direction !== existing.direction) {
          if (existing.entryPrice) await postSignal(`⚠️ <b>NEXIO — SIGNAL FADING</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n❌ Direction reversed — exit now\n📍 Entry: $${fmtP(existing.entryPrice)} → Now: $${fmtP(price)}\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          coinTracker.delete(symbol);
          continue;
        }
        existing.history.push(snap);
        existing.scanCount++;
        existing.score  = score;
        existing.layers = layers;
        existing.state  = score >= 8 ? 'FIRE' : score >= 6 ? 'CONFIRMING' : 'WATCHING';
        coinTracker.set(symbol, existing);
      }

      const state = coinTracker.get(symbol);
      if (!state) continue;

      // STAGE 1 — WATCH alert
      if (state.scanCount === 2 && score >= 5) {
        const watchKey = `watch_${symbol}`;
        if (canAlert(watchKey)) { await postSignal(buildWatchMsg(symbol, score, direction, layers, btc)); markAlert(watchKey); }
      }

      // STAGE 2 — FIRE alert
      // Only fires on STRONG or WEAK candle — FAKE candle blocks the alert
      const breakoutConfirmed = (() => {
        if (klines.length < 2) return false;
        const latest = klines[klines.length - 1];
        const o = parseFloat(latest[1]), c = parseFloat(latest[4]);
        const move = Math.abs((c - o) / o) * 100;
        return isLong ? (c > o && move >= 0.3) : (c < o && move >= 0.3);
      })();

      const candleOk = trap.candle?.verdict !== 'FAKE'; // NEW: block FAKE candles from firing

      if (btc.pass && score >= MIN_ALERT_SCORE && state.scanCount >= 2 && trap.safe && breakoutConfirmed && candleOk && alertsFired < 4) {
        const fireKey = `fire_${symbol}`;
        if (canAlert(fireKey)) {
          state.entryPrice = price;
          state.state = 'FIRE';
          await postSignal(buildFireMsg(symbol, price, score, direction, layers, state.scanCount, btc));
          markAlert(fireKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now() });
          alertsFired++;
          log(`🚀 FIRED: ${symbol} ${direction} score:${score} candle:${trap.candle?.verdict}`);
        }
      } else if (btc.pass && score >= MIN_ALERT_SCORE && state.scanCount >= 2 && !candleOk) {
        // Log that we skipped due to fake candle
        log(`⚠️ SKIP: ${symbol} — fake candle detected (${trap.candle?.details})`);
      }

      if (score < 2.5 && state.scanCount >= 3) { coinTracker.delete(symbol); await removeFromWatchlist(symbol); }

      // LAYER 9 — Momentum guard
      const sig = signalPrices.get(symbol);
      if (sig) {
        const chg = sig.direction === 'LONG' ? ((sig.price - price) / sig.price) * 100 : ((price - sig.price) / sig.price) * 100;
        if (!btc.pass && Date.now() - sig.firedAt < 3600000) {
          await postSignal(`🚨 <b>NEXIO — EMERGENCY EXIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n⚠️ BTC momentum reversed!\n${btc.reason}\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n⚡ <b>Exit immediately</b>\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          signalPrices.delete(symbol);
        } else if (chg >= FADE_THRESHOLD_PCT) {
          await postSignal(`⚠️ <b>NEXIO — MOMENTUM FADING</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n📉 Down ${chg.toFixed(1)}% from entry\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n⚡ Tighten stop or exit\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          signalPrices.delete(symbol);
        }
      }
    }

    if (watchlistScanCount % 3 === 0 && coinTracker.size > 0) {
      const msg = buildPriorityList(btc);
      if (msg) await postSignal(msg);
    }

    const fire    = [...coinTracker.values()].filter(c => c.state === 'FIRE').length;
    const conf    = [...coinTracker.values()].filter(c => c.state === 'CONFIRMING').length;
    const watching = [...coinTracker.values()].filter(c => c.state === 'WATCHING').length;
    await tg(OWNER_CHAT_ID, `👁 Scan #${watchlistScanCount} | ${gstNow()}\nWatchlist: ${symbols.length} | Tracking: ${coinTracker.size}\n🔥 ${fire} | ⚡ ${conf} | 👀 ${watching}\nBTC: ${btc.pass ? '✅' : '❌'} ${btc.reason}\nAlerts: ${alertsFired}`);

  } catch (err) { log('Watchlist error:', err.message); }
};

// ── Bot Commands ──────────────────────────────────────────────────────────────
const handleCommand = async msg => {
  const chatId    = String(msg.chat?.id);
  const username  = msg.from?.username || '';
  const firstName = msg.from?.first_name || '';
  const text      = (msg.text || '').trim();
  await saveUser(chatId, username, firstName);

  if (text === '/start') {
    await tg(chatId, `👋 <b>Welcome to Nexio!</b>\n━━━━━━━━━━━━━━━\nSmart crypto signals 24/7\n\n📢 Free: @NexioSignals\n👑 Premium: Nexio Prime\n\n/subscribe — $${PRICE_USD}/mo\n/status — Server status\n/help — All commands\n🐆 Nexio`);
  }
  else if (text === '/subscribe') {
    await tg(chatId, `💳 <b>Nexio Prime — $${PRICE_USD}/mo</b>\n━━━━━━━━━━━━━━━\nSend <b>$${PRICE_USD} USDT TRC20</b> to:\n<code>${USDT_ADDRESS}</code>\n⚠️ TRC20 ONLY\n\nAfter sending:\n<code>/txid YOUR_TXID_HERE</code>\n✅ Activated within 1 hour 🐆`);
  }
  else if (text.startsWith('/txid')) {
    const txid = text.replace('/txid','').trim();
    if (!txid) { await tg(chatId, '⚠️ Usage: <code>/txid abc123...</code>'); return; }
    await savePayment(chatId, username, txid);
    await tg(chatId, `⏳ Payment submitted!\nTXID: <code>${txid.slice(0,20)}...</code>\n✅ Activation within 1 hour 🐆`);
    await tg(OWNER_CHAT_ID, `💰 <b>NEW SUBSCRIBER!</b>\n👤 @${username||chatId}\n💵 $${PRICE_USD} USDT\n🔗 <code>${txid}</code>\n<a href="https://tronscan.org/#/transaction/${txid}">Verify ↗</a>\n/activate ${chatId}`);
  }
  else if (text === '/status') {
    const all = await getAllUsers(), premium = await getPremiumUsers(), wl = await getWatchlist();
    await tg(chatId, `📊 <b>Nexio Status</b>\n━━━━━━━━━━━━━━━\n🤖 Online ✅\n👥 Users: ${all.length} | 👑 Prime: ${premium.length}\n👁 Watchlist: ${wl.length} | Tracking: ${coinTracker.size}\n🌐 BTC: ${btcGateStatus.pass ? '✅' : '❌'} ${btcGateStatus.reason}\n🕯 Candle wick detector: ✅ Active\n⏰ ${gstNow()} GST`);
  }
  else if (text === '/watchlist') {
    const wl = await getWatchlist();
    if (!wl.length) { await tg(chatId, '👁 Watchlist empty'); return; }
    await tg(chatId, `👁 <b>Watchlist (${wl.length})</b>\n━━━━━━━━━━━━━━━\n${wl.slice(0,20).map((r,i) => `${i+1}. ${r.symbol.replace('USDT','')} ${r.direction||'?'} score:${r.score||'?'}`).join('\n')}`);
  }
  else if (text === '/tracking') {
    const s = [...coinTracker.values()].sort((a,b) => b.score-a.score);
    if (!s.length) { await tg(chatId, '📊 Nothing tracked yet'); return; }
    await tg(chatId, `📊 <b>Tracking (${s.length})</b>\n━━━━━━━━━━━━━━━\n${s.map((c,i) => `${i+1}. ${c.symbol.replace('USDT','')} — ${c.state} ${c.score}/10 (${c.scanCount} scans)`).join('\n')}`);
  }
  else if (text === '/btc') {
    const btc = await checkBTCGate();
    await tg(chatId, `₿ <b>BTC Gate</b>\n${btc.emoji} $${btc.price?.toLocaleString()}\n24h: ${btc.change > 0?'+':''}${btc.change?.toFixed(2)}% | 1H: ${btc.change1H > 0?'+':''}${btc.change1H?.toFixed(2)}%\nFunding: ${btc.funding?.toFixed(3)}%\n🚦 ${btc.pass ? '✅ PASS' : '❌ BLOCKED'} — ${btc.reason}\n⏰ ${gstNow()}`);
  }
  else if (text === '/help') {
    await tg(chatId, `📖 <b>Commands</b>\n/start /subscribe /txid /status /watchlist /tracking /btc /test /help\n🐆 Nexio v2.1`);
  }

  if (text === '/test') {
    const btc = await checkBTCGate();
    await postSignal(`🧪 <b>NEXIO v2.1 — TEST</b>\n━━━━━━━━━━━━━━━\n✅ Bot online\n✅ Both channels connected\n✅ 9-Layer scanner active\n✅ Candle wick detector active\n${btc.emoji} BTC Gate: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n📊 Watchlist: ${(await getWatchlist()).length}\n🔍 Tracking: ${coinTracker.size}\n⏰ ${gstNow()} GST\n🐆 Nexio is watching`);
    await tg(chatId, '✅ Test sent!');
  }

  if (chatId === OWNER_CHAT_ID) {
    if (text === '/fullscan')     { await tg(chatId, '🌍 Running...'); runFullMarketScan(); }
    if (text === '/scan')         { await tg(chatId, '👁 Running...'); runWatchlistScan(); }
    if (text === '/users')        { const a = await getAllUsers(), p = await getPremiumUsers(); await tg(chatId, `👥 ${a.length} | 👑 ${p.length} | 💰 $${(p.length*PRICE_USD).toFixed(0)}/mo`); }
    if (text === '/pending') {
      const pending = await getPendingPayments();
      if (!pending.length) { await tg(chatId, '✅ No pending'); return; }
      let m = `⏳ <b>Pending (${pending.length})</b>\n`;
      for (const p of pending) m += `\n👤 ${p.email||p.user_id}\n<code>${p.txid?.slice(0,20)}...</code>\n<a href="https://tronscan.org/#/transaction/${p.txid}">Verify ↗</a>\n/activate ${p.user_id}\n`;
      await tg(chatId, m);
    }
    if (text.startsWith('/activate')) {
      const id = text.replace('/activate','').trim();
      if (!id) { await tg(chatId, '⚠️ /activate <chatId>'); return; }
      await setPremium(id);
      await addToChannel(parseInt(id), PREMIUM_CHANNEL);
      await tg(id, `👑 <b>Welcome to Nexio Prime!</b>\n✅ Activated! Full signals incoming 🐆`);
      await tg(chatId, `✅ ${id} activated!`);
    }
    if (text.startsWith('/broadcast')) {
      const bMsg = text.replace('/broadcast','').trim();
      if (!bMsg) { await tg(chatId, '⚠️ /broadcast <msg>'); return; }
      const users = await getAllUsers();
      for (const u of users) { await tg(u.chat_id, `📢 <b>Nexio</b>\n\n${bMsg}`); await sleep(100); }
      await tg(chatId, `✅ Sent to ${users.length}`);
    }
    if (text === '/clearwatchlist') {
      const wl = await getWatchlist();
      for (const r of wl) await removeFromWatchlist(r.symbol);
      coinTracker.clear();
      await tg(chatId, `✅ Cleared ${wl.length} coins`);
    }
  }
};

// ── Poll ──────────────────────────────────────────────────────────────────────
const pollUsers = async () => {
  try {
    const data = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&limit=20&timeout=0`);
    if (!data?.ok || !data.result?.length) return;
    for (const u of data.result) { lastUpdateId = u.update_id; if (u.message) await handleCommand(u.message); }
  } catch (err) { log('Poll error:', err.message); }
};

// ── Start ─────────────────────────────────────────────────────────────────────
const start = async () => {
  log('🚀 Nexio v2.1 — 9-Layer Intelligence Scanner + Candle Wick Detector starting...');
  const btc = await checkBTCGate();
  await tg(OWNER_CHAT_ID, `🟢 <b>Nexio v2.1 Started</b>\n━━━━━━━━━━━━━━━\n🧠 9-Layer Scanner active\n📦 Compression + OI detection\n🧱 Resistance pressure tracker\n🔊 Volume buildup detector\n🛡 Trap risk filter\n🕯 Candle wick detector (NEW)\n🚦 BTC momentum gate\n📊 Min score: ${MIN_ALERT_SCORE}/10\n📈 Pump filter: ${PUMP_EXCLUDE_PCT}%\n${btc.emoji} BTC: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n⏰ ${gstNow()} GST\n━━━━━━━━━━━━━━━\n/fullscan /scan /btc /pending /users /activate /broadcast /watchlist /tracking /clearwatchlist /test`);

  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
};

start();
