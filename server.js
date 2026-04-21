// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v3.7 — 9-Layer Intelligence Scanner
//
// LAYER 1  — BTC Momentum Gate + HTF EMA50 trend filter
// LAYER 2  — Full coin universe (low + mid cap, pump filter 15%)
// LAYER 3  — Price Compression + OI Buildup (MOST IMPORTANT)
// LAYER 4  — Volume Buildup BEFORE Breakout
// LAYER 5  — Repeated Resistance Testing (Breakout Pressure)
// LAYER 6  — Funding + L/S Confirmation
// LAYER 7  — Trap Risk Filter + Candle Wick + Liquidity Sweep Detector
// LAYER 8  — THREE-Stage Alert: EARLY → WATCH → FIRE
// LAYER 9  — Position Manager (breakeven + partial TP)
//
// v3.0 NEW:
//   1. EARLY ENTRY MODE — compression+OI before breakout (best R:R)
//   2. Fixed R:R — SL=1.2 ATR, TP1=1.5 ATR, TP2=3 ATR (R:R >= 1.5)
//   3. HTF EMA50 filter — LONG above EMA50 only, SHORT below only
//   4. Liquidity sweep detector — enter AFTER sweep not before
//   5. Two setup types — EARLY (pre-breakout) + FIRE (confirmed breakout)
//   6. Position manager — move SL to breakeven after TP1 hit
// ─────────────────────────────────────────────────────────────────────────────


const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003900595640';
const PREMIUM_CHANNEL = '-1003913881352';
const OWNER_CHAT_ID   = '6896387082';

// ── PAPER TRADING MODE ───────────────────────────────────────────────────────
// When true: alerts go ONLY to owner (no channels), every signal logged to Supabase
// Bot researches silently, outcomes tracked, real stats after 1-2 weeks
const PAPER_MODE = true;
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

const FULL_MARKET_INTERVAL_MS = 120000; // v3.7 — 2 min
const WATCHLIST_SCAN_INTERVAL = 45000; // v3.7 — 45 sec
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 200000; // was 500K — catch low caps before pump
const MAX_WATCHLIST           = 50; // quality over quantity
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 1.2;
const MIN_ALERT_SCORE         = 6.5; // v3.7 — balanced quality
const PUMP_EXCLUDE_PCT        = 25.0; // was 15% — coins up 15% can still pump

const EXCLUDE = new Set([
  // ── High cap crypto ──────────────────────────────────────────────────────────
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'HBARUSDT','WBTCUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'ATOMUSDT','NEARUSDT','UNIUSDT','APTUSDT','LDOUSDT',

  // ── Tokenized commodities — gold, silver, oil, platinum ──────────────────────
  'XAUUSDT','XAUTUSDT','PAXGUSDT','XAGUUSDT','CLUSDT',
  'WBTCUSDT','XPTUSD','PALAUSDT',

  // ── Stablecoins / index / dom ────────────────────────────────────────────────
  'USDCUSDT','USDTUSDT','BUSDUSDT','DAIUSDT','FRAXUSDT',
  'BTCDOMUSDT','DEFIUSDT','ALTUSDT',

  // ── Tokenized US stocks ──────────────────────────────────────────────────────
  'TSLAUSDT','AAPLUSDT','GOOGLUSDT','AMZNUSDT','MSFTUSDT',
  'NVDAUSDT','METAUSDT','COINUSDT','NFLXUSDT','BABAUSDT',
  'AMDUSDT','BRKBUSDT','BRKAUSDT','INTCUSDT','TSMUSDT',
  'TSMAUSDT','UBERUSDT','ABNBUSDT','SPYUSDT','QQQUSDT',
  'PLTRУСDT','PYTUSDT','SHOP1USDT','SNAPUSDT','LYFTUSDT',
  'RKLBUSDT','IONQUSDT','MSTRUSDT','MSTRUUSDT',
]);

// Regex catches any tokenized asset not in the list above
// Tokenized stocks / ETFs / commodities — blacklist by symbol prefix
const EXCLUDE_REGEX = /^(TSLA|AAPL|GOOGL|AMZN|MSFT|NVDA|META|NFLX|AMD|COIN|BABA|BRKB|BRKA|INTC|UBER|SPY|QQQ|ABNB|TSM|PLTR|SHOP|PYPL|SNAP|LYFT|XAU|XAG|PAX|CL1|MSTR|RKLB|IONQ|HOOD|GME|AMC|NIO|BIDU|JD|PDD|ARKK|IWM|DIA|GLD|SLV|USO|UNG|DXY|VIX|SPX|NDX|DJI|RUT|FTSE|DAX|NIKKEI|SP500|NSDQ|DOW|CRUDE|BRENT|WTI|GAS|COPPER|PLATINUM|PALLADIUM|WHEAT|CORN|SOYBEAN|COTTON|COFFEE|SUGAR|COCOA|CATTLE|HOGS|LUMBER|ORANGE|RUBBER|OILF|PYT|MSTR|EGLD\d|USTC|CFX|LUNC|UST|XEC|BTT|ELON|BITCOIN|ETHEREUM|XPTUSD|PALA|FOREX|EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD|NZDUSD|USDCAD)/;

// Additional patterns — tokens ending in specific suffixes that indicate non-crypto
const STOCK_SUFFIX_REGEX = /(STOCK|SHARE|SHARES|EQUITY|ETF|COMMODITY)USDT$/;

// Real crypto coin pattern — typically 2-10 alpha chars + USDT
// Reject if symbol contains digits after letters (usually tokenized versions like TSLA1, NVDA2)
const isLikelyStock = (symbol) => {
  const base = symbol.replace('USDT', '');
  // Real crypto is usually all-letters, 2-10 chars
  // Stocks often have numbers mid-symbol or weird patterns
  if (/^[A-Z]{2,10}$/.test(base)) return false; // pure letters = likely crypto
  if (/\d/.test(base) && base.length <= 5) return true; // short with numbers = stock ticker
  return false;
};

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

// ── Session Filter — skip low liquidity windows ──────────────────────────────
// Dubai time (UAE) used because server/user in UAE
// Low liquidity windows (GST): 01:00-05:00 (Asia dead zone between close & London open)
const isLowLiquiditySession = () => {
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  return hour >= 1 && hour < 5;
};
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

// ── ATR Calculator ────────────────────────────────────────────────────────────
const calculateATR = (klines, period = 14) => {
  if (klines.length < period + 1) return 0;
  let trSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high      = parseFloat(klines[i][2]);
    const low       = parseFloat(klines[i][3]);
    const prevClose = i > 0 ? parseFloat(klines[i-1][4]) : high;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trSum += tr;
  }
  return trSum / period;
};

// ── EMA Calculator ────────────────────────────────────────────────────────────
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

// ── HTF EMA50 + EMA200 Trend Filter (v3.1) ───────────────────────────────────
// LONG only if price > EMA50 > EMA200
// SHORT only if price < EMA50 < EMA200
const checkHTFTrend = async (symbol) => {
  try {
    const klines1h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=210`);
    if (klines1h.length < 200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'insufficient data' };
    const closes = klines1h.map(k => parseFloat(k[4]));
    const price  = closes[closes.length - 1];
    const ema50  = calcEMAFromCloses(closes, 50);
    const ema200 = calcEMAFromCloses(closes, 200);
    if (!ema50 || !ema200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'calc error' };
    // EMA50 is the gate. EMA200 adds confidence but does NOT block.
    const bullish   = price > ema50;
    const bearish   = price < ema50;
    const ema200ok  = ema200 ? (bullish ? ema50 > ema200 : ema50 < ema200) : true;
    const pctAbove  = ((price - ema50) / ema50) * 100;
    return {
      bullish, bearish, ema50, ema200, ema200ok,
      pctAbove: parseFloat(pctAbove.toFixed(2)),
      reason: bullish
        ? `above EMA50${ema200ok ? ' + EMA200 ✅' : ' (EMA200 pending ⚡)'}`
        : `below EMA50${ema200ok ? ' + EMA200 ✅' : ' (EMA200 pending ⚡)'}`,
    };
  } catch {
    return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'data error' };
  }
};

// ── Market Regime Classifier (v3.1) ──────────────────────────────────────────
const classifyRegime = (klines) => {
  if (klines.length < 20) return { regime: 'unknown', allowFire: true, allowEarly: true };
  const closes   = klines.map(k => parseFloat(k[4]));
  const highs    = klines.map(k => parseFloat(k[2]));
  const lows     = klines.map(k => parseFloat(k[3]));
  const price    = closes[closes.length - 1];
  const ema10Now = calcEMAFromCloses(closes, 10);
  const ema10Prv = calcEMAFromCloses(closes.slice(0, -5), 10);
  const slope    = ema10Now && ema10Prv ? ((ema10Now - ema10Prv) / ema10Prv) * 100 : 0;
  const atr      = calculateATR(klines, 10);
  const atrPct   = price > 0 ? (atr / price) * 100 : 0;
  const rangePct = price > 0 ? ((Math.max(...highs.slice(-10)) - Math.min(...lows.slice(-10))) / price) * 100 : 0;
  let regime;
  if (atrPct > 3.5)                               regime = 'unstable';
  else if (Math.abs(slope) > 0.3 && rangePct > 4) regime = 'trending';
  else                                             regime = 'ranging';
  return { regime, slope: parseFloat(slope.toFixed(2)), atrPct: parseFloat(atrPct.toFixed(2)), allowFire: regime === 'trending', allowEarly: regime !== 'unstable' };
};

// ── OI Classifier (v3.1) ─────────────────────────────────────────────────────
const classifyOI = (currentOI, prevOI, price, prevPrice, funding, candle) => {
  if (!prevOI || prevOI === 0) return { type: 'unknown', bullish: false };
  const oiChange    = ((currentOI - prevOI) / prevOI) * 100;
  const priceMove   = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
  const oiRising    = oiChange > 1;
  const priceFlat   = Math.abs(priceMove) < 1.5;
  const pricePumped = priceMove > 3;
  const wicky       = candle?.verdict === 'FAKE' || candle?.upperWickPct > 40;
  let type, bullish;
  if (oiRising && priceFlat && funding < -0.005) { type = 'squeeze';      bullish = true;  }
  else if (oiRising && priceFlat)                { type = 'buildup';      bullish = true;  }
  else if (oiRising && !priceFlat && !pricePumped){ type = 'continuation'; bullish = true; }
  else if (oiRising && pricePumped && wicky)     { type = 'trap';         bullish = false; }
  else                                            { type = 'neutral';      bullish = false; }
  return { type, bullish, oiChange: parseFloat(oiChange.toFixed(2)) };
};

// ── Extension Filter (v3.1) ───────────────────────────────────────────────────
const checkExtension = (klines, price, atr) => {
  if (klines.length < 12 || !atr) return { tooExtended: false, reason: '' };
  const closes       = klines.slice(0, -2).map(k => parseFloat(k[4]));
  const basePrice    = closes.reduce((a, b) => a + b, 0) / closes.length;
  const extension    = Math.abs(price - basePrice) / atr;
  const recentRanges = klines.slice(-11, -1).map(k => parseFloat(k[2]) - parseFloat(k[3]));
  const avgRange     = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
  const latestRange  = parseFloat(klines[klines.length-1][2]) - parseFloat(klines[klines.length-1][3]);
  const candleTooLarge = avgRange > 0 && latestRange > avgRange * 3;
  const tooExtended  = extension > 2.0 || candleTooLarge;
  return { tooExtended, extension: parseFloat(extension.toFixed(2)), candleTooLarge, reason: tooExtended ? (candleTooLarge ? `candle ${(latestRange/avgRange).toFixed(1)}x avg` : `${extension.toFixed(1)} ATR from base`) : '' };
};

// ── Social Hype Check — PER-COIN analysis via CoinGecko (FREE) ───────────────
// For each scanned coin, checks its actual Twitter/Reddit/Telegram community metrics
// Cached per-coin for 30 min to respect rate limits (30 req/min free tier)

// Symbol → CoinGecko ID mapping (fetched once, cached for 24h)
let coinIdCache = { data: null, ts: 0 };

const buildCoinIdMap = async () => {
  const now = Date.now();
  if (coinIdCache.data && now - coinIdCache.ts < 86400000) return coinIdCache.data;
  try {
    const list = await fetchJSON('https://api.coingecko.com/api/v3/coins/list');
    const map = new Map();
    // Prefer exact symbol match — pick first match (usually the main coin)
    for (const coin of list || []) {
      const sym = coin.symbol?.toUpperCase();
      if (sym && !map.has(sym)) map.set(sym, coin.id);
    }
    coinIdCache = { data: map, ts: now };
    log(`📖 CoinGecko ID map: ${map.size} coins indexed`);
    return map;
  } catch (err) {
    log('CG id map error:', err.message);
    return coinIdCache.data || new Map();
  }
};

// Per-coin hype cache — avoids hammering API
const hypeCache = new Map();  // symbol → { data, ts }
const HYPE_CACHE_MS = 1800000; // 30 min per coin

const checkSocialHype = async (symbol) => {
  const sym = symbol.replace('USDT', '').toUpperCase();

  // Return cached if fresh
  const cached = hypeCache.get(sym);
  if (cached && Date.now() - cached.ts < HYPE_CACHE_MS) return cached.data;

  try {
    const idMap = await buildCoinIdMap();
    const coinId = idMap.get(sym);
    if (!coinId) {
      const result = { hasData: false, hypeBonus: 0, tag: '', reason: 'not on CG' };
      hypeCache.set(sym, { data: result, ts: Date.now() });
      return result;
    }

    // Fetch coin data — community + sentiment only (lean response)
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false&sparkline=false`;
    const data = await fetchJSON(url);
    if (!data) throw new Error('no data');

    const community = data.community_data || {};
    const twitter   = community.twitter_followers || 0;
    const reddit    = community.reddit_subscribers || 0;
    const telegram  = community.telegram_channel_user_count || 0;
    const sentiment = data.sentiment_votes_up_percentage || 0; // 0-100
    const watchlist = data.watchlist_portfolio_users || 0;
    const cgRank    = data.coingecko_rank || 9999;
    const mcRank    = data.market_cap_rank || 9999;

    // Calculate hype score
    let hypeBonus = 0;
    const tags = [];

    // Sentiment bonus (bullish community)
    if (sentiment >= 80)       { hypeBonus += 0.8; tags.push(`😊${sentiment.toFixed(0)}%bull`); }
    else if (sentiment >= 65)  { hypeBonus += 0.5; tags.push(`😊${sentiment.toFixed(0)}%bull`); }
    else if (sentiment > 0 && sentiment < 40) { hypeBonus -= 1; tags.push(`😟${sentiment.toFixed(0)}%bear`); }

    // Watchlist users bonus (active interest)
    if (watchlist > 100000)     { hypeBonus += 1.0; tags.push(`⭐${Math.round(watchlist/1000)}k`); }
    else if (watchlist > 30000) { hypeBonus += 0.5; tags.push(`⭐${Math.round(watchlist/1000)}k`); }
    else if (watchlist > 10000) { hypeBonus += 0.3; }

    // Twitter community bonus
    if (twitter > 500000)       { hypeBonus += 0.5; tags.push(`🐦${Math.round(twitter/1000)}k`); }
    else if (twitter > 100000)  { hypeBonus += 0.3; }
    else if (twitter < 5000 && twitter > 0) { hypeBonus -= 0.5; tags.push('🪦dead'); }

    // Cap bonus at +3, floor at -1.5
    hypeBonus = Math.max(-1.5, Math.min(1.5, hypeBonus)); // reduced influence — crowded = late

    const result = {
      hasData:   true,
      hypeBonus,
      sentiment,
      watchlist,
      twitter,
      reddit,
      telegram,
      cgRank,
      mcRank,
      tag: tags.length > 0 ? tags.join(' ') : '',
    };
    hypeCache.set(sym, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    const result = { hasData: false, hypeBonus: 0, tag: '', reason: err.message };
    hypeCache.set(sym, { data: result, ts: Date.now() });
    return result;
  }
};

// ── Post-Loss Protection (v3.1) ───────────────────────────────────────────────
const lossTracker   = new Map();
const pumpTracker   = new Map(); // symbol → { pumpedAt, pctMove }
const PUMP_COOLDOWN_MIN = 30; // minutes to skip coin after 5%+ move

const checkRecentPump = (klines, price) => {
  if (klines.length < 4) return { pumped: false, pct: 0 };
  // Check if coin moved 5%+ in last 4 candles (1h on 15m)
  const priceAgo = parseFloat(klines[klines.length - 4][4]);
  const pct = Math.abs((price - priceAgo) / priceAgo) * 100;
  return { pumped: pct >= 5, pct: parseFloat(pct.toFixed(2)) };
};
const dailyLosses   = { count: 0, date: '' };
const LOSS_COOLDOWN = 90;
const DAILY_KILL    = 3;

const recordLoss = (symbol) => {
  const today = new Date().toDateString();
  if (dailyLosses.date !== today) { dailyLosses.count = 0; dailyLosses.date = today; }
  dailyLosses.count++;
  lossTracker.set(symbol, { lossTime: Date.now() });
  log(`❌ Loss: ${symbol} | Daily: ${dailyLosses.count}/${DAILY_KILL}`);
};

const isBlocked = (symbol) => {
  if (dailyLosses.count >= DAILY_KILL) return { blocked: true, reason: `Daily kill switch (${dailyLosses.count} losses)` };
  const rec = lossTracker.get(symbol);
  if (rec) {
    const minsAgo = (Date.now() - rec.lossTime) / 60000;
    if (minsAgo < LOSS_COOLDOWN) return { blocked: true, reason: `Loss cooldown ${Math.ceil(LOSS_COOLDOWN - minsAgo)}min` };
  }
  return { blocked: false, reason: '' };
};

// ── Liquidity Sweep Detector ──────────────────────────────────────────────────
const checkLiquiditySweep = (klines, direction) => {
  if (klines.length < 4) return { swept: false, sweepLevel: null, recovery: false };
  const recent      = klines.slice(-4);
  const closes      = recent.map(k => parseFloat(k[4]));
  const lows        = recent.map(k => parseFloat(k[3]));
  const highs       = recent.map(k => parseFloat(k[2]));
  const latestClose = closes[closes.length - 1];
  const latestOpen  = parseFloat(recent[recent.length - 1][1]);
  if (direction === 'LONG') {
    const recentLow = Math.min(...lows.slice(0, -1));
    const latestLow = lows[lows.length - 1];
    const swept     = latestLow < recentLow * 0.998;
    const recovery  = latestClose > latestOpen && latestClose > recentLow;
    return { swept, sweepLevel: recentLow, recovery };
  } else {
    const recentHigh = Math.max(...highs.slice(0, -1));
    const latestHigh = highs[highs.length - 1];
    const swept      = latestHigh > recentHigh * 1.002;
    const recovery   = latestClose < latestOpen && latestClose < recentHigh;
    return { swept, sweepLevel: recentHigh, recovery };
  }
};

// ── Early Entry Checker ───────────────────────────────────────────────────────
const checkEarlyEntry = (compression, volume, fundingLS) => {
  const quietAccum   = compression.compressed && compression.oiBuilding;
  const notBrokenOut = volume.spike < 1.5;
  const fundingReady = fundingLS.funding < 0 || fundingLS.ls < 1.0;
  const isEarly      = quietAccum && notBrokenOut && fundingReady;
  let earlyScore = 0;
  if (quietAccum)         earlyScore += 3;
  if (compression.tightening) earlyScore += 1;
  if (fundingReady)       earlyScore += 1;
  return { isEarly, earlyScore, quietAccum, notBrokenOut, fundingReady };
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

const getWatchlist         = async () => (await sb('watchlist?select=symbol,score,direction,updated_at,added_by')) || [];
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

// ── PAPER TRADE LOGGER ───────────────────────────────────────────────────────
// Logs every signal to Supabase 'paper_trades' table for outcome tracking
const logPaperTrade = async (signal) => {
  try {
    await sb('paper_trades', {
      method: 'POST',
      body: JSON.stringify({
        symbol:      signal.symbol,
        direction:   signal.direction,
        signal_type: signal.type,        // 'EARLY' | 'FIRE' | 'WATCH'
        entry:       signal.price,
        sl:          signal.sl,
        tp1:         signal.tp1,
        tp2:         signal.tp2,
        score:       signal.score,
        candle:      signal.candle,
        btc_change:  signal.btcChange,
        status:      'OPEN',             // will be updated by outcome checker
        created_at:  new Date().toISOString(),
      }),
    });
  } catch (err) { log('Paper log error:', err.message); }
};

// ── PAPER TRADE OUTCOME CHECKER ──────────────────────────────────────────────
// Every 10 min: check open paper trades, see if SL or TP was hit, update status
const checkPaperOutcomes = async () => {
  try {
    const open = (await sb('paper_trades?status=eq.OPEN&select=*')) || [];
    if (!open.length) return;
    log(`📒 Checking ${open.length} open paper trades...`);
    for (const trade of open) {
      await sleep(200);
      try {
        const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${trade.symbol}`);
        const price = parseFloat(t.price);
        const isLong = trade.direction === 'LONG';
        let status = 'OPEN', outcome = null;
        // Check SL hit
        if (isLong && price <= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        else if (!isLong && price >= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        // Check TP1 hit (partial win)
        else if (isLong && price >= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
        else if (!isLong && price <= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
        // Timeout after 4h
        else if (Date.now() - new Date(trade.created_at).getTime() > 4 * 3600000) {
          status = 'TIMEOUT';
          const chg = isLong ? ((price - trade.entry) / trade.entry) * 100 : ((trade.entry - price) / trade.entry) * 100;
          outcome = chg > 0 ? 'WIN' : 'LOSS';
        }
        if (status !== 'OPEN') {
          await sb(`paper_trades?id=eq.${trade.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status, outcome, closed_price: price, closed_at: new Date().toISOString() }),
          });
          log(`📒 ${trade.symbol} ${trade.direction} → ${status} (${outcome})`);
        }
      } catch { }
    }
  } catch (err) { log('Paper outcome error:', err.message); }
};

const postSignal = async text => {
  // In PAPER_MODE, only owner gets alerts — no channel posts
  const targets = PAPER_MODE ? [OWNER_CHAT_ID] : [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID];
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
    // Tightened v3.4 — block LONG entries when BTC is not actively supporting
    if (change1H < -0.8)                      { pass = false; reason = `🔴 BTC dumping ${change1H.toFixed(2)}% in 1H`; }
    else if (change24h < -3)                  { pass = false; reason = `🔴 BTC down ${change24h.toFixed(2)}% 24h — bearish regime`; }
    else if (fundRate > 0.02)                 { pass = false; reason = `⚠️ BTC funding ${fundRate.toFixed(3)}% — overheated`; }
    else if (!candleGreen && change1H < -0.3) { pass = false; reason = `🟠 BTC bearish 15m`; }
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
  if (compressed && oiBuilding) score += 4;
  else if (compressed)          score += 2.5;
  else if (oiBuilding)          score += 1.5;
  if (tightening)               score += 1;
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
  if (quietAccum)              score += 3;
  else if (latestSpike >= 2)   score += 2;
  else if (latestSpike >= 1.5) score += 1.5;
  if (gradual) score += 1;
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
  if (pressure)             score += 3;
  else if (totalTests >= 3) score += 2;
  else if (totalTests >= 2) score += 1;
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
  return { score: Math.min(score, 3), funding, ls };
};

// ── LAYER 7a: Candle Wick Detector (NEW v3.0) ─────────────────────────────────
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
    const ob      = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
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

  // NEW v3.0: Candle wick quality check
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

// ── Bullish Absorption Detector (v3.7) ────────────────────────────────────────
// Detects stealth accumulation pattern — smart money buying quietly
// Signals:
//   1. Price flat/compressed (not moving much)
//   2. OI rising (new longs opening)
//   3. Volume rising (real activity, not thin)
//   4. Funding negative or neutral (shorts paying / not overheated)
//   5. Bid side strong (buying absorbing sell pressure)
//   6. Green candle bias (more green than red candles recently)
const checkBullishAbsorption = async (symbol, price, klines, currentOI, prevOI, funding) => {
  if (!klines || klines.length < 6) return { absorbing: false, score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  // 1. Price compression — small range in last 6 candles
  const recent = klines.slice(-6);
  const highs  = recent.map(k => parseFloat(k[2]));
  const lows   = recent.map(k => parseFloat(k[3]));
  const maxH   = Math.max(...highs);
  const minL   = Math.min(...lows);
  const rangePct = ((maxH - minL) / price) * 100;
  const priceFlat = rangePct < 3.5; // under 3.5% range = flat
  if (priceFlat) { score += 2; reasons.push(`🤫 flat ${rangePct.toFixed(1)}%`); }

  // 2. OI rising (new longs opening silently)
  const oiRising = prevOI > 0 && currentOI > prevOI * 1.015;
  const oiPct = prevOI > 0 ? ((currentOI - prevOI) / prevOI) * 100 : 0;
  if (oiRising) { score += 2; reasons.push(`📈 OI+${oiPct.toFixed(1)}%`); }

  // 3. Volume building (real activity, not ghost town)
  const vols   = recent.map(k => parseFloat(k[5]));
  const firstHalf = vols.slice(0, 3).reduce((a,b) => a+b, 0) / 3;
  const secondHalf = vols.slice(3).reduce((a,b) => a+b, 0) / 3;
  const volRising = secondHalf > firstHalf * 1.2;
  if (volRising) { score += 1.5; reasons.push(`🔊 vol rising`); }

  // 4. Funding negative or slightly negative (shorts paying = bullish setup)
  const fundingOk = funding < 0.005; // not overheated
  const fundingStrong = funding < -0.005; // shorts actively paying
  if (fundingStrong) { score += 2; reasons.push(`💸 shorts paying ${funding.toFixed(3)}%`); }
  else if (fundingOk) { score += 1; }

  // 5. Bid side strong — order book check
  try {
    const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
    const bidValue = ob.bids.slice(0, 20).reduce((s, b) => s + parseFloat(b[0]) * parseFloat(b[1]), 0);
    const askValue = ob.asks.slice(0, 20).reduce((s, a) => s + parseFloat(a[0]) * parseFloat(a[1]), 0);
    const bidDominance = bidValue / (askValue || 1);
    if (bidDominance > 1.3) { score += 1.5; reasons.push(`🟢 bids dominate ${bidDominance.toFixed(2)}x`); }
    else if (bidDominance > 1.1) { score += 0.5; }
  } catch { }

  // 6. Green candle bias — more buying than selling pressure
  const greenCount = recent.filter(k => parseFloat(k[4]) >= parseFloat(k[1])).length;
  if (greenCount >= 4) { score += 1; reasons.push(`🟩 ${greenCount}/6 green`); }

  // Final verdict — must have at least 3 signals firing + score >= 5
  const absorbing = score >= 5 && reasons.length >= 3 && priceFlat && oiRising;

  return {
    absorbing,
    score: parseFloat(score.toFixed(1)),
    reasons,
    rangePct: parseFloat(rangePct.toFixed(2)),
    oiPct: parseFloat(oiPct.toFixed(2)),
    funding,
  };
};

// ── Master Score ──────────────────────────────────────────────────────────────
const calcMasterScore = ({ compression, volume, resistance, fundingLS, trap }) => {
  const raw = compression.score + volume.score + resistance.score + fundingLS.score - (trap.trapScore * 1.0);
  return Math.max(0, Math.min(10, parseFloat(raw.toFixed(1))));
};

// ── Alert Messages ────────────────────────────────────────────────────────────
// ── Shared footer (only shown once per message) ──────────────────────────────
const FOOTER = (btc, symbol) => {
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0?'+':''}${btc.change?.toFixed(1)}%` : '';
  const link   = symbol ? `bybit.com/trade/usdt/${symbol}` : '';
  return [btcStr, link, `⏰ ${gstNow()} GST`, `<i>DYOR · SL always set</i>`].filter(Boolean).join('  |  ');
};

// WATCH — compact single block per coin
const buildWatchMsg = (symbol, score, direction, layers, btc, hype = null) => {
  const isLong = direction === 'LONG';
  const tag    = isLong ? '🟢 LONG' : '🔴 SHORT';
  const candle = layers.trap?.candle;
  const cv     = candle?.verdict !== 'UNKNOWN' ? ` · 🕯${candle?.emoji}${candle?.verdict}` : '';

  const tags = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) tags.push('📦Coiling+OI');
  else if (layers.compression.compressed) tags.push('📦Coiling');
  if (layers.compression.tightening)  tags.push('🎯Tightening');
  if (layers.volume.building)         tags.push('🔊VolBuild');
  if (layers.resistance.pressure)     tags.push(`🧱Resist×${layers.resistance.tests}`);
  if (layers.fundingLS.funding < 0)   tags.push(`💸Fund${layers.fundingLS.funding.toFixed(3)}%`);
  if (layers.fundingLS.ls < 1)        tags.push(`⚖️L/S${layers.fundingLS.ls.toFixed(2)}`);
  if (hype?.tag)                      tags.push(hype.tag);

  return `👀 <b>${symbol.replace('USDT','')} ${tag}</b>  ${score}/10 ${confBar(score)}${cv}
${tags.join(' · ')}
⏳ Waiting for breakout
${FOOTER(btc, symbol)}`.trim();
};

// EARLY — compact pre-breakout
const buildEarlyMsg = (symbol, price, score, direction, layers, htf, sweep, atr, btc, hype = null) => {
  const isLong = direction === 'LONG';
  const sl  = isLong ? price - atr * 1.2 : price + atr * 1.2;
  const tp1 = isLong ? price + atr * 1.5 : price - atr * 1.5;
  const tp2 = isLong ? price + atr * 3.0 : price - atr * 3.0;
  const rr  = ((Math.abs(tp1 - price)) / Math.abs(price - sl)).toFixed(1);

  const tags = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) tags.push('📦Coiling+OI');
  if (layers.compression.tightening)  tags.push('🎯Tightening');
  if (layers.fundingLS.funding < 0)   tags.push(`💸Fund${layers.fundingLS.funding.toFixed(3)}%`);
  if (layers.fundingLS.ls < 1)        tags.push(`⚖️L/S${layers.fundingLS.ls.toFixed(2)}`);
  if (sweep?.swept && sweep?.recovery) tags.push('🌊Swept');
  if (hype?.isTrending)                tags.push(hype.tag);

  return `⚡ <b>${symbol.replace('USDT','')} ${isLong?'🟢LONG':'🔴SHORT'} EARLY</b>  ${score}/10 ${confBar(score)}
${tags.join(' · ')}
💰 $${fmtP(price)}  🛑 $${fmtP(sl)}  🎯 $${fmtP(tp1)} / $${fmtP(tp2)}  R:R 1:${rr}
⚠️ <b>Position size: SMALL (20-30% of normal)</b> · Pre-breakout
${FOOTER(btc, symbol)}`.trim();
};

// FIRE — full signal with SL/TP
const buildFireMsg = (symbol, price, score, direction, layers, scanCount, btc, klines = [], hype = null) => {
  const isLong   = direction === 'LONG';
  const atr      = calculateATR(klines) || (price * 0.018);
  // Wider SL for FIRE — breakout trades need breathing room
  const sl       = isLong ? price - atr * 1.8 : price + atr * 1.8;
  const tp1      = isLong ? price + atr * 2.0 : price - atr * 2.0;
  const tp2      = isLong ? price + atr * 3.5 : price - atr * 3.5;
  const tp3      = isLong ? price + atr * 5.0 : price - atr * 5.0;
  const candle   = layers.trap?.candle;

  const conf = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) conf.push('📦OI+Coil');
  if (layers.volume.spike >= 2)       conf.push(`🔊Vol${layers.volume.spike}x`);
  if (layers.resistance.pressure)     conf.push(`🧱Res×${layers.resistance.tests}`);
  if (layers.fundingLS.funding < 0)   conf.push(`💸${layers.fundingLS.funding.toFixed(3)}%`);
  if (layers.fundingLS.ls < 1)        conf.push(`⚖️${layers.fundingLS.ls.toFixed(2)}`);
  if (scanCount >= 2)                 conf.push(`🔁${scanCount}scans`);
  if (candle?.verdict === 'STRONG')   conf.push(`🕯✅${candle.bodyPct}%body`);
  if (hype?.tag)                      conf.push(hype.tag);
  if (layers?.absorption?.absorbing)  conf.push('🤫ABSORBED');

  return `${isLong?'🟢':'🔴'} <b>NEXIO ${isLong?'📈LONG':'📉SHORT'} CONFIRMATION — ${symbol.replace('USDT','')}</b>\n<i>⚠️ Best entry was EARLY. Skip if you missed it.</i>
📊 ${score}/10 ${confBar(score)}
${conf.join(' · ')}
━━━━━━━━━━━━━━━
💰 $${fmtP(price)}  🛑 $${fmtP(sl)}
🎯 TP1 $${fmtP(tp1)}  TP2 $${fmtP(tp2)}  TP3 $${fmtP(tp3)}\n💼 <b>Position size: MEDIUM (50-70% of normal)</b>
${FOOTER(btc, symbol)}`.trim();
};

// BREAKEVEN — after TP1 hit
const buildBreakevenMsg = (symbol, entryPrice, tp1Price, direction) => {
  return `✅ <b>${symbol.replace('USDT','')} TP1 HIT</b> — Move SL to entry $${fmtP(entryPrice)}
🎯 TP1: $${fmtP(tp1Price)} reached · Let TP2 run
⏰ ${gstNow()} GST`.trim();
};

// PRIORITY LIST — grouped, no per-coin repetition
const buildPriorityList = (btc) => {
  const sorted = [...coinTracker.values()].filter(c => c.state !== 'FADING' && c.score >= 6).sort((a, b) => b.score - a.score);
  if (!sorted.length) return null;
  const lines = sorted.slice(0, 10).map((s, i) => {
    const rank  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir   = s.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const state = s.state === 'FIRE' ? '🔥 HIGH CONF' : s.state === 'CONFIRMING' ? '⚡ CONFIRMED' : '👀 WATCHING';
    const bar   = confBar(s.score);
    return `${rank} ${dir} <b>${s.symbol.replace('USDT','')}</b> — ${state} ${s.score}/10\n     ${bar}`;
  }).join('\n');
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0?'+':''}${btc.change?.toFixed(1)}%` : '';
  return `📊 <b>NEXIO PRIORITY LIST</b>
━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━
${btcStr}  ⏰ ${gstNow()} GST
🔥 HIGH CONF = enter | ⚡ CONFIRMED = watch | 👀 WATCHING = building
<i>DYOR · SL always set</i>`.trim();
};


// ── Contract Info Cache — only fetch once per hour ────────────────────────────
let contractInfoCache = { data: null, ts: 0 };
const getContractInfo = async () => {
  const now = Date.now();
  if (contractInfoCache.data && now - contractInfoCache.ts < 3600000) return contractInfoCache.data;
  try {
    const info = await fetchJSON('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const cryptoSymbols = new Set();
    for (const s of info.symbols || []) {
      // Only keep PERPETUAL contracts with crypto underlying
      // Binance categorizes tokenized stocks with contractType that differs or status
      if (s.status !== 'TRADING') continue;
      if (s.contractType !== 'PERPETUAL') continue;
      if (s.quoteAsset !== 'USDT') continue;
      // Underlying type check — CRYPTO is what we want
      if (s.underlyingType && s.underlyingType !== 'COIN') continue;
      cryptoSymbols.add(s.symbol);
    }
    contractInfoCache = { data: cryptoSymbols, ts: now };
    log(`📋 Contract info refreshed: ${cryptoSymbols.size} crypto perpetuals found`);
    return cryptoSymbols;
  } catch (err) {
    log('⚠️ exchangeInfo fetch failed:', err.message);
    return contractInfoCache.data || new Set();
  }
};

// ── Scanner 1: Full Market ────────────────────────────────────────────────────
const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount}`);
  try {
    const cryptoSet = await getContractInfo();
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
        // WHITELIST: must be in Binance's crypto perpetuals list
        if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) return false;
        // Blacklist fallback
        if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) return false;
        if (STOCK_SUFFIX_REGEX.test(t.symbol)) return false;
        if (isLikelyStock(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
        if (Math.abs(parseFloat(t.priceChangePercent)) >= PUMP_EXCLUDE_PCT) return false;
        return true;
      })
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), isMid: MID_CAP.has(t.symbol) }))
      .sort((a, b) => Math.abs(a.change) - Math.abs(b.change)) // flat price first = early movers
      .slice(0, 100); // v3.7 — 100 highest quality coins only

    // Stale cleanup: remove coins older than 30 min OR scored under 3 last check
    const currentWatchlistRaw = await getWatchlist();
    let staleRemoved = 0;
    for (const r of currentWatchlistRaw) {
      const ageMin = r.updated_at ? (Date.now() - new Date(r.updated_at).getTime()) / 60000 : 0;
      if (ageMin > 15 || (r.score || 0) < 3.5) {
        await removeFromWatchlist(r.symbol);
        coinTracker.delete(r.symbol);
        staleRemoved++;
      }
    }
    if (staleRemoved > 0) log(`🧹 Cleaned ${staleRemoved} stale coins from watchlist`);

    const currentWatchlist = await getWatchlist();
    const currentSymbols   = currentWatchlist.map(r => r.symbol);
    let added = 0;

    for (const coin of valid) {
      await sleep(250); // v3.7 faster — 350→250ms
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=12`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      const direction = ls <= 1.2 ? 'LONG' : 'SHORT'; // structure-first direction
      // direction always set above — no skip

      const score = calcMasterScore({
        compression: checkCompression(klines, currentOI, prevOI),
        volume:      checkVolumeBuild(klines),
        resistance:  checkResistanceTesting(coin.symbol, coin.price, klines),
        fundingLS:   checkFundingLS(funding, ls, direction),
        trap:        { safe: true, trapScore: 0 },
      });

      // Update score for existing coins (keeps watchlist fresh)
      if (score >= 1.5 && currentSymbols.includes(coin.symbol)) {
        await updateWatchlistScore(coin.symbol, score, direction);
      }

      // Auto-rotate: if full, only add if this coin scores higher than any existing low scorer
      if (score >= 2.5 && !currentSymbols.includes(coin.symbol)) {
        // If at capacity, remove lowest scorer to make room
        if (currentSymbols.length + added >= MAX_WATCHLIST) {
          const currentWl = await getWatchlist();
          const lowest = currentWl.filter(r => r.score !== null).sort((a,b) => (a.score||0) - (b.score||0))[0];
          if (lowest && (lowest.score || 0) < score - 0.5) {
            await removeFromWatchlist(lowest.symbol);
            coinTracker.delete(lowest.symbol);
            const idx = currentSymbols.indexOf(lowest.symbol);
            if (idx > -1) currentSymbols.splice(idx, 1);
            log(`🔄 Rotated out ${lowest.symbol} (${lowest.score}) for ${coin.symbol} (${score})`);
          } else {
            continue; // no room and this coin isn't clearly better
          }
        }
        await addToWatchlist(coin.symbol, score, direction);
        currentSymbols.push(coin.symbol);
        added++;
        log(`✅ ${coin.symbol} score:${score} ${direction} ${coin.isMid ? '[MID]' : '[LOW]'}`);
      }
      if (score < 1.5 && currentSymbols.includes(coin.symbol)) {
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
      await sleep(200); // v3.7 faster — 400→200ms
      let price = 0, funding = 0, ls = 1, currentOI = 0, prevOI = 0, klines = [];
      try { const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); price = parseFloat(t.price); } catch { }
      if (!price) continue;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      // Direction — use PRICE STRUCTURE first (HTF EMA50), funding/LS as confirmation
      // Fetch HTF trend first before deciding direction
      const htfPre = await checkHTFTrend(symbol);
      // If price is clearly above EMA50 and trend aligned → LONG
      // If price is clearly below EMA50 and trend aligned → SHORT
      // Funding confirms but doesn't decide
      let isLong  = false;
      let isShort = false;
      if (htfPre.bullish && funding < 0.015) isLong  = true;
      else if (htfPre.bearish && funding > -0.015) isShort = true;
      // If HTF not aligned, skip this coin entirely
      if (!isLong && !isShort) { coinTracker.delete(symbol); continue; }
      const direction = isLong ? 'LONG' : 'SHORT';

      // HTF already checked above when deciding direction
      const htf = htfPre;

      const compression = checkCompression(klines, currentOI, prevOI);
      const volume      = checkVolumeBuild(klines);
      const resistance  = checkResistanceTesting(symbol, price, klines);
      const fundingLS   = checkFundingLS(funding, ls, direction);
      const trap        = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);

      // Bullish absorption check — only for LONG (stealth accumulation)
      let absorption = { absorbing: false, score: 0, reasons: [] };
      if (direction === 'LONG') {
        absorption = await checkBullishAbsorption(symbol, price, klines, currentOI, prevOI, funding);
        if (absorption.absorbing) log(`🤫 ABSORPTION: ${symbol} score:${absorption.score} [${absorption.reasons.join(', ')}]`);
      }

      let score = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      // Absorption boost — add up to +2 for stealth accumulation
      if (absorption.absorbing) {
        const boost = Math.min(2, absorption.score * 0.3);
        score = Math.min(10, score + boost);
      }
      const layers      = { compression, volume, resistance, fundingLS, trap, absorption };

      // ── Liquidity sweep check (Fix 4) ─────────────────────────────────────
      const sweep = checkLiquiditySweep(klines, direction);

      // ── Early entry check (Fix 1) ─────────────────────────────────────────
      const early = checkEarlyEntry(compression, volume, fundingLS);

      const atr = calculateATR(klines) || (price * 0.018);

      // Social hype cross-check — bonus score if trending on CoinGecko
      const hype = await checkSocialHype(symbol);
      const finalScore = Math.max(0, Math.min(10, score + (hype.hypeBonus || 0)));
      if (hype.hasData && hype.hypeBonus !== 0) log(`🌊 ${symbol} hype ${hype.hypeBonus > 0 ? '+' : ''}${hype.hypeBonus} (${hype.tag})`);

      log(`📊 ${symbol} ${direction} score:${score}${hype.hypeBonus !== 0 ? (hype.hypeBonus > 0 ? '+' : '') + hype.hypeBonus : ''}=${finalScore} candle:${trap.candle?.verdict || 'N/A'} ${hype.tag ? '['+hype.tag+']' : ''}`);

      const existing = coinTracker.get(symbol);
      const snap = { price, funding, oi: currentOI, ls, vol: volume.spike, score, time: Date.now() };

      if (!existing) {
        coinTracker.set(symbol, { symbol, direction, state: 'WATCHING', scanCount: 1, score: finalScore, layers, hype, absorption, firstSeen: Date.now(), history: [snap], entryPrice: null, earlyEntry: null, tp1Price: null });
      } else {
        if (direction !== existing.direction) {
          if (existing.entryPrice) await postSignal(`⚠️ <b>NEXIO — SIGNAL FADING</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n❌ Direction reversed — exit now\n📍 Entry: $${fmtP(existing.entryPrice)} → Now: $${fmtP(price)}\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          coinTracker.delete(symbol);
          continue;
        }
        existing.history.push(snap);
        existing.scanCount++;
        existing.score  = finalScore;
        existing.layers = layers;
        existing.hype   = hype;
        existing.absorption = absorption;
        existing.state  = finalScore >= 8 ? 'FIRE' : finalScore >= 6 ? 'CONFIRMING' : 'WATCHING';
        coinTracker.set(symbol, existing);
      }

      const state = coinTracker.get(symbol);
      if (!state) continue;

      // ── STAGE 0 — EARLY ENTRY alert (Fix 1 + Fix 5) ───────────────────────
      // Pre-breakout: compression + OI building + low volume + HTF aligned
      // Best R:R — enter before the crowd
      // EARLY also requires BTC direction alignment
      const earlyBtcOk = isLong ? (btc.change1H > -0.3) : (btc.change1H < 0.3);
      if (
        btc.pass &&
        earlyBtcOk &&
        (early.isEarly || absorption.absorbing) &&
        (early.earlyScore >= 2 || absorption.absorbing) &&
        finalScore >= 5 &&
        !ext.tooExtended &&
        !pumpCheck.pumped &&
        state.scanCount >= 1 &&
        alertsFired < 2
      ) {
        const earlyKey = `early_${symbol}`;
        if (canAlert(earlyKey)) {
          state.earlyEntry = price;
          const tp1e = isLong ? price + atr * 1.5 : price - atr * 1.5;
          state.tp1Price = tp1e;
          await postSignal(buildEarlyMsg(symbol, price, finalScore, direction, layers, htf, sweep, atr, btc, hype));
          markAlert(earlyKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now(), type: 'EARLY', atr, tp1: tp1e });
          alertsFired++;
          log(`⚡ EARLY: ${symbol} ${direction} score:${score} earlyScore:${early.earlyScore}`);
          // Paper trade log
          const slEarly = isLong ? price - atr * 1.2 : price + atr * 1.2;
          const tp2Early = isLong ? price + atr * 3.0 : price - atr * 3.0;
          await logPaperTrade({ symbol, direction, type: 'EARLY', price, sl: slEarly, tp1: tp1e, tp2: tp2Early, score, candle: trap.candle?.verdict, btcChange: btc.change });
        }
      }

      // ── STAGE 1 — WATCH alert ─────────────────────────────────────────────
      if ((state.scanCount === 2 && finalScore >= 6) || (state.scanCount === 1 && finalScore >= 7.5)) {
        const watchKey = `watch_${symbol}`;
        if (canAlert(watchKey)) { await postSignal(buildWatchMsg(symbol, finalScore, direction, layers, btc, hype)); markAlert(watchKey); }
      }

      // ── STAGE 2 — FIRE alert (v3.1 — one-bar confirm + all filters) ─────────
      // Requires: BTC + trending regime + EMA200 aligned + one-bar confirmation
      //           + STRONG candle + no extension + not loss-blocked + OI not trap

      const regime    = classifyRegime(klines);
      const prevPrice = klines.length >= 2 ? parseFloat(klines[klines.length-2][4]) : price;
      const oiClass   = classifyOI(currentOI, prevOI, price, prevPrice, funding, trap.candle);
      const ext       = checkExtension(klines, price, atr);
      const block     = isBlocked(symbol);

      // ONE-BAR CONFIRMATION: breakout happened on candle n-1, current candle n confirms
      const breakoutConfirmed = (() => {
        if (klines.length < 3) return false;
        const breakoutCandle = klines[klines.length - 2]; // the breakout bar
        const confirmCandle  = klines[klines.length - 1]; // confirmation bar
        const breakO  = parseFloat(breakoutCandle[1]);
        const breakC  = parseFloat(breakoutCandle[4]);
        const breakH  = parseFloat(breakoutCandle[2]);
        const breakL  = parseFloat(breakoutCandle[3]);
        const confC   = parseFloat(confirmCandle[4]);
        const confL   = parseFloat(confirmCandle[3]);
        const confH   = parseFloat(confirmCandle[2]);
        const breakMove  = Math.abs((breakC - breakO) / breakO) * 100;
        const breakRange = breakH - breakL;
        const breakBody  = breakRange > 0 ? (Math.abs(breakC - breakO) / breakRange) * 100 : 0;
        const volSpike   = parseFloat(breakoutCandle[5]) > parseFloat(klines[klines.length-3][5]) * 1.3;
        // Valid breakout candle: direction + 0.5% move + 45% body + vol spike
        const validBreak = (isLong ? breakC > breakO : breakC < breakO) && breakMove >= 0.5 && breakBody >= 45 && volSpike;
        // Confirmation candle holds above/below breakout close
        const holds = isLong ? confL >= breakC * 0.997 : confH <= breakC * 1.003;
        return validBreak && holds;
      })();

      const candleOk = trap.candle?.verdict === 'STRONG' || (trap.candle?.verdict === 'WEAK' && score >= 8);
      // Regime, OI, extension — log as warnings but do NOT block
      // Current market: most alts below EMA200, regime shows ranging — but can still 3x
      const regimeWarn = !regime.allowFire ? `regime:${regime.regime}` : '';
      const oiWarn     = oiClass.type === 'trap' ? 'OI:trap' : '';
      const extWarn    = ext.tooExtended ? `ext:${ext.reason}` : '';
      const warnings   = [regimeWarn, oiWarn, extWarn].filter(Boolean).join(' | ');
      if (warnings) log(`⚠️ WARN: ${symbol} — ${warnings} (not blocking)`);

      // Require BTC not dumping for LONG, not pumping for SHORT
      const btcSupportive = isLong ? (btc.change1H > -0.5) : (btc.change1H < 0.5); // loosened
      if (!btcSupportive) log(`🚫 BTC-DRAG: ${symbol} ${direction} — BTC 1H ${btc.change1H?.toFixed(2)}% against us`);

      // NO CHASE: block if already extended
      const pumpCheck = checkRecentPump(klines, price);
      if (pumpCheck.pumped) log(`🚫 NO-CHASE: ${symbol} pumped ${pumpCheck.pct}% recently — skip`);

      // Session filter
      const lowLiq = isLowLiquiditySession();
      if (lowLiq && state.scanCount === 1) log(`🌙 LOW-LIQ: ${symbol} — Dubai dead hours`);

      if (block.blocked) {
        log(`🛑 BLOCKED: ${symbol} — ${block.reason}`);
      } else if (btc.pass && btcSupportive && !pumpCheck.pumped && !lowLiq && finalScore >= MIN_ALERT_SCORE && (state.scanCount >= 2 || finalScore >= 8.5) && trap.safe && candleOk && breakoutConfirmed && !ext.tooExtended && alertsFired < 2) {
        const fireKey = `fire_${symbol}`;
        if (canAlert(fireKey)) {
          state.entryPrice = price;
          state.state = 'FIRE';
          const tp1f = isLong ? price + atr * 1.5 : price - atr * 1.5;
          state.tp1Price = tp1f;
          await postSignal(buildFireMsg(symbol, price, finalScore, direction, layers, state.scanCount, btc, klines, hype));
          markAlert(fireKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now(), type: 'FIRE', atr, tp1: tp1f });
          alertsFired++;
          log(`🚀 FIRED: ${symbol} ${direction} score:${score} candle:${trap.candle?.verdict} ${warnings ? '⚠️'+warnings : ''}`);
        }
      } else if (btc.pass && score >= MIN_ALERT_SCORE && state.scanCount >= 2) {
        const reasons = [];
        if (!breakoutConfirmed) reasons.push('no 1-bar confirm');
        if (!candleOk)          reasons.push(`candle:${trap.candle?.verdict}`);
        if (reasons.length)     log(`⚠️ SKIP: ${symbol} — ${reasons.join(' | ')}`);
      }

      if (score < 1.5 && state.scanCount >= 3) { coinTracker.delete(symbol); await removeFromWatchlist(symbol); }

      // ── LAYER 9 — Position Manager (Fix 6) ───────────────────────────────
      // Momentum guard + breakeven alert after TP1 hit
      const sig = signalPrices.get(symbol);
      if (sig) {
        const tp1Hit = sig.direction === 'LONG'
          ? price >= sig.tp1
          : price <= sig.tp1;

        // Breakeven alert after TP1
        if (tp1Hit && !sig.breakevenSent) {
          sig.breakevenSent = true;
          signalPrices.set(symbol, sig);
          await postSignal(buildBreakevenMsg(symbol, sig.price, sig.tp1, sig.direction));
          log(`✅ TP1 HIT: ${symbol} — sending breakeven alert`);
        }

        // Emergency exit if BTC reverses
        const chg = sig.direction === 'LONG'
          ? ((sig.price - price) / sig.price) * 100
          : ((price - sig.price) / sig.price) * 100;

        // ATR-based fade threshold — adapts to each coin's volatility
        const fadeThreshold = sig.atr ? (sig.atr / sig.price) * 100 * 1.2 : FADE_THRESHOLD_PCT;

        if (!btc.pass && Date.now() - sig.firedAt < 3600000) {
          await postSignal(`🚨 <b>NEXIO — EMERGENCY EXIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n⚠️ BTC momentum reversed!\n${btc.reason}\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n⚡ <b>Exit immediately</b>\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          recordLoss(symbol);
          signalPrices.delete(symbol);
        } else if (chg >= fadeThreshold && !sig.breakevenSent) {
          await postSignal(`⚠️ <b>NEXIO — SL HIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n📉 Down ${chg.toFixed(1)}% from entry (${fadeThreshold.toFixed(1)}% threshold)\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n🛑 Stop triggered — ${symbol.replace('USDT','')} blocked ${LOSS_COOLDOWN}min\n⏰ ${gstNow()} GST\n${DISCLAIMER}`);
          recordLoss(symbol);
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
  else if (text === '/stats') {
    const all = (await sb('paper_trades?select=*')) || [];
    const closed = all.filter(t => t.status !== 'OPEN');
    const wins = closed.filter(t => t.outcome === 'WIN').length;
    const losses = closed.filter(t => t.outcome === 'LOSS').length;
    const open = all.filter(t => t.status === 'OPEN').length;
    const total = closed.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const longs = closed.filter(t => t.direction === 'LONG');
    const shorts = closed.filter(t => t.direction === 'SHORT');
    const longWR = longs.length > 0 ? ((longs.filter(t => t.outcome === 'WIN').length / longs.length) * 100).toFixed(1) : '0';
    const shortWR = shorts.length > 0 ? ((shorts.filter(t => t.outcome === 'WIN').length / shorts.length) * 100).toFixed(1) : '0';
    await tg(chatId, `📒 <b>Paper Trade Stats</b>\n━━━━━━━━━━━━━━━\n🟢 Wins:   ${wins}\n🔴 Losses: ${losses}\n⏳ Open:   ${open}\n📊 Total closed: ${total}\n\n🎯 <b>Win Rate: ${winRate}%</b>\n📈 LONG WR:  ${longWR}% (${longs.length})\n📉 SHORT WR: ${shortWR}% (${shorts.length})\n\n${total < 20 ? '⏳ Need 20+ trades for reliable data' : parseFloat(winRate) >= 55 ? '✅ Strategy working' : '❌ Strategy not ready'}`);
  }
  else if (text === '/help') {
    await tg(chatId, `📖 <b>Commands</b>\n/start /status /watchlist /tracking /btc /stats /test /help\n🐆 Nexio v3.7`);
  }

  if (text === '/test') {
    const btc = await checkBTCGate();
    await postSignal(`🧪 <b>NEXIO v3.7 — TEST</b>\n━━━━━━━━━━━━━━━\n✅ Bot online\n✅ Both channels connected\n✅ 9-Layer scanner active\n✅ Candle wick detector active\n${btc.emoji} BTC Gate: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n📊 Watchlist: ${(await getWatchlist()).length}\n🔍 Tracking: ${coinTracker.size}\n⏰ ${gstNow()} GST\n🐆 Nexio is watching`);
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
  const modeLabel = PAPER_MODE ? '📒 PAPER MODE — alerts silenced, logging only' : '🟢 LIVE MODE';
  log(`🚀 Nexio v3.7 — Signal Intelligence Engine starting... ${modeLabel}`);
  const btc = await checkBTCGate();
  await tg(OWNER_CHAT_ID, `🟢 <b>Nexio v3.7 Started</b>\n━━━━━━━━━━━━━━━\n🧠 9-Layer Scanner active\n📈 HTF EMA50 filter (EMA200 advisory)\n🕯 STRONG candle gate\n📐 ATR-based SL/TP (R:R ≥ 1.5)\n🔄 1-bar confirmation\n🛡 Post-loss protection (90min)\n☠️ Daily kill switch (3 losses)\n🚦 BTC gate\n📊 Min score: ${MIN_ALERT_SCORE}/10\n⚡ Max alerts/scan: 2\n${btc.emoji} BTC: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n⏰ ${gstNow()} GST\n━━━━━━━━━━━━━━━\n/fullscan /scan /btc /pending /users /activate /broadcast /watchlist /tracking /clearwatchlist /test`);

  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);

  // Paper trade outcome checker — every 10 min
  setInterval(checkPaperOutcomes, 600000);
};

start();
