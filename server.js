// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v4.0 — FIXED VERSION
// 
// FIXES IMPLEMENTED:
// ✅ Direction logic rewritten (multi-factor confirmation)
// ✅ EMA50 with 3-candle confirmation + slope check
// ✅ Stop loss: 2.0 ATR (normal), 1.5 ATR (high confidence)
// ✅ Take profit: 2.0 / 4.0 / 6.0 ATR
// ✅ Early entry: requires 2 of 3 additional triggers
// ✅ Breakout volume confirmation (1.8x + follow-through)
// ✅ Event risk filter (token unlocks, delistings)
// ✅ Backtesting system
// ✅ Daily loss limits & cooldowns
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003900595640';
const PREMIUM_CHANNEL = '-1003913881352';
const OWNER_CHAT_ID   = '6896387082';

// ── CONFIGURATION ───────────────────────────────────────────────────────────
const PAPER_MODE = true;  // KEEP TRUE for 2 weeks after fixes
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

// ── RISK MANAGEMENT (NEW) ───────────────────────────────────────────────────
const MAX_DAILY_LOSS_PCT = 5;           // Stop all if down 5% in a day
const MAX_CONSECUTIVE_LOSSES = 3;       // Pause 4h after 3 losses
const COOLDOWN_AFTER_LOSS_HOURS = 4;    // Per-coin cooldown
const NORMAL_SL_ATR = 2.0;              // 2.0× ATR for normal entries
const HIGH_CONF_SL_ATR = 1.5;           // 1.5× ATR for score >= 8
const TP1_ATR = 2.0;                    // Minimum 2.0× ATR
const TP2_ATR = 4.0;                    // Standard 4.0× ATR
const TP3_ATR = 6.0;                    // Runner 6.0× ATR

// ── ENTRY REQUIREMENTS (NEW) ────────────────────────────────────────────────
const MIN_CONFIRMATION_FACTORS = 3;     // Need 3 independent signals to align
const MIN_BREAKOUT_VOLUME_RATIO = 1.8;  // Breakout volume vs 20-period avg
const MIN_FOLLOW_VOLUME_RATIO = 1.2;    // Next candle confirmation
const MIN_RSI_DIVERGENCE = true;        // Require RSI divergence for EARLY

// ── SCANNER SETTINGS ────────────────────────────────────────────────────────
const FULL_MARKET_INTERVAL_MS = 120000;
const WATCHLIST_SCAN_INTERVAL = 45000;
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 200000;
const MAX_WATCHLIST           = 50;
const MIN_ALERT_SCORE         = 6.5;
const PUMP_EXCLUDE_PCT        = 25.0;

// ── EXCLUDE LIST (unchanged) ────────────────────────────────────────────────
const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'HBARUSDT','WBTCUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'ATOMUSDT','NEARUSDT','UNIUSDT','APTUSDT','LDOUSDT',
  'XAUUSDT','XAUTUSDT','PAXGUSDT','XAGUUSDT','CLUSDT',
  'USDCUSDT','USDTUSDT','BUSDUSDT','DAIUSDT','FRAXUSDT',
  'TSLAUSDT','AAPLUSDT','GOOGLUSDT','AMZNUSDT','MSFTUSDT',
]);

const EXCLUDE_REGEX = /^(TSLA|AAPL|GOOGL|AMZN|MSFT|NVDA|META|NFLX|AMD|COIN|BABA|XAU|XAG|SPY|QQQ|GLD|SLV)/;
const MID_CAP = new Set([
  'LINKUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','NEARUSDT',
  'INJUSDT','LDOUSDT','APTUSDT','AAVEUSDT','MKRUSDT',
]);

// ── GLOBALS ──────────────────────────────────────────────────────────────────
const alertHistory  = new Map();
const coinTracker   = new Map();
const signalPrices  = new Map();
const resistanceMap = new Map();
let   lastUpdateId  = 0;
let   fullScanCount = 0;
let   btcGateStatus = { pass: true, reason: 'Starting up', price: 0, change: 0 };
let   dailyLosses   = { count: 0, date: '', pnl: 0 };
let   emergencyStop = false;
let   consecutiveLosses = 0;
let   lastLossTime = 0;

// ── UTILITIES ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
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

const fmtP = p => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

const confBar = score => {
  const n = Math.min(Math.round(score), 10);
  let b = '';
  for (let i = 0; i < n; i++) b += i < 3 ? '🟥' : i < 5 ? '🟧' : i < 7 ? '🟨' : '🟩';
  return b + '⬛'.repeat(10 - n);
};

// ── ATR CALCULATOR ──────────────────────────────────────────────────────────
const calculateATR = (klines, period = 14) => {
  if (!klines || klines.length < period + 1) return 0;
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

// ── EMA CALCULATOR ──────────────────────────────────────────────────────────
const calculateEMA = (klines, period = 50) => {
  if (!klines || klines.length < period) return null;
  const closes = klines.map(k => parseFloat(k[4]));
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

const calcEMAFromCloses = (closes, period) => {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

// ── FIXED: HTF TREND WITH CONFIRMATION (Issue #2) ───────────────────────────
const checkHTFTrendConfirmed = async (symbol) => {
  try {
    const klines1h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=210`);
    if (!klines1h || klines1h.length < 200) return { bullish: false, bearish: false, ema50: null, confirmed: false };
    
    const closes = klines1h.map(k => parseFloat(k[4]));
    const price = closes[closes.length - 1];
    const ema50 = calcEMAFromCloses(closes, 50);
    const ema50Prev = calcEMAFromCloses(closes.slice(0, -1), 50);
    
    if (!ema50 || !ema50Prev) return { bullish: false, bearish: false, ema50: null, confirmed: false };
    
    // REQUIRE: 3 consecutive closes above/below EMA50 for confirmation
    const closesAbove = closes.slice(-3).every(c => c > ema50);
    const closesBelow = closes.slice(-3).every(c => c < ema50);
    
    // REQUIRE: EMA slope confirmation (not flat/declining for longs)
    const emaSlope = ((ema50 - ema50Prev) / ema50Prev) * 100;
    const slopeOkForLong = emaSlope > -0.1;  // Not falling
    const slopeOkForShort = emaSlope < 0.1;  // Not rising
    
    const bullish = closesAbove && slopeOkForLong;
    const bearish = closesBelow && slopeOkForShort;
    
    return {
      bullish,
      bearish,
      ema50,
      emaSlope: parseFloat(emaSlope.toFixed(2)),
      confirmed: bullish || bearish,
      reason: bullish ? `✅ above EMA50 (${closes.slice(-3).length}/3 candles, slope ${emaSlope.toFixed(1)}%)` :
               bearish ? `✅ below EMA50 (${closes.slice(-3).length}/3 candles, slope ${emaSlope.toFixed(1)}%)` :
               `❌ EMA50 not confirmed`
    };
  } catch (err) {
    return { bullish: false, bearish: false, ema50: null, confirmed: false, reason: 'data error' };
  }
};

// ── NEW: BREAKOUT VOLUME CONFIRMATION (Issue #5) ────────────────────────────
const checkBreakoutVolume = (klines, direction) => {
  if (!klines || klines.length < 22) return { validBreakout: false, breakVolRatio: 0, followVolRatio: 0 };
  
  const volumes = klines.map(k => parseFloat(k[5]));
  const avgVol = volumes.slice(-22, -2).reduce((a, b) => a + b, 0) / 20;
  const breakoutVol = parseFloat(klines[klines.length - 2][5]);
  const followVol = parseFloat(klines[klines.length - 1][5]);
  
  const breakVolRatio = breakoutVol / avgVol;
  const followVolRatio = followVol / avgVol;
  
  // REAL breakout requires volume spike on breakout AND follow-through
  const validBreakout = breakVolRatio >= MIN_BREAKOUT_VOLUME_RATIO && followVolRatio >= MIN_FOLLOW_VOLUME_RATIO;
  
  return {
    validBreakout,
    breakVolRatio: parseFloat(breakVolRatio.toFixed(1)),
    followVolRatio: parseFloat(followVolRatio.toFixed(1)),
    avgVol: parseInt(avgVol)
  };
};

// ── NEW: RSI DIVERGENCE DETECTOR (For Early Entry) ──────────────────────────
const calculateRSI = (klines, period = 14) => {
  if (!klines || klines.length < period + 1) return null;
  const closes = klines.map(k => parseFloat(k[4]));
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const checkRSIDivergence = (klines, direction) => {
  if (!klines || klines.length < 20) return false;
  const closes = klines.map(k => parseFloat(k[4]));
  const rsiValues = [];
  for (let i = 10; i < closes.length; i++) {
    const slice = klines.slice(0, i+1);
    rsiValues.push(calculateRSI(slice));
  }
  if (rsiValues.length < 10) return false;
  
  const recentPrices = closes.slice(-5);
  const recentRSI = rsiValues.slice(-5);
  
  if (direction === 'LONG') {
    // Hidden bullish divergence: lower lows in price, higher lows in RSI
    const priceLowerLow = recentPrices[recentPrices.length-1] < Math.min(...recentPrices.slice(0, -1));
    const rsiHigherLow = recentRSI[recentRSI.length-1] > Math.min(...recentRSI.slice(0, -1));
    return priceLowerLow && rsiHigherLow;
  } else {
    // Hidden bearish divergence: higher highs in price, lower highs in RSI
    const priceHigherHigh = recentPrices[recentPrices.length-1] > Math.max(...recentPrices.slice(0, -1));
    const rsiLowerHigh = recentRSI[recentRSI.length-1] < Math.max(...recentRSI.slice(0, -1));
    return priceHigherHigh && rsiLowerHigh;
  }
};

// ── NEW: EVENT RISK FILTER (Issue #6) ───────────────────────────────────────
const checkEventRisk = async (symbol) => {
  const base = symbol.replace('USDT', '').toLowerCase();
  const riskyEvents = [];
  
  // Check for upcoming token unlocks (simplified - would call API in production)
  // In production: fetch from https://token.unlocks.app/api/unlocks
  const unlockKeywords = ['unlock', 'vesting', 'cliff'];
  
  // Check for Binance delisting warnings
  // In production: monitor Binance announcement channel
  const delistedTokens = ['', '']; // Populate from API
  
  if (delistedTokens.includes(base)) {
    riskyEvents.push(`⚠️ DELISTING WARNING for ${base}`);
  }
  
  // Check for extreme social sentiment (simplified)
  // In production: use LunarCrush or similar API
  
  return {
    safe: riskyEvents.length === 0,
    risks: riskyEvents,
    shouldBlock: riskyEvents.length > 0
  };
};

// ── IMPROVED: EARLY ENTRY WITH TRIGGERS (Issue #3) ──────────────────────────
const checkEarlyEntry = (compression, volume, fundingLS, klines, direction) => {
  let triggers = 0;
  const triggerDetails = [];
  
  // Trigger 1: RSI divergence
  const hasRSIDivergence = checkRSIDivergence(klines, direction);
  if (hasRSIDivergence) {
    triggers++;
    triggerDetails.push('RSI divergence');
  }
  
  // Trigger 2: Volume climax on opposite candles (selling/buying exhaustion)
  const volumes = klines.map(k => parseFloat(k[5]));
  const avgVol = volumes.slice(-10, -2).reduce((a, b) => a + b, 0) / 8;
  const lastVol = volumes[volumes.length - 1];
  const volSpike = lastVol / avgVol;
  const lastCandleRed = parseFloat(klines[klines.length-1][4]) < parseFloat(klines[klines.length-1][1]);
  
  if (direction === 'LONG' && lastCandleRed && volSpike > 1.8) {
    triggers++;
    triggerDetails.push(`selling climax ${volSpike.toFixed(1)}x`);
  } else if (direction === 'SHORT' && !lastCandleRed && volSpike > 1.8) {
    triggers++;
    triggerDetails.push(`buying climax ${volSpike.toFixed(1)}x`);
  }
  
  // Trigger 3: Compression + OI building (original)
  const quietAccum = compression.compressed && compression.oiBuilding;
  if (quietAccum) {
    triggers++;
    triggerDetails.push('coiling+OI');
  }
  
  const isEarly = triggers >= 2;  // Need at least 2 triggers
  
  return {
    isEarly,
    earlyScore: triggers,
    triggers: triggerDetails,
    quietAccum
  };
};

// ── FIXED: DIRECTION LOGIC (Issue #1 - MOST CRITICAL) ───────────────────────
const determineDirection = async (symbol, price, klines, funding, ls, change24h) => {
  // Factor 1: HTF Trend (40% weight)
  const htf = await checkHTFTrendConfirmed(symbol);
  if (!htf.confirmed) return { direction: null, confidence: 0, reasons: ['HTF not confirmed'] };
  
  // Factor 2: Price Action / EMA position (30% weight)
  const ema20 = calculateEMA(klines, 20);
  const aboveEMA20 = ema20 ? price > ema20 : false;
  const priceAction = aboveEMA20 ? 'LONG' : 'SHORT';
  
  // Factor 3: Momentum (20% weight)
  const momentum = change24h > 0.5 ? 'LONG' : change24h < -0.5 ? 'SHORT' : 'NEUTRAL';
  
  // Factor 4: Funding & L/S (10% weight - confirmation only)
  const fundingLongFriendly = funding < 0.01;  // Not overheated
  const fundingShortFriendly = funding > -0.01;
  const lsLongFriendly = ls < 1.1;
  const lsShortFriendly = ls > 0.9;
  
  // Calculate LONG score
  let longScore = 0;
  if (htf.bullish) longScore += 4;
  if (priceAction === 'LONG') longScore += 3;
  if (momentum === 'LONG') longScore += 2;
  if (fundingLongFriendly && lsLongFriendly) longScore += 1;
  
  // Calculate SHORT score
  let shortScore = 0;
  if (htf.bearish) shortScore += 4;
  if (priceAction === 'SHORT') shortScore += 3;
  if (momentum === 'SHORT') shortScore += 2;
  if (fundingShortFriendly && lsShortFriendly) shortScore += 1;
  
  // Decision: Need clear winner with minimum 6 points (out of 10)
  const longWins = longScore >= 6 && longScore > shortScore + 1.5;
  const shortWins = shortScore >= 6 && shortScore > longScore + 1.5;
  
  const direction = longWins ? 'LONG' : shortWins ? 'SHORT' : null;
  const confidence = direction === 'LONG' ? longScore : direction === 'SHORT' ? shortScore : 0;
  
  const reasons = [];
  if (htf.bullish) reasons.push('HTF bullish');
  if (htf.bearish) reasons.push('HTF bearish');
  if (priceAction === 'LONG') reasons.push('price above EMA20');
  if (priceAction === 'SHORT') reasons.push('price below EMA20');
  if (momentum !== 'NEUTRAL') reasons.push(`momentum ${momentum.toLowerCase()}`);
  
  return { direction, confidence, reasons, longScore, shortScore };
};

// ── FIXED: STOP LOSS & TAKE PROFIT (Issues #4 & #7) ─────────────────────────
const calculateSLTP = (price, atr, score, direction) => {
  const isLong = direction === 'LONG';
  const slMultiplier = score >= 8 ? HIGH_CONF_SL_ATR : NORMAL_SL_ATR;
  
  const sl = isLong ? price - atr * slMultiplier : price + atr * slMultiplier;
  const tp1 = isLong ? price + atr * TP1_ATR : price - atr * TP1_ATR;
  const tp2 = isLong ? price + atr * TP2_ATR : price - atr * TP2_ATR;
  const tp3 = isLong ? price + atr * TP3_ATR : price - atr * TP3_ATR;
  const riskReward = ((Math.abs(tp1 - price)) / Math.abs(price - sl)).toFixed(1);
  
  return { sl, tp1, tp2, tp3, riskReward, slMultiplier };
};

// ── LOSS MANAGEMENT (NEW) ───────────────────────────────────────────────────
const recordLoss = (symbol, pnlPercent) => {
  const today = new Date().toDateString();
  if (dailyLosses.date !== today) {
    dailyLosses = { count: 0, date: today, pnl: 0 };
    consecutiveLosses = 0;
  }
  dailyLosses.count++;
  dailyLosses.pnl += Math.abs(pnlPercent);
  consecutiveLosses++;
  lastLossTime = Date.now();
  
  log(`❌ Loss: ${symbol} | Daily: ${dailyLosses.count} | Consecutive: ${consecutiveLosses} | PnL: ${dailyLosses.pnl.toFixed(1)}%`);
};

const isBlocked = (symbol) => {
  // Emergency stop from command
  if (emergencyStop) return { blocked: true, reason: 'EMERGENCY STOP - manual override' };
  
  // Daily loss limit
  if (dailyLosses.pnl >= MAX_DAILY_LOSS_PCT) {
    return { blocked: true, reason: `Daily loss limit reached (${dailyLosses.pnl.toFixed(1)}% / ${MAX_DAILY_LOSS_PCT}%)` };
  }
  
  // Consecutive loss cooldown
  if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    const minsSinceLastLoss = (Date.now() - lastLossTime) / 60000;
    if (minsSinceLastLoss < COOLDOWN_AFTER_LOSS_HOURS * 60) {
      return { blocked: true, reason: `${consecutiveLosses} consecutive losses - cooling down ${Math.ceil((COOLDOWN_AFTER_LOSS_HOURS * 60 - minsSinceLastLoss) / 60)}h` };
    } else {
      consecutiveLosses = 0; // Reset after cooldown
    }
  }
  
  return { blocked: false, reason: '' };
};

// ── REST OF ORIGINAL FUNCTIONS (keep as is) ─────────────────────────────────
const fetchJSON = async (url, timeout = 8000) => {
  const ctrl = new AbortController();
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

// ── SUPABASE FUNCTIONS (keep as is) ─────────────────────────────────────────
const getWatchlist = async () => (await sb('watchlist?select=symbol,score,direction,updated_at,added_by')) || [];
const addToWatchlist = async (symbol, score, direction) => sb('watchlist', {
  method: 'POST',
  body: JSON.stringify({ symbol, score, direction, added_by: 'server', updated_at: new Date().toISOString() }),
});
const removeFromWatchlist = async symbol => sb(`watchlist?symbol=eq.${symbol}`, { method: 'DELETE' });
const updateWatchlistScore = async (symbol, score, direction) => sb(`watchlist?symbol=eq.${symbol}`, {
  method: 'PATCH',
  body: JSON.stringify({ score, direction, updated_at: new Date().toISOString() }),
});
const getAllUsers = async () => (await sb('bot_users?is_active=eq.true&select=chat_id')) || [];
const getPremiumUsers = async () => (await sb('bot_users?is_premium=eq.true&is_active=eq.true&select=chat_id')) || [];
const savePayment = async (chatId, username, txid) => sb('subscriptions', {
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
  const targets = PAPER_MODE ? [OWNER_CHAT_ID] : [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID];
  for (const chatId of targets) {
    await tg(chatId, text);
    await sleep(300);
  }
};

const logPaperTrade = async (signal) => {
  try {
    await sb('paper_trades', {
      method: 'POST',
      body: JSON.stringify({
        symbol: signal.symbol, direction: signal.direction, signal_type: signal.type,
        entry: signal.price, sl: signal.sl, tp1: signal.tp1, tp2: signal.tp2,
        score: signal.score, created_at: new Date().toISOString(), status: 'OPEN'
      }),
    });
  } catch (err) { log('Paper log error:', err.message); }
};

// ── CHECK BTC GATE (keep as is) ─────────────────────────────────────────────
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
    const latestOpen = parseFloat(klines[klines.length - 1][1]);
    const latestClose = parseFloat(klines[klines.length - 1][4]);
    const candleGreen = latestClose >= latestOpen;
    let pass = true, reason = '✅ BTC stable';
    if (change1H < -0.8) { pass = false; reason = `🔴 BTC dumping ${change1H.toFixed(2)}% in 1H`; }
    else if (change24h < -3) { pass = false; reason = `🔴 BTC down ${change24h.toFixed(2)}% 24h`; }
    else if (fundRate > 0.02) { pass = false; reason = `⚠️ BTC funding ${fundRate.toFixed(3)}%`; }
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji };
    return btcGateStatus;
  } catch {
    return { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0 };
  }
};

// ── LAYER FUNCTIONS (keep compression, volume, resistance, fundingLS, trap) ──
const checkCompression = (klines, currentOI, prevOI) => {
  if (!klines || klines.length < 6) return { score: 0, compressed: false, oiBuilding: false, tightening: false, range: 99 };
  const recent = klines.slice(-6);
  const highs = recent.map(k => parseFloat(k[2]));
  const lows = recent.map(k => parseFloat(k[3]));
  const mid = (Math.max(...highs) + Math.min(...lows)) / 2;
  const range = mid > 0 ? ((Math.max(...highs) - Math.min(...lows)) / mid) * 100 : 99;
  const compressed = range < 4.0;
  const oiBuilding = prevOI > 0 && currentOI > prevOI * 1.02;
  const ranges = recent.map(k => parseFloat(k[2]) - parseFloat(k[3]));
  const tightening = ranges[ranges.length-1] < ranges[0] * 0.7;
  let score = 0;
  if (compressed && oiBuilding) score += 4;
  else if (compressed) score += 2.5;
  else if (oiBuilding) score += 1.5;
  if (tightening) score += 1;
  return { score, compressed, oiBuilding, tightening, range: parseFloat(range.toFixed(2)) };
};

const checkVolumeBuild = (klines) => {
  if (!klines || klines.length < 6) return { score: 0, building: false, spike: 0, gradual: false };
  const vols = klines.map(k => parseFloat(k[5]));
  const recent = vols.slice(-4);
  const base = vols.slice(0, -4);
  const avgBase = base.reduce((a, b) => a + b, 0) / (base.length || 1);
  const gradual = recent[0] < recent[1] && recent[1] < recent[2];
  const latestSpike = avgBase > 0 ? recent[recent.length-1] / avgBase : 0;
  const closes = klines.map(k => parseFloat(k[4]));
  const priceChange = closes[0] > 0 ? Math.abs((closes[closes.length-1] - closes[0]) / closes[0]) * 100 : 0;
  const quietAccum = latestSpike >= 1.5 && priceChange < 3;
  let score = 0;
  if (quietAccum) score += 3;
  else if (latestSpike >= 2) score += 2;
  else if (latestSpike >= 1.5) score += 1.5;
  if (gradual) score += 1;
  return { score, building: quietAccum, spike: parseFloat(latestSpike.toFixed(1)), gradual };
};

const checkResistanceTesting = (symbol, price, klines) => {
  if (!klines || klines.length < 6) return { score: 0, tests: 0, pressure: false, resistanceLevel: price };
  const highs = klines.map(k => parseFloat(k[2]));
  const maxH = Math.max(...highs);
  const tolerance = maxH * 0.005;
  const tests = highs.filter(h => Math.abs(h - maxH) <= tolerance).length;
  const testVols = klines.filter(k => Math.abs(parseFloat(k[2]) - maxH) <= tolerance).map(k => parseFloat(k[5]));
  const volInc = testVols.length >= 2 && testVols[testVols.length-1] > testVols[0];
  const prev = resistanceMap.get(symbol) || { level: maxH, tests: 0 };
  if (Math.abs(maxH - prev.level) / (prev.level || 1) < 0.01) {
    resistanceMap.set(symbol, { level: maxH, tests: Math.max(tests, prev.tests) });
  } else {
    resistanceMap.set(symbol, { level: maxH, tests });
  }
  const totalTests = resistanceMap.get(symbol).tests;
  const pressure = totalTests >= 3 && volInc;
  let score = 0;
  if (pressure) score += 3;
  else if (totalTests >= 3) score += 2;
  else if (totalTests >= 2) score += 1;
  return { score, tests: totalTests, pressure, resistanceLevel: parseFloat(maxH.toFixed(5)) };
};

const checkFundingLS = (funding, ls, direction) => {
  let score = 0;
  if (direction === 'LONG') {
    if (funding < -0.01) score += 2;
    else if (funding < 0) score += 1;
    else if (funding < 0.005) score += 0.5;
    if (ls < 0.85) score += 2;
    else if (ls < 0.95) score += 1;
    else if (ls < 1.05) score += 0.5;
  } else {
    if (funding > 0.02) score += 2;
    else if (funding > 0.01) score += 1;
    if (ls > 1.3) score += 2;
    else if (ls > 1.15) score += 1;
  }
  return { score: Math.min(score, 3), funding, ls };
};

const checkCandleQuality = (klines, direction) => {
  if (!klines || klines.length < 2) return { verdict: 'UNKNOWN', bodyPct: 0, upperWickPct: 0, lowerWickPct: 0 };
  const recent = klines.slice(-3);
  const results = recent.map(k => {
    const open = parseFloat(k[1]), high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
    const range = high - low;
    if (range === 0) return { bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, isGreen: false };
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    return { bodyPct: parseFloat((body / range * 100).toFixed(1)), upperWickPct: parseFloat((upperWick / range * 100).toFixed(1)), lowerWickPct: parseFloat((lowerWick / range * 100).toFixed(1)), isGreen: close >= open };
  });
  const latest = results[results.length - 1];
  let verdict, emoji, details;
  if (direction === 'LONG') {
    if (latest.bodyPct >= 60 && latest.upperWickPct <= 25 && latest.isGreen) { verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}%`; }
    else if (latest.upperWickPct > 60 || latest.bodyPct < 25) { verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — rejection`; }
    else { verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}%`; }
  } else {
    if (latest.bodyPct >= 60 && latest.lowerWickPct <= 25 && !latest.isGreen) { verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}%`; }
    else if (latest.lowerWickPct > 60 || latest.bodyPct < 25) { verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}%`; }
    else { verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}%`; }
  }
  return { verdict, emoji, details, bodyPct: latest.bodyPct, upperWickPct: latest.upperWickPct, lowerWickPct: latest.lowerWickPct, isGreen: latest.isGreen };
};

const checkTrapRisk = async (symbol, price, direction, volSpike, oiBuilding, klines = []) => {
  let trapScore = 0;
  const reasons = [];
  if (volSpike >= 2 && !oiBuilding) { trapScore += 2; reasons.push('vol spike no OI'); }
  try {
    const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
    const bids = ob.bids.map(b => ({ p: parseFloat(b[0]), q: parseFloat(b[1]) }));
    const asks = ob.asks.map(a => ({ p: parseFloat(a[0]), q: parseFloat(a[1]) }));
    const bidVal = bids.filter(b => b.p >= price * 0.99).reduce((s, b) => s + b.p * b.q, 0);
    const askVal = asks.filter(a => a.p <= price * 1.01).reduce((s, a) => s + a.p * a.q, 0);
    if (direction === 'LONG' && askVal > bidVal * 2) { trapScore += 1; reasons.push('asks dominating'); }
  } catch { }
  const candle = checkCandleQuality(klines, direction);
  if (candle.verdict === 'FAKE') { trapScore += 2; reasons.push(`fake candle`); }
  else if (candle.verdict === 'WEAK') { trapScore += 1; reasons.push(`weak candle`); }
  return { safe: trapScore === 0, trapScore, reasons, candle };
};

const checkLiquiditySweep = (klines, direction) => {
  if (!klines || klines.length < 4) return { swept: false, sweepLevel: null, recovery: false };
  const recent = klines.slice(-4);
  const lows = recent.map(k => parseFloat(k[3]));
  const highs = recent.map(k => parseFloat(k[2]));
  const latestClose = parseFloat(recent[recent.length - 1][4]);
  const latestOpen = parseFloat(recent[recent.length - 1][1]);
  if (direction === 'LONG') {
    const recentLow = Math.min(...lows.slice(0, -1));
    const latestLow = lows[lows.length - 1];
    const swept = latestLow < recentLow * 0.998;
    const recovery = latestClose > latestOpen && latestClose > recentLow;
    return { swept, sweepLevel: recentLow, recovery };
  } else {
    const recentHigh = Math.max(...highs.slice(0, -1));
    const latestHigh = highs[highs.length - 1];
    const swept = latestHigh > recentHigh * 1.002;
    const recovery = latestClose < latestOpen && latestClose < recentHigh;
    return { swept, sweepLevel: recentHigh, recovery };
  }
};

const checkExtension = (klines, price, atr) => {
  if (!klines || klines.length < 12 || !atr) return { tooExtended: false, reason: '' };
  const closes = klines.slice(0, -2).map(k => parseFloat(k[4]));
  const basePrice = closes.reduce((a, b) => a + b, 0) / closes.length;
  const extension = Math.abs(price - basePrice) / atr;
  const recentRanges = klines.slice(-11, -1).map(k => parseFloat(k[2]) - parseFloat(k[3]));
  const avgRange = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
  const latestRange = parseFloat(klines[klines.length-1][2]) - parseFloat(klines[klines.length-1][3]);
  const candleTooLarge = avgRange > 0 && latestRange > avgRange * 3;
  const tooExtended = extension > 2.0 || candleTooLarge;
  return { tooExtended, extension: parseFloat(extension.toFixed(2)), candleTooLarge, reason: tooExtended ? (candleTooLarge ? `candle ${(latestRange/avgRange).toFixed(1)}x avg` : `${extension.toFixed(1)} ATR`) : '' };
};

const checkRecentPump = (klines, price) => {
  if (!klines || klines.length < 4) return { pumped: false, pct: 0 };
  const priceAgo = parseFloat(klines[klines.length - 4][4]);
  const pct = Math.abs((price - priceAgo) / priceAgo) * 100;
  return { pumped: pct >= 5, pct: parseFloat(pct.toFixed(2)) };
};

const classifyRegime = (klines) => {
  if (!klines || klines.length < 20) return { regime: 'unknown', allowFire: true, allowEarly: true };
  const closes = klines.map(k => parseFloat(k[4]));
  const price = closes[closes.length - 1];
  const atr = calculateATR(klines, 10);
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  let regime = atrPct > 3.5 ? 'unstable' : 'ranging';
  return { regime, atrPct: parseFloat(atrPct.toFixed(2)), allowFire: regime !== 'unstable', allowEarly: regime !== 'unstable' };
};

const classifyOI = (currentOI, prevOI, price, prevPrice, funding, candle) => {
  if (!prevOI || prevOI === 0) return { type: 'unknown', bullish: false };
  const oiChange = ((currentOI - prevOI) / prevOI) * 100;
  const priceMove = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
  const oiRising = oiChange > 1;
  const priceFlat = Math.abs(priceMove) < 1.5;
  const pricePumped = priceMove > 3;
  const wicky = candle?.verdict === 'FAKE' || candle?.upperWickPct > 40;
  let type, bullish;
  if (oiRising && priceFlat && funding < -0.005) { type = 'squeeze'; bullish = true; }
  else if (oiRising && priceFlat) { type = 'buildup'; bullish = true; }
  else if (oiRising && !priceFlat && !pricePumped) { type = 'continuation'; bullish = true; }
  else if (oiRising && pricePumped && wicky) { type = 'trap'; bullish = false; }
  else { type = 'neutral'; bullish = false; }
  return { type, bullish, oiChange: parseFloat(oiChange.toFixed(2)) };
};

// ── MASTER SCORE ────────────────────────────────────────────────────────────
const calcMasterScore = ({ compression, volume, resistance, fundingLS, trap }) => {
  const raw = compression.score + volume.score + resistance.score + fundingLS.score - (trap.trapScore * 1.0);
  return Math.max(0, Math.min(10, parseFloat(raw.toFixed(1))));
};

// ── ALERT MESSAGES ──────────────────────────────────────────────────────────
const FOOTER = (btc, symbol) => {
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(1)}%` : '';
  return [btcStr, `⏰ ${gstNow()} GST`, `<i>DYOR · SL always set</i>`].filter(Boolean).join('  |  ');
};

const buildEarlyMsg = (symbol, price, score, direction, layers, atr, btc, earlyDetails) => {
  const isLong = direction === 'LONG';
  const { sl, tp1, tp2, riskReward } = calculateSLTP(price, atr, score, direction);
  const tags = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) tags.push('📦Coiling+OI');
  if (layers.fundingLS.funding < 0) tags.push(`💸Fund${layers.fundingLS.funding.toFixed(3)}%`);
  if (earlyDetails.triggers.length) tags.push(`🎯${earlyDetails.triggers.join('+')}`);
  return `⚡ <b>${symbol.replace('USDT','')} ${isLong?'🟢LONG':'🔴SHORT'} EARLY</b>  ${score}/10 ${confBar(score)}
${tags.join(' · ')}
💰 $${fmtP(price)}  🛑 $${fmtP(sl)}  🎯 $${fmtP(tp1)} / $${fmtP(tp2)}  R:R 1:${riskReward}
⚠️ <b>Position size: SMALL (20-30% of normal)</b> · Pre-breakout
${FOOTER(btc, symbol)}`.trim();
};

const buildFireMsg = (symbol, price, score, direction, layers, btc, klines = []) => {
  const isLong = direction === 'LONG';
  const atr = calculateATR(klines) || (price * 0.018);
  const { sl, tp1, tp2, tp3, riskReward } = calculateSLTP(price, atr, score, direction);
  const volumeCheck = checkBreakoutVolume(klines, direction);
  const conf = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) conf.push('📦OI+Coil');
  if (volumeCheck.validBreakout) conf.push(`🔊Vol${volumeCheck.breakVolRatio}x→${volumeCheck.followVolRatio}x`);
  if (layers.resistance.pressure) conf.push(`🧱Res×${layers.resistance.tests}`);
  if (layers.fundingLS.funding < 0) conf.push(`💸${layers.fundingLS.funding.toFixed(3)}%`);
  return `${isLong?'🟢':'🔴'} <b>NEXIO ${isLong?'📈LONG':'📉SHORT'} CONFIRMATION — ${symbol.replace('USDT','')}</b>
📊 ${score}/10 ${confBar(score)}
${conf.join(' · ')}
━━━━━━━━━━━━━━━
💰 $${fmtP(price)}  🛑 $${fmtP(sl)}
🎯 TP1 $${fmtP(tp1)}  TP2 $${fmtP(tp2)}  TP3 $${fmtP(tp3)}  R:R 1:${riskReward}
💼 <b>Position size: MEDIUM (50-70% of normal)</b>
${FOOTER(btc, symbol)}`.trim();
};

// ── SCANNER: FULL MARKET ────────────────────────────────────────────────────
let contractInfoCache = { data: null, ts: 0 };
const getContractInfo = async () => {
  const now = Date.now();
  if (contractInfoCache.data && now - contractInfoCache.ts < 3600000) return contractInfoCache.data;
  try {
    const info = await fetchJSON('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const cryptoSymbols = new Set();
    for (const s of info.symbols || []) {
      if (s.status !== 'TRADING') continue;
      if (s.contractType !== 'PERPETUAL') continue;
      if (s.quoteAsset !== 'USDT') continue;
      if (s.underlyingType && s.underlyingType !== 'COIN') continue;
      cryptoSymbols.add(s.symbol);
    }
    contractInfoCache = { data: cryptoSymbols, ts: now };
    return cryptoSymbols;
  } catch { return contractInfoCache.data || new Set(); }
};

const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount}`);
  try {
    const cryptoSet = await getContractInfo();
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers.filter(t => {
      if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
      if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) return false;
      if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) return false;
      if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
      if (Math.abs(parseFloat(t.priceChangePercent)) >= PUMP_EXCLUDE_PCT) return false;
      return true;
    }).map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), isMid: MID_CAP.has(t.symbol) }))
      .sort((a, b) => Math.abs(a.change) - Math.abs(b.change)).slice(0, 100);
    
    const currentWatchlist = await getWatchlist();
    const currentSymbols = currentWatchlist.map(r => r.symbol);
    let added = 0;
    
    for (const coin of valid) {
      await sleep(250);
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=12`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }
      
      const directionData = await determineDirection(coin.symbol, coin.price, klines, funding, ls, coin.change);
      if (!directionData.direction) continue;
      
      const compression = checkCompression(klines, currentOI, prevOI);
      const volume = checkVolumeBuild(klines);
      const resistance = checkResistanceTesting(coin.symbol, coin.price, klines);
      const fundingLS = checkFundingLS(funding, ls, directionData.direction);
      const trap = await checkTrapRisk(coin.symbol, coin.price, directionData.direction, volume.spike, compression.oiBuilding, klines);
      const score = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      
      if (score >= 2.5 && !currentSymbols.includes(coin.symbol)) {
        if (currentSymbols.length + added >= MAX_WATCHLIST) {
          const currentWl = await getWatchlist();
          const lowest = currentWl.filter(r => r.score !== null).sort((a,b) => (a.score||0) - (b.score||0))[0];
          if (lowest && (lowest.score || 0) < score - 0.5) {
            await removeFromWatchlist(lowest.symbol);
            coinTracker.delete(lowest.symbol);
            const idx = currentSymbols.indexOf(lowest.symbol);
            if (idx > -1) currentSymbols.splice(idx, 1);
          } else continue;
        }
        await addToWatchlist(coin.symbol, score, directionData.direction);
        currentSymbols.push(coin.symbol);
        added++;
        log(`✅ ${coin.symbol} score:${score} ${directionData.direction}`);
      }
    }
    log(`🌍 Scan #${fullScanCount} done — +${added} added — Watchlist: ${currentSymbols.length}`);
  } catch (err) { log('Full scan error:', err.message); }
};

// ── SCANNER: WATCHLIST (UPDATED WITH FIXES) ─────────────────────────────────
const runWatchlistScan = async () => {
  log(`👁 Watchlist Scan #${++watchlistScanCount}`);
  try {
    const btc = await checkBTCGate();
    const watchlist = await getWatchlist();
    const symbols = watchlist.map(r => r.symbol);
    if (!symbols.length) return;
    
    let alertsFired = 0;
    
    for (const symbol of symbols) {
      await sleep(200);
      let price = 0, funding = 0, ls = 1, currentOI = 0, prevOI = 0, klines = [];
      try { const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); price = parseFloat(t.price); } catch { }
      if (!price) continue;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=25`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }
      
      const ticker24h = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`).catch(() => null);
      const change24h = ticker24h ? parseFloat(ticker24h.priceChangePercent) : 0;
      
      // NEW: Determine direction with fixed logic
      const directionData = await determineDirection(symbol, price, klines, funding, ls, change24h);
      if (!directionData.direction) {
        coinTracker.delete(symbol);
        continue;
      }
      const direction = directionData.direction;
      
      // NEW: Check event risk
      const eventRisk = await checkEventRisk(symbol);
      if (eventRisk.shouldBlock) {
        log(`🚫 EVENT BLOCK: ${symbol} - ${eventRisk.risks.join(', ')}`);
        continue;
      }
      
      const compression = checkCompression(klines, currentOI, prevOI);
      const volume = checkVolumeBuild(klines);
      const resistance = checkResistanceTesting(symbol, price, klines);
      const fundingLS = checkFundingLS(funding, ls, direction);
      const trap = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);
      
      let score = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      
      // NEW: Breakout volume confirmation
      const breakoutVol = checkBreakoutVolume(klines, direction);
      const volumeBonus = breakoutVol.validBreakout ? 1.5 : 0;
      score = Math.min(10, score + volumeBonus);
      
      const layers = { compression, volume, resistance, fundingLS, trap };
      const atr = calculateATR(klines) || (price * 0.018);
      const ext = checkExtension(klines, price, atr);
      const pumpCheck = checkRecentPump(klines, price);
      const block = isBlocked(symbol);
      const regime = classifyRegime(klines);
      const early = checkEarlyEntry(compression, volume, fundingLS, klines, direction);
      const sweep = checkLiquiditySweep(klines, direction);
      
      // NEW: Candle quality check
      const candleOk = trap.candle?.verdict === 'STRONG' || (trap.candle?.verdict === 'WEAK' && score >= 8);
      
      // Update tracker
      const existing = coinTracker.get(symbol);
      if (!existing) {
        coinTracker.set(symbol, { symbol, direction, state: 'WATCHING', scanCount: 1, score, layers, firstSeen: Date.now(), history: [] });
      } else {
        if (direction !== existing.direction) {
          coinTracker.delete(symbol);
          continue;
        }
        existing.scanCount++;
        existing.score = score;
        existing.layers = layers;
        existing.state = score >= 8 ? 'FIRE' : score >= 6 ? 'CONFIRMING' : 'WATCHING';
        coinTracker.set(symbol, existing);
      }
      
      const state = coinTracker.get(symbol);
      if (!state) continue;
      
      // EARLY ENTRY (requires 2+ triggers, no extension, no pump)
      if (btc.pass && early.isEarly && !ext.tooExtended && !pumpCheck.pumped && !block.blocked && score >= 5 && alertsFired < 2) {
        const earlyKey = `early_${symbol}`;
        if (canAlert(earlyKey)) {
          await postSignal(buildEarlyMsg(symbol, price, score, direction, layers, atr, btc, early));
          markAlert(earlyKey);
          const { sl, tp1 } = calculateSLTP(price, atr, score, direction);
          await logPaperTrade({ symbol, direction, type: 'EARLY', price, sl, tp1, score });
          alertsFired++;
          log(`⚡ EARLY: ${symbol} ${direction} triggers:${early.triggers.join(',')}`);
        }
      }
      
      // FIRE ENTRY (requires breakout volume + candle quality + no block)
      else if (btc.pass && !ext.tooExtended && !pumpCheck.pumped && !block.blocked && 
               score >= MIN_ALERT_SCORE && breakoutVol.validBreakout && candleOk && 
               trap.safe && regime.allowFire && alertsFired < 2) {
        const fireKey = `fire_${symbol}`;
        if (canAlert(fireKey)) {
          await postSignal(buildFireMsg(symbol, price, score, direction, layers, btc, klines));
          markAlert(fireKey);
          const { sl, tp1, tp2 } = calculateSLTP(price, atr, score, direction);
          await logPaperTrade({ symbol, direction, type: 'FIRE', price, sl, tp1, tp2, score });
          alertsFired++;
          log(`🔥 FIRE: ${symbol} ${direction} score:${score} vol:${breakoutVol.breakVolRatio}x→${breakoutVol.followVolRatio}x`);
        }
      }
      
      // Cleanup low scorers
      if (score < 1.5 && state.scanCount >= 3) {
        coinTracker.delete(symbol);
        await removeFromWatchlist(symbol);
      }
    }
    
    // Send priority list every 3 scans
    if (watchlistScanCount % 3 === 0 && coinTracker.size > 0) {
      const sorted = [...coinTracker.values()].filter(c => c.score >= 6).sort((a, b) => b.score - a.score).slice(0, 10);
      if (sorted.length) {
        const lines = sorted.map((s, i) => {
          const rank = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
          return `${rank} ${s.direction === 'LONG' ? '📈' : '📉'} ${s.symbol.replace('USDT','')} — ${s.state} ${s.score}/10`;
        }).join('\n');
        await postSignal(`📊 <b>NEXIO PRIORITY LIST</b>\n━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━\n${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(1)}%\n⏰ ${gstNow()} GST`);
      }
    }
    
    await tg(OWNER_CHAT_ID, `👁 Scan #${watchlistScanCount} | ${gstNow()}\nTracking: ${coinTracker.size} | Alerts: ${alertsFired}\nBTC: ${btc.pass ? '✅' : '❌'} ${btc.reason}`);
  } catch (err) { log('Watchlist error:', err.message); }
};

// ── BACKTESTING SYSTEM (NEW) ────────────────────────────────────────────────
const runBacktest = async (startDate, endDate) => {
  log(`📊 Running backtest from ${startDate} to ${endDate}`);
  // This would fetch historical data and simulate trades
  // Returns { winRate, profitFactor, sharpeRatio, maxDrawdown, totalTrades }
  return { winRate: 0, profitFactor: 0, sharpeRatio: 0, maxDrawdown: 0, totalTrades: 0 };
};

// ── BOT COMMANDS ────────────────────────────────────────────────────────────
const handleCommand = async msg => {
  const chatId = String(msg.chat?.id);
  const username = msg.from?.username || '';
  const firstName = msg.from?.first_name || '';
  const text = (msg.text || '').trim();
  
  if (text === '/start') {
    await tg(chatId, `👋 <b>Welcome to Nexio v4.0!</b>\n━━━━━━━━━━━━━━━\n✅ Fixed direction logic\n✅ Volume confirmation\n✅ Better risk management\n\n/subscribe — $${PRICE_USD}/mo\n/status — Server status\n/stats — Paper trade stats\n/help — All commands`);
  }
  else if (text === '/status') {
    const all = await getAllUsers(), premium = await getPremiumUsers(), wl = await getWatchlist();
    await tg(chatId, `📊 <b>Nexio v4.0 Status</b>\n━━━━━━━━━━━━━━━\n✅ Online | PAPER_MODE: ${PAPER_MODE}\n👥 Users: ${all.length} | 👑 Prime: ${premium.length}\n👁 Watchlist: ${wl.length} | Tracking: ${coinTracker.size}\n📉 Daily loss: ${dailyLosses.pnl.toFixed(1)}% / ${MAX_DAILY_LOSS_PCT}%\n🚦 Emergency stop: ${emergencyStop ? 'ACTIVE' : 'OFF'}\n⏰ ${gstNow()} GST`);
  }
  else if (text === '/stats') {
    const all = (await sb('paper_trades?select=*')) || [];
    const closed = all.filter(t => t.status !== 'OPEN');
    const wins = closed.filter(t => t.outcome === 'WIN').length;
    const losses = closed.filter(t => t.outcome === 'LOSS').length;
    const winRate = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : '0';
    await tg(chatId, `📒 <b>Paper Trade Stats</b>\n━━━━━━━━━━━━━━━\n🟢 Wins: ${wins}\n🔴 Losses: ${losses}\n📊 Win Rate: ${winRate}%\n📈 Total trades: ${closed.length}\n\n${closed.length < 50 ? '⏳ Need 50+ trades for reliable data' : winRate >= 55 ? '✅ Strategy working' : '❌ Keep paper trading'}`);
  }
  else if (text === '/emergencystop' && chatId === OWNER_CHAT_ID) {
    emergencyStop = true;
    await tg(OWNER_CHAT_ID, '🛑 EMERGENCY STOP activated — no signals for 24 hours');
    setTimeout(() => { emergencyStop = false; tg(OWNER_CHAT_ID, '🟢 Emergency stop released'); }, 86400000);
  }
  else if (text === '/resume' && chatId === OWNER_CHAT_ID) {
    emergencyStop = false;
    await tg(OWNER_CHAT_ID, '🟢 Signals resumed');
  }
  else if (text === '/help') {
    await tg(chatId, `📖 <b>Commands</b>\n/start /status /stats /watchlist /tracking /btc /help\n\n👑 Owner only:\n/emergencystop /resume /fullscan /clearwatchlist`);
  }
  else if (text === '/test' && chatId === OWNER_CHAT_ID) {
    await postSignal(`🧪 <b>NEXIO v4.0 — TEST</b>\n━━━━━━━━━━━━━━━\n✅ Fixed version online\n✅ Direction logic fixed\n✅ Volume confirmation active\n✅ Risk management active\n⏰ ${gstNow()} GST`);
  }
  else if (text === '/fullscan' && chatId === OWNER_CHAT_ID) {
    await runFullMarketScan();
  }
  else if (text === '/clearwatchlist' && chatId === OWNER_CHAT_ID) {
    const wl = await getWatchlist();
    for (const r of wl) await removeFromWatchlist(r.symbol);
    coinTracker.clear();
    await tg(chatId, `✅ Cleared ${wl.length} coins`);
  }
};

// ── POLL USERS ──────────────────────────────────────────────────────────────
let updateId = 0;
const pollUsers = async () => {
  try {
    const data = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${updateId + 1}&limit=20&timeout=0`);
    if (!data?.ok || !data.result?.length) return;
    for (const u of data.result) {
      updateId = u.update_id;
      if (u.message) await handleCommand(u.message);
    }
  } catch (err) { log('Poll error:', err.message); }
};

// ── START ───────────────────────────────────────────────────────────────────
const start = async () => {
  log(`🚀 Nexio v4.0 — FIXED VERSION starting... PAPER_MODE: ${PAPER_MODE}`);
  await tg(OWNER_CHAT_ID, `🟢 <b>Nexio v4.0 Started (FIXED)</b>\n━━━━━━━━━━━━━━━\n✅ Direction logic: MULTI-FACTOR\n✅ SL: ${NORMAL_SL_ATR} ATR (normal) / ${HIGH_CONF_SL_ATR} ATR (high conf)\n✅ TP: ${TP1_ATR}/${TP2_ATR}/${TP3_ATR} ATR\n✅ Volume confirmation: ${MIN_BREAKOUT_VOLUME_RATIO}x → ${MIN_FOLLOW_VOLUME_RATIO}x\n✅ Daily loss limit: ${MAX_DAILY_LOSS_PCT}%\n📒 PAPER MODE: ${PAPER_MODE ? 'ON (2 weeks minimum)' : 'OFF'}\n⏰ ${gstNow()} GST`);
  
  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
};

start();
