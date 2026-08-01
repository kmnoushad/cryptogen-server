import http from 'http';
import('node:dns').then(m => (m.default || m).setDefaultResultOrder('ipv4first')).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v5.44 — THE PUMP CATCHER (CRASH-FIXED)
//
// FIXES APPLIED:
// 1. Added HTTP health-check server (binds immediately so platform won't SIGTERM)
// 2. Added missing stubs: checkWeeklyDrawdown, isBlocked, recordWin, recordLoss,
//    dailyLosses, LOSS_COOLDOWN, addToChannel
// 3. Fixed template-literal syntax error in buildMomentumMsg
// 4. Added graceful SIGTERM shutdown handler
// 5. Fixed /profile command using observations24h (changed to observations)
// 6. ES MODULE: replaced require('http') with import http from 'http'
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = (process.env.BOT_TOKEN || '').trim();
const FREE_CHANNEL    = (process.env.FREE_CHANNEL    || '-1003900595640').trim();
const PREMIUM_CHANNEL = (process.env.PREMIUM_CHANNEL || '-1003913881352').trim();
const OWNER_CHAT_ID   = (process.env.OWNER_CHAT_ID   || '6896387082').trim();

const PAPER_TEST_USERS = [];

const PAPER_MODE = true;
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = (process.env.SUPABASE_URL || 'https://jxsvqxnbjuhtenmarioe.supabase.co').trim().replace(/\/+$/, '');
const SUPABASE_KEY    = (process.env.SUPABASE_KEY || '').trim();
const FINNHUB_KEY     = (process.env.FINNHUB_KEY || '').trim();

(() => {
  const missing = [];
  if (!BOT_TOKEN)    missing.push('BOT_TOKEN');
  if (!SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (missing.length) {
    console.error(`[FATAL] Missing required env variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!FINNHUB_KEY) {
    console.warn('[WARN] FINNHUB_KEY not set — economic calendar will use fallback hardcoded dates only.');
  }
})();

const FULL_MARKET_INTERVAL_MS = 180000; // v5.44: 3 min (was 5)
const WATCHLIST_SCAN_INTERVAL = 90000;  // v5.44: 90s (was 2 min)
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 900000; // 15 min
const MOMENTUM_COOLDOWN_MS    = 1800000; // 30 min between momentum signals
const MIN_VOLUME_USD          = 100000; // v5.44: lower to catch low-caps earlier
const MAX_WATCHLIST           = 50;
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 1.2;
const MIN_ALERT_SCORE         = 6.5;
const MIN_FIRE_SCORE          = 7.5;

// v5.44: R:R recalibrated for scalp reality (avg peak +1.49%)
const UNIFIED_SL_ATR  = 1.0;  // was 1.2 — cut losers faster
const UNIFIED_TP1_ATR = 1.0;  // was 1.2 — reachable target
const UNIFIED_TP2_ATR = 2.0;  // was 2.5
const UNIFIED_TP3_ATR = 4.0;  // was 5.0

// v5.44: Meme blacklist — BUT momentum path can override with strict filters
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
const PUMP_EXCLUDE_PCT        = 35.0; // v5.44: allow hotter coins (was 25)

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

// ── MISSING STUBS (prevent ReferenceError crashes) ───────────────────────────
const checkWeeklyDrawdown = async () => { /* stub — add weekly drawdown logic here */ };
const addToChannel = async (chatId, channelId) => { log(`📋 addToChannel stub: ${chatId} → ${channelId}`); };
const dailyLosses = { dailyProfitPct: 0, totalPnlPct: 0 };
const recordWin = (symbol, pct) => { log(`🏆 WIN recorded: ${symbol} +${pct?.toFixed?.(2) || pct}%`); };
const recordLoss = (symbol) => { log(`💔 LOSS recorded: ${symbol}`); };
const LOSS_COOLDOWN = 30; // minutes
const isBlocked = (symbol) => ({ blocked: false, reason: '' });

const alertHistory  = new Map();
const coinTracker   = new Map();
const signalPrices  = new Map();

const cleanupAlertHistory = () => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let cleaned = 0;
  for (const [k, ts] of alertHistory) if (ts < cutoff) { alertHistory.delete(k); cleaned++; }
  if (economicEventNotified.size > 200) economicEventNotified.clear();
  if (cleaned > 0) log(`🧹 alertHistory pruned: ${cleaned} stale keys`);
};

const cleanupSignalPrices = () => {
  const cutoff = Date.now() - 4 * 3600 * 1000;
  let cleaned = 0;
  for (const [k, v] of signalPrices.entries()) {
    if (v.firedAt < cutoff) { signalPrices.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`🧹 Signal prices cleaned: ${cleaned} expired signals`);
};

const cleanupCoinTracker = () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let cleaned = 0;
  for (const [symbol, state] of coinTracker.entries()) {
    const lastSeen = state.lastUpdated || state.firstSeen || 0;
    if (lastSeen < cutoff) { coinTracker.delete(symbol); cleaned++; }
  }
  if (cleaned > 0) log(`🧹 Coin tracker cleaned: ${cleaned} stale entries (size: ${coinTracker.size})`);
};

const getOpenDirectionCount = (direction) => {
  let count = 0;
  const cutoffMs = Date.now() - 4 * 3600 * 1000;
  for (const [, sig] of signalPrices.entries()) {
    if (sig.direction === direction && sig.firedAt > cutoffMs) count++;
  }
  return count;
};
const resistanceMap = new Map();
let   lastUpdateId  = 0;
let   fullScanCount      = 0;
let   watchlistScanCount = 0;
let   btcGateStatus      = { pass: true, reason: 'Starting up', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };

const sleep   = ms => new Promise(r => setTimeout(r, ms));

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

const isLowLiquiditySession = () => {
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  return hour >= 1 && hour < 5;
};
const canAlert  = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > ALERT_COOLDOWN_MS;
const canAlertMomentum = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > MOMENTUM_COOLDOWN_MS;
const markAlert = k => alertHistory.set(k, Date.now());

// ── Economic Calendar (unchanged core, kept compact) ─────────────────────────
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
      log(`📅 Finnhub: loaded ${liveEconomicEvents.length} US high-impact events`);
    }
  } catch (err) {
    log(`⚠️ Finnhub fetch failed: ${err.message} — using hardcoded fallback`);
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
  return `\n\n⚠️ <b>CAUTION:</b> ${ev.name} ${ev.phase === 'BEFORE' ? `in ~${ev.minsUntil}min` : 'happening now'} — high-impact data window. Use tight SL, reduce size, the move is fast.`;
};
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
    for (const ev of allUpcoming) msg += `🕐 ${eventTimeDubai(ev.evTime)} Dubai — ${ev.name}\n`;
    msg += `\nReminders will follow at 4hr, 1hr, then every 15min.\n<i>Plan your positions around these windows.</i>`;
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
      { at: 15,  tol: 2, label: '15 minutes', emoji: '🔴', extra: 'FINAL WARNING — tighten SL now, the move is fast.' },
      { at: 0,   tol: 2, label: 'NOW',        emoji: '🔴', extra: 'DATA DROPPING — expect sharp volatility either direction.' },
    ];
    for (const st of stages) {
      const stageKey = `${ev.key}@${st.at}`;
      if (Math.abs(minsUntil - st.at) <= st.tol && !eventReminderSent.has(stageKey)) {
        eventReminderSent.add(stageKey);
        const timing = st.at === 0 ? 'happening NOW' : `in ~${st.label}`;
        await tg(OWNER_CHAT_ID,
          `${st.emoji} <b>${ev.name.toUpperCase()}</b> — ${timing}\n━━━━━━━━━━━━━━━\n` +
          `🕐 ${eventTimeDubai(ev.evTime)} Dubai\n\n${st.extra}\n\n<i>Tight SL · reduce size · don't chase the first candle</i>\n⏰ ${gstNow()} GST`);
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

// ── ATR / EMA (unchanged math) ────────────────────────────────────────────────
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
const calcEMAFromCloses = (closes, period) => {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
};
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
      reason: bullish ? `${pctAbove.toFixed(1)}% above EMA50${ema200ok ? ' ✅' : ' ⚡'}` : bearish ? `${Math.abs(pctAbove).toFixed(1)}% below EMA50${ema200ok ? ' ✅' : ' ⚡'}` : `hugging EMA50 ±0.5% — choppy ⚠️`,
    };
  } catch {
    return { bullish: true, bearish: true, ema50: null, ema200: null, reason: 'data error' };
  }
};
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

// ── v5.44 TAKER BUY/SELL RATIO — from klines[9], zero extra API calls ───────
const checkTakerRatio = (klines) => {
  if (!klines || klines.length < 3) return { ratio: 0.5, trend: 'flat', fake: false, tag: '' };
  const recent = klines.slice(-3);
  let totalVol = 0, takerBuy = 0;
  for (const k of recent) {
    totalVol += parseFloat(k[5]);
    takerBuy += parseFloat(k[9] || 0); // index 9 = taker buy base volume
  }
  const ratio = totalVol > 0 ? takerBuy / totalVol : 0.5;
  const lastClose = parseFloat(recent[2][4]);
  const lastOpen = parseFloat(recent[2][1]);
  const isGreen = lastClose >= lastOpen;
  // Fake pump: price up but taker ratio < 45% = distribution / passive buying only
  const fake = isGreen && ratio < 0.45;
  const tag = ratio > 0.60 ? `🟢Taker${(ratio*100).toFixed(0)}%` : ratio < 0.45 ? `🔴Taker${(ratio*100).toFixed(0)}%` : `⚪Taker${(ratio*100).toFixed(0)}%`;
  return { ratio: parseFloat(ratio.toFixed(2)), trend: ratio > 0.55 ? 'buying' : ratio < 0.45 ? 'selling' : 'flat', fake, tag };
};

// ── v5.44 PARABOLIC / MOMENTUM DETECTOR — catches GIGGLE/COTI style pumps ─────
const checkParabolic = (klines) => {
  if (!klines || klines.length < 8) return { isParabolic: false, score: 0, accel: 0, volSpike: 0, takerRatio: 0.5, rugRisk: false, candles: [] };
  const last3 = klines.slice(-3);
  const prev3 = klines.slice(-6, -3);
  
  const c1 = ((parseFloat(last3[0][4]) - parseFloat(last3[0][1])) / parseFloat(last3[0][1])) * 100;
  const c2 = ((parseFloat(last3[1][4]) - parseFloat(last3[1][1])) / parseFloat(last3[1][1])) * 100;
  const c3 = ((parseFloat(last3[2][4]) - parseFloat(last3[2][1])) / parseFloat(last3[2][1])) * 100;
  
  const v1 = parseFloat(last3[0][5]);
  const v2 = parseFloat(last3[1][5]);
  const v3 = parseFloat(last3[2][5]);
  const avgPrev = prev3.reduce((s,k) => s + parseFloat(k[5]), 0) / 3;
  const volSpike = avgPrev > 0 ? v3 / avgPrev : 0;
  
  const takerRecent = last3.reduce((s,k) => s + parseFloat(k[9] || 0), 0);
  const volRecent = last3.reduce((s,k) => s + parseFloat(k[5]), 0);
  const takerRatio = volRecent > 0 ? takerRecent / volRecent : 0.5;
  
  // Rug risk checks
  const range = parseFloat(last3[2][2]) - parseFloat(last3[2][3]);
  const body = Math.abs(parseFloat(last3[2][4]) - parseFloat(last3[2][1]));
  const wickPct = range > 0 ? ((range - body) / range) * 100 : 0;
  const isGreen = parseFloat(last3[2][4]) >= parseFloat(last3[2][1]);
  // Blow-off: candle 3 is >3x candle 2 and candle 2 was tiny = exhaustion
  const blowOff = c3 > c2 * 3 && c2 < 0.3;
  const rugRisk = (isGreen && wickPct > 55) || (isGreen && takerRatio < 0.40) || blowOff || (c3 > 8.0); // >8% in 5m = likely blow-off top
  
  let score = 0;
  if (c1 > 0 && c2 > c1 && c3 > c2) score += 3;
  else if (c2 > 0 && c3 > c2) score += 2;
  else if (c3 > 1.0) score += 1;
  
  if (v3 > v2 && v2 > v1) score += 2;
  else if (v3 > avgPrev * 2) score += 1.5;
  
  if (takerRatio > 0.60) score += 2;
  else if (takerRatio > 0.52) score += 1;
  
  if (!rugRisk) score += 1;
  if (isGreen && c3 > 0) score += 0.5;
  
  // For meme coins, require much higher conviction
  const isMeme = false; // checked outside
  
  const isParabolic = score >= 5 && c3 >= 0.8 && volSpike >= 1.3 && !rugRisk;
  
  return {
    isParabolic,
    score,
    accel: parseFloat(c3.toFixed(2)),
    volSpike: parseFloat(volSpike.toFixed(1)),
    takerRatio: parseFloat(takerRatio.toFixed(2)),
    rugRisk,
    candles: [c1,c2,c3]
  };
};

// ── Social Hype (unchanged) ───────────────────────────────────────────────────
let coinIdCache = { data: null, ts: 0 };
const buildCoinIdMap = async () => {
  const now = Date.now();
  if (coinIdCache.data && now - coinIdCache.ts < 86400000) return coinIdCache.data;
  try {
    const list = await fetchJSON('https://api.coingecko.com/api/v3/coins/list');
    const map = new Map();
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
const hypeCache = new Map();
const HYPE_CACHE_MS = 1800000;
const checkSocialHype = async (symbol) => {
  const sym = symbol.replace('USDT', '').toUpperCase();
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
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=false&community_data=true&developer_data=false&sparkline=false`;
    const data = await fetchJSON(url);
    if (!data) throw new Error('no data');
    const community = data.community_data || {};
    const twitter   = community.twitter_followers || 0;
    const reddit    = community.reddit_subscribers || 0;
    const telegram  = community.telegram_channel_user_count || 0;
    const sentiment = data.sentiment_votes_up_percentage || 0;
    const watchlist = data.watchlist_portfolio_users || 0;
    let hypeBonus = 0;
    const tags = [];
    if (sentiment >= 80)       { hypeBonus += 0.8; tags.push(`😊${sentiment.toFixed(0)}%bull`); }
    else if (sentiment >= 65)  { hypeBonus += 0.5; tags.push(`😊${sentiment.toFixed(0)}%bull`); }
    else if (sentiment > 0 && sentiment < 40) { hypeBonus -= 1; tags.push(`😟${sentiment.toFixed(0)}%bear`); }
    if (watchlist > 100000)     { hypeBonus += 1.0; tags.push(`⭐${Math.round(watchlist/1000)}k`); }
    else if (watchlist > 30000) { hypeBonus += 0.5; tags.push(`⭐${Math.round(watchlist/1000)}k
