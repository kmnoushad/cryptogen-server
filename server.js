// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v5.20 — PROFITABILITY EDITION
// Copy this ENTIRE file to your server and run: node nexio_v520.js
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003900595640';
const PREMIUM_CHANNEL = '-1003913881352';
const OWNER_CHAT_ID   = '6896387082';

const PAPER_TEST_USERS = [
  // Add friend chat IDs here
];

const PAPER_MODE = true;
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

const FULL_MARKET_INTERVAL_MS = 300000;
const WATCHLIST_SCAN_INTERVAL = 120000;
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 200000;
const MAX_WATCHLIST           = 50;
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 1.2;
const MIN_ALERT_SCORE         = 6.5;        // For EARLY
const MIN_FIRE_SCORE          = 7.5;        // For FIRE (higher requirement)

// ── PROFITABILITY GUARDS (v5.20) ─────────────────────────────────────────────
const MAX_LOSS_PERCENT_PER_TRADE = 4.0;        // Hard exit if loss hits 4%
const MIN_BTC_MOMENTUM_FOR_LONG = 0.5;         // BTC 1H change >0.5% for LONG FIRE
const MIN_BTC_MOMENTUM_FOR_SHORT = -0.5;       // BTC 1H change <-0.5% for SHORT FIRE
const MAX_PRICE_MOVE_FROM_FIRST_SEEN = 1.5;    // Don't fire if price up >1.5% since detection
const EARLY_SL_ATR = 1.0;                     // Tighter SL for EARLY (was 1.8)
const FIRE_SL_ATR = 1.2;                      // Tighter SL for FIRE (was 1.8)
const MIN_BREAKOUT_MOVE_PERCENT = 0.8;         // Breakout candle must move >=0.8% (was 0.3)
const MIN_BREAKOUT_BODY_PERCENT = 40;          // Breakout body >=40% (was 35)
const MIN_VOL_SPIKE_BREAKOUT = 2.0;            // Volume spike >=2x (was 1.5)
const ENABLE_FIRE_SHORT = false;               // SHORT FIRE disabled (0% win rate)
const DAILY_PNL_KILL = -3.0;                   // Daily loss kill at -3% (was -5%)

const UNIFIED_TP1_ATR = 2.0;
const UNIFIED_TP2_ATR = 3.5;
const UNIFIED_TP3_ATR = 5.0;

// Meme blacklist
const MEME_BLACKLIST = new Set([
  'DOGEUSDT','SHIBUSDT','BABYDOGEUSDT','1MBABYDOGEUSDT','FLOKIUSDT',
  'BONKUSDT','WIFUSDT','1000BONKUSDT','1000FLOKIUSDT','1000SHIBUSDT',
  'NEIROUSDT','NEIROETHUSDT','1000XECUSDT','DOGSUSDT',
  'PEPEUSDT','1000PEPEUSDT','TURBOUSDT','BOMEUSDT','POPCATUSDT',
  'BRETTUSDT','MEWUSDT','PNUTUSDT','CHILLGUYUSDT','MOODENGUSDT',
  'MEMEUSDT','1000RATSUSDT','SLERFUSDT','MYROUSDT','BANANAUSDT',
  'GOATUSDT','ACTUSDT','PEOPLEUSDT','1000SATSUSDT',
  'TRUMPUSDT','MELANIA1USDT','MELANIAUSDT','BIDENUSDT','JELLYJELLYUSDT',
  'WLDUSDT','GMTUSDT','GALAUSDT',
]);

const isMemeCoin = (symbol) => MEME_BLACKLIST.has(symbol.toUpperCase());
const PUMP_EXCLUDE_PCT = 25.0;

const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'HBARUSDT','WBTCUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'ATOMUSDT','NEARUSDT','UNIUSDT','APTUSDT','LDOUSDT',
  'XAUUSDT','XAUTUSDT','PAXGUSDT','XAGUUSDT','CLUSDT',
  'USDCUSDT','USDTUSDT','BUSDUSDT','DAIUSDT','FRAXUSDT',
  'BTCDOMUSDT','DEFIUSDT','ALTUSDT',
  'TSLAUSDT','AAPLUSDT','GOOGLUSDT','AMZNUSDT','MSFTUSDT',
  'NVDAUSDT','METAUSDT','COINUSDT','NFLXUSDT','BABAUSDT',
  'AMDUSDT','BRKBUSDT','BRKAUSDT','INTCUSDT','TSMUSDT',
  'TSMAUSDT','UBERUSDT','ABNBUSDT','SPYUSDT','QQQUSDT',
]);

const EXCLUDE_REGEX = /^(TSLA|AAPL|GOOGL|AMZN|MSFT|NVDA|META|NFLX|AMD|COIN|BABA|BRKB|BRKA|INTC|UBER|SPY|QQQ|ABNB|TSM|PLTR|SHOP|PYPL|SNAP|LYFT|XAU|XAG|PAX|CL1|MSTR|RKLB|IONQ|HOOD|GME|AMC|NIO|BIDU|JD|PDD|ARKK|IWM|DIA|GLD|SLV|USO|UNG|DXY|VIX|SPX|NDX|DJI|RUT|FTSE|DAX|NIKKEI|SP500|NSDQ|DOW|CRUDE|BRENT|WTI|GAS|COPPER|PLATINUM|PALLADIUM|WHEAT|CORN|SOYBEAN|COTTON|COFFEE|SUGAR|COCOA|CATTLE|HOGS|LUMBER|ORANGE|RUBBER|OILF|PYT|MSTR|EGLD\d|USTC|CFX|LUNC|UST|XEC|BTT|ELON|BITCOIN|ETHEREUM|XPTUSD|PALA|FOREX|EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD|NZDUSD|USDCAD)/;

const STOCK_SUFFIX_REGEX = /(STOCK|SHARE|SHARES|EQUITY|ETF|COMMODITY)USDT$/;

const isLikelyStock = (symbol) => {
  const base = symbol.replace('USDT', '');
  if (/^[A-Z]{2,10}$/.test(base)) return false;
  if (/\d/.test(base) && base.length <= 5) return true;
  return false;
};

const MID_CAP = new Set([
  'LINKUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','NEARUSDT',
  'INJUSDT','LDOUSDT','APTUSDT','AAVEUSDT','MKRUSDT',
  'ARBUSDT','OPUSDT','STXUSDT','GMXUSDT','SNXUSDT',
  'COMPUSDT','CRVUSDT','UNIUSDT','ENJUSDT','CHZUSDT',
  'SANDUSDT','MANAUSDT','GALAUSDT','APEUSDT','IMXUSDT',
]);

// Global state
const alertHistory  = new Map();
const coinTracker   = new Map();
const signalPrices  = new Map();
const resistanceMap = new Map();
let lastUpdateId  = 0;
let fullScanCount      = 0;
let watchlistScanCount = 0;
let btcGateStatus      = { pass: true, reason: 'Starting up', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };
let btcRegime = { regime: 'UNKNOWN', confidence: 0, reason: 'init', changedAt: 0, lastNotified: 'UNKNOWN' };
let btcCyclePosition = { stage: 'UNKNOWN', risk: 'unknown', reason: '', updated: 0 };
let btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
let weeklyDrawdown = 0;
let weeklyDrawdownCheckedAt = 0;
const WEEKLY_DD_KILL = -15.0;
const WEEKLY_DD_CACHE_MS = 600000;

// Loss tracking
const lossTracker   = new Map();
const pumpTracker   = new Map();
const PUMP_COOLDOWN_MIN = 30;
const LOSS_COOLDOWN = 90;
const DAILY_KILL    = 3;
const HARD_KILL_24H = 5;

let dailyLosses   = { count: 0, date: '', totalPnlPct: 0, dailyProfitPct: 0, dailyTrades: 0 };
let recoveryState = { consecutiveLosses: 0, lastTradeWin: null };

const blockReasons = {
  btcDrag: 0, pumped: 0, pumpCooldown: 0, dumpTrap: 0, newsEvent: 0,
  climax: 0, lowLiq: 0, correlation: 0, atrFlat: 0, weakCandle: 0,
  notExtended: 0, scoreLow: 0, htfMisaligned: 0, momentumAgainst: 0
};

const incBlock = (reason) => { if (blockReasons[reason] !== undefined) blockReasons[reason]++; };

// Helper functions
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getSession = () => {
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 0 && utcHour < 7)   return 'ASIA';
  if (utcHour >= 7 && utcHour < 12)  return 'LONDON';
  if (utcHour >= 12 && utcHour < 20) return 'NY';
  return 'OFF';
};
const gstNow = () => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log = (...a) => console.log(`[${gstNow()}]`, ...a);

const isLowLiquiditySession = () => {
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  return hour >= 1 && hour < 5;
};
const canAlert = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > ALERT_COOLDOWN_MS;
const markAlert = k => alertHistory.set(k, Date.now());

const fmtP = p => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

const confBar = score => {
  const n = Math.min(Math.round(score), 10);
  let b = '';
  for (let i = 0; i < n; i++) b += i < 3 ? '🟥' : i < 5 ? '🟧' : i < 7 ? '🟨' : '🟩';
  return b + '⬛'.repeat(10 - n);
};

// ATR Calculator
const calculateATR = (klines, period = 14) => {
  if (klines.length < period + 1) return 0;
  let trSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = i > 0 ? parseFloat(klines[i-1][4]) : high;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
};

const calculateEMA = (klines, period = 50) => {
  if (klines.length < period) return null;
  const closes = klines.map(k => parseFloat(k[4]));
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

const calcEMAFromCloses = (closes, period) => {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

// ── NEW SL/TP helpers with hard loss cap (v5.20) ────────────────────────
const getEarlySL = (price, atr, direction) => {
  const slPrice = direction === 'LONG' ? price - atr * EARLY_SL_ATR : price + atr * EARLY_SL_ATR;
  const maxLossPrice = direction === 'LONG' ? price * (1 - MAX_LOSS_PERCENT_PER_TRADE/100) : price * (1 + MAX_LOSS_PERCENT_PER_TRADE/100);
  return direction === 'LONG' ? Math.max(slPrice, maxLossPrice) : Math.min(slPrice, maxLossPrice);
};

const getFireSL = (price, atr, direction) => {
  const slPrice = direction === 'LONG' ? price - atr * FIRE_SL_ATR : price + atr * FIRE_SL_ATR;
  const maxLossPrice = direction === 'LONG' ? price * (1 - MAX_LOSS_PERCENT_PER_TRADE/100) : price * (1 + MAX_LOSS_PERCENT_PER_TRADE/100);
  return direction === 'LONG' ? Math.max(slPrice, maxLossPrice) : Math.min(slPrice, maxLossPrice);
};

const getPositionSizeHint = (atrPct = null, isEarly = false) => {
  let basePct = 100;
  if (isEarly) basePct = 67;
  if (recoveryState.consecutiveLosses >= 2) basePct = 50;
  if (atrPct && atrPct > 3.5) basePct = Math.floor(basePct * 0.5);
  else if (atrPct && atrPct > 2.5) basePct = Math.floor(basePct * 0.7);
  return { pct: basePct, label: `${basePct}% size` };
};

// Fetch JSON with timeout
const fetchJSON = async (url, timeout = 8000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
};

// Supabase functions
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

const getWatchlist         = async () => (await sb('watchlist?select=symbol,score,direction,updated_at,added_by')) || [];
const addToWatchlist       = async (symbol, score, direction) => sb('watchlist', { method: 'POST', body: JSON.stringify({ symbol, score, direction, added_by: 'server', updated_at: new Date().toISOString() }) });
const removeFromWatchlist  = async symbol => sb(`watchlist?symbol=eq.${symbol}`, { method: 'DELETE' });
const updateWatchlistScore = async (symbol, score, direction) => sb(`watchlist?symbol=eq.${symbol}`, { method: 'PATCH', body: JSON.stringify({ score, direction, updated_at: new Date().toISOString() }) });
const getUser         = async chatId => (await sb(`bot_users?chat_id=eq.${chatId}`))?.[0];
const saveUser        = async (chatId, username, firstName) => sb('bot_users', { method: 'POST', body: JSON.stringify({ chat_id: String(chatId), username: username||'', first_name: firstName||'', is_active: true }) });
const setPremium      = async chatId => sb(`bot_users?chat_id=eq.${chatId}`, { method: 'PATCH', body: JSON.stringify({ is_premium: true, premium_since: new Date().toISOString() }) });
const getAllUsers     = async () => (await sb('bot_users?is_active=eq.true&select=chat_id')) || [];
const getPremiumUsers = async () => (await sb('bot_users?is_premium=eq.true&is_active=eq.true&select=chat_id')) || [];
const savePayment     = async (chatId, username, txid) => sb('subscriptions', { method: 'POST', body: JSON.stringify({ user_id: chatId, email: username, txid, plan: 'premium', status: 'pending', amount_paid: PRICE_USD, currency: 'USDT', created_at: new Date().toISOString() }) });
const getPendingPayments = async () => (await sb('subscriptions?status=eq.pending&select=*')) || [];

// Telegram send
const tg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { }
};

const postSignal = async text => {
  const targets = PAPER_MODE ? [OWNER_CHAT_ID, ...PAPER_TEST_USERS] : [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID];
  for (const chatId of targets) {
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

// getOpenDirectionCount
const getOpenDirectionCount = (direction) => {
  let count = 0;
  const cutoffMs = Date.now() - 4 * 3600 * 1000;
  for (const [, sig] of signalPrices.entries()) {
    if (sig.direction === direction && sig.firedAt > cutoffMs) count++;
  }
  return count;
};
const MAX_SAME_DIRECTION = 3;

// Record win/loss
const recordLoss = (symbol) => {
  const today = new Date().toDateString();
  if (dailyLosses.date !== today) { dailyLosses.count = 0; dailyLosses.totalPnlPct = 0; dailyLosses.dailyProfitPct = 0; dailyLosses.dailyTrades = 0; dailyLosses.date = today; }
  dailyLosses.count++;
  dailyLosses.totalPnlPct -= 1.8;
  recoveryState.consecutiveLosses++;
  recoveryState.lastTradeWin = false;
  lossTracker.set(symbol, { lossTime: Date.now() });
  log(`❌ Loss: ${symbol} | Daily: ${dailyLosses.count}/${DAILY_KILL} | Est PnL: ${dailyLosses.totalPnlPct.toFixed(1)}% | Consecutive: ${recoveryState.consecutiveLosses}`);
};

const recordWin = (symbol, pnlPct) => {
  recoveryState.consecutiveLosses = 0;
  recoveryState.lastTradeWin = true;
  log(`✅ Win: ${symbol} | +${pnlPct.toFixed(2)}% | Consecutive losses reset`);
};

// Weekly drawdown
const checkWeeklyDrawdown = async () => {
  const now = Date.now();
  if (now - weeklyDrawdownCheckedAt < WEEKLY_DD_CACHE_MS) return weeklyDrawdown;
  try {
    const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const trades = await sb(`paper_trades?outcome=eq.LOSS&created_at=gte.${since}&select=id`) || [];
    weeklyDrawdown = trades.length * -1.8;
    weeklyDrawdownCheckedAt = now;
    if (weeklyDrawdown <= WEEKLY_DD_KILL) log(`🛑 WEEKLY DRAWDOWN: ${weeklyDrawdown.toFixed(1)}% — all trading blocked`);
    return weeklyDrawdown;
  } catch { return weeklyDrawdown; }
};

const isBlocked = (symbol) => {
  if (weeklyDrawdown <= WEEKLY_DD_KILL) return { blocked: true, reason: `Weekly drawdown ${weeklyDrawdown.toFixed(1)}% — trading halted` };
  if (dailyLosses.totalPnlPct <= DAILY_PNL_KILL) return { blocked: true, reason: `Daily PnL kill (${dailyLosses.totalPnlPct.toFixed(1)}%)` };
  if (dailyLosses.count >= DAILY_KILL) return { blocked: true, reason: `Daily kill switch (${dailyLosses.count} losses)` };
  const cutoff24h = Date.now() - 24 * 3600 * 1000;
  let losses24h = 0;
  for (const [, v] of lossTracker.entries()) if (v.lossTime > cutoff24h) losses24h++;
  if (losses24h >= HARD_KILL_24H) return { blocked: true, reason: `24h hard kill (${losses24h} losses)` };
  const rec = lossTracker.get(symbol);
  if (rec) {
    const minsAgo = (Date.now() - rec.lossTime) / 60000;
    if (minsAgo < LOSS_COOLDOWN) return { blocked: true, reason: `Loss cooldown ${Math.ceil(LOSS_COOLDOWN - minsAgo)}min` };
  }
  return { blocked: false, reason: '' };
};

// HTF trend
const checkHTFTrend = async (symbol) => {
  try {
    const klines1h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=210`);
    if (klines1h.length < 200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'insufficient data' };
    const closes = klines1h.map(k => parseFloat(k[4]));
    const price  = closes[closes.length - 1];
    const ema50  = calcEMAFromCloses(closes, 50);
    const ema200 = calcEMAFromCloses(closes, 200);
    if (!ema50 || !ema200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'calc error' };
    const pctAbove = ((price - ema50) / ema50) * 100;
    const bullish = pctAbove > 0.5;
    const bearish = pctAbove < -0.5;
    const ema200ok = ema200 ? (bullish ? ema50 > ema200 : ema50 < ema200) : true;
    return { bullish, bearish, ema50, ema200, ema200ok, pctAbove: parseFloat(pctAbove.toFixed(2)), reason: '' };
  } catch { return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'data error' }; }
};

// BTC Gate
const checkBTCGate = async () => {
  try {
    const [klines, ticker, funding] = await Promise.all([
      fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=8'),
      fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
      fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    ]);
    const price = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const fundRate = parseFloat(funding.lastFundingRate) * 100;
    const open1H = parseFloat(klines[klines.length - 4][1]);
    const close1H = parseFloat(klines[klines.length - 1][4]);
    const change1H = ((close1H - open1H) / open1H) * 100;
    let pass = true, reason = '';
    if (Math.abs(change1H) > 2.5 || Math.abs(change24h) > 7) { pass = false; reason = `⚡ BTC extreme move (1H ${change1H.toFixed(2)}%)`; }
    else if (fundRate > 0.04) { pass = false; reason = `⚠️ BTC funding extreme ${fundRate.toFixed(3)}%`; }
    else reason = `BTC 1H ${change1H.toFixed(2)}%`;
    const bullishOk = change1H > -1.2 && change24h > -4;
    const bearishOk = change1H < 1.2 && change24h < 4;
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji, bullishOk, bearishOk };
    return btcGateStatus;
  } catch (err) {
    log(`⚠️ BTC gate fetch failed: ${err.message}`);
    if (btcGateStatus.price > 0) return btcGateStatus;
    btcGateStatus = { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };
    return btcGateStatus;
  }
};

// BTC Regime
const checkBTCRegime = async () => {
  try {
    const klines1H = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100');
    const klines4H = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=100');
    if (!klines1H || !klines4H) return btcRegime;
    const closes1H = klines1H.map(k => parseFloat(k[4]));
    const closes4H = klines4H.map(k => parseFloat(k[4]));
    const price = closes1H[closes1H.length - 1];
    const ema50_1h = calcEMAFromCloses(closes1H, 50);
    const ema50_4h = calcEMAFromCloses(closes4H, 50);
    const ema200_4h = calcEMAFromCloses(closes4H, 200);
    const momentum1H = ((price - closes1H[closes1H.length - 5]) / closes1H[closes1H.length - 5]) * 100;
    const momentum4H = ((price - closes4H[closes4H.length - 4]) / closes4H[closes4H.length - 4]) * 100;
    const recent24h = closes1H.slice(-24);
    const rangePct = ((Math.max(...recent24h) - Math.min(...recent24h)) / price) * 100;
    let regime = 'CHOPPY', confidence = 0, reasons = [];
    const above1H = price > ema50_1h;
    const above4H = price > ema50_4h;
    const trendUp = ema50_4h > ema200_4h;
    if (above1H && (above4H || momentum1H > 0.2)) { regime = 'BULLISH'; confidence = (above1H && above4H && trendUp) ? 80 : 60; reasons.push('above EMA50'); }
    else if (!above1H && (!above4H || momentum1H < -0.2)) { regime = 'BEARISH'; confidence = (!above1H && !above4H && !trendUp) ? 80 : 60; reasons.push('below EMA50'); }
    else { regime = 'CHOPPY'; confidence = 70; reasons.push(`range ${rangePct.toFixed(1)}%`); }
    const changed = regime !== btcRegime.regime;
    btcRegime = { regime, confidence, reason: reasons.join(' · '), changedAt: changed ? Date.now() : btcRegime.changedAt, lastNotified: btcRegime.lastNotified, momentum1H, momentum4H, rangePct };
    if (changed) {
      const emoji = regime === 'BULLISH' ? '🟢' : regime === 'BEARISH' ? '🔴' : '🟡';
      const msg = regime === 'BULLISH' ? 'LONG signals enabled' : regime === 'BEARISH' ? 'SHORT signals enabled' : '⚠️ ALL signals blocked';
      const recipients = [OWNER_CHAT_ID, ...PAPER_TEST_USERS];
      for (const r of recipients) await tg(r, `${emoji} <b>BTC REGIME CHANGE: ${regime}</b>\n━━━━━━━━━━━━━━━\n${reasons.join('\n')}\n\nConfidence: ${confidence}%\n${msg}\n⏰ ${gstNow()} GST`);
      btcRegime.lastNotified = regime;
    }
    return btcRegime;
  } catch { return btcRegime; }
};

// BTC Early Warning
const checkBTCEarlyWarning = async () => {
  try {
    const klines15m = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=30');
    if (!klines15m || klines15m.length < 25) return;
    const closes = klines15m.map(k => parseFloat(k[4]));
    const opens = klines15m.map(k => parseFloat(k[1]));
    const price = closes[closes.length - 1];
    const ema20_15m = calcEMAFromCloses(closes, 20);
    const lastHour = ((price - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
    const prevHour = ((closes[closes.length - 5] - closes[closes.length - 9]) / closes[closes.length - 9]) * 100;
    const momentumSlope = lastHour - prevHour;
    let redStreak = 0, greenStreak = 0;
    for (let i = closes.length - 1; i >= closes.length - 8; i--) { if (closes[i] < opens[i]) redStreak++; else break; }
    for (let i = closes.length - 1; i >= closes.length - 8; i--) { if (closes[i] > opens[i]) greenStreak++; else break; }
    let warningType = null, direction = null;
    if (price < ema20_15m && lastHour < -0.3 && momentumSlope < -0.1 && redStreak >= 3) { warningType = 'BEARISH_EARLY'; direction = 'down'; }
    else if (price > ema20_15m && lastHour > 0.3 && momentumSlope > 0.1 && greenStreak >= 3) { warningType = 'BULLISH_EARLY'; direction = 'up'; }
    if (warningType && direction !== btcEarlyWarning.lastDirection && (Date.now() - btcEarlyWarning.notifiedAt) > 30 * 60 * 1000) {
      const warningMsg = warningType === 'BEARISH_EARLY' 
        ? `📉 <b>BTC EARLY WARNING — Bearish momentum building</b>\nPrice below 15m EMA20 · ${lastHour.toFixed(2)}% in 1h\nAction: Tighten stops, avoid new LONG`
        : `📈 <b>BTC EARLY WARNING — Bullish momentum building</b>\nPrice above 15m EMA20 · +${lastHour.toFixed(2
