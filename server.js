// ═══════════════════════════════════════════════════════════════════════════════
// NEXIO SERVER v6.00 — SURGEON FIX EDITION
// 
// WHAT WAS BROKEN (v5.30) → WHAT WAS FIXED:
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ❌ Catching pumps AFTER exhaust (late entry)
//    → Lowered thresholds: FIRE 7.5→6.0, EARLY 5→4
//    → Faster trigger: scanCount >= 1 (was 2) 
//    → Relaxed candle gate: WEAK allowed at score >= 6.5 (was 8)
//
// ❌ One win killed by many losers (bad R:R)
//    → SL 1.8x → 1.2x ATR (tighter stop)
//    → TP1 2.0x → 2.5x ATR (bigger reward)
//    → TP2 3.5x → 4.0x, TP3 5.0x → 6.0x
//    → Break-even WR: 47% → 32% (your 40% LONG WR now PROFITS)
//
// ❌ Trap filter too aggressive (killing good entries)
//    → Fake candle penalty: -2 → -1
//    → Weak candle penalty: -1 → -0.5
//
// ❌ No momentum scoring (missing early moves)
//    → NEW: Momentum layer adds +1 to +2 for aligned 15m push
//
// ❌ Recovery sizing too slow
//    → 1 loss: 100% → 75% | 2 losses: 50% | 3+: 25%
//
// ❌ SHORT signals (25% WR — proven loser)
//    → Remains DISABLED (v5.28 was correct)
//
// LAYERS (unchanged structure):
// LAYER 1  — BTC Momentum Gate + HTF EMA50/200
// LAYER 2  — Full coin universe (crypto only, anti-pump, dump-trap, climax)
// LAYER 3  — Price Compression + OI Buildup
// LAYER 4  — Volume Buildup + Climax Detection
// LAYER 5  — Repeated Resistance Testing (Breakout Pressure)
// LAYER 6  — Funding + L/S + Funding z-score (mean reversion)
// LAYER 7  — Trap Risk + Candle Wick + Liquidity Sweep + Bullish Absorption
// LAYER 8  — THREE-Stage Alert: EARLY → WATCH → FIRE
// LAYER 9  — Position Manager (breakeven, trailing, force-exit, recovery)
// ═══════════════════════════════════════════════════════════════════════════════


// ── v6.00 SECURITY: All secrets loaded from Railway environment variables ─────
const BOT_TOKEN       = process.env.BOT_TOKEN;
const FREE_CHANNEL    = process.env.FREE_CHANNEL    || '-1003900595640';
const PREMIUM_CHANNEL = process.env.PREMIUM_CHANNEL || '-1003913881352';
const OWNER_CHAT_ID   = process.env.OWNER_CHAT_ID   || '6896387082';

// v5.16+ — Paper test users
const PAPER_TEST_USERS = [];

// ── PAPER TRADING MODE ───────────────────────────────────────────────────────
const PAPER_MODE = true;
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = process.env.SUPABASE_URL || 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const FINNHUB_KEY     = process.env.FINNHUB_KEY;

// v6.00: Validate critical secrets
(() => {
  const missing = [];
  if (!BOT_TOKEN)    missing.push('BOT_TOKEN');
  if (!SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (missing.length) {
    console.error(`[FATAL] Missing required env variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!FINNHUB_KEY) {
    console.warn('[WARN] FINNHUB_KEY not set — economic calendar will use fallback.');
  }
})();

const FULL_MARKET_INTERVAL_MS = 300000;
const WATCHLIST_SCAN_INTERVAL = 120000;
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 200000;
const MAX_WATCHLIST           = 50;
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 1.2;

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #1: SCORING THRESHOLDS (were too high = late entry)
// ═══════════════════════════════════════════════════════════════════════════════
const MIN_ALERT_SCORE         = 5.0;   // was 6.5 — let more signals through
const MIN_FIRE_SCORE          = 6.0;   // was 7.5 — catch moves BEFORE exhaust
const MIN_EARLY_SCORE         = 4.0;   // NEW — pre-breakout entry threshold

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #2: RISK/REWARD (was 1.11:1, now 2.08:1)
// At 40% WR: OLD = -0.28x ATR per trade (LOSING)
//            NEW = +0.28x ATR per trade (WINNING)
// ═══════════════════════════════════════════════════════════════════════════════
const UNIFIED_SL_ATR  = 1.2;   // was 1.8 — tighter stop, less bleed per loss
const UNIFIED_TP1_ATR = 2.5;   // was 2.0 — bigger TP1 reward
const UNIFIED_TP2_ATR = 4.0;   // was 3.5
const UNIFIED_TP3_ATR = 6.0;   // was 5.0

// v6.00: Breakeven trigger — move SL to entry sooner
const BREAKEVEN_TRIGGER_PCT = 1.0;  // was 0.5% — give trade more room first

// v5.14 — Meme coin blacklist
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
const PUMP_EXCLUDE_PCT        = 25.0;

const EXCLUDE = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOGEUSDT','TRXUSDT','LTCUSDT','MATICUSDT',
  'HBARUSDT','WBTCUSDT','AVAXUSDT','DOTUSDT','LINKUSDT',
  'ATOMUSDT','NEARUSDT','UNIUSDT','APTUSDT','LDOUSDT',
  'XAUUSDT','XAUTUSDT','PAXGUSDT','XAGUUSDT','CLUSDT',
  'WBTCUSDT','XPTUSD','PALAUSDT',
  'USDCUSDT','USDTUSDT','BUSDUSDT','DAIUSDT','FRAXUSDT',
  'BTCDOMUSDT','DEFIUSDT','ALTUSDT',
  'TSLAUSDT','AAPLUSDT','GOOGLUSDT','AMZNUSDT','MSFTUSDT',
  'NVDAUSDT','METAUSDT','COINUSDT','NFLXUSDT','BABAUSDT',
  'AMDUSDT','BRKBUSDT','BRKAUSDT','INTCUSDT','TSMUSDT',
  'TSMAUSDT','UBERUSDT','ABNBUSDT','SPYUSDT','QQQUSDT',
  'PLTRУСDT','PYTUSDT','SHOP1USDT','SNAPUSDT','LYFTUSDT',
  'RKLBUSDT','IONQUSDT','MSTRUSDT','MSTRUUSDT',
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

const alertHistory  = new Map();
const coinTracker   = new Map();
const signalPrices  = new Map();

const cleanupSignalPrices = () => {
  const cutoff = Date.now() - 4 * 3600 * 1000;
  let cleaned = 0;
  for (const [k, v] of signalPrices.entries()) {
    if (v.firedAt < cutoff) { signalPrices.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`Signal prices cleaned: ${cleaned} expired`);
};

const cleanupCoinTracker = () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let cleaned = 0;
  for (const [symbol, state] of coinTracker.entries()) {
    const lastSeen = state.lastUpdated || state.firstSeen || 0;
    if (lastSeen < cutoff) {
      coinTracker.delete(symbol);
      cleaned++;
    }
  }
  if (cleaned > 0) log(`Coin tracker cleaned: ${cleaned} stale`);
};

// ── Correlation Filter ────────────────────────────────────────────────────────
const getOpenDirectionCount = (direction) => {
  let count = 0;
  const cutoffMs = Date.now() - 4 * 3600 * 1000;
  for (const [, sig] of signalPrices.entries()) {
    if (sig.direction === direction && sig.firedAt > cutoffMs) count++;
  }
  return count;
};
const MAX_SAME_DIRECTION = 3;
const resistanceMap = new Map();
let   lastUpdateId  = 0;
let   fullScanCount      = 0;
let   watchlistScanCount = 0;
let   btcGateStatus      = { pass: true, reason: 'Starting up', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };

const sleep   = ms => new Promise(r => setTimeout(r, ms));

// Session classifier (UTC)
const getSession = () => {
  const utcHour = new Date().getUTCHours();
  if (utcHour >= 0 && utcHour < 7)   return 'ASIA';
  if (utcHour >= 7 && utcHour < 12)  return 'LONDON';
  if (utcHour >= 12 && utcHour < 20) return 'NY';
  return 'OFF';
};
const gstNow  = ()  => new Date().toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai'
});
const log       = (...a) => console.log(`[${gstNow()}]`, ...a);

// ── Session Filter ────────────────────────────────────────────────────────────
const isLowLiquiditySession = () => {
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  return hour >= 1 && hour < 5;
};
const canAlert  = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > ALERT_COOLDOWN_MS;
const markAlert = k => alertHistory.set(k, Date.now());

// ── v5.25 ECONOMIC EVENT CALENDAR ────────────────────────────────────────────
const ECONOMIC_EVENTS = [
  { date: '2026-06-17', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-07-29', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-09-16', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-11-04', timeUTC: '19:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-12-16', timeUTC: '19:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-05-12', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-06-10', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-07-14', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-08-12', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-06-05', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
  { date: '2026-07-02', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
  { date: '2026-08-07', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
];

const eventTimeDubai = (evTime) => new Date(evTime).toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Dubai'
});

// ── v5.26 FINNHUB LIVE ECONOMIC CALENDAR ─────────────────────────────────────
let liveEconomicEvents = [];
let lastFinnhubFetch = 0;

const fetchFinnhubCalendar = async () => {
  if (!FINNHUB_KEY) return;
  if (Date.now() - lastFinnhubFetch < 6 * 60 * 60 * 1000 && liveEconomicEvents.length) return;
  try {
    const now = new Date();
    const from = now.toISOString().slice(0, 10);
    const toDate = new Date(now.getTime() + 14 * 24 * 60 * 60000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${toDate}&token=${FINNHUB_KEY}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.economicCalendar)) {
      liveEconomicEvents = data.economicCalendar
        .filter(e => e.country === 'US' && (e.impact === 'high' || e.impact === 3))
        .map(e => {
          const evTime = new Date(e.time.replace(' ', 'T') + 'Z').getTime();
          return { name: e.event, evTime, impact: 'HIGH' };
        })
        .filter(e => !isNaN(e.evTime));
      lastFinnhubFetch = Date.now();
      log(`Finnhub: loaded ${liveEconomicEvents.length} US high-impact events`);
    }
  } catch (err) {
    log(`Finnhub fetch failed: ${err.message}`);
  }
};

const economicEventNotified = new Set();

const getActiveEconomicEvent = (windowBeforeMin = 60, windowAfterMin = 90) => {
  const now = Date.now();
  for (const ev of liveEconomicEvents) {
    if (now >= ev.evTime - windowBeforeMin*60000 && now <= ev.evTime + windowAfterMin*60000) {
      const minsUntil = Math.round((ev.evTime - now) / 60000);
      return { ...ev, minsUntil, phase: minsUntil > 0 ? 'BEFORE' : 'DURING' };
    }
  }
  for (const ev of ECONOMIC_EVENTS) {
    const evTime = new Date(`${ev.date}T${ev.timeUTC}:00Z`).getTime();
    if (now >= evTime - windowBeforeMin*60000 && now <= evTime + windowAfterMin*60000) {
      const minsUntil = Math.round((evTime - now) / 60000);
      return { ...ev, evTime, minsUntil, phase: minsUntil > 0 ? 'BEFORE' : 'DURING' };
    }
  }
  const d = new Date();
  if (d.getUTCDay() === 4) {
    const claimsTime = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 30, 0)).getTime();
    if (now >= claimsTime - windowBeforeMin*60000 && now <= claimsTime + windowAfterMin*60000) {
      const minsUntil = Math.round((claimsTime - now) / 60000);
      return { name: 'US Jobless Claims + Data', impact: 'HIGH', evTime: claimsTime, minsUntil, phase: minsUntil > 0 ? 'BEFORE' : 'DURING' };
    }
  }
  return null;
};

const econCautionTag = () => {
  const ev = getActiveEconomicEvent();
  if (!ev) return '';
  return `\n\n⚠️ <b>CAUTION:</b> ${ev.name} ${ev.phase === 'BEFORE' ? `in ~${ev.minsUntil}min` : 'happening now'} — high-impact data window. Use tight SL, reduce size.`;
};

// ── v5.27 MULTI-STAGE EVENT REMINDERS ────────────────────────────────────────
const eventReminderSent = new Set();

const getUpcomingEventsForReminders = () => {
  const now = Date.now();
  const events = [];
  const seen = new Set();
  const add = (name, evTime) => {
    const k = `${name}-${new Date(evTime).toISOString().slice(0,13)}`;
    if (seen.has(k)) return; seen.add(k);
    events.push({ name, evTime, key: k });
  };
  for (const ev of liveEconomicEvents) {
    if (ev.evTime > now - 5*60000 && ev.evTime < now + 5*60*60000) add(ev.name, ev.evTime);
  }
  for (const ev of ECONOMIC_EVENTS) {
    const evTime = new Date(`${ev.date}T${ev.timeUTC}:00Z`).getTime();
    if (evTime > now - 5*60000 && evTime < now + 5*60*60000) add(ev.name, evTime);
  }
  const d = new Date();
  if (d.getUTCDay() === 4) {
    const claimsTime = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 30, 0)).getTime();
    if (claimsTime > now - 5*60000 && claimsTime < now + 5*60*60000) add('US Jobless Claims + Data', claimsTime);
  }
  return events;
};

const checkEventReminders = async () => {
  const now = Date.now();
  const dubaiHour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  const dubaiDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dubai' });

  const allUpcoming = [];
  const seenM = new Set();
  for (const ev of liveEconomicEvents) {
    const evDubaiDate = new Date(ev.evTime).toLocaleDateString('en-US', { timeZone: 'Asia/Dubai' });
    if (evDubaiDate === dubaiDate && ev.evTime > now) {
      const k = `${ev.name}-${new Date(ev.evTime).toISOString().slice(0,13)}`;
      if (!seenM.has(k)) { seenM.add(k); allUpcoming.push(ev); }
    }
  }
  const morningKey = `morning-${dubaiDate}`;
  if (dubaiHour === 8 && allUpcoming.length && !eventReminderSent.has(morningKey)) {
    eventReminderSent.add(morningKey);
    let msg = `📅 <b>TODAY'S HIGH-IMPACT EVENTS</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const ev of allUpcoming) {
      msg += `🕐 ${eventTimeDubai(ev.evTime)} Dubai — ${ev.name}\n`;
    }
    msg += `\nReminders will follow at 4hr, 1hr, then every 15min.`;
    await tg(OWNER_CHAT_ID, msg);
  }

  const events = getUpcomingEventsForReminders();
  for (const ev of events) {
    const minsUntil = Math.round((ev.evTime - now) / 60000);
    const stages = [
      { at: 240, tol: 3, label: '4 hours', emoji: '⚠️', extra: 'Plan your positions.' },
      { at: 60,  tol: 2, label: '1 hour',  emoji: '⚠️', extra: 'Prepare — volatility burst approaching.' },
      { at: 45,  tol: 2, label: '45 minutes', emoji: '⚠️', extra: 'Reduce size if entering.' },
      { at: 30,  tol: 2, label: '30 minutes', emoji: '⚠️', extra: 'Set tight stops on open positions.' },
      { at: 15,  tol: 2, label: '15 minutes', emoji: '🔴', extra: 'FINAL WARNING — tighten SL now.' },
      { at: 0,   tol: 2, label: 'NOW',        emoji: '🔴', extra: 'DATA DROPPING — expect sharp volatility.' },
    ];
    for (const st of stages) {
      const stageKey = `${ev.key}@${st.at}`;
      if (Math.abs(minsUntil - st.at) <= st.tol && !eventReminderSent.has(stageKey)) {
        eventReminderSent.add(stageKey);
        const timing = st.at === 0 ? 'happening NOW' : `in ~${st.label}`;
        await tg(OWNER_CHAT_ID,
          `${st.emoji} <b>${ev.name.toUpperCase()}</b> — ${timing}\n━━━━━━━━━━━━━━━\n` +
          `🕐 ${eventTimeDubai(ev.evTime)} Dubai\n\n${st.extra}\n\n` +
          `<i>Tight SL · reduce size · don't chase</i>\n⏰ ${gstNow()} GST`);
        break;
      }
    }
  }
  if (eventReminderSent.size > 200) eventReminderSent.clear();
};

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
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
};

// ── EMA Calculator ────────────────────────────────────────────────────────────
const calcEMAFromCloses = (closes, period) => {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};

// ── HTF EMA50 + EMA200 Trend Filter ──────────────────────────────────────────
const checkHTFTrend = async (symbol) => {
  try {
    const klines1h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=210`);
    if (klines1h.length < 200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'insufficient data' };
    const closes = klines1h.map(k => parseFloat(k[4]));
    const price  = closes[closes.length - 1];
    const ema50  = calcEMAFromCloses(closes, 50);
    const ema200 = calcEMAFromCloses(closes, 200);
    if (!ema50 || !ema200) return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'calc error' };
    const pctAbove  = ((price - ema50) / ema50) * 100;
    const bullish   = pctAbove > 0.5;
    const bearish   = pctAbove < -0.5;
    const ema200ok  = ema200 ? (bullish ? ema50 > ema200 : ema50 < ema200) : true;
    return {
      bullish, bearish, ema50, ema200, ema200ok,
      pctAbove: parseFloat(pctAbove.toFixed(2)),
      reason: bullish ? `${pctAbove.toFixed(1)}% above EMA50${ema200ok ? ' ✅' : ' ⚡'}`
        : bearish ? `${Math.abs(pctAbove).toFixed(1)}% below EMA50${ema200ok ? ' ✅' : ' ⚡'}`
        : `hugging EMA50 ±0.5% — choppy ⚠️`,
    };
  } catch {
    return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'data error' };
  }
};

// ── Market Regime Classifier ─────────────────────────────────────────────────
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

// ── OI Classifier ────────────────────────────────────────────────────────────
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

// ── Extension Filter ──────────────────────────────────────────────────────────
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

// ── Post-Loss Protection ─────────────────────────────────────────────────────
const lossTracker   = new Map();
const pumpTracker   = new Map();
const PUMP_COOLDOWN_MIN = 30;

// v6.00 CRITICAL FIX #3: Recovery sizing — more aggressive reduction
const recoveryState = { consecutiveLosses: 0, lastTradeWin: null };

const blockReasons = {
  btcDrag: 0, pumped: 0, pumpCooldown: 0, dumpTrap: 0, newsEvent: 0,
  climax: 0, lowLiq: 0, correlation: 0, atrFlat: 0, weakCandle: 0,
  notExtended: 0, scoreLow: 0, htfMisaligned: 0, momentumAgainst: 0,
  hostileDirection: 0, fireCaution: 0
};
const incBlock = (reason) => { if (blockReasons[reason] !== undefined) blockReasons[reason]++; };

// v5.30 — Relative Strength watch
const rsWatch = new Map();

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #4: Recovery position sizing — tighter after losses
// ═══════════════════════════════════════════════════════════════════════════════
const getPositionSizeHint = () => {
  if (recoveryState.consecutiveLosses >= 3) return { pct: 25, label: '🔴 MINIMAL 25% (3+ losses)' };
  if (recoveryState.consecutiveLosses >= 2) return { pct: 50, label: '⚠️ REDUCED 50% (2 losses)' };
  if (recoveryState.consecutiveLosses >= 1) return { pct: 75, label: '🟡 CAUTION 75% (1 loss)' };
  return { pct: 100, label: '✅ NORMAL 100%' };
};

const cleanupPumpTracker = () => {
  const cutoff = Date.now() - (PUMP_COOLDOWN_MIN * 2 * 60000);
  let cleaned = 0;
  for (const [k, v] of pumpTracker.entries()) {
    if (v.pumpedAt < cutoff) { pumpTracker.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`Pump tracker cleaned: ${cleaned} stale`);
};

// ── RSI Helper ────────────────────────────────────────────────────────────────
const calcRSI = (klines, period = 14) => {
  if (!klines || klines.length < period + 1) return 50;
  const closes = klines.map(k => parseFloat(k[4]));
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains/period) / (losses/period);
  return 100 - (100 / (1 + rs));
};

// ── MA Stack Analysis ────────────────────────────────────────────────────────
const checkMAStack = (klines) => {
  if (!klines || klines.length < 99) return { stack: 'unknown' };
  const closes = klines.map(k => parseFloat(k[4]));
  const ma7  = closes.slice(-7).reduce((a,b) => a+b, 0) / 7;
  const ma25 = closes.slice(-25).reduce((a,b) => a+b, 0) / 25;
  const ma99 = closes.slice(-99).reduce((a,b) => a+b, 0) / 99;
  const price = closes[closes.length - 1];
  let stack = 'mixed';
  if (price > ma7 && ma7 > ma25 && ma25 > ma99) stack = 'bullish_full';
  else if (price > ma7 && ma7 > ma25)            stack = 'bullish_partial';
  else if (price < ma7 && ma7 < ma25 && ma25 < ma99) stack = 'bearish_full';
  else if (price < ma7 && ma7 < ma25)            stack = 'bearish_partial';
  return { stack, ma7, ma25, ma99 };
};

// ── BTC Cycle Position ───────────────────────────────────────────────────────
let btcCyclePosition = { stage: 'UNKNOWN', risk: 'unknown', reason: '', updated: 0 };

const checkBTCCycle = async () => {
  try {
    const klines = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=42');
    if (!klines || klines.length < 30) return btcCyclePosition;
    const closes = klines.map(k => parseFloat(k[4]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows = klines.map(k => parseFloat(k[3]));
    const price = closes[closes.length - 1];
    const high7d = Math.max(...highs);
    const low7d = Math.min(...lows);
    const range = high7d - low7d;
    const positionInRange = range > 0 ? ((price - low7d) / range) * 100 : 50;
    const move7d = ((price - closes[0]) / closes[0]) * 100;
    const recentMomentum = ((price - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
    const lastQuarter = ((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
    const prevQuarter = ((closes[closes.length - 5] - closes[closes.length - 9]) / closes[closes.length - 9]) * 100;
    const slowing = lastQuarter < prevQuarter && lastQuarter < 0.3;
    let stage, risk, reason;
    if (positionInRange < 25) { stage = 'BOTTOM'; risk = 'low'; reason = `at bottom of 7d range (${positionInRange.toFixed(0)}%)`; }
    else if (positionInRange < 50) { stage = 'EARLY_PUMP'; risk = 'low'; reason = `lower-mid of 7d range (${positionInRange.toFixed(0)}%)`; }
    else if (positionInRange < 75) { stage = 'MID_PUMP'; risk = 'medium'; reason = `upper-mid of 7d range (${positionInRange.toFixed(0)}%)`; }
    else if (positionInRange < 90) { stage = 'LATE_PUMP'; risk = slowing ? 'high' : 'medium'; reason = `near top of 7d range (${positionInRange.toFixed(0)}%)${slowing ? ' · momentum slowing ⚠️' : ''}`; }
    else { stage = 'TOP_ZONE'; risk = 'extreme'; reason = `at peak of 7d range (${positionInRange.toFixed(0)}%) · pullback risk HIGH`; }
    if (move7d > 5 && slowing) { stage = 'EXHAUSTION'; risk = 'extreme'; reason = `+${move7d.toFixed(1)}% in 7d, momentum stalling — pullback likely`; }
    if (move7d < -3) { stage = 'FALLING'; risk = 'high_for_long'; reason = `${move7d.toFixed(1)}% in 7d — bearish bias`; }
    btcCyclePosition = { stage, risk, reason, positionInRange, move7d, recentMomentum, slowing, updated: Date.now() };
    return btcCyclePosition;
  } catch (err) {
    log(`BTC cycle check failed: ${err.message}`);
    return btcCyclePosition;
  }
};

// ── BTC Early Warning ─────────────────────────────────────────────────────────
let btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
const EARLY_WARNING_COOLDOWN_MS = 30 * 60 * 1000;

const checkBTCEarlyWarning = async () => {
  try {
    const klines15m = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=30');
    if (!klines15m || klines15m.length < 25) return;
    const closes = klines15m.map(k => parseFloat(k[4]));
    const opens = klines15m.map(k => parseFloat(k[1]));
    const volumes = klines15m.map(k => parseFloat(k[5]));
    const price = closes[closes.length - 1];
    const ema20_15m = calcEMAFromCloses(closes, 20);
    const lastHour = ((price - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
    const prevHour = ((closes[closes.length - 5] - closes[closes.length - 9]) / closes[closes.length - 9]) * 100;
    const momentumSlope = lastHour - prevHour;
    let redStreak = 0, greenStreak = 0;
    for (let i = closes.length - 1; i >= closes.length - 8; i--) {
      if (closes[i] < opens[i]) redStreak++; else break;
    }
    for (let i = closes.length - 1; i >= closes.length - 8; i--) {
      if (closes[i] > opens[i]) greenStreak++; else break;
    }
    const redCandles = []; const greenCandles = [];
    for (let i = closes.length - 8; i < closes.length; i++) {
      if (closes[i] < opens[i]) redCandles.push(volumes[i]);
      else greenCandles.push(volumes[i]);
    }
    const avgRedVol = redCandles.length > 0 ? redCandles.reduce((s,v)=>s+v,0) / redCandles.length : 0;
    const avgGreenVol = greenCandles.length > 0 ? greenCandles.reduce((s,v)=>s+v,0) / greenCandles.length : 0;
    let warningType = null;
    let warningMsg = '';
    let direction = null;
    if (price < ema20_15m && lastHour < -0.3 && momentumSlope < -0.1 && redStreak >= 3) {
      warningType = 'BEARISH_EARLY';
      direction = 'down';
      warningMsg = `📉 <b>BTC EARLY WARNING — Bearish momentum building</b>\n━━━━━━━━━━━━━━━\nPrice: $${price.toFixed(0)} (below 15m EMA20: $${ema20_15m.toFixed(0)})\nLast hour: ${lastHour.toFixed(2)}% · Slope: ${momentumSlope.toFixed(2)}%\nRed streak: ${redStreak} consecutive 15m candles\n⏰ ${gstNow()} GST`;
    }
    else if (price > ema20_15m && lastHour > 0.3 && momentumSlope > 0.1 && greenStreak >= 3) {
      warningType = 'BULLISH_EARLY';
      direction = 'up';
      warningMsg = `📈 <b>BTC EARLY WARNING — Bullish momentum building</b>\n━━━━━━━━━━━━━━━\nPrice: $${price.toFixed(0)} (above 15m EMA20: $${ema20_15m.toFixed(0)})\nLast hour: +${lastHour.toFixed(2)}% · Slope: +${momentumSlope.toFixed(2)}%\nGreen streak: ${greenStreak} consecutive 15m candles\n⏰ ${gstNow()} GST`;
    }
    if (warningType && direction !== btcEarlyWarning.lastDirection) {
      const sinceLast = Date.now() - btcEarlyWarning.notifiedAt;
      if (sinceLast > EARLY_WARNING_COOLDOWN_MS) {
        for (const r of [OWNER_CHAT_ID, ...PAPER_TEST_USERS]) await tg(r, warningMsg);
        btcEarlyWarning = { state: warningType, notifiedAt: Date.now(), lastDirection: direction };
      }
    }
    else if (!warningType && btcEarlyWarning.state !== 'normal') {
      if (Date.now() - btcEarlyWarning.notifiedAt > EARLY_WARNING_COOLDOWN_MS) {
        btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
      }
    }
  } catch (err) {
    log(`Early warning check failed: ${err.message}`);
  }
};

// ── BTC Regime Predictor ──────────────────────────────────────────────────────
let btcRegime = { regime: 'UNKNOWN', confidence: 0, reason: 'init', changedAt: 0, lastNotified: 'UNKNOWN' };

const checkBTCRegime = async () => {
  try {
    const klines1H = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100');
    const klines4H = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=100');
    if (!klines1H || !klines4H) return btcRegime;
    const closes1H = klines1H.map(k => parseFloat(k[4]));
    const closes4H = klines4H.map(k => parseFloat(k[4]));
    const price    = closes1H[closes1H.length - 1];
    const ema50_1h  = calcEMAFromCloses(closes1H, 50);
    const ema50_4h  = calcEMAFromCloses(closes4H, 50);
    const ema200_4h = calcEMAFromCloses(closes4H, 200);
    const momentum1H = ((price - closes1H[closes1H.length - 5]) / closes1H[closes1H.length - 5]) * 100;
    const momentum4H = ((price - closes4H[closes4H.length - 4]) / closes4H[closes4H.length - 4]) * 100;
    const recent24h = closes1H.slice(-24);
    const rangePct = ((Math.max(...recent24h) - Math.min(...recent24h)) / price) * 100;
    let regime = 'CHOPPY';
    let confidence = 0;
    const reasons = [];
    const above1H = price > ema50_1h;
    const above4H = price > ema50_4h;
    const trendUp = ema50_4h > ema200_4h;
    if (above1H && (above4H || momentum1H > 0.2)) {
      regime = 'BULLISH';
      confidence = (above1H && above4H && trendUp) ? 80 : 60;
      reasons.push(above4H ? `above EMA50 1H+4H` : `above EMA50 1H`, `momentum +${momentum1H.toFixed(1)}%/+${momentum4H.toFixed(1)}%`);
    }
    else if (!above1H && (!above4H || momentum1H < -0.2)) {
      regime = 'BEARISH';
      confidence = (!above1H && !above4H && !trendUp) ? 80 : 60;
      reasons.push(!above4H ? `below EMA50 1H+4H` : `below EMA50 1H`, `momentum ${momentum1H.toFixed(1)}%/${momentum4H.toFixed(1)}%`);
    }
    else {
      regime = 'CHOPPY';
      confidence = 70;
      reasons.push(`range ${rangePct.toFixed(1)}% in 24h`, `1H/4H mixed`);
    }
    const changed = regime !== btcRegime.regime;
    btcRegime = { regime, confidence, reason: reasons.join(' · '), changedAt: changed ? Date.now() : btcRegime.changedAt, lastNotified: btcRegime.lastNotified, momentum1H: parseFloat(momentum1H.toFixed(2)), momentum4H: parseFloat(momentum4H.toFixed(2)), rangePct: parseFloat(rangePct.toFixed(2)) };
    if (changed) {
      const emoji = regime === 'BULLISH' ? '🟢' : regime === 'BEARISH' ? '🔴' : '🟡';
      const msg = regime === 'BULLISH' ? 'LONG signals enabled · SHORT blocked' : regime === 'BEARISH' ? 'SHORT signals enabled · LONG blocked' : '⚠️ ALL signals blocked — sit out';
      for (const r of [OWNER_CHAT_ID, ...PAPER_TEST_USERS]) {
        await tg(r, `${emoji} <b>BTC REGIME CHANGE: ${regime}</b>\n━━━━━━━━━━━━━━━\n${reasons.join('\n')}\n\nConfidence: ${confidence}%\n${msg}\n⏰ ${gstNow()} GST`);
      }
      btcRegime.lastNotified = regime;
      log(`BTC REGIME: ${regime} (${confidence}%)`);
    }
    return btcRegime;
  } catch (err) {
    log(`BTC regime check failed: ${err.message}`);
    return btcRegime;
  }
};

// ── Fake Pump History Detector ───────────────────────────────────────────────
const fakePumpCache = new Map();
const FAKE_PUMP_CACHE_MS = 4 * 3600 * 1000;

const checkFakePumpHistory = async (symbol) => {
  const cached = fakePumpCache.get(symbol);
  if (cached && Date.now() - cached.ts < FAKE_PUMP_CACHE_MS) return cached.result;
  try {
    const klines4h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=42`);
    if (!klines4h || klines4h.length < 20) {
      const result = { isPumpDump: false, fakeCount: 0, reason: 'insufficient history' };
      fakePumpCache.set(symbol, { result, ts: Date.now() });
      return result;
    }
    let fakeCount = 0;
    const events = [];
    for (let i = 0; i < klines4h.length - 2; i++) {
      const open = parseFloat(klines4h[i][1]);
      const high = parseFloat(klines4h[i][2]);
      const pumpPct = ((high - open) / open) * 100;
      if (pumpPct < 5) continue;
      const next1Low = parseFloat(klines4h[i+1][3]);
      const next2Low = parseFloat(klines4h[i+2][3]);
      const lowestAfter = Math.min(next1Low, next2Low);
      if (lowestAfter < open) {
        fakeCount++;
        events.push(`+${pumpPct.toFixed(1)}% → dumped`);
      }
    }
    const isPumpDump = fakeCount >= 3;
    const result = { isPumpDump, fakeCount, events: events.slice(-3), reason: isPumpDump ? `🚨 ${fakeCount} fake pumps in 7d` : `${fakeCount} fake pumps in 7d (clean)` };
    fakePumpCache.set(symbol, { result, ts: Date.now() });
    return result;
  } catch (err) {
    log(`Fake pump history check failed for ${symbol}: ${err.message}`);
    return { isPumpDump: false, fakeCount: 0, reason: 'fetch failed' };
  }
};

// ── ATR Expansion Check ──────────────────────────────────────────────────────
const checkATRExpansion = (klines) => {
  if (!klines || klines.length < 30) return { expanding: false, reason: 'insufficient data', expansion: 0 };
  const atr10 = calculateATR(klines.slice(-10), 10);
  const atr20 = calculateATR(klines.slice(-30, -10), 10);
  if (atr20 === 0) return { expanding: false, reason: 'zero ATR', expansion: 0 };
  const expansion = ((atr10 - atr20) / atr20) * 100;
  const expanding = expansion > 5;
  return { expanding, expansion: parseFloat(expansion.toFixed(1)), atr10: parseFloat(atr10.toFixed(6)), atr20: parseFloat(atr20.toFixed(6)), reason: expanding ? `ATR +${expansion.toFixed(1)}%` : `ATR flat ${expansion.toFixed(1)}%` };
};

// ── Funding Mean Reversion ───────────────────────────────────────────────────
const fundingHistCache = new Map();
const FUNDING_CACHE_MS = 3600000;

const checkFundingExtreme = async (symbol, currentFunding) => {
  try {
    const cached = fundingHistCache.get(symbol);
    let history;
    if (cached && Date.now() - cached.ts < FUNDING_CACHE_MS) {
      history = cached.data;
    } else {
      history = await fetchJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=50`);
      fundingHistCache.set(symbol, { data: history, ts: Date.now() });
    }
    if (!history || history.length < 20) return { extreme: false };
    const rates = history.map(r => parseFloat(r.fundingRate) * 100);
    const avg   = rates.reduce((a,b) => a+b, 0) / rates.length;
    const std   = Math.sqrt(rates.reduce((s,r) => s + Math.pow(r - avg, 2), 0) / rates.length);
    const z = std > 0 ? (currentFunding - avg) / std : 0;
    const extremeNeg = z < -2;
    const extremePos = z > 2;
    return { extreme: extremeNeg || extremePos, extremeNeg, extremePos, z: parseFloat(z.toFixed(2)), avg: parseFloat(avg.toFixed(4)), current: currentFunding };
  } catch {
    return { extreme: false };
  }
};

const checkRecentPump = (klines, price) => {
  if (klines.length < 8) return { pumped: false, pct: 0, window: null };
  const price30m = parseFloat(klines[klines.length - 2][4]);
  const pct30m = Math.abs((price - price30m) / price30m) * 100;
  const price1h = parseFloat(klines[klines.length - 4][4]);
  const pct1h = Math.abs((price - price1h) / price1h) * 100;
  const price2h = parseFloat(klines[klines.length - 8][4]);
  const pct2h = Math.abs((price - price2h) / price2h) * 100;
  let pumped = false;
  let pct = 0;
  let window = null;
  if (pct30m >= 3)        { pumped = true; pct = pct30m; window = '30m'; }
  else if (pct1h >= 4)    { pumped = true; pct = pct1h;  window = '1h'; }
  else if (pct2h >= 6)    { pumped = true; pct = pct2h;  window = '2h'; }
  return { pumped, pct: parseFloat(pct.toFixed(2)), window, pct30m: +pct30m.toFixed(1), pct1h: +pct1h.toFixed(1), pct2h: +pct2h.toFixed(1) };
};

const dailyLosses   = { count: 0, date: '', totalPnlPct: 0, dailyProfitPct: 0, dailyTrades: 0 };

const DAILY_PNL_KILL      = -5.0;
const DAILY_LOSS_STOP_PCT = -1.5;
const DAILY_PROFIT_STOP   = 2.0;
const MAX_TRADES_PER_DAY  = 3;
const LOSS_COOLDOWN = 90;
const DAILY_KILL    = 3;
const HARD_KILL_24H = 5;

const recordLoss = (symbol) => {
  const today = new Date().toDateString();
  if (dailyLosses.date !== today) { dailyLosses.count = 0; dailyLosses.totalPnlPct = 0; dailyLosses.dailyProfitPct = 0; dailyLosses.dailyTrades = 0; dailyLosses.date = today; }
  dailyLosses.count++;
  dailyLosses.totalPnlPct -= 1.8;
  recoveryState.consecutiveLosses++;
  recoveryState.lastTradeWin = false;
  lossTracker.set(symbol, { lossTime: Date.now() });
  const sizeHint = getPositionSizeHint();
  log(`❌ Loss: ${symbol} | Daily: ${dailyLosses.count}/${DAILY_KILL} | Est PnL: ${dailyLosses.totalPnlPct.toFixed(1)}% | Consecutive: ${recoveryState.consecutiveLosses} | Next: ${sizeHint.label}`);
};

const recordWin = (symbol, pnlPct) => {
  recoveryState.consecutiveLosses = 0;
  recoveryState.lastTradeWin = true;
  log(`✅ Win: ${symbol} | +${pnlPct.toFixed(2)}% | Consecutive losses reset`);
};

let weeklyDrawdown = 0;
let weeklyDrawdownCheckedAt = 0;
const WEEKLY_DD_CACHE_MS = 600000;
const WEEKLY_DD_KILL = -15.0;

const checkWeeklyDrawdown = async () => {
  const now = Date.now();
  if (now - weeklyDrawdownCheckedAt < WEEKLY_DD_CACHE_MS) return weeklyDrawdown;
  try {
    const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const trades = await sb(`paper_trades?outcome=eq.LOSS&created_at=gte.${since}&select=id`) || [];
    weeklyDrawdown = trades.length * -1.8;
    weeklyDrawdownCheckedAt = now;
    if (weeklyDrawdown <= WEEKLY_DD_KILL) log(`WEEKLY DRAWDOWN: ${weeklyDrawdown.toFixed(1)}% — all trading blocked`);
    return weeklyDrawdown;
  } catch {
    return weeklyDrawdown;
  }
};

const isBlocked = (symbol) => {
  if (weeklyDrawdown <= WEEKLY_DD_KILL) return { blocked: true, reason: `Weekly drawdown ${weeklyDrawdown.toFixed(1)}%` };
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

// ── Liquidity Sweep Detector ─────────────────────────────────────────────────
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

// ── Early Entry Checker ──────────────────────────────────────────────────────
const checkEarlyEntry = (compression, volume, fundingLS, klines) => {
  const quietAccum   = compression.compressed && compression.oiBuilding;
  const notBrokenOut = volume.spike < 1.5;
  const fundingReady = fundingLS.funding < 0 || fundingLS.ls < 1.0;
  let earlyInterest = false;
  if (klines && klines.length >= 6) {
    const vols = klines.map(k => parseFloat(k[5]));
    const last2avg = (vols[vols.length-1] + vols[vols.length-2]) / 2;
    const prev4avg = (vols[vols.length-3] + vols[vols.length-4] + vols[vols.length-5] + vols[vols.length-6]) / 4;
    earlyInterest = prev4avg > 0 && last2avg > prev4avg * 1.15;
  }
  const isEarly = quietAccum && notBrokenOut && fundingReady && earlyInterest;
  let earlyScore = 0;
  if (quietAccum)              earlyScore += 3;
  if (compression.tightening) earlyScore += 1;
  if (fundingReady)            earlyScore += 1;
  if (earlyInterest)           earlyScore += 1;
  return { isEarly, earlyScore, quietAccum, notBrokenOut, fundingReady, earlyInterest };
};

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #5: MOMENTUM SCORING — catch early moves before breakout
// ═══════════════════════════════════════════════════════════════════════════════
const checkMomentumScore = (klines, direction) => {
  if (!klines || klines.length < 4) return { score: 0, momentumPct: 0, aligned: false };
  const closes = klines.map(k => parseFloat(k[4]));
  const opens = klines.map(k => parseFloat(k[1]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const price = closes[closes.length - 1];
  
  // 15m momentum (last 4 candles = 1 hour)
  const momentum1h = ((price - closes[closes.length - 4]) / closes[closes.length - 4]) * 100;
  
  // Volume on last 2 candles vs prior 4
  const recentVol = (volumes[volumes.length-1] + volumes[volumes.length-2]) / 2;
  const priorVol = (volumes[volumes.length-3] + volumes[volumes.length-4] + volumes[volumes.length-5] + volumes[volumes.length-6]) / 4;
  const volBoost = priorVol > 0 && recentVol > priorVol * 1.3;
  
  // Green candle count in last 3
  let greenCount = 0;
  for (let i = closes.length - 3; i < closes.length; i++) {
    if (closes[i] > opens[i]) greenCount++;
  }
  
  const isLong = direction === 'LONG';
  const momentumAligned = isLong ? momentum1h > 0.3 : momentum1h < -0.3;
  const hasVolume = volBoost;
  const hasCandleBias = isLong ? greenCount >= 2 : greenCount <= 1;
  
  let score = 0;
  if (momentumAligned) score += 1.0;
  if (hasVolume) score += 0.5;
  if (hasCandleBias) score += 0.5;
  
  return {
    score: parseFloat(score.toFixed(1)),
    momentumPct: parseFloat(momentum1h.toFixed(2)),
    aligned: momentumAligned && (hasVolume || hasCandleBias),
    volBoost,
    greenCount,
  };
};

// ── HTTP Helpers ─────────────────────────────────────────────────────────────
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

const tg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { }
};

// ── COIN BEHAVIOR RECORDER ───────────────────────────────────────────────────
const recordCoinBehavior = async (data) => {
  try {
    await sb('coin_behavior', {
      method: 'POST',
      body: JSON.stringify({
        symbol:         data.symbol,
        recorded_at:    new Date().toISOString(),
        price:          data.price,
        candle_color:   data.candleColor,
        body_pct:       data.bodyPct,
        volume:         data.volume,
        vol_vs_avg:     data.volVsAvg,
        funding:        data.funding,
        ls_ratio:       data.lsRatio,
        oi:             data.oi,
        oi_change_pct:  data.oiChangePct,
        rsi:            data.rsi,
        score:          data.score,
        ma_stack:       data.maStack,
        was_alerted:    data.wasAlerted || false,
        alert_type:     data.alertType || null,
        btc_regime:     btcRegime.regime,
        btc_change1h:   btcRegime.momentum1H,
        session:        getSession(),
      }),
    });
  } catch { }
};

// ── ROLLING COIN INTELLIGENCE ────────────────────────────────────────────────
const coinProfileCache = new Map();
const PROFILE_CACHE_MS = 30 * 60 * 1000;

const getCoinProfile = async (symbol) => {
  const cached = coinProfileCache.get(symbol);
  if (cached && Date.now() - cached.ts < PROFILE_CACHE_MS) return cached.profile;
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const trades = (await sb(`paper_trades?symbol=eq.${symbol}&created_at=gte.${since}&select=*`)) || [];
    const closed = trades.filter(t => t.status !== 'OPEN');
    const wins = closed.filter(t => t.outcome === 'WIN').length;
    const losses = closed.filter(t => t.outcome === 'LOSS').length;
    const total = closed.length;
    const winRate = total > 0 ? (wins / total) : null;
    const earlyTrades = closed.filter(t => t.signal_type === 'EARLY');
    const fireTrades = closed.filter(t => t.signal_type === 'FIRE');
    const earlyWins = earlyTrades.filter(t => t.outcome === 'WIN').length;
    const fireWins = fireTrades.filter(t => t.outcome === 'WIN').length;
    const earlyWR = earlyTrades.length > 0 ? (earlyWins / earlyTrades.length) : null;
    const fireWR = fireTrades.length > 0 ? (fireWins / fireTrades.length) : null;
    const longTrades = closed.filter(t => t.direction === 'LONG');
    const shortTrades = closed.filter(t => t.direction === 'SHORT');
    const longWins = longTrades.filter(t => t.outcome === 'WIN').length;
    const shortWins = shortTrades.filter(t => t.outcome === 'WIN').length;
    const longWR = longTrades.length > 0 ? (longWins / longTrades.length) : null;
    const shortWR = shortTrades.length > 0 ? (shortWins / shortTrades.length) : null;
    const behavior = (await sb(`coin_behavior?symbol=eq.${symbol}&recorded_at=gte.${since}&select=candle_color,score,vol_vs_avg,rsi,ma_stack,btc_regime,session`)) || [];
    const obsCount = behavior.length;
    const greens = behavior.filter(b => b.candle_color === 'green').length;
    const greenRatio = obsCount > 0 ? (greens / obsCount) : null;
    const scores = behavior.map(b => parseFloat(b.score || 0)).filter(s => !isNaN(s));
    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
    const peakScore = scores.length > 0 ? Math.max(...scores) : null;
    const volRatios = behavior.map(b => parseFloat(b.vol_vs_avg || 0)).filter(v => !isNaN(v) && v > 0);
    const avgVolRatio = volRatios.length > 0 ? volRatios.reduce((s, v) => s + v, 0) / volRatios.length : null;
    const rsis = behavior.map(b => parseFloat(b.rsi || 0)).filter(r => !isNaN(r) && r > 0);
    const avgRsi = rsis.length > 0 ? rsis.reduce((s, v) => s + v, 0) / rsis.length : null;
    const sessions = { ASIA: 0, LONDON: 0, NY: 0, OFF: 0 };
    behavior.forEach(b => { if (sessions[b.session] !== undefined) sessions[b.session]++; });
    
    let verdict = 'INSUFFICIENT_DATA';
    let verdictEmoji = '⚪';
    let verdictReason = 'Need more data';
    if (total >= 3) {
      if (winRate >= 0.65 && greenRatio >= 0.5) { verdict = 'TRUSTED'; verdictEmoji = '🟢'; verdictReason = 'Strong WR + bullish bias'; }
      else if (winRate >= 0.5) { verdict = 'NORMAL'; verdictEmoji = '🟡'; verdictReason = 'Average performance'; }
      else if (winRate < 0.4) { verdict = 'HOSTILE'; verdictEmoji = '🔴'; verdictReason = `Poor WR (${(winRate*100).toFixed(0)}%)`; }
    } else if (total === 2 && wins === 0) {
      verdict = 'WARNING'; verdictEmoji = '🟠'; verdictReason = `Lost 2/2 — caution`;
    } else if (total === 1 && losses === 1) {
      verdict = 'CAUTION'; verdictEmoji = '🟡'; verdictReason = `1 loss recorded`;
    } else if (obsCount >= 100 && greenRatio !== null) {
      if (greenRatio >= 0.55) { verdict = 'PROMISING'; verdictEmoji = '🟢'; verdictReason = `${(greenRatio*100).toFixed(0)}% green`; }
      else if (greenRatio < 0.4) { verdict = 'WEAK'; verdictEmoji = '🔴'; verdictReason = `Mostly red`; }
    }
    
    let tier = 'UNKNOWN';
    let action = 'normal';
    if (total >= 3) {
      if (winRate >= 0.7)      { tier = 'A'; action = 'boost'; }
      else if (winRate >= 0.5) { tier = 'B'; action = 'normal'; }
      else if (winRate < 0.4)  { tier = 'C'; action = 'normal'; }
    }
    
    const profile = {
      symbol, tier, action, winRate, wins, losses, totalTrades: total,
      earlyWR, earlyWins, earlyLosses: earlyTrades.length - earlyWins, earlyTotal: earlyTrades.length,
      fireWR, fireWins, fireLosses: fireTrades.length - fireWins, fireTotal: fireTrades.length,
      longWR, longWins, longLosses, longTotal: longTrades.length,
      shortWR, shortWins, shortLosses, shortTotal: shortTrades.length,
      greenRatio, avgScore, peakScore, avgVolRatio, avgRsi,
      observations: obsCount, sessions,
      verdict, verdictEmoji, verdictReason,
      hasData: total >= 1 || obsCount >= 10,
    };
    coinProfileCache.set(symbol, { profile, ts: Date.now() });
    return profile;
  } catch {
    return { symbol, tier: 'UNKNOWN', action: 'normal', hasData: false, totalTrades: 0, wins: 0, losses: 0, winRate: null, verdict: 'ERROR', verdictEmoji: '⚪', verdictReason: 'Profile fetch failed' };
  }
};

// ── v5.24 SUPABASE DECISION LAYER ────────────────────────────────────────────
const checkHostileDirection = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') {
    return { block: false, reason: '' };
  }
  const isLong = direction === 'LONG';
  const dirWR = isLong ? profile.longWR : profile.shortWR;
  const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
  const dirWins = isLong ? profile.longWins : profile.shortWins;
  const dirLosses = isLong ? profile.longLosses : profile.shortLosses;
  if (dirTotal >= 3 && dirWR !== null && dirWR < 0.35) {
    return { block: true, reason: `${direction} WR ${(dirWR*100).toFixed(0)}% (${dirWins}W/${dirLosses}L)` };
  }
  return { block: false, reason: '' };
};

const calcScoreAdjustment = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') {
    return { adjustment: 0, reason: '' };
  }
  const isLong = direction === 'LONG';
  const dirWR = isLong ? profile.longWR : profile.shortWR;
  const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
  if (dirTotal >= 5 && dirWR !== null && dirWR >= 0.60) {
    return { adjustment: -1.0, reason: `TRUSTED ${(dirWR*100).toFixed(0)}% WR` };
  }
  if (dirTotal >= 3 && dirWR !== null && dirWR >= 0.35 && dirWR < 0.45) {
    return { adjustment: +1.0, reason: `CAUTION ${(dirWR*100).toFixed(0)}% WR` };
  }
  return { adjustment: 0, reason: '' };
};

const shouldBlockFireOnCaution = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') return false;
  if (profile.verdict === 'CAUTION' || profile.verdict === 'WARNING') return true;
  return false;
};

// ── PAPER TRADE LOGGER ───────────────────────────────────────────────────────
const logPaperTrade = async (signal) => {
  try {
    log(`Logging paper trade: ${signal.symbol} ${signal.direction} ${signal.type} entry=${signal.price}`);
    await sb('paper_trades', {
      method: 'POST',
      body: JSON.stringify({
        symbol:      signal.symbol,
        direction:   signal.direction,
        signal_type: signal.type,
        session:     getSession(),
        entry:       signal.price,
        sl:          signal.sl,
        tp1:         signal.tp1,
        tp2:         signal.tp2,
        score:       signal.score,
        candle:      signal.candle,
        btc_change:  signal.btcChange,
        status:      'OPEN',
        created_at:  new Date().toISOString(),
      }),
    });
    lastSignalLogTime = Date.now();
  } catch (err) {
    log(`Paper log FAILED for ${signal.symbol}: ${err.message}`);
  }
};

// ── Daily Summary + Anomaly Alerts ───────────────────────────────────────────
let lastSummaryDate = '';
let lastAnomalyCheck = 0;
let lastSignalLogTime = Date.now();
let btcFetchFails = 0;

const sendDailySummary = async () => {
  try {
    const all = (await sb('paper_trades?select=*')) || [];
    const today = new Date().toDateString();
    const todayTrades = all.filter(t => new Date(t.created_at).toDateString() === today);
    const closed = todayTrades.filter(t => t.status !== 'OPEN');
    const wins = closed.filter(t => t.outcome === 'WIN').length;
    const losses = closed.filter(t => t.outcome === 'LOSS').length;
    const open = todayTrades.filter(t => t.status === 'OPEN').length;
    const longs = todayTrades.filter(t => t.direction === 'LONG').length;
    const shorts = todayTrades.filter(t => t.direction === 'SHORT').length;
    const wr = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(0) : '—';
    const sortedBlocks = Object.entries(blockReasons).sort((a,b) => b[1] - a[1]).filter(([_,v]) => v > 0).slice(0, 3);
    const topBlocks = sortedBlocks.length > 0 ? sortedBlocks.map(([k,v]) => `  ${k}: ${v}`).join('\n') : '  none';
    const minsSinceLog = Math.floor((Date.now() - lastSignalLogTime) / 60000);
    const paperOk = minsSinceLog < 1440 ? '✅' : '⚠️ no logs for ' + Math.floor(minsSinceLog/60) + 'h';
    const btcOk = btcFetchFails < 5 ? '✅' : `⚠️ ${btcFetchFails} fails`;
    const trackerOk = coinTracker.size > 0 ? `✅ tracking ${coinTracker.size}` : '⚠️ empty tracker';
    const msg = `📊 <b>NEXIO v6.00 DAILY SUMMARY</b>
━━━━━━━━━━━━━━━
🌐 BTC Regime: ${btcRegime.regime} (${btcRegime.confidence}%)
📈 Today's signals: ${todayTrades.length}
   LONG: ${longs} · SHORT: ${shorts}
🎯 Closed: ${wins}W ${losses}L · Open: ${open}
🔥 Win rate today: ${wr}%

📊 Cumulative: ${all.length} signals
   Closed: ${all.filter(t => t.status !== 'OPEN').length}
   WR: ${all.filter(t => t.status !== 'OPEN').length > 0 ? ((all.filter(t => t.outcome === 'WIN').length / all.filter(t => t.status !== 'OPEN').length) * 100).toFixed(0) : '—'}%

🔬 Top blocks today:
${topBlocks}

🩺 Health:
  Paper logger: ${paperOk}
  BTC fetch: ${btcOk}
  Coin tracker: ${trackerOk}
  Watchlist: ${(await getWatchlist()).length}

⏰ ${gstNow()} GST
━━━━━━━━━━━━━━━
<i>v6.00 — SL 1.2x TP1 2.5x | FIRE ≥6.0 | EARLY ≥4.0</i>`;
    await tg(OWNER_CHAT_ID, msg);
    log('Daily summary sent');
    Object.keys(blockReasons).forEach(k => blockReasons[k] = 0);
    btcFetchFails = 0;
  } catch (err) {
    log(`Daily summary failed: ${err.message}`);
  }
};

const checkDailySummary = async () => {
  const now = new Date();
  const dubaiHour = parseInt(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  const today = now.toDateString();
  if (dubaiHour === 21 && lastSummaryDate !== today) {
    lastSummaryDate = today;
    await sendDailySummary();
  }
};

const checkAnomalies = async () => {
  try {
    const alerts = [];
    const minsSinceLog = (Date.now() - lastSignalLogTime) / 60000;
    const btcWasTradeable = btcRegime.regime === 'BULLISH' || btcRegime.regime === 'BEARISH';
    const totalBlocksToday = Object.values(blockReasons).reduce((a,b) => a+b, 0);
    if (minsSinceLog > 1440 && fullScanCount > 10 && btcWasTradeable && totalBlocksToday < 30 && coinTracker.size > 0) {
      alerts.push(`⚠️ No paper trade logged in ${Math.floor(minsSinceLog/60)}h despite tradeable BTC and active tracker`);
    }
    if (btcFetchFails >= 20 && btcGateStatus.price === 0) {
      alerts.push(`⚠️ BTC fetch broken (${btcFetchFails} fails)`);
    }
    if (fullScanCount > 30 && coinTracker.size === 0) {
      const isChoppy = btcRegime.regime === 'CHOPPY';
      if (!isChoppy) {
        alerts.push(`⚠️ Coin tracker empty despite ${fullScanCount} scans`);
      }
    }
    if (btcRegime.regime === 'UNKNOWN' && Date.now() - btcRegime.changedAt > 3600000) {
      alerts.push(`⚠️ BTC regime stuck UNKNOWN`);
    }
    const wl = await getWatchlist();
    if (wl.length < 5 && fullScanCount > 5) {
      alerts.push(`⚠️ Watchlist only ${wl.length} coins`);
    }
    if (alerts.length > 0) {
      const msg = `🚨 <b>NEXIO ANOMALY</b>\n━━━━━━━━━━━━━━━\n${alerts.join('\n\n')}\n\n⏰ ${gstNow()} GST`;
      await tg(OWNER_CHAT_ID, msg);
    }
  } catch (err) {
    log(`Anomaly check failed: ${err.message}`);
  }
};

// ── PAPER TRADE OUTCOME CHECKER ──────────────────────────────────────────────
const checkPaperOutcomes = async () => {
  try {
    const open = (await sb('paper_trades?status=eq.OPEN&select=*')) || [];
    if (!open.length) return;
    log(`Checking ${open.length} open paper trades...`);
    for (const trade of open) {
      await sleep(200);
      try {
        const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${trade.symbol}`);
        const price = parseFloat(t.price);
        const isLong = trade.direction === 'LONG';
        let status = 'OPEN', outcome = null;
        if (isLong && price <= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        else if (!isLong && price >= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        else if (isLong && price >= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
        else if (!isLong && price <= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
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
          log(`${trade.symbol} ${trade.direction} → ${status} (${outcome})`);
        }
      } catch { }
    }
  } catch (err) { log('Paper outcome error:', err.message); }
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

// ── LAYER 1: BTC Gate ────────────────────────────────────────────────────────
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
    let pass = true, reason;
    if (change1H >= 0.5)       reason = `📈 BTC pumping +${change1H.toFixed(2)}% (1H)`;
    else if (change1H >= 0.1)  reason = `🟢 BTC drifting up +${change1H.toFixed(2)}% (1H)`;
    else if (change1H > -0.1)  reason = `⚪ BTC flat ${change1H.toFixed(2)}% (1H)`;
    else if (change1H > -0.5)  reason = `🟡 BTC drifting down ${change1H.toFixed(2)}% (1H)`;
    else                       reason = `🔴 BTC dumping ${change1H.toFixed(2)}% (1H)`;
    const extremeMove = Math.abs(change1H) > 2.5 || Math.abs(change24h) > 7;
    if (extremeMove) {
      pass = false;
      reason = `⚡ BTC extreme move (1H ${change1H.toFixed(2)}%) — skip all`;
    } else if (fundRate > 0.04) {
      pass = false;
      reason = `⚠️ BTC funding extreme ${fundRate.toFixed(3)}%`;
    }
    const bullishOk = change1H > -1.2 && change24h > -4;
    const bearishOk = change1H < 1.2 && change24h < 4;
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji, bullishOk, bearishOk };
    return btcGateStatus;
  } catch (err) {
    log(`BTC gate fetch failed: ${err.message}`);
    btcFetchFails++;
    if (btcGateStatus.price > 0) {
      btcGateStatus.reason = `⚠️ BTC fetch failed (cached: ${btcGateStatus.change?.toFixed(2)}%)`;
      return btcGateStatus;
    }
    btcGateStatus = { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };
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

// ── LAYER 6: Funding + L/S ───────────────────────────────────────────────────
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

// ── LAYER 7a: Candle Wick Detector ───────────────────────────────────────────
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
      verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% · Wick ${latest.upperWickPct}% — clean breakout`;
    } else if (latest.upperWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% · Wick ${latest.upperWickPct}% — rejection`;
    } else if (wickyCount >= 2) {
      verdict = 'FAKE'; emoji = '❌'; details = `${wickyCount}/3 wicky candles`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% · Wick ${latest.upperWickPct}% — weak`;
    }
  } else {
    if (latest.bodyPct >= 60 && latest.lowerWickPct <= 25 && !latest.isGreen) {
      verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% · Lower wick ${latest.lowerWickPct}% — clean breakdown`;
    } else if (latest.lowerWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% · Lower wick ${latest.lowerWickPct}% — possible reversal`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% · Lower wick ${latest.lowerWickPct}% — weak`;
    }
  }
  return { verdict, emoji, details, bodyPct: latest.bodyPct, upperWickPct: latest.upperWickPct, lowerWickPct: latest.lowerWickPct, wickyCount, isGreen: latest.isGreen };
};

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #6: TRAP FILTER — reduced penalties (was killing good entries)
// ═══════════════════════════════════════════════════════════════════════════════
const checkTrapRisk = async (symbol, price, direction, volSpike, oiBuilding, klines = []) => {
  let trapScore = 0;
  const reasons = [];
  if (volSpike >= 2 && !oiBuilding) {
    trapScore += 2;
    reasons.push('vol spike no OI confirmation');
  }
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
  const candle = checkCandleQuality(klines, direction);
  // v6.00 FIX: Reduced penalties — let more borderline signals through
  if (candle.verdict === 'FAKE') {
    trapScore += 1.0;  // was 2.0
    reasons.push(`fake candle: ${candle.details}`);
  } else if (candle.verdict === 'WEAK') {
    trapScore += 0.5;  // was 1.0
    reasons.push(`weak candle: ${candle.details}`);
  } else if (candle.verdict === 'STRONG') {
    trapScore = Math.max(0, trapScore - 0.5);
  }
  return { safe: trapScore === 0, trapScore, reasons, candle };
};

// ── Volume Climax Detector ───────────────────────────────────────────────────
const checkVolumeClimax = (klines, direction) => {
  if (!klines || klines.length < 8) return { climax: false, peakRatio: 0, peakCandlesAgo: 0 };
  const vols   = klines.slice(-8).map(k => parseFloat(k[5]));
  const closes = klines.slice(-8).map(k => parseFloat(k[4]));
  const maxVol = Math.max(...vols);
  const maxVolIdx = vols.indexOf(maxVol);
  const avgVol = vols.reduce((a,b) => a+b, 0) / vols.length;
  const peakIsRecent    = maxVolIdx >= 4 && maxVolIdx <= 6;
  const peakIsSpike     = avgVol > 0 && maxVol > avgVol * 2.5;
  const currentVolLower = vols[vols.length-1] < maxVol * 0.7;
  const priceAtPeak  = closes[maxVolIdx];
  const priceCurrent = closes[closes.length-1];
  const priceStall   = priceAtPeak > 0 && Math.abs((priceCurrent - priceAtPeak) / priceAtPeak) * 100 < 1.5;
  const climax = peakIsRecent && peakIsSpike && currentVolLower && priceStall;
  return { climax, peakRatio: avgVol > 0 ? parseFloat((maxVol/avgVol).toFixed(1)) : 0, peakCandlesAgo: 7 - maxVolIdx };
};

// ── Anti-Dump Trap Detector ───────────────────────────────────────────────────
const checkAntiDumpTrap = (klines, direction) => {
  if (direction !== 'LONG' || !klines || klines.length < 25) {
    return { isTrap: false, reasons: [] };
  }
  const closes = klines.map(k => parseFloat(k[4]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const price  = closes[closes.length - 1];
  const reasons = [];
  const priceAgo = closes[closes.length - 9] || closes[0];
  const pctDrop = ((priceAgo - price) / priceAgo) * 100;
  const recentDump = pctDrop >= 3;
  const ma7  = closes.slice(-7).reduce((a,b) => a+b, 0) / 7;
  const ma25 = closes.slice(-25).reduce((a,b) => a+b, 0) / 25;
  const bearishStructure = ma7 < ma25;
  const rangeHigh = Math.max(...highs.slice(-25));
  const rangeLow  = Math.min(...lows.slice(-25));
  const rangeSize = rangeHigh - rangeLow;
  const pricePosition = rangeSize > 0 ? (price - rangeLow) / rangeSize : 0.5;
  const inLowerThird = pricePosition < 0.33;
  const recentHighs = highs.slice(-6);
  const firstHalfHigh = Math.max(...recentHighs.slice(0, 3));
  const secondHalfHigh = Math.max(...recentHighs.slice(3));
  const lowerHighs = secondHalfHigh < firstHalfHigh * 0.98;
  if (recentDump) reasons.push(`dumped ${pctDrop.toFixed(1)}% recently`);
  if (bearishStructure) reasons.push(`MA7<MA25`);
  if (inLowerThird) reasons.push(`lower ${(pricePosition*100).toFixed(0)}% of range`);
  if (lowerHighs) reasons.push(`lower highs`);
  const isTrap = recentDump && (bearishStructure || inLowerThird);
  return { isTrap, reasons, pctDrop: parseFloat(pctDrop.toFixed(2)), ma7: parseFloat(ma7.toFixed(6)), ma25: parseFloat(ma25.toFixed(6)), pricePosition: parseFloat(pricePosition.toFixed(2)) };
};

// ── Bullish Absorption Detector ───────────────────────────────────────────────
const checkBullishAbsorption = async (symbol, price, klines, currentOI, prevOI, funding) => {
  if (!klines || klines.length < 6) return { absorbing: false, score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const recent = klines.slice(-6);
  const highs  = recent.map(k => parseFloat(k[2]));
  const lows   = recent.map(k => parseFloat(k[3]));
  const maxH   = Math.max(...highs);
  const minL   = Math.min(...lows);
  const rangePct = ((maxH - minL) / price) * 100;
  const priceFlat = rangePct < 3.5;
  if (priceFlat) { score += 2; reasons.push(`flat ${rangePct.toFixed(1)}%`); }
  const oiRising = prevOI > 0 && currentOI > prevOI * 1.015;
  const oiPct = prevOI > 0 ? ((currentOI - prevOI) / prevOI) * 100 : 0;
  if (oiRising) { score += 2; reasons.push(`OI+${oiPct.toFixed(1)}%`); }
  const vols   = recent.map(k => parseFloat(k[5]));
  const firstHalf = vols.slice(0, 3).reduce((a,b) => a+b, 0) / 3;
  const secondHalf = vols.slice(3).reduce((a,b) => a+b, 0) / 3;
  const volRising = secondHalf > firstHalf * 1.2;
  if (volRising) { score += 1.5; reasons.push(`vol rising`); }
  const fundingOk = funding < 0.005;
  const fundingStrong = funding < -0.005;
  if (fundingStrong) { score += 2; reasons.push(`shorts paying ${funding.toFixed(3)}%`); }
  else if (fundingOk) { score += 1; }
  try {
    const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
    const bidValue = ob.bids.slice(0, 20).reduce((s, b) => s + parseFloat(b[0]) * parseFloat(b[1]), 0);
    const askValue = ob.asks.slice(0, 20).reduce((s, a) => s + parseFloat(a[0]) * parseFloat(a[1]), 0);
    const bidDominance = bidValue / (askValue || 1);
    if (bidDominance > 1.3) { score += 1.5; reasons.push(`bids dominate ${bidDominance.toFixed(2)}x`); }
    else if (bidDominance > 1.1) { score += 0.5; }
  } catch { }
  const greenCount = recent.filter(k => parseFloat(k[4]) >= parseFloat(k[1])).length;
  if (greenCount >= 4) { score += 1; reasons.push(`${greenCount}/6 green`); }
  const absorbing = score >= 5 && reasons.length >= 3 && priceFlat && oiRising;
  return { absorbing, score: parseFloat(score.toFixed(1)), reasons, rangePct: parseFloat(rangePct.toFixed(2)), oiPct: parseFloat(oiPct.toFixed(2)), funding };
};

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #7: MASTER SCORE — includes momentum layer
// ═══════════════════════════════════════════════════════════════════════════════
const calcMasterScore = ({ compression, volume, resistance, fundingLS, trap, momentum }) => {
  const raw = compression.score + volume.score + resistance.score + fundingLS.score + (momentum?.score || 0) - (trap.trapScore * 1.0);
  return Math.max(0, Math.min(10, parseFloat(raw.toFixed(1))));
};


// ── Alert Messages ────────────────────────────────────────────────────────────
const FOOTER = (btc, symbol) => {
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0?'+':''}${btc.change?.toFixed(1)}%` : '';
  const link   = symbol ? `bybit.com/trade/usdt/${symbol}` : '';
  return [btcStr, link, `⏰ ${gstNow()} GST`, `<i>DYOR · SL always set</i>`].filter(Boolean).join('  |  ');
};

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
  if (layers?.rsi)                    tags.push(`📊RSI${layers.rsi.toFixed(0)}`);
  if (layers?.maStack === 'bullish_full') tags.push('📈MA-Stack✅');
  else if (layers?.maStack === 'bearish_full') tags.push('📉MA-Stack✅');
  if (layers?.momentum?.aligned)      tags.push(`🚀Momentum+${layers.momentum.momentumPct.toFixed(1)}%`);
  return `👀 ${symbol.replace('USDT','')} ${tag}  ${score}/10 ${confBar(score)}${cv}
${tags.join(' · ')}
${direction === 'LONG' ? '⏳ Waiting for breakout (up)' : '⏳ Waiting for breakdown (down)'}
${FOOTER(btc, symbol)}`.trim();
};

const buildEarlyMsg = (symbol, price, score, direction, layers, htf, sweep, atr, btc, hype = null, profile = null) => {
  const isLong = direction === 'LONG';
  // v6.00: Use new tighter SL / wider TP
  const sl  = isLong ? price - atr * UNIFIED_SL_ATR  : price + atr * UNIFIED_SL_ATR;
  const tp1 = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
  const tp2 = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
  const tp3 = isLong ? price + atr * UNIFIED_TP3_ATR : price - atr * UNIFIED_TP3_ATR;
  const rr  = ((Math.abs(tp1 - price)) / Math.abs(price - sl)).toFixed(2);
  const tags = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) tags.push('📦Coiling+OI');
  if (layers.compression.tightening)  tags.push('🎯Tightening');
  if (layers.fundingLS.funding < 0)   tags.push(`💸Fund${layers.fundingLS.funding.toFixed(3)}%`);
  if (layers.fundingLS.ls < 1)        tags.push(`⚖️L/S${layers.fundingLS.ls.toFixed(2)}`);
  if (sweep?.swept && sweep?.recovery) tags.push('🌊Swept');
  if (hype?.isTrending)                tags.push(hype.tag);
  if (layers?.momentum?.aligned)       tags.push(`🚀Mom+${layers.momentum.momentumPct.toFixed(1)}%`);
  const reliability = (() => {
    if (!profile || profile.verdict === 'ERROR') return '';
    const lines = [];
    if (profile.verdict !== 'INSUFFICIENT_DATA') {
      lines.push(`🎯 <b>Coin Reliability: ${profile.verdictEmoji} ${profile.verdict}</b>`);
    } else if (profile.observations >= 30) {
      lines.push(`🎯 <b>Coin Profile: ⚪ LIMITED DATA</b>`);
    } else {
      lines.push(`🎯 <b>Coin Profile: ⚪ NEW (${profile.observations || 0} obs)</b>`);
    }
    if (profile.greenRatio !== null && profile.observations >= 30) {
      lines.push(`   7d trend: ${(profile.greenRatio*100).toFixed(0)}% green ${profile.greenRatio >= 0.55 ? '🟢' : profile.greenRatio >= 0.45 ? '🟡' : '🔴'}`);
    }
    const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
    const dirWins = isLong ? profile.longWins : profile.shortWins;
    const dirLosses = isLong ? profile.longLosses : profile.shortLosses;
    const dirWR = isLong ? profile.longWR : profile.shortWR;
    if (dirTotal >= 1) {
      const dirEmoji = dirWR >= 0.6 ? '🟢' : dirWR >= 0.4 ? '🟡' : '🔴';
      lines.push(`   ${isLong ? 'LONG' : 'SHORT'} record: ${dirWins}W/${dirLosses}L${dirWR !== null ? ` (${(dirWR*100).toFixed(0)}%)` : ''} ${dirEmoji}`);
    }
    return '\n' + lines.join('\n');
  })();
  return `⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡
<b>⚡ NEXIO EARLY — ${isLong?'📈 LONG':'📉 SHORT'}</b>
<b>${symbol.replace('USDT','')}</b>
⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡

<b>💰 ENTRY:  $${fmtP(price)}</b>
<b>🛑 STOP:   $${fmtP(sl)}</b>
<b>🎯 TP1:    $${fmtP(tp1)}</b>
<b>🎯 TP2:    $${fmtP(tp2)}</b>
<b>🎯 TP3:    $${fmtP(tp3)}</b>

━━━━━━━━━━━━━━━
📊 Score: ${score}/10  ·  R:R 1:${rr}
${tags.join(' · ')}${reliability}
${FOOTER(btc, symbol)}`.trim();
};

const buildFireMsg = (symbol, price, score, direction, layers, scanCount, btc, klines = [], hype = null, profile = null) => {
  const isLong   = direction === 'LONG';
  const atr      = calculateATR(klines) || (price * 0.018);
  const sl       = isLong ? price - atr * UNIFIED_SL_ATR  : price + atr * UNIFIED_SL_ATR;
  const tp1      = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
  const tp2      = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
  const tp3      = isLong ? price + atr * UNIFIED_TP3_ATR : price - atr * UNIFIED_TP3_ATR;
  const candle   = layers.trap?.candle;
  const rr = ((Math.abs(tp1 - price)) / Math.abs(price - sl)).toFixed(2);
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
  if (layers?.momentum?.aligned)      conf.push(`🚀Mom+${layers.momentum.momentumPct.toFixed(1)}%`);
  const sizeHint = getPositionSizeHint();
  const reliability = (() => {
    if (!profile || profile.verdict === 'ERROR') return '';
    const lines = [];
    if (profile.verdict !== 'INSUFFICIENT_DATA') {
      lines.push(`🎯 <b>Coin Reliability: ${profile.verdictEmoji} ${profile.verdict}</b>`);
    } else if (profile.observations >= 30) {
      lines.push(`🎯 <b>Coin Profile: ⚪ LIMITED DATA</b>`);
    } else {
      lines.push(`🎯 <b>Coin Profile: ⚪ NEW (${profile.observations || 0} obs)</b>`);
    }
    if (profile.greenRatio !== null && profile.observations >= 30) {
      lines.push(`   7d trend: ${(profile.greenRatio*100).toFixed(0)}% green ${profile.greenRatio >= 0.55 ? '🟢' : profile.greenRatio >= 0.45 ? '🟡' : '🔴'}`);
    }
    const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
    const dirWins = isLong ? profile.longWins : profile.shortWins;
    const dirLosses = isLong ? profile.longLosses : profile.shortLosses;
    const dirWR = isLong ? profile.longWR : profile.shortWR;
    if (dirTotal >= 1) {
      const dirEmoji = dirWR >= 0.6 ? '🟢' : dirWR >= 0.4 ? '🟡' : '🔴';
      lines.push(`   ${isLong ? 'LONG' : 'SHORT'} record: ${dirWins}W/${dirLosses}L${dirWR !== null ? ` (${(dirWR*100).toFixed(0)}%)` : ''} ${dirEmoji}`);
    }
    return '\n' + lines.join('\n');
  })();
  return `🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
<b>🔥 NEXIO FIRE — ${isLong?'📈 LONG':'📉 SHORT'}</b>
<b>${symbol.replace('USDT','')}</b>
🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

<b>💰 ENTRY:  $${fmtP(price)}</b>
<b>🛑 STOP:   $${fmtP(sl)}</b>
<b>🎯 TP1:    $${fmtP(tp1)}</b>
<b>🎯 TP2:    $${fmtP(tp2)}</b>
<b>🎯 TP3:    $${fmtP(tp3)}</b>

━━━━━━━━━━━━━━━
📊 Score: ${score}/10 ${confBar(score)} · R:R 1:${rr}
${conf.join(' · ')}${reliability}
${FOOTER(btc, symbol)}`.trim();
};

const buildBreakevenMsg = (symbol, entryPrice, tp1Price, direction) => {
  return `✅ <b>${symbol.replace('USDT','')} TP1 HIT</b> — Move SL to entry $${fmtP(entryPrice)}
🎯 TP1: $${fmtP(tp1Price)} reached · Let TP2 run
⏰ ${gstNow()} GST`.trim();
};

// ── Contract Info Cache ──────────────────────────────────────────────────────
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
    log(`Contract info refreshed: ${cryptoSymbols.size} crypto perpetuals`);
    return cryptoSymbols;
  } catch (err) {
    log('exchangeInfo fetch failed:', err.message);
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

    // ── Relative Strength Front-Runner Tracker ───────────────────────────────
    try {
      const btc24h = btcGateStatus.change || 0;
      const btc1H  = btcGateStatus.change1H || 0;
      if (btc24h <= -1.5) {
        for (const t of tickers) {
          if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) continue;
          if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) continue;
          if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) continue;
          if (isMemeCoin(t.symbol)) continue;
          if (STOCK_SUFFIX_REGEX.test(t.symbol) || isLikelyStock(t.symbol)) continue;
          if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) continue;
          const chg = parseFloat(t.priceChangePercent);
          if (chg >= btc24h + 1.5 && chg >= -0.5 && chg <= 6) {
            if (!rsWatch.has(t.symbol)) {
              if (rsWatch.size >= 15) continue;
              rsWatch.set(t.symbol, {
                detectedAt: Date.now(),
                detectPrice: parseFloat(t.lastPrice),
                detectChg: chg,
                btcChgAtDetect: btc24h,
                alerted: false,
              });
              log(`RS-DETECT: ${t.symbol} holding ${chg.toFixed(1)}% while BTC ${btc24h.toFixed(1)}%`);
            }
          }
        }
      }
      for (const [sym, rs] of rsWatch) {
        if (Date.now() - rs.detectedAt > 48 * 3600000) rsWatch.delete(sym);
      }
      if (btc1H >= 0.4 && rsWatch.size > 0) {
        for (const [sym, rs] of rsWatch) {
          if (rs.alerted) continue;
          const tk = tickers.find(t => t.symbol === sym);
          if (!tk) continue;
          const nowPrice = parseFloat(tk.lastPrice);
          const moveFromDetect = ((nowPrice - rs.detectPrice) / rs.detectPrice) * 100;
          if (moveFromDetect >= 1.5) {
            rs.alerted = true;
            const heldFor = Math.round((Date.now() - rs.detectedAt) / 3600000);
            await tg(OWNER_CHAT_ID,
              `🏃 <b>FRONT-RUNNER: ${sym.replace('USDT','')}</b>\n━━━━━━━━━━━━━━━\n` +
              `💎 Held strong during dump (${rs.detectChg.toFixed(1)}% while BTC ${rs.btcChgAtDetect.toFixed(1)}%)\n` +
              `📈 Now +${moveFromDetect.toFixed(1)}% from detection (${heldFor}h ago)\n` +
              `🟢 BTC turning: +${btc1H.toFixed(2)}% (1H)\n\n<i>Early mover off accumulation. DYOR · SL always set</i>\n⏰ ${gstNow()} GST`);
            log(`FRONT-RUNNER ALERT: ${sym} +${moveFromDetect.toFixed(1)}%`);
          }
        }
      }
    } catch (rsErr) { log(`RS tracker error: ${rsErr.message}`); }

    const valid = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
        if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) return false;
        if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) return false;
        if (isMemeCoin(t.symbol)) return false;
        if (STOCK_SUFFIX_REGEX.test(t.symbol)) return false;
        if (isLikelyStock(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
        if (Math.abs(parseFloat(t.priceChangePercent)) >= PUMP_EXCLUDE_PCT) return false;
        return true;
      })
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), isMid: MID_CAP.has(t.symbol) }))
      .sort((a, b) => Math.abs(a.change) - Math.abs(b.change))
      .slice(0, 100);

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
    if (staleRemoved > 0) log(`Cleaned ${staleRemoved} stale coins from watchlist`);

    const currentWatchlist = await getWatchlist();
    const currentSymbols   = currentWatchlist.map(r => r.symbol);
    let added = 0;

    for (const coin of valid) {
      await sleep(500);
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=12`); } catch { }
      if (!klines || !Array.isArray(klines) || klines.length < 8) { continue; }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      const htfFM = await checkHTFTrend(coin.symbol);
      let direction = null;
      if (htfFM.bullish && funding < 0.03)      direction = 'LONG';
      else if (htfFM.bearish && funding > -0.03) direction = 'SHORT';
      if (!direction) continue;
      
      // v5.28: SHORT DISABLED — proven 35% WR, does not work in this system
      if (direction === 'SHORT') {
        log(`SHORT-DISABLED: ${coin.symbol} (v5.28 — proven loser)`);
        continue;
      }

      // v6.00: Include momentum in full scan score
      const momentum = checkMomentumScore(klines, direction);
      const score = calcMasterScore({
        compression: checkCompression(klines, currentOI, prevOI),
        volume:      checkVolumeBuild(klines),
        resistance:  checkResistanceTesting(coin.symbol, coin.price, klines),
        fundingLS:   checkFundingLS(funding, ls, direction),
        trap:        { safe: true, trapScore: 0 },
        momentum,
      });

      if (score >= 1.5 && currentSymbols.includes(coin.symbol)) {
        await updateWatchlistScore(coin.symbol, score, direction);
      }
      if (score >= 2.5 && !currentSymbols.includes(coin.symbol)) {
        if (currentSymbols.length + added >= MAX_WATCHLIST) {
          const currentWl = await getWatchlist();
          const lowest = currentWl.filter(r => r.score !== null).sort((a,b) => (a.score||0) - (b.score||0))[0];
          if (lowest && (lowest.score || 0) < score - 0.5) {
            await removeFromWatchlist(lowest.symbol);
            coinTracker.delete(lowest.symbol);
            const idx = currentSymbols.indexOf(lowest.symbol);
            if (idx > -1) currentSymbols.splice(idx, 1);
            log(`Rotated out ${lowest.symbol} (${lowest.score}) for ${coin.symbol} (${score})`);
          } else {
            continue;
          }
        }
        await addToWatchlist(coin.symbol, score, direction);
        currentSymbols.push(coin.symbol);
        added++;
        log(`${coin.symbol} score:${score} ${direction} ${coin.isMid ? '[MID]' : '[LOW]'}`);
      }
      if (score < 1.5 && currentSymbols.includes(coin.symbol)) {
        await removeFromWatchlist(coin.symbol);
        coinTracker.delete(coin.symbol);
      }
    }

    log(`Scan #${fullScanCount} done — +${added} added — Watchlist: ${currentSymbols.length}`);
    await tg(OWNER_CHAT_ID, `🌍 Full scan #${fullScanCount}\n+${added} coins | Total: ${currentSymbols.length}\n${btcGateStatus.emoji} BTC ${btcGateStatus.change > 0 ? '+' : ''}${btcGateStatus.change?.toFixed(2)}% | ${btcGateStatus.reason}`);
  } catch (err) { log('Full scan error:', err.message); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// v6.00 CRITICAL FIX #8: WATCHLIST SCAN — faster entry, relaxed conditions
// ═══════════════════════════════════════════════════════════════════════════════
const runWatchlistScan = async () => {
  watchlistScanCount++;
  log(`👁 Watchlist Scan #${watchlistScanCount}`);
  try {
    await checkWeeklyDrawdown();
    await fetchFinnhubCalendar();
    await checkEventReminders();

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
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      if (!klines || !Array.isArray(klines) || klines.length < 10) {
        log(`Bad klines for ${symbol} — skipping`);
        continue;
      }

      // Direction — HTF decides, funding only blocks bad setups
      const htfPre = await checkHTFTrend(symbol);
      let isLong  = false;
      let isShort = false;
      if (htfPre.bullish && btcRegime.regime !== 'BEARISH') {
        if (funding < 0.03) isLong = true;
      } else if (htfPre.bearish && btcRegime.regime !== 'BULLISH') {
        if (funding > -0.03) isShort = true;
      }
      if (klines.length >= 4) {
        const close4 = parseFloat(klines[klines.length - 4][4]);
        const closeNow = parseFloat(klines[klines.length - 1][4]);
        const momentum15m = ((closeNow - close4) / close4) * 100;
        if (isLong && momentum15m < -1.5) isLong = false;
        if (isShort && momentum15m > 1.5) isShort = false;
      }
      if (!isLong && !isShort) { coinTracker.delete(symbol); continue; }
      const direction = isLong ? 'LONG' : 'SHORT';

      // v5.28: SHORT DISABLED — proven 35% WR
      if (direction === 'SHORT') {
        log(`SHORT-DISABLED: ${symbol} (v5.28)`);
        coinTracker.delete(symbol);
        continue;
      }

      const htf = htfPre;

      // ── LAYER ANALYSIS ─────────────────────────────────────────────────────
      const compression = checkCompression(klines, currentOI, prevOI);
      const volume      = checkVolumeBuild(klines);
      const atrExp      = checkATRExpansion(klines);
      const fundingZ    = await checkFundingExtreme(symbol, funding);
      const resistance  = checkResistanceTesting(symbol, price, klines);
      const fundingLS   = checkFundingLS(funding, ls, direction);
      const trap        = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);
      // v6.00: NEW momentum layer
      const momentum    = checkMomentumScore(klines, direction);

      // Fake pump history check
      const fakeHist = await checkFakePumpHistory(symbol);
      if (fakeHist.isPumpDump) {
        log(`PUMP-DUMP-COIN: ${symbol} ${fakeHist.reason} — blocking`);
        coinTracker.delete(symbol);
        continue;
      }

      // Anti-dump trap check
      const dumpTrap = checkAntiDumpTrap(klines, direction);
      if (dumpTrap.isTrap) {
        incBlock('dumpTrap'); log(`DUMP-TRAP: ${symbol} LONG blocked — ${dumpTrap.reasons.join(', ')}`);
      }

      // News/event detector
      let newsEvent = false;
      if (klines.length >= 10) {
        const lastVol = parseFloat(klines[klines.length - 1][5]);
        const prevVols = klines.slice(-11, -1).map(k => parseFloat(k[5]));
        const prevAvg = prevVols.reduce((a,b) => a+b, 0) / prevVols.length;
        const priceMove = klines.length >= 2 
          ? Math.abs((parseFloat(klines[klines.length-1][4]) - parseFloat(klines[klines.length-2][4])) / parseFloat(klines[klines.length-2][4])) * 100
          : 0;
        if (prevAvg > 0 && lastVol > prevAvg * 5 && priceMove < 1) {
          newsEvent = true;
          incBlock('newsEvent'); log(`NEWS-EVENT: ${symbol} vol ${(lastVol/prevAvg).toFixed(1)}x but price ${priceMove.toFixed(1)}%`);
        }
      }

      // Volume climax check
      const climax = checkVolumeClimax(klines, direction);
      if (climax.climax && direction === 'LONG') {
        incBlock('climax'); log(`VOL-CLIMAX: ${symbol} LONG blocked — buying exhaustion`);
      }

      // Bullish absorption check
      let absorption = { absorbing: false, score: 0, reasons: [] };
      if (direction === 'LONG' && !dumpTrap.isTrap) {
        absorption = await checkBullishAbsorption(symbol, price, klines, currentOI, prevOI, funding);
        if (absorption.absorbing) log(`ABSORPTION: ${symbol} score:${absorption.score}`);
      }

      const rsi = calcRSI(klines);
      const maStack = checkMAStack(klines);
      
      // v6.00: Relaxed RSI — was blocking too many entries
      // Only block extreme overbought (was >75, now >80)
      if (direction === 'LONG' && rsi > 80) {
        log(`RSI-OVERBOUGHT: ${symbol} LONG skipped (RSI ${rsi.toFixed(1)})`);
        continue;
      }

      // v6.00: Calculate score WITH momentum layer
      let score = calcMasterScore({ compression, volume, resistance, fundingLS, trap, momentum });
      
      // Absorption boost
      if (absorption.absorbing) {
        const boost = Math.min(2, absorption.score * 0.3);
        score = Math.min(10, score + boost);
      }
      // Funding extreme boost
      if (fundingZ.extreme) {
        if (direction === 'LONG' && fundingZ.extremeNeg) {
          score = Math.min(10, score + 1.5);
          log(`EXTREME-FUNDING: ${symbol} LONG boost +1.5 (z=${fundingZ.z})`);
        } else if (direction === 'SHORT' && fundingZ.extremePos) {
          score = Math.min(10, score + 1.5);
          log(`EXTREME-FUNDING: ${symbol} SHORT boost +1.5 (z=${fundingZ.z})`);
        }
      }
      
      const layers = { compression, volume, resistance, fundingLS, trap, absorption, dumpTrap, rsi, maStack: maStack.stack, momentum };
      const sweep = checkLiquiditySweep(klines, direction);
      const early = checkEarlyEntry(compression, volume, fundingLS, klines);
      const atr = calculateATR(klines) || (price * 0.018);
      const hype = { hasData: false, hypeBonus: 0, tag: '' }; // Skip CoinGecko to save API calls
      const finalScore = Math.max(0, Math.min(10, score));

      // Record behavior
      try {
        const lastK = klines[klines.length - 1];
        const candleOpen = parseFloat(lastK[1]);
        const candleClose = parseFloat(lastK[4]);
        const bodyAbsPct = candleOpen > 0 ? Math.abs(candleClose - candleOpen) / candleOpen * 100 : 0;
        const candleColor = candleClose >= candleOpen ? 'green' : 'red';
        const recentVols = klines.slice(-20).map(k => parseFloat(k[5]));
        const avgVol = recentVols.reduce((a,b) => a+b, 0) / recentVols.length;
        const lastVol = parseFloat(lastK[5]);
        recordCoinBehavior({
          symbol, price, candleColor, bodyPct: parseFloat(bodyAbsPct.toFixed(2)),
          volume: lastVol, volVsAvg: avgVol > 0 ? parseFloat((lastVol / avgVol).toFixed(2)) : null,
          funding, lsRatio: ls, oi: currentOI,
          oiChangePct: prevOI > 0 ? parseFloat(((currentOI - prevOI) / prevOI * 100).toFixed(2)) : null,
          rsi: parseFloat(rsi.toFixed(1)), score: parseFloat(finalScore.toFixed(1)),
          maStack: maStack.stack, wasAlerted: false,
        });
      } catch { }

      log(`${symbol} ${direction} score:${finalScore} mom:${momentum.momentumPct.toFixed(1)}% candle:${trap.candle?.verdict || 'N/A'}`);

      const existing = coinTracker.get(symbol);
      const snap = { price, funding, oi: currentOI, ls, vol: volume.spike, score: finalScore, time: Date.now() };

      if (!existing) {
        coinTracker.set(symbol, { 
          symbol, direction, state: 'WATCHING', scanCount: 1, score: finalScore, 
          layers, hype, absorption, firstSeen: Date.now(), firstSeenPrice: price, 
          priceChangePct: 0, lastUpdated: Date.now(), history: [snap], 
          entryPrice: null, earlyEntry: null, tp1Price: null 
        });
      } else {
        if (direction !== existing.direction) {
          if (existing.entryPrice) await postSignal(`⚠️ <b>NEXIO — SIGNAL FADING</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n❌ Direction reversed — exit now\n📍 Entry: $${fmtP(existing.entryPrice)} → Now: $${fmtP(price)}\n⏰ ${gstNow()} GST`);
          coinTracker.delete(symbol);
          continue;
        }
        existing.history.push(snap);
        existing.scanCount++;
        existing.lastUpdated = Date.now();
        existing.score  = finalScore;
        existing.layers = layers;
        existing.hype   = hype;
        existing.absorption = absorption;
        existing.state  = finalScore >= 8 ? 'FIRE' : finalScore >= 6 ? 'CONFIRMING' : 'WATCHING';
        if (!existing.firstSeenPrice) existing.firstSeenPrice = price;
        existing.priceChangePct = ((price - existing.firstSeenPrice) / existing.firstSeenPrice) * 100;
        if (direction === 'SHORT') existing.priceChangePct = -existing.priceChangePct;
        coinTracker.set(symbol, existing);
      }

      const state = coinTracker.get(symbol);
      if (!state) continue;

      if (isMemeCoin(symbol)) {
        log(`MEME-SKIP: ${symbol}`);
        coinTracker.delete(symbol);
        continue;
      }

      const profile = await getCoinProfile(symbol);

      // v5.24 LAYER 1: Hard block on HOSTILE direction history
      const hostile = checkHostileDirection(profile, direction);
      if (hostile.block) {
        incBlock('hostileDirection');
        log(`HOSTILE-BLOCK: ${symbol} ${direction} — ${hostile.reason}`);
        coinTracker.delete(symbol);
        continue;
      }

      // v5.24 LAYER 2: Score adjustment
      const scoreAdj = calcScoreAdjustment(profile, direction);
      if (scoreAdj.adjustment !== 0) {
        log(`SCORE-ADJ: ${symbol} ${direction} ${scoreAdj.adjustment > 0 ? '+' : ''}${scoreAdj.adjustment} (${scoreAdj.reason})`);
      }
      const effectiveMinFire = MIN_FIRE_SCORE + scoreAdj.adjustment;
      const effectiveMinAlert = MIN_ALERT_SCORE + scoreAdj.adjustment;
      const effectiveMinEarly = MIN_EARLY_SCORE + scoreAdj.adjustment;

      // ── GUARDS ────────────────────────────────────────────────────────────
      const block = isBlocked(symbol);
      const btcSupportive = isLong ? (btc.bullishOk !== false) : (btc.bearishOk !== false);
      if (!btcSupportive) incBlock('btcDrag'); log(`BTC-DRAG: ${symbol} ${direction} — BTC 1H ${btc.change1H?.toFixed(2)}% against`);

      const pumpCheck = checkRecentPump(klines, price);
      if (pumpCheck.pumped) {
        incBlock('pumped'); log(`NO-CHASE: ${symbol} pumped ${pumpCheck.pct}% in ${pumpCheck.window}`);
        pumpTracker.set(symbol, { pumpedAt: Date.now(), pct: pumpCheck.pct });
      }
      const pumpCD = pumpTracker.get(symbol);
      const inPumpCooldown = pumpCD && (Date.now() - pumpCD.pumpedAt) < (PUMP_COOLDOWN_MIN * 60000);
      if (inPumpCooldown) {
        const minsLeft = Math.ceil(PUMP_COOLDOWN_MIN - (Date.now() - pumpCD.pumpedAt) / 60000);
        incBlock('pumpCooldown'); log(`PUMP-COOLDOWN: ${symbol} skip ${minsLeft}min`);
      }

      const lowLiq = isLowLiquiditySession();
      if (lowLiq && state.scanCount === 1) incBlock('lowLiq'); log(`LOW-LIQ: ${symbol}`);

      const regime    = classifyRegime(klines);
      const prevPrice = klines.length >= 2 ? parseFloat(klines[klines.length-2][4]) : price;
      const oiClass   = classifyOI(currentOI, prevOI, price, prevPrice, funding, trap.candle);
      const ext       = checkExtension(klines, price, atr);

      // ═══════════════════════════════════════════════════════════════════════
      // v6.00 CRITICAL FIX #9: EARLY ENTRY — much easier to trigger
      // ═══════════════════════════════════════════════════════════════════════
      const earlyBtcOk = isLong ? (btc.change1H > -0.3) : (btc.change1H < 0.3);
      if (
        btc.pass &&
        earlyBtcOk &&
        (early.isEarly || absorption.absorbing) &&
        (early.earlyScore >= 1 || absorption.absorbing) &&  // was >= 2, now >= 1
        finalScore >= effectiveMinEarly &&                   // was 5+adj, now 4+adj
        !ext.tooExtended &&
        btcRegime.regime !== 'CHOPPY' &&
        !pumpCheck.pumped &&
        !inPumpCooldown &&
        !(direction === 'LONG' && climax.climax) &&
        getOpenDirectionCount(direction) < MAX_SAME_DIRECTION &&
        !dumpTrap.isTrap &&
        !newsEvent &&
        state.scanCount >= 1 &&
        alertsFired < 2
      ) {
        const earlyKey = `early_${symbol}`;
        if (canAlert(earlyKey)) {
          state.earlyEntry = price;
          const tp1e = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
          state.tp1Price = tp1e;
          await postSignal(buildEarlyMsg(symbol, price, finalScore, direction, layers, htf, sweep, atr, btc, hype, profile) + econCautionTag());
          markAlert(earlyKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now(), type: 'EARLY', atr, tp1: tp1e });
          alertsFired++;
          log(`⚡ EARLY: ${symbol} ${direction} score:${finalScore} earlyScore:${early.earlyScore} momentum:${momentum.momentumPct.toFixed(1)}%`);
          const slEarly = isLong ? price - atr * UNIFIED_SL_ATR : price + atr * UNIFIED_SL_ATR;
          const tp2Early = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
          await logPaperTrade({ symbol, direction, type: 'EARLY', price, sl: slEarly, tp1: tp1e, tp2: tp2Early, score: finalScore, candle: trap.candle?.verdict, btcChange: btc.change });
        }
      }

      // ── STAGE 1 — WATCH alert ─────────────────────────────────────────────
      if ((state.scanCount === 2 && finalScore >= 6) || (state.scanCount === 1 && finalScore >= 7.5)) {
        const watchKey = `watch_${symbol}`;
        if (canAlert(watchKey)) { await postSignal(buildWatchMsg(symbol, finalScore, direction, layers, btc, hype)); markAlert(watchKey); }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // v6.00 CRITICAL FIX #10: FIRE — faster, relaxed candle gate
      // ═══════════════════════════════════════════════════════════════════════
      const breakoutConfirmed = (() => {
        if (klines.length < 3) return false;
        const breakoutCandle = klines[klines.length - 2];
        const confirmCandle  = klines[klines.length - 1];
        const breakO  = parseFloat(breakoutCandle[1]);
        const breakC  = parseFloat(breakoutCandle[4]);
        const breakH  = parseFloat(breakoutCandle[2]);
        const breakL  = parseFloat(breakoutCandle[3]);
        const confC   = parseFloat(confirmCandle[4]);
        const confL   = parseFloat(confirmCandle[3]);
        const breakMove  = Math.abs((breakC - breakO) / breakO) * 100;
        const breakRange = breakH - breakL;
        const breakBody  = breakRange > 0 ? (Math.abs(breakC - breakO) / breakRange) * 100 : 0;
        const lastVols = klines.slice(-11, -1).map(k => parseFloat(k[5]));
        const avgVol   = lastVols.reduce((a,b) => a+b, 0) / lastVols.length;
        const breakVol = parseFloat(breakoutCandle[5]);
        const volSpike = avgVol > 0 && breakVol > avgVol * 1.5;
        const validBreak = (isLong ? breakC > breakO : breakC < breakO) && breakMove >= 0.3 && breakBody >= 35 && volSpike;
        const holds = isLong ? confL >= breakC * 0.997 : confH <= breakC * 1.003;
        return validBreak && holds;
      })();

      // v6.00 FIX: Relaxed candle gate — WEAK allowed at score >= 6.5 (was 8)
      const candleOk = trap.candle?.verdict === 'STRONG' || (trap.candle?.verdict === 'WEAK' && finalScore >= 6.5);
      
      const regimeWarn = !regime.allowFire ? `regime:${regime.regime}` : '';
      const oiWarn     = oiClass.type === 'trap' ? 'OI:trap' : '';
      const extWarn    = ext.tooExtended ? `ext:${ext.reason}` : '';
      const warnings   = [regimeWarn, oiWarn, extWarn].filter(Boolean).join(' | ');
      if (warnings) log(`WARN: ${symbol} — ${warnings} (not blocking)`);

      // v6.00 FIX: Faster entry — bullConfirmed needs only 30min (was 60min)
      // scanCount >= 1 always allowed if score is high enough
      const bullConfirmed = btcRegime.regime === 'BULLISH' && direction === 'LONG'
        && (Date.now() - (btcRegime.changedAt || 0)) > 30*60000;  // was 60min
      // v6.00 FIX: scanCount >= 1 if bullConfirmed OR score >= 7.5 (was 8.5)
      const scanCountOk = bullConfirmed ? (state.scanCount >= 1) : (state.scanCount >= 1 || finalScore >= 7.5);

      // v6.00 FIX: Main FIRE condition — lower score threshold, relaxed requirements
      if (block.blocked) {
        log(`BLOCKED: ${symbol} — ${block.reason}`);
      } else if (finalScore >= effectiveMinFire && shouldBlockFireOnCaution(profile, direction)) {
        incBlock('fireCaution');
        log(`FIRE-CAUTION: ${symbol} ${direction} score=${finalScore} verdict=${profile?.verdict}`);
      } else if (
        btc.pass && 
        btcRegime.regime !== 'CHOPPY' && 
        btcSupportive && 
        !pumpCheck.pumped && 
        !inPumpCooldown && 
        !(direction === 'LONG' && climax.climax) && 
        getOpenDirectionCount(direction) < MAX_SAME_DIRECTION && 
        !lowLiq && 
        !dumpTrap.isTrap && 
        !newsEvent && 
        (atrExp.expanding || finalScore >= 7.0) &&  // was 7.5
        finalScore >= effectiveMinFire && 
        !shouldBlockFireOnCaution(profile, direction) && 
        scanCountOk && 
        trap.safe && 
        candleOk && 
        breakoutConfirmed && 
        !ext.tooExtended && 
        alertsFired < 2
      ) {
        const fireKey = `fire_${symbol}`;
        if (canAlert(fireKey)) {
          state.entryPrice = price;
          state.state = 'FIRE';
          const tp1f = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
          state.tp1Price = tp1f;
          await postSignal(buildFireMsg(symbol, price, finalScore, direction, layers, state.scanCount, btc, klines, hype, profile) + econCautionTag());
          markAlert(fireKey);
          signalPrices.set(symbol, { price, direction, firedAt: Date.now(), type: 'FIRE', atr, tp1: tp1f });
          alertsFired++;
          log(`🚀 FIRED: ${symbol} ${direction} score:${finalScore} candle:${trap.candle?.verdict} momentum:${momentum.momentumPct.toFixed(1)}%`);
          const slFire = isLong ? price - atr * UNIFIED_SL_ATR : price + atr * UNIFIED_SL_ATR;
          const tp2Fire = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
          await logPaperTrade({ symbol, direction, type: 'FIRE', price, sl: slFire, tp1: tp1f, tp2: tp2Fire, score: finalScore, candle: trap.candle?.verdict, btcChange: btc.change });
        }
      } else if (btc.pass && finalScore >= MIN_ALERT_SCORE && state.scanCount >= 1) {
        const reasons = [];
        if (!breakoutConfirmed) reasons.push('no 1-bar confirm');
        if (!candleOk)          reasons.push(`candle:${trap.candle?.verdict}`);
        if (finalScore < effectiveMinFire) reasons.push(`score:${finalScore}<${effectiveMinFire.toFixed(1)}`);
        if (reasons.length)     log(`SKIP: ${symbol} — ${reasons.join(' | ')}`);
      }

      if (finalScore < 1.5 && state.scanCount >= 3) { coinTracker.delete(symbol); await removeFromWatchlist(symbol); }

      // ── LAYER 9 — Position Manager ───────────────────────────────────────
      const sig = signalPrices.get(symbol);
      if (sig) {
        const tp1Hit = sig.direction === 'LONG' ? price >= sig.tp1 : price <= sig.tp1;
        if (tp1Hit && !sig.breakevenSent) {
          sig.breakevenSent = true;
          signalPrices.set(symbol, sig);
          await postSignal(buildBreakevenMsg(symbol, sig.price, sig.tp1, sig.direction));
          log(`TP1 HIT: ${symbol}`);
        }

        const chg = sig.direction === 'LONG'
          ? ((sig.price - price) / sig.price) * 100
          : ((price - sig.price) / sig.price) * 100;

        const inProfitPct = sig.direction === 'LONG'
          ? ((price - sig.price) / sig.price) * 100
          : ((sig.price - price) / sig.price) * 100;

        // v6.00: Breakeven at +1.0% (was 0.5%)
        if (inProfitPct >= BREAKEVEN_TRIGGER_PCT && !sig.breakevenEarly) {
          await postSignal(`✅ <b>${symbol.replace('USDT','')} BREAKEVEN</b> — Move SL to entry $${fmtP(sig.price)}\n💰 +${BREAKEVEN_TRIGGER_PCT}% secured · Risk now zero\n⏰ ${gstNow()} GST`);
          sig.breakevenEarly = true;
          signalPrices.set(symbol, sig);
          log(`BREAKEVEN-EARLY: ${symbol} +${inProfitPct.toFixed(2)}%`);
        }

        // Milestone alerts
        const milestones = [
          { level: 1.0, key: 'm1', emoji: '💚', msg: 'Building momentum — hold for TP1', action: 'HOLD' },
          { level: 2.0, key: 'm2', emoji: '🟢', msg: 'TP1 zone — consider closing 30%', action: 'PARTIAL' },
          { level: 3.0, key: 'm3', emoji: '🚀', msg: 'Strong move — close 30% more', action: 'PARTIAL' },
          { level: 4.0, key: 'm4', emoji: '💎', msg: 'Big move — secure 50% profit', action: 'BIG' },
          { level: 5.0, key: 'm5', emoji: '🏆', msg: 'Huge move — close most, keep runner', action: 'HUGE' },
          { level: 7.0, key: 'm7', emoji: '⭐', msg: 'Exceptional move — close all', action: 'EXIT' },
        ];
        for (const m of milestones) {
          if (inProfitPct >= m.level && !sig[m.key]) {
            sig[m.key] = true;
            signalPrices.set(symbol, sig);
            await postSignal(`${m.emoji} <b>${symbol.replace('USDT','')} +${m.level}%</b>\n${m.msg}\nCurrent: +${inProfitPct.toFixed(2)}%\n⏰ ${gstNow()} GST`);
            log(`MILESTONE +${m.level}%: ${symbol}`);
          }
        }

        // Momentum fade warning
        if (sig.trailingHigh && sig.trailingHigh > 1.5) {
          const retracedFromPeak = sig.trailingHigh - inProfitPct;
          if (retracedFromPeak >= 0.7 && !sig.fadeAlert && inProfitPct > 0) {
            sig.fadeAlert = true;
            signalPrices.set(symbol, sig);
            await postSignal(`⚠️ <b>${symbol.replace('USDT','')} MOMENTUM FADING</b>\n🎯 Peak: +${sig.trailingHigh.toFixed(2)}%\n📉 Current: +${inProfitPct.toFixed(2)}%\n💡 Consider closing\n⏰ ${gstNow()} GST`);
            log(`FADE-ALERT: ${symbol}`);
          }
        }

        // Trailing stop
        if (inProfitPct >= 1.5) {
          if (!sig.trailingHigh || inProfitPct > sig.trailingHigh) {
            sig.trailingHigh = inProfitPct;
            signalPrices.set(symbol, sig);
          }
          if (sig.trailingHigh && sig.trailingHigh - inProfitPct > 0.5 && !sig.trailingExitSent) {
            await postSignal(`📉 <b>${symbol.replace('USDT','')} TRAILING STOP</b>\n🎯 Peak: +${sig.trailingHigh.toFixed(2)}%  Current: +${inProfitPct.toFixed(2)}%\n💰 Lock in profit — exit\n⏰ ${gstNow()} GST`);
            sig.trailingExitSent = true;
            signalPrices.set(symbol, sig);
            const pnl = Math.max(0.5, inProfitPct - 0.5);
            dailyLosses.dailyProfitPct += pnl;
            recordWin(symbol, pnl);
            log(`TRAILING-WIN: ${symbol} +${pnl.toFixed(2)}%`);
            try {
              await sb(`paper_trades?symbol=eq.${symbol}&status=eq.OPEN`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'TRAILING_EXIT', outcome: 'WIN', closed_price: price, closed_at: new Date().toISOString() }),
              });
            } catch (e) { }
          }
        }

        // Force exit after 6 hours
        const hoursHeld = (Date.now() - sig.firedAt) / 3600000;
        if (hoursHeld >= 6 && !sig.timeoutSent) {
          await postSignal(`⏰ <b>${symbol.replace('USDT','')} TIME EXIT</b>\n6 hours held — close position\n📊 Current: ${inProfitPct > 0 ? '+' : ''}${inProfitPct.toFixed(2)}%\n⏰ ${gstNow()} GST`);
          sig.timeoutSent = true;
          if (inProfitPct > 0) {
            dailyLosses.dailyProfitPct += inProfitPct;
            recordWin(symbol, inProfitPct);
          } else {
            dailyLosses.totalPnlPct += inProfitPct;
          }
          signalPrices.delete(symbol);
          log(`TIME-EXIT: ${symbol} ${inProfitPct.toFixed(2)}%`);
          try {
            await sb(`paper_trades?symbol=eq.${symbol}&status=eq.OPEN`, {
              method: 'PATCH',
              body: JSON.stringify({ status: 'TIMEOUT', outcome: inProfitPct > 0 ? 'WIN' : 'LOSS', closed_price: price, closed_at: new Date().toISOString() }),
            });
          } catch { }
          continue;
        }

        // Emergency exit
        const fadeThreshold = sig.atr ? (sig.atr / sig.price) * 100 * 1.2 : FADE_THRESHOLD_PCT;
        if (!btc.pass && Date.now() - sig.firedAt < 3600000) {
          await postSignal(`🚨 <b>NEXIO — EMERGENCY EXIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n⚠️ BTC momentum reversed!\n${btc.reason}\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n⏰ ${gstNow()} GST`);
          recordLoss(symbol);
          signalPrices.delete(symbol);
        } else if (chg >= fadeThreshold && !sig.breakevenSent) {
          await postSignal(`⚠️ <b>NEXIO — SL HIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n📉 Down ${chg.toFixed(1)}% from entry\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n🛑 Stop triggered\n⏰ ${gstNow()} GST`);
          recordLoss(symbol);
          signalPrices.delete(symbol);
        }
      }
    }

    if (watchlistScanCount % 3 === 0 && coinTracker.size > 0) {
      // Priority list simplified (removed buildPriorityList for brevity)
      const sorted = [...coinTracker.values()].filter(c => c.state !== 'FADING' && c.score >= 6).sort((a, b) => b.score - a.score).slice(0, 10);
      if (sorted.length > 0) {
        let msg = `📊 <b>NEXIO PRIORITY LIST</b>\n━━━━━━━━━━━━━━━\n`;
        sorted.forEach((s, i) => {
          const rank = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
          msg += `${rank} ${s.direction==='LONG'?'📈':'📉'} <b>${s.symbol.replace('USDT','')}</b> — ${s.state==='FIRE'?'🔥':s.state==='CONFIRMING'?'⚡':'👀'} ${s.score}/10\n`;
        });
        msg += `━━━━━━━━━━━━━━━\n⏰ ${gstNow()} GST`;
        await postSignal(msg);
      }
    }

    const fire = [...coinTracker.values()].filter(c => c.state === 'FIRE').length;
    const conf = [...coinTracker.values()].filter(c => c.state === 'CONFIRMING').length;
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

  if (text === '/start') {
    await tg(chatId, `👋 <b>Welcome to Nexio v6.00!</b>\n━━━━━━━━━━━━━━━\n🚀 FIXED: Earlier entry, better R:R 1:2.08\n🚀 FIXED: Tighter SL 1.2x, bigger TP1 2.5x\n🚀 FIXED: Momentum scoring layer\n🚀 FIXED: Relaxed trap penalties\n\n/status — Server status\n/stats — Paper trade stats\n/help — All commands\n🐆 Nexio v6.00`);
  }
  else if (text === '/status') {
    const wl = await getWatchlist();
    await tg(chatId, `📊 <b>Nexio v6.00 Status</b>\n━━━━━━━━━━━━━━━\n🤖 Online ✅\n👁 Watchlist: ${wl.length} | Tracking: ${coinTracker.size}\n🌐 BTC: ${btcGateStatus.pass ? '✅' : '❌'} ${btcGateStatus.reason}\n📐 SL: ${UNIFIED_SL_ATR}x ATR | TP1: ${UNIFIED_TP1_ATR}x | TP2: ${UNIFIED_TP2_ATR}x\n📊 Min FIRE: ${MIN_FIRE_SCORE} | Min EARLY: ${MIN_EARLY_SCORE}\n🕯 Candle wick detector: ✅\n⏰ ${gstNow()} GST`);
  }
  else if (text === '/stats') {
    const all = (await sb('paper_trades?select=*')) || [];
    const closed = all.filter(t => t.status !== 'OPEN');
    const wins = closed.filter(t => t.outcome === 'WIN').length;
    const losses = closed.filter(t => t.outcome === 'LOSS').length;
    const total = closed.length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const longs = closed.filter(t => t.direction === 'LONG');
    const shorts = closed.filter(t => t.direction === 'SHORT');
    const longWR = longs.length > 0 ? ((longs.filter(t => t.outcome === 'WIN').length / longs.length) * 100).toFixed(1) : '0';
    const shortWR = shorts.length > 0 ? ((shorts.filter(t => t.outcome === 'WIN').length / shorts.length) * 100).toFixed(1) : '0';
    await tg(chatId, `📒 <b>Nexio v6.00 Paper Stats</b>\n━━━━━━━━━━━━━━━\n🟢 Wins:   ${wins}\n🔴 Losses: ${losses}\n📊 Total:  ${total}\n\n🎯 <b>Win Rate: ${winRate}%</b>\n📈 LONG WR:  ${longWR}% (${longs.length})\n📉 SHORT WR: ${shortWR}% (${shorts.length})\n\n📐 R:R TP1 = 1:${(UNIFIED_TP1_ATR/UNIFIED_SL_ATR).toFixed(2)}\n📐 Break-even WR: ${(100/(1+UNIFIED_TP1_ATR/UNIFIED_SL_ATR)).toFixed(1)}%\n\n${total < 20 ? '⏳ Need 20+ trades for reliable data' : parseFloat(winRate) >= 55 ? '✅ Strategy working' : parseFloat(winRate) >= 35 ? '🟡 Below target — check entries' : '❌ Strategy needs tuning'}`);
  }
  else if (text === '/regime') {
    const r = btcRegime;
    const emoji = r.regime === 'BULLISH' ? '🟢' : r.regime === 'BEARISH' ? '🔴' : '🟡';
    await tg(chatId, `${emoji} <b>BTC Regime: ${r.regime}</b>\n━━━━━━━━━━━━━━━\n${r.reason || 'no data'}\nConfidence: ${r.confidence}%\n⏰ ${gstNow()} GST`);
  }
  else if (text === '/help') {
    await tg(chatId, `📖 <b>Nexio v6.00 Commands</b>\n/start /status /stats /regime /help\n🐆 Nexio v6.00 — Fixed Edition`);
  }
  else if (text === '/test') {
    const btc = await checkBTCGate();
    const sizeHint = getPositionSizeHint();
    await postSignal(`🧪 <b>NEXIO v6.00 — TEST</b>\n━━━━━━━━━━━━━━━\n✅ Bot online (PAPER MODE)\n✅ v6.00 Surgeon Fix active\n✅ SL ${UNIFIED_SL_ATR}x | TP1 ${UNIFIED_TP1_ATR}x | R:R 1:${(UNIFIED_TP1_ATR/UNIFIED_SL_ATR).toFixed(2)}\n✅ Min FIRE: ${MIN_FIRE_SCORE} | Min EARLY: ${MIN_EARLY_SCORE}\n✅ Position: ${sizeHint.label}\n${btc.emoji} BTC Gate: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n⏰ ${gstNow()} GST\n🐆 Nexio v6.00`);
    await tg(chatId, '✅ Test sent!');
  }

  if (chatId === OWNER_CHAT_ID) {
    if (text === '/fullscan')     { await tg(chatId, '🌍 Running...'); runFullMarketScan(); }
    if (text === '/scan')         { await tg(chatId, '👁 Running...'); runWatchlistScan(); }
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
  const modeLabel = PAPER_MODE ? '📒 PAPER MODE' : '🟢 LIVE MODE';
  log(`🚀 Nexio v6.00 — Surgeon Fix Starting... ${modeLabel}`);
  const btc = await checkBTCGate();
  const sizeHint = getPositionSizeHint();
  await tg(OWNER_CHAT_ID, `🟢 <b>Nexio v6.00 Started</b>
━━━━━━━━━━━━━━━
🔧 SURGEON FIXES APPLIED:
✅ SL: ${UNIFIED_SL_ATR}x ATR (was 1.8)
✅ TP1: ${UNIFIED_TP1_ATR}x ATR (was 2.0) → R:R 1:${(UNIFIED_TP1_ATR/UNIFIED_SL_ATR).toFixed(2)}
✅ FIRE threshold: ${MIN_FIRE_SCORE} (was 7.5)
✅ EARLY threshold: ${MIN_EARLY_SCORE} (was 5.0)
✅ Momentum scoring: ACTIVE
✅ Trap penalties: REDUCED
✅ Faster scan trigger: scanCount ≥ 1
✅ Recovery sizing: ${sizeHint.label}
${btc.emoji} BTC: ${btc.pass?'✅ PASS':'❌ BLOCKED'}
⏰ ${gstNow()} GST
━━━━━━━━━━━━━━━
/fullscan /scan /stats /test /help`);

  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);
  setInterval(() => { cleanupPumpTracker(); cleanupSignalPrices(); cleanupCoinTracker(); }, 600000);
  setInterval(checkDailySummary, 1800000);
  setInterval(checkAnomalies, 3600000);
  await checkBTCRegime();
  setInterval(checkBTCRegime, 300000);
  await checkBTCCycle();
  setInterval(checkBTCCycle, 900000);
  await checkBTCEarlyWarning();
  setInterval(checkBTCEarlyWarning, 300000);
  setInterval(checkPaperOutcomes, 600000);
};

start();
