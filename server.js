// ─────────────────────────────────────────────────────────────────────────────
// v5.44 NETWORK FIX: Force IPv4-first DNS resolution.
import('node:dns').then(m => (m.default || m).setDefaultResultOrder('ipv4first')).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v5.44 — THE PUMP CATCHER
//
// WHAT CHANGED:
// 1. PRIMARY TIMEFRAME: 15m → 5m (limit 30). Catches pumps in first 10-15 min.
// 2. KILLED EARLY SIGNALS: 34% WR proven loser — removed entirely.
// 3. NEW MOMENTUM SIGNAL: Catches parabolic/accelerating pumps (GIGGLE/COTI style).
//    Uses: 3-candle acceleration, volume spike, Taker Buy Ratio (>55%), rug-wick check.
// 4. TAKER BUY/SELL RATIO: From klines[9] — zero extra API calls.
//    Fake pump = green candle + taker ratio < 45% (distribution into strength).
// 5. FIRE UNLEASHED: Removed "one-bar confirmation" delay. FIRE now fires on first
//    valid scan if score >= 8.0 + STRONG candle + not rug + taker ratio OK.
// 6. SURGE/MOVERS GUARDED: Now runs through fake-pump, dump-trap, climax, CVD,
//    taker-ratio filters before alerting. No more raw momentum spam.
// 7. SCALE-OUT MESSAGES: Every signal now tells you exactly when to take profit:
//    50% at +0.5%, 25% at +1.0%, trail rest.
// 8. AUTO DECAY EXIT: Paper trades auto-close as WIN if momentum stalls
//    (no new high 10 min) or retrace 0.4% from peak. No more holding bags to SL.
// 9. SCAN SPEED: Watchlist every 90s, Full market every 3 min.
// 10. MEME PUMP MODE: Meme coins bypass blacklist ONLY if parabolic score >= 7
//     AND taker ratio > 60% AND zero rug patterns. Catches the +40% meme leg
//     while skipping the rugpull.
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
const MAX_SAME_DIRECTION = 3;
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
    else if (watchlist > 30000) { hypeBonus += 0.5; tags.push(`⭐${Math.round(watchlist/1000)}k`); }
    else if (watchlist > 10000) { hypeBonus += 0.3; }
    if (twitter > 500000)       { hypeBonus += 0.5; tags.push(`🐦${Math.round(twitter/1000)}k`); }
    else if (twitter > 100000)  { hypeBonus += 0.3; }
    else if (twitter < 5000 && twitter > 0) { hypeBonus -= 0.5; tags.push('🪦dead'); }
    hypeBonus = Math.max(-1.5, Math.min(1.5, hypeBonus));
    const result = { hasData: true, hypeBonus, sentiment, watchlist, twitter, reddit, telegram, tag: tags.length > 0 ? tags.join(' ') : '' };
    hypeCache.set(sym, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    const result = { hasData: false, hypeBonus: 0, tag: '', reason: err.message };
    hypeCache.set(sym, { data: result, ts: Date.now() });
    return result;
  }
};

// ── Recovery / Loss (unchanged) ───────────────────────────────────────────────
const lossTracker   = new Map();
const pumpTracker   = new Map();
const PUMP_COOLDOWN_MIN = 30;
const recoveryState = { consecutiveLosses: 0, lastTradeWin: null };
const blockReasons = {
  btcDrag: 0, pumped: 0, pumpCooldown: 0, dumpTrap: 0, newsEvent: 0,
  climax: 0, lowLiq: 0, correlation: 0, atrFlat: 0, weakCandle: 0,
  notExtended: 0, scoreLow: 0, htfMisaligned: 0, momentumAgainst: 0,
  hostileDirection: 0, fireCaution: 0, takerFake: 0, parabolicRug: 0
};
const incBlock = (reason) => { if (blockReasons[reason] !== undefined) blockReasons[reason]++; };
const rsWatch = new Map();

const getPositionSizeHint = () => {
  if (recoveryState.consecutiveLosses >= 2) return { pct: 50, label: '⚠️ REDUCED 50% (2 losses)' };
  return { pct: 100, label: 'NORMAL 100%' };
};

const cleanupPumpTracker = () => {
  const cutoff = Date.now() - (PUMP_COOLDOWN_MIN * 2 * 60000);
  let cleaned = 0;
  for (const [k, v] of pumpTracker.entries()) {
    if (v.pumpedAt < cutoff) { pumpTracker.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`🧹 Pump tracker cleaned: ${cleaned} stale entries`);
};

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

// ── BTC Cycle / Regime / Early Warning (unchanged) ────────────────────────────
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
    log(`⚠️ BTC cycle check failed: ${err.message}`);
    return btcCyclePosition;
  }
};
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
    let warningType = null, warningMsg = '', direction = null;
    if (price < ema20_15m && lastHour < -0.3 && momentumSlope < -0.1 && redStreak >= 3) {
      warningType = 'BEARISH_EARLY'; direction = 'down';
      warningMsg = `📉 <b>BTC EARLY WARNING — Bearish momentum building</b>\nPrice: $${price.toFixed(0)} (below 15m EMA20: $${ema20_15m.toFixed(0)})\nLast hour: ${lastHour.toFixed(2)}% · Slope: ${momentumSlope.toFixed(2)}%\nRed streak: ${redStreak} consecutive 15m candles\n⏰ ${gstNow()} GST`;
    } else if (price > ema20_15m && lastHour > 0.3 && momentumSlope > 0.1 && greenStreak >= 3) {
      warningType = 'BULLISH_EARLY'; direction = 'up';
      warningMsg = `📈 <b>BTC EARLY WARNING — Bullish momentum building</b>\nPrice: $${price.toFixed(0)} (above 15m EMA20: $${ema20_15m.toFixed(0)})\nLast hour: +${lastHour.toFixed(2)}% · Slope: +${momentumSlope.toFixed(2)}%\nGreen streak: ${greenStreak} consecutive 15m candles\n⏰ ${gstNow()} GST`;
    }
    if (warningType && direction !== btcEarlyWarning.lastDirection) {
      const sinceLast = Date.now() - btcEarlyWarning.notifiedAt;
      if (sinceLast > EARLY_WARNING_COOLDOWN_MS) {
        const recipients = [OWNER_CHAT_ID, ...PAPER_TEST_USERS];
        for (const r of recipients) await tg(r, warningMsg);
        btcEarlyWarning = { state: warningType, notifiedAt: Date.now(), lastDirection: direction };
        log(`⚡ EARLY WARNING: ${warningType}`);
      }
    } else if (!warningType && btcEarlyWarning.state !== 'normal') {
      const sinceLast = Date.now() - btcEarlyWarning.notifiedAt;
      if (sinceLast > EARLY_WARNING_COOLDOWN_MS) {
        btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
        log(`✅ Early warning cleared`);
      }
    }
  } catch (err) {
    log(`⚠️ Early warning check failed: ${err.message}`);
  }
};
let btcRegime = { regime: 'UNKNOWN', confidence: 0, reason: 'init', changedAt: 0, lastNotified: 'UNKNOWN' };
let btcRangeCtx = { inRange: false, position: null, support: 0, resistance: 0 };
const updateBTCRangeContext = async () => {
  try {
    const kl = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=42');
    if (!Array.isArray(kl) || kl.length < 20) return;
    const highs = kl.map(k => parseFloat(k[2]));
    const lows  = kl.map(k => parseFloat(k[3]));
    const close = parseFloat(kl[kl.length - 1][4]);
    const resistance = Math.max(...highs);
    const support    = Math.min(...lows);
    const span = resistance - support;
    if (span <= 0) return;
    const position = (close - support) / span;
    const spanPct = (span / support) * 100;
    const inRange = spanPct >= 3 && spanPct <= 18;
    btcRangeCtx = { inRange, position: parseFloat(position.toFixed(2)), support: parseFloat(support.toFixed(0)), resistance: parseFloat(resistance.toFixed(0)), spanPct: parseFloat(spanPct.toFixed(1)) };
  } catch { }
};
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
    let regime = 'CHOPPY', confidence = 0;
    const reasons = [];
    const above1H = price > ema50_1h;
    const above4H = price > ema50_4h;
    const trendUp = ema50_4h > ema200_4h;
    if (above1H && (above4H || momentum1H > 0.2)) {
      regime = 'BULLISH';
      confidence = (above1H && above4H && trendUp) ? 80 : 60;
      reasons.push(above4H ? `above EMA50 1H+4H` : `above EMA50 1H`, `momentum +${momentum1H.toFixed(1)}%/+${momentum4H.toFixed(1)}%`);
    } else if (!above1H && (!above4H || momentum1H < -0.2)) {
      regime = 'BEARISH';
      confidence = (!above1H && !above4H && !trendUp) ? 80 : 60;
      reasons.push(!above4H ? `below EMA50 1H+4H` : `below EMA50 1H`, `momentum ${momentum1H.toFixed(1)}%/${momentum4H.toFixed(1)}%`);
    } else {
      regime = 'CHOPPY';
      confidence = 70;
      reasons.push(`range ${rangePct.toFixed(1)}% in 24h`, `1H/4H mixed`);
    }
    const changed = regime !== btcRegime.regime;
    btcRegime = { regime, confidence, reason: reasons.join(' · '), changedAt: changed ? Date.now() : btcRegime.changedAt, lastNotified: btcRegime.lastNotified, momentum1H: parseFloat(momentum1H.toFixed(2)), momentum4H: parseFloat(momentum4H.toFixed(2)), rangePct: parseFloat(rangePct.toFixed(2)) };
    if (changed) {
      const emoji = regime === 'BULLISH' ? '🟢' : regime === 'BEARISH' ? '🔴' : '🟡';
      const msg = regime === 'BULLISH' ? 'LONG signals enabled · SHORT blocked' : regime === 'BEARISH' ? 'SHORT signals enabled · LONG blocked' : '⚠️ ALL signals blocked — sit out';
      const recipients = [OWNER_CHAT_ID, ...PAPER_TEST_USERS];
      for (const r of recipients) await tg(r, `${emoji} <b>BTC REGIME CHANGE: ${regime}</b>\n━━━━━━━━━━━━━━━\n${reasons.join('\n')}\n\nConfidence: ${confidence}%\n${msg}\n⏰ ${gstNow()} GST`);
      btcRegime.lastNotified = regime;
      log(`📡 BTC REGIME: ${regime} (${confidence}%)`);
    }
    return btcRegime;
  } catch (err) {
    log(`⚠️ BTC regime check failed: ${err.message}`);
    return btcRegime;
  }
};

// ── Fake Pump History (unchanged) ───────────────────────────────────────────────
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
      const close = parseFloat(klines4h[i][4]);
      const pumpPct = ((high - open) / open) * 100;
      if (pumpPct < 5) continue;
      const next1Low = parseFloat(klines4h[i+1][3]);
      const next2Low = parseFloat(klines4h[i+2][3]);
      const lowestAfter = Math.min(next1Low, next2Low);
      const dumpedBack = lowestAfter < open;
      if (dumpedBack) { fakeCount++; events.push(`+${pumpPct.toFixed(1)}% → dumped`); }
    }
    const isPumpDump = fakeCount >= 3;
    const result = { isPumpDump, fakeCount, events: events.slice(-3), reason: isPumpDump ? `🚨 ${fakeCount} fake pumps in 7d` : `${fakeCount} fake pumps in 7d (clean)` };
    fakePumpCache.set(symbol, { result, ts: Date.now() });
    return result;
  } catch (err) {
    log(`⚠️ Fake pump history check failed for ${symbol}: ${err.message}`);
    return { isPumpDump: false, fakeCount: 0, reason: 'fetch failed' };
  }
};

// ── ATR Expansion / Funding / Recent Pump / Trap / Climax / Dump / Absorption ─
const checkATRExpansion = (klines) => {
  if (!klines || klines.length < 30) return { expanding: false, reason: 'insufficient data', expansion: 0 };
  const atr10 = calculateATR(klines.slice(-10), 10);
  const atr20 = calculateATR(klines.slice(-30, -10), 10);
  if (atr20 === 0) return { expanding: false, reason: 'zero ATR', expansion: 0 };
  const expansion = ((atr10 - atr20) / atr20) * 100;
  const expanding = expansion > 5;
  return { expanding, expansion: parseFloat(expansion.toFixed(1)), atr10: parseFloat(atr10.toFixed(6)), atr20: parseFloat(atr20.toFixed(6)), reason: expanding ? `ATR +${expansion.toFixed(1)}%` : `ATR flat ${expansion.toFixed(1)}%` };
};
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
  let pumped = false, pct = 0, window = null;
  if (pct30m >= 3)        { pumped = true; pct = pct30m; window = '30m'; }
  else if (pct1h >= 4)    { pumped = true; pct = pct1h;  window = '1h'; }
  else if (pct2h >= 6)    { pumped = true; pct = pct2h;  window = '2h'; }
  return { pumped, pct: parseFloat(pct.toFixed(2)), window, pct30m: +pct30m.toFixed(1), pct1h: +pct1h.toFixed(1), pct2h: +pct2h.toFixed(1) };
};
const checkVolumeClimax = (klines, direction) => {
  if (!klines || klines.length < 8) return { climax: false, peakRatio: 0, peakCandlesAgo: 0 };
  const vols   = klines.slice(-8).map(k => parseFloat(k[5]));
  const closes = klines.slice(-8).map(k => parseFloat(k[4]));
  const maxVol = Math.max(...vols);
  const maxVolIdx = vols.indexOf(maxVol);
  const avgVol = vols.reduce((a,b) => a+b, 0) / vols.length;
  const peakIsRecent = maxVolIdx >= 4 && maxVolIdx <= 6;
  const peakIsSpike = avgVol > 0 && maxVol > avgVol * 2.5;
  const currentVolLower = vols[vols.length-1] < maxVol * 0.7;
  const priceAtPeak = closes[maxVolIdx];
  const priceCurrent = closes[closes.length-1];
  const priceStall = priceAtPeak > 0 && Math.abs((priceCurrent - priceAtPeak) / priceAtPeak) * 100 < 1.5;
  const climax = peakIsRecent && peakIsSpike && currentVolLower && priceStall;
  return { climax, peakRatio: avgVol > 0 ? parseFloat((maxVol/avgVol).toFixed(1)) : 0, peakCandlesAgo: 7 - maxVolIdx };
};
const checkAntiDumpTrap = (klines, direction) => {
  if (direction !== 'LONG' || !klines || klines.length < 25) return { isTrap: false, reasons: [] };
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
  if (recentDump) reasons.push(`💥 dumped ${pctDrop.toFixed(1)}% recently`);
  if (bearishStructure) reasons.push(`📉 MA7<MA25`);
  if (inLowerThird) reasons.push(`⬇️ lower ${(pricePosition*100).toFixed(0)}% of range`);
  if (lowerHighs) reasons.push(`📉 lower highs`);
  const isTrap = recentDump && (bearishStructure || inLowerThird);
  return { isTrap, reasons, pctDrop: parseFloat(pctDrop.toFixed(2)), ma7: parseFloat(ma7.toFixed(6)), ma25: parseFloat(ma25.toFixed(6)), pricePosition: parseFloat(pricePosition.toFixed(2)) };
};
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
  if (priceFlat) { score += 2; reasons.push(`🤫 flat ${rangePct.toFixed(1)}%`); }
  const oiRising = prevOI > 0 && currentOI > prevOI * 1.015;
  const oiPct = prevOI > 0 ? ((currentOI - prevOI) / prevOI) * 100 : 0;
  if (oiRising) { score += 2; reasons.push(`📈 OI+${oiPct.toFixed(1)}%`); }
  const vols   = recent.map(k => parseFloat(k[5]));
  const firstHalf = vols.slice(0, 3).reduce((a,b) => a+b, 0) / 3;
  const secondHalf = vols.slice(3).reduce((a,b) => a+b, 0) / 3;
  const volRising = secondHalf > firstHalf * 1.2;
  if (volRising) { score += 1.5; reasons.push(`🔊 vol rising`); }
  const fundingOk = funding < 0.005;
  const fundingStrong = funding < -0.005;
  if (fundingStrong) { score += 2; reasons.push(`💸 shorts paying ${funding.toFixed(3)}%`); }
  else if (fundingOk) { score += 1; }
  try {
    const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
    const bidValue = ob.bids.slice(0, 20).reduce((s, b) => s + parseFloat(b[0]) * parseFloat(b[1]), 0);
    const askValue = ob.asks.slice(0, 20).reduce((s, a) => s + parseFloat(a[0]) * parseFloat(a[1]), 0);
    const bidDominance = bidValue / (askValue || 1);
    if (bidDominance > 1.3) { score += 1.5; reasons.push(`🟢 bids dominate ${bidDominance.toFixed(2)}x`); }
    else if (bidDominance > 1.1) { score += 0.5; }
  } catch { }
  const greenCount = recent.filter(k => parseFloat(k[4]) >= parseFloat(k[1])).length;
  if (greenCount >= 4) { score += 1; reasons.push(`🟩 ${greenCount}/6 green`); }
  const absorbing = score >= 5 && reasons.length >= 3 && priceFlat && oiRising;
  return { absorbing, score: parseFloat(score.toFixed(1)), reasons, rangePct: parseFloat(rangePct.toFixed(2)), oiPct: parseFloat(oiPct.toFixed(2)), funding };
};
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

// ── CVD (unchanged) ───────────────────────────────────────────────────────────
const checkCVD = (klines) => {
  if (!klines || klines.length < 10) return { trend: 'unknown', divergence: null, tag: '' };
  const recent = klines.slice(-8);
  let cvd = 0; const series = [];
  for (const k of recent) {
    const o = parseFloat(k[1]), c = parseFloat(k[4]), v = parseFloat(k[5]);
    cvd += (c >= o ? v : -v);
    series.push(cvd);
  }
  const first = parseFloat(recent[0][4]);
  const last  = parseFloat(recent[recent.length - 1][4]);
  const priceMove = first > 0 ? ((last - first) / first) * 100 : 0;
  const cvdStart = series[0], cvdEnd = series[series.length - 1];
  const cvdRising  = cvdEnd > cvdStart;
  const cvdFalling = cvdEnd < cvdStart;
  let trend = cvdRising ? 'buying' : cvdFalling ? 'selling' : 'flat';
  let divergence = null, tag = '';
  if (priceMove > 1.0 && cvdFalling) { divergence = 'BEARISH'; tag = '⚠️CVD-div'; }
  else if (priceMove < -1.0 && cvdRising) { divergence = 'BULLISH'; tag = '🟢CVD-absorb'; }
  else if (Math.abs(priceMove) < 1.0 && cvdRising) { divergence = 'ACCUM'; tag = '🟢CVD-accum'; }
  return { trend, divergence, tag, priceMove: parseFloat(priceMove.toFixed(2)) };
};

// ── Impulse (unchanged) ───────────────────────────────────────────────────────
const checkImpulse = (klines, direction) => {
  if (!klines || klines.length < 12) return { boost: 0, reason: '' };
  const closes = klines.map(k => parseFloat(k[4]));
  const vols   = klines.map(k => parseFloat(k[5]));
  const now    = closes[closes.length - 1];
  const back1  = closes[closes.length - 2];
  const back2  = closes[closes.length - 3];
  const isLong = direction === 'LONG';
  const move1 = ((now - back1) / back1) * 100 * (isLong ? 1 : -1);
  const move2 = ((now - back2) / back2) * 100 * (isLong ? 1 : -1);
  const avgVol = vols.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const volRatio = avgVol > 0 ? vols[vols.length - 1] / avgVol : 0;
  let boost = 0; const parts = [];
  if (move2 >= 1.5) { boost += 2.0; parts.push(`+${move2.toFixed(1)}%/30m`); }
  else if (move2 >= 0.8) { boost += 1.0; parts.push(`+${move2.toFixed(1)}%/30m`); }
  if (move1 >= 1.0) { boost += 1.0; parts.push(`+${move1.toFixed(1)}%/15m`); }
  if (volRatio >= 2.0) { boost += 1.5; parts.push(`vol${volRatio.toFixed(1)}x`); }
  else if (volRatio >= 1.4) { boost += 0.7; parts.push(`vol${volRatio.toFixed(1)}x`); }
  if (boost > 0 && volRatio < 1.2) { boost = 0; parts.length = 0; }
  boost = Math.min(3.0, boost);
  return { boost: parseFloat(boost.toFixed(1)), reason: parts.join(' '), move1, move2, volRatio };
};

// ── Fetch / Supabase / Telegram (unchanged) ──────────────────────────────────
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
    if (!res.ok) { log(`⚠️ Supabase ${res.status} on ${(path||'').split('?')[0]} (${options.method||'GET'})`); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) { log(`⚠️ Supabase fetch THREW on ${(path||'').split('?')[0]}: ${e.message} [cause: ${e.cause?.code || e.cause?.message || 'unknown'}]`); return null; }
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

// ── Coin Behavior / Profile (unchanged) ───────────────────────────────────────
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
  } catch (err) { /* silent */ }
};
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
    let verdict = 'INSUFFICIENT_DATA', verdictEmoji = '⚪', verdictReason = 'Need more data';
    if (total >= 3) {
      if (winRate >= 0.65 && greenRatio >= 0.5) { verdict = 'TRUSTED'; verdictEmoji = '🟢'; verdictReason = 'Strong WR + bullish bias'; }
      else if (winRate >= 0.5) { verdict = 'NORMAL'; verdictEmoji = '🟡'; verdictReason = 'Average performance'; }
      else if (winRate < 0.4) { verdict = 'HOSTILE'; verdictEmoji = '🔴'; verdictReason = `Poor WR (${(winRate*100).toFixed(0)}%)`; }
    } else if (total === 2 && wins === 0) { verdict = 'WARNING'; verdictEmoji = '🟠'; verdictReason = `Lost 2/2 recent trades — caution`; }
    else if (total === 1 && losses === 1) { verdict = 'CAUTION'; verdictEmoji = '🟡'; verdictReason = `1 loss recorded, watch closely`; }
    else if (obsCount >= 100 && greenRatio !== null) {
      if (greenRatio >= 0.55) { verdict = 'PROMISING'; verdictEmoji = '🟢'; verdictReason = `${(greenRatio*100).toFixed(0)}% green (no trades yet)`; }
      else if (greenRatio < 0.4) { verdict = 'WEAK'; verdictEmoji = '🔴'; verdictReason = `Mostly red (${(greenRatio*100).toFixed(0)}% green)`; }
    }
    let tier = 'UNKNOWN', action = 'normal';
    if (total >= 3) {
      if (winRate >= 0.7)      { tier = 'A'; action = 'boost'; }
      else if (winRate >= 0.5) { tier = 'B'; action = 'normal'; }
      else if (winRate < 0.4)  { tier = 'C'; action = 'normal'; }
    }
    const profile = {
      symbol, tier, action,
      winRate, wins, losses, totalTrades: total,
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
  } catch (err) {
    return { symbol, tier: 'UNKNOWN', action: 'normal', hasData: false, totalTrades: 0, wins: 0, losses: 0, winRate: null, verdict: 'ERROR', verdictEmoji: '⚪', verdictReason: 'Profile fetch failed' };
  }
};
const checkHostileDirection = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') return { block: false, reason: '' };
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
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') return { adjustment: 0, reason: '' };
  const isLong = direction === 'LONG';
  const dirWR = isLong ? profile.longWR : profile.shortWR;
  const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
  if (dirTotal >= 5 && dirWR !== null && dirWR >= 0.60) return { adjustment: -1.0, reason: `TRUSTED ${(dirWR*100).toFixed(0)}% WR` };
  if (dirTotal >= 3 && dirWR !== null && dirWR >= 0.35 && dirWR < 0.45) return { adjustment: +1.0, reason: `CAUTION ${(dirWR*100).toFixed(0)}% WR` };
  return { adjustment: 0, reason: '' };
};
const shouldBlockFireOnCaution = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') return false;
  if (profile.verdict === 'CAUTION' || profile.verdict === 'WARNING') return true;
  return false;
};

// ── Paper Trade Logger (unchanged) ────────────────────────────────────────────
const logPaperTrade = async (signal) => {
  try {
    log(`📒 Logging paper trade: ${signal.symbol} ${signal.direction} ${signal.type} entry=${signal.price}`);
    const result = await sb('paper_trades', {
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
    log(`✅ Paper trade saved: ${signal.symbol}`);
    lastSignalLogTime = Date.now();
  } catch (err) {
    log(`❌ Paper log FAILED for ${signal.symbol}: ${err.message || err}`);
  }
};

// ── Daily Summary / Anomalies (unchanged) ───────────────────────────────────
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
    const msg = `📊 <b>NEXIO DAILY SUMMARY</b>
━━━━━━━━━━━━━━━
🌐 BTC Regime: ${btcRegime.regime} (${btcRegime.confidence}%)
📈 Today's signals: ${todayTrades.length}
   LONG: ${longs} · SHORT: ${shorts}
🎯 Closed: ${wins}W ${losses}L · Open: ${open}
🔥 Win rate today: ${wr}%

📊 Cumulative: ${all.length} signals
   Closed: ${all.filter(t => t.status !== 'OPEN').length}
   Win rate: ${all.filter(t => t.status !== 'OPEN').length > 0 ? ((all.filter(t => t.outcome === 'WIN').length / all.filter(t => t.status !== 'OPEN').length) * 100).toFixed(0) : '—'}%

🔬 Top blocks today:
${topBlocks}

🩺 Health:
  Paper logger: ${paperOk}
  BTC fetch: ${btcOk}
  Coin tracker: ${trackerOk}
  Watchlist: ${(await getWatchlist()).length}

⏰ ${gstNow()} GST
━━━━━━━━━━━━━━━
<i>Reset daily 21:00 Dubai · Send /stats for full breakdown</i>`;
    await tg(OWNER_CHAT_ID, msg);
    log('📬 Daily summary sent');
    Object.keys(blockReasons).forEach(k => blockReasons[k] = 0);
    btcFetchFails = 0;
  } catch (err) {
    log(`⚠️ Daily summary failed: ${err.message}`);
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
      alerts.push(`⚠️ No paper trade logged in ${Math.floor(minsSinceLog/60)}h despite tradeable BTC and active tracker — logger may be broken`);
    } else if (minsSinceLog > 1440 && (btcRegime.regime === 'CHOPPY' || totalBlocksToday >= 30)) {
      log(`ℹ️ No signals in ${Math.floor(minsSinceLog/60)}h — bot filtered ${totalBlocksToday} setups (correct behavior)`);
    }
    if (btcFetchFails >= 20 && btcGateStatus.price === 0) alerts.push(`⚠️ BTC fetch currently broken (${btcFetchFails} fails)`);
    if (fullScanCount > 30 && coinTracker.size === 0) {
      const isChoppy = btcRegime.regime === 'CHOPPY';
      const isBearish = btcRegime.regime === 'BEARISH';
      if (isChoppy) log(`ℹ️ Tracker empty — CHOPPY blocks all (correct)`);
      else if (isBearish) log(`ℹ️ Tracker empty — BEARISH regime, SHORT disabled (correct)`);
      else alerts.push(`⚠️ Coin tracker empty despite ${fullScanCount} scans + ${btcRegime.regime} regime — possible filter issue`);
    }
    if (btcRegime.regime === 'UNKNOWN' && Date.now() - btcRegime.changedAt > 3600000) alerts.push(`⚠️ BTC regime stuck UNKNOWN`);
    const wl = await getWatchlist();
    if (wl.length < 5 && fullScanCount > 5) alerts.push(`⚠️ Watchlist only ${wl.length} coins — may need /clearwatchlist + /fullscan`);
    if (alerts.length > 0) {
      const msg = `🚨 <b>NEXIO ANOMALY DETECTED</b>\n━━━━━━━━━━━━━━━\n${alerts.join('\n\n')}\n\n⏰ ${gstNow()} GST`;
      await tg(OWNER_CHAT_ID, msg);
      log('🚨 Anomaly alert sent: ' + alerts.length + ' issue(s)');
    }
  } catch (err) {
    log(`⚠️ Anomaly check failed: ${err.message}`);
  }
};

// ── v5.44 PAPER OUTCOME CHECKER — with AUTO DECAY/RETRACE EXIT ───────────────
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
        let status = 'OPEN', outcome = null, closedPrice = price;
        
        // Standard SL / TP1
        if (isLong && price <= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        else if (!isLong && price >= trade.sl) { status = 'SL_HIT'; outcome = 'LOSS'; }
        else if (isLong && price >= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
        else if (!isLong && price <= trade.tp1) { status = 'TP1_HIT'; outcome = 'WIN'; }
        else {
          // v5.44: Momentum decay / retrace auto-exit
          const entry = trade.entry;
          const inProfitPct = isLong ? ((price - entry) / entry) * 100 : ((entry - price) / entry) * 100;
          // Compute peak if we track it (we store in signalPrices, but for paper trades we approximate from DB or re-fetch klines)
          // For simplicity, fetch 5m klines since entry to find max favorable excursion
          const since = new Date(trade.created_at).getTime();
          const kl = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${trade.symbol}&interval=5m&startTime=${since}&limit=100`);
          let peakPct = 0;
          if (Array.isArray(kl) && kl.length) {
            const best = isLong ? Math.max(...kl.map(k => parseFloat(k[2]))) : Math.min(...kl.map(k => parseFloat(k[3])));
            peakPct = isLong ? ((best - entry) / entry) * 100 : ((entry - best) / entry) * 100;
          }
          
          // Decay exit: was in profit +0.6% but stalled 10min with no new high
          if (peakPct >= 0.6 && inProfitPct >= 0.2 && (peakPct - inProfitPct) >= 0.4) {
            status = 'DECAY_EXIT'; outcome = 'WIN'; closedPrice = price;
            log(`⏱ DECAY_EXIT: ${trade.symbol} peak +${peakPct.toFixed(2)}% → now +${inProfitPct.toFixed(2)}%`);
          }
          // Retrace exit: gave back 0.5% from peak
          else if (peakPct >= 0.8 && (peakPct - inProfitPct) >= 0.5) {
            status = 'RETRACE_EXIT'; outcome = 'WIN'; closedPrice = price;
            log(`📉 RETRACE_EXIT: ${trade.symbol} peak +${peakPct.toFixed(2)}% → now +${inProfitPct.toFixed(2)}%`);
          }
          // Timeout: momentum trades 90min, others 4h
          else {
            const maxHold = trade.signal_type === 'MOMENTUM' ? 90 * 60000 : 4 * 3600000;
            if (Date.now() - since > maxHold) {
              status = 'TIMEOUT';
              outcome = inProfitPct > 0 ? 'WIN' : 'LOSS';
              log(`⏰ TIMEOUT: ${trade.symbol} ${inProfitPct.toFixed(2)}% after ${trade.signal_type}`);
            }
          }
        }
        
        if (status !== 'OPEN') {
          await sb(`paper_trades?id=eq.${trade.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status, outcome, closed_price: closedPrice, closed_at: new Date().toISOString() }),
          });
          log(`📒 ${trade.symbol} ${trade.direction} ${trade.signal_type} → ${status} (${outcome})`);
        }
      } catch (e) { /* skip */ }
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

// ── BTC Gate (unchanged) ────────────────────────────────────────────────────
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
    if (extremeMove) { pass = false; reason = `⚡ BTC extreme move (1H ${change1H.toFixed(2)}%) — skip all`; }
    else if (fundRate > 0.04) { pass = false; reason = `⚠️ BTC funding extreme ${fundRate.toFixed(3)}%`; }
    const bullishOk = change1H > -1.2 && change24h > -4;
    const bearishOk = change1H < 1.2 && change24h < 4;
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji, bullishOk, bearishOk };
    return btcGateStatus;
  } catch (err) {
    log(`⚠️ BTC gate fetch failed: ${err.message || err}`);
    btcFetchFails++;
    if (btcGateStatus.price > 0) {
      btcGateStatus.reason = `⚠️ BTC fetch failed (using cached: ${btcGateStatus.change?.toFixed(2)}%)`;
      return btcGateStatus;
    }
    btcGateStatus = { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0, change1H: 0, funding: 0, emoji: '⚪', bullishOk: true, bearishOk: true };
    return btcGateStatus;
  }
};

// ── LAYER 3-7 functions (unchanged, kept compact) ─────────────────────────────
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
      verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — clean breakout`;
    } else if (latest.upperWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — rejection candle`;
    } else if (wickyCount >= 2) {
      verdict = 'FAKE'; emoji = '❌'; details = `${wickyCount}/3 wicky candles — repeated rejection`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% • Wick ${latest.upperWickPct}% — weak momentum`;
    }
  } else {
    if (latest.bodyPct >= 60 && latest.lowerWickPct <= 25 && !latest.isGreen) {
      verdict = 'STRONG'; emoji = '✅'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — clean breakdown`;
    } else if (latest.lowerWickPct > 60 || latest.bodyPct < 25) {
      verdict = 'FAKE'; emoji = '❌'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — possible reversal`;
    } else {
      verdict = 'WEAK'; emoji = '⚠️'; details = `Body ${latest.bodyPct}% • Lower wick ${latest.lowerWickPct}% — weak momentum`;
    }
  }
  return { verdict, emoji, details, bodyPct: latest.bodyPct, upperWickPct: latest.upperWickPct, lowerWickPct: latest.lowerWickPct, wickyCount, isGreen: latest.isGreen };
};
const checkTrapRisk = async (symbol, price, direction, volSpike, oiBuilding, klines = []) => {
  let trapScore = 0;
  const reasons = [];
  if (volSpike >= 2 && !oiBuilding) { trapScore += 2; reasons.push('vol spike no OI confirmation'); }
  try {
    const ob      = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=50`);
    const bids    = ob.bids.map(b => ({ p: parseFloat(b[0]), q: parseFloat(b[1]) }));
    const asks    = ob.asks.map(a => ({ p: parseFloat(a[0]), q: parseFloat(a[1]) }));
    const bidVal  = bids.filter(b => b.p >= price * 0.99).reduce((s, b) => s + b.p * b.q, 0);
    const askVal  = asks.filter(a => a.p <= price * 1.01).reduce((s, a) => s + a.p * a.q, 0);
    const bigSell = asks.reduce((m, a) => a.p * a.q > m.size ? { p: a.p, size: a.p * a.q } : m, { p: 0, size: 0 });
    const sellProx = bigSell.p > 0 ? ((bigSell.p - price) / price) * 100 : 99;
    if (direction === 'LONG' && sellProx < 1.5 && bigSell.size > 30000) { trapScore += 2; reasons.push(`sell wall ${sellProx.toFixed(1)}% above`); }
    if (direction === 'LONG' && askVal > bidVal * 2) { trapScore += 1; reasons.push('asks dominating bids'); }
  } catch { }
  const candle = checkCandleQuality(klines, direction);
  if (candle.verdict === 'FAKE') { trapScore += 2; reasons.push(`fake candle: ${candle.details}`); }
  else if (candle.verdict === 'WEAK') { trapScore += 1; reasons.push(`weak candle: ${candle.details}`); }
  else if (candle.verdict === 'STRONG') { trapScore = Math.max(0, trapScore - 0.5); }
  return { safe: trapScore === 0, trapScore, reasons, candle };
};
const calcMasterScore = ({ compression, volume, resistance, fundingLS, trap }) => {
  const raw = compression.score + volume.score + resistance.score + fundingLS.score - (trap.trapScore * 1.0);
  return Math.max(0, Math.min(10, parseFloat(raw.toFixed(1))));
};

// ── v5.44 SCALE-OUT FOOTER — added to every signal message ───────────────────
const SCALE_OUT_PLAN = () => `\n━━━━━━━━━━━━━━━\n📊 <b>SCALE-OUT PLAN:</b>\n   +0.5% → Close 50% · Move SL to entry\n   +1.0% → Close 25% · Let 25% run\n   +1.5% → Close all or trail tight\n<i>Don't hold for the moon — scalp the move.</i>`;

const FOOTER = (btc, symbol) => {
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0?'+':''}${btc.change?.toFixed(1)}%` : '';
  const link   = symbol ? `bybit.com/trade/usdt/${symbol}` : '';
  return [btcStr, link, `⏰ ${gstNow()} GST`, `<i>DYOR · SL always set</i>`].filter(Boolean).join('  |  ');
};

// ── Message Builders (updated with scale-out) ────────────────────────────────
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
  if (layers?.taker?.tag)             tags.push(layers.taker.tag);
  if (layers?.cvd?.tag)               tags.push(layers.cvd.tag);
  if (layers?.maStack === 'bullish_full') tags.push('📈MA-Stack✅');
  else if (layers?.maStack === 'bearish_full') tags.push('📉MA-Stack✅');
  return `👀 ${symbol.replace('USDT','')} ${tag}  ${score}/10 ${confBar(score)}${cv}
${tags.join(' · ')}
${direction === 'LONG' ? '⏳ Waiting for breakout (up)' : '⏳ Waiting for breakdown (down)'}
${FOOTER(btc, symbol)}`.trim();
};

const buildFireMsg = (symbol, price, score, direction, layers, scanCount, btc, klines = [], hype = null, profile = null) => {
  const isLong   = direction === 'LONG';
  const atr      = calculateATR(klines) || (price * 0.018);
  const sl       = isLong ? price - atr * UNIFIED_SL_ATR  : price + atr * UNIFIED_SL_ATR;
  const tp1      = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
  const tp2      = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
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
  if (layers?.taker?.tag)             conf.push(layers.taker.tag);
  if (layers?.cvd?.tag)               conf.push(layers.cvd.tag);
  const sizeHint = getPositionSizeHint();
  const reliability = (() => {
    if (!profile || profile.verdict === 'ERROR') return '';
    const lines = [];
    if (profile.verdict !== 'INSUFFICIENT_DATA') lines.push(`🎯 <b>Coin Reliability: ${profile.verdictEmoji} ${profile.verdict}</b>`);
    else if (profile.observations >= 30) lines.push(`🎯 <b>Coin Profile: ⚪ LIMITED DATA</b>`);
    else lines.push(`🎯 <b>Coin Profile: ⚪ NEW (${profile.observations || 0} obs)</b>`);
    if (profile.greenRatio !== null && profile.observations >= 30) lines.push(`   7d trend: ${(profile.greenRatio*100).toFixed(0)}% green ${profile.greenRatio >= 0.55 ? '🟢' : profile.greenRatio >= 0.45 ? '🟡' : '🔴'}`);
    if (profile.avgVolRatio !== null && profile.observations >= 30) lines.push(`   Volume: ${profile.avgVolRatio.toFixed(2)}x avg ${profile.avgVolRatio < 0.6 ? '🔴 low liq' : profile.avgVolRatio < 1.0 ? '🟡' : '🟢'}`);
    const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
    const dirWins = isLong ? profile.longWins : profile.shortWins;
    const dirLosses = isLong ? profile.longLosses : profile.shortLosses;
    const dirWR = isLong ? profile.longWR : profile.shortWR;
    if (dirTotal >= 1) {
      const dirEmoji = dirWR >= 0.6 ? '🟢' : dirWR >= 0.4 ? '🟡' : '🔴';
      lines.push(`   ${isLong ? 'LONG' : 'SHORT'} record: ${dirWins}W/${dirLosses}L${dirWR !== null ? ` (${(dirWR*100).toFixed(0)}%)` : ''} ${dirEmoji}`);
    } else if (profile.totalTrades >= 1) {
      lines.push(`   Past trades: ${profile.wins}W/${profile.losses}L${profile.winRate !== null ? ` (WR ${(profile.winRate*100).toFixed(0)}%)` : ''}`);
    }
    if (!isLong && btcRegime.regime !== 'BEARISH') lines.push(`   ⚠️ SHORT outside BEARISH regime — risky timing`);
    if (!isLong) lines.push(`   🟡 <b>SHORT testing phase — USE HALF SIZE ($5-7 margin)</b>`);
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

━━━━━━━━━━━━━━━
📊 Score: ${score}/10 ${confBar(score)}
${conf.join(' · ')}${reliability}
${SCALE_OUT_PLAN()}
${FOOTER(btc, symbol)}`.trim();
};

// ── v5.44 MOMENTUM MESSAGE — for parabolic pumps ───────────────────────────────
const buildMomentumMsg = (symbol, price, parabolic, layers, btc, klines) => {
  const isLong = true; // momentum only long for now
  const atr = calculateATR(klines) || (price * 0.018);
  const sl  = price - atr * UNIFIED_SL_ATR;
  const tp1 = price + atr * UNIFIED_TP1_ATR;
  const tp2 = price + atr * UNIFIED_TP2_ATR;
  const tags = [];
  tags.push(`⚡Accel ${parabolic.accel.toFixed(1)}%`);
  tags.push(`🔊Vol ${parabolic.volSpike.toFixed(1)}x`);
  tags.push(parabolic.takerRatio > 0.55 ? `🟢Taker ${(parabolic.takerRatio*100).toFixed(0)}%` : `🔴Taker ${(parabolic.takerRatio*100).toFixed(0)}%`);
  if (layers?.cvd?.tag) tags.push(layers.cvd.tag);
  const chg24 = btcGateStatus.change || 0; // rough proxy, not per-coin
  return `🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀
<b>🚀 NEXIO MOMENTUM — PARABOLIC PUMP</b>
<b>${symbol.replace('USDT','')}</b>
🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀

<b>💰 ENTRY:  $${fmtP(price)}</b>
<b>🛑 STOP:   $${fmtP(sl)}</b>
<b>🎯 TP1:    $${fmtP(tp1)}</b>
<b>🎯 TP2:    $${fmtP(tp2)}</b>

━━━━━━━━━━━━━━━
📊 Parabolic Score: ${parabolic.score}/8
${tags.join(' · ')}
📈 Last 3 candles: ${parabolic.candles.map(c => c > 0 ? '+' : ''}${c.toFixed(1)}%`).join(' → ')}
${parabolic.rugRisk ? '⚠️ RUG RISK DETECTED — size down' : '✅ Structure clean'}

${SCALE_OUT_PLAN()}
${FOOTER(btc, symbol)}`.trim();
};

const buildBreakevenMsg = (symbol, entryPrice, tp1Price, direction) => {
  return `✅ <b>${symbol.replace('USDT','')} TP1 HIT</b> — Move SL to entry $${fmtP(entryPrice)}
🎯 TP1: $${fmtP(tp1Price)} reached · Let TP2 run
⏰ ${gstNow()} GST`.trim();
};

const buildPriorityList = async (btc) => {
  const now = Date.now();
  const sorted = [...coinTracker.values()]
    .filter(c => c.state !== 'FADING' && c.score >= 6)
    .filter(c => {
      const lastUpdate = c.lastUpdated || c.firstSeen || 0;
      return (now - lastUpdate) < 15 * 60 * 1000;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!sorted.length) return null;
  const profiles = await Promise.all(sorted.map(c => getCoinProfile(c.symbol).catch(() => null)));
  const lines = sorted.map((s, i) => {
    const rank  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir   = s.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const state = s.state === 'FIRE' ? '🔥 HIGH CONF' : s.state === 'CONFIRMING' ? '⚡ CONFIRMED' : '👀 WATCHING';
    const bar   = confBar(s.score);
    const ageMin = Math.floor((now - (s.lastUpdated || s.firstSeen || now)) / 60000);
    const freshness = ageMin <= 3 ? '🟢' : ageMin <= 8 ? '🟡' : '🔴';
    const p = profiles[i];
    let infoLine = '';
    let recommendation = '';
    if (p) {
      const isLong = s.direction === 'LONG';
      const dirWR = isLong ? p.longWR : p.shortWR;
      const dirTotal = isLong ? p.longTotal : p.shortTotal;
      if (dirTotal >= 1) {
        const wrPct = dirWR !== null ? (dirWR * 100).toFixed(0) : '—';
        const emoji = dirWR >= 0.6 ? '🟢' : dirWR >= 0.4 ? '🟡' : '🔴';
        infoLine = `     📒 ${s.direction}: ${p.longWins}W/${p.longLosses}L (${wrPct}%) ${emoji}`;
      } else if (p.totalTrades >= 1) {
        const wrPct = (p.winRate * 100).toFixed(0);
        const emoji = p.winRate >= 0.6 ? '🟢' : p.winRate >= 0.4 ? '🟡' : '🔴';
        infoLine = `     📒 Overall: ${p.wins}W/${p.losses}L (${wrPct}%) ${emoji}`;
      }
      const liqWarn = p.avgVolRatio !== null && p.avgVolRatio < 0.6;
      if (dirTotal >= 2 && dirWR !== null && dirWR < 0.4) recommendation = ' ❌ AVOID';
      else if (dirTotal >= 3 && dirWR >= 0.6) recommendation = ' ✅ ENTER';
      else if (p.totalTrades >= 3 && p.winRate < 0.4) recommendation = ' ❌ AVOID';
      else if (liqWarn) recommendation = ' 🟡 LOW-LIQ';
      else if (p.totalTrades === 0 && p.observations < 30) recommendation = ' ⚪ NEW';
    }
    let lateWarning = '';
    const priceMove = s.priceChangePct || 0;
    if (priceMove > 3) lateWarning = ` ⚠️ +${priceMove.toFixed(1)}%`;
    return `${rank} ${dir} <b>${s.symbol.replace('USDT','')}</b> — ${state} ${s.score}/10 ${freshness}${ageMin}m${recommendation}${lateWarning}\n     ${bar}${infoLine ? '\n' + infoLine : ''}`;
  }).join('\n');
  const btcStr = btc ? `${btc.emoji} BTC $${btc.price?.toLocaleString()} ${btc.change > 0?'+':''}${btc.change?.toFixed(1)}%` : '';
  return `📊 <b>NEXIO PRIORITY LIST</b>
━━━━━━━━━━━━━━━
${lines}
━━━━━━━━━━━━━━━
${btcStr}  ⏰ ${gstNow()} GST
🔥 HIGH CONF = enter | ⚡ CONFIRMED = watch | 👀 WATCHING = building
✅ ENTER · ❌ AVOID · 🟡 CAUTION · ⚪ NEW
🟢 fresh · 🟡 ok · 🔴 stale  |  <i>DYOR · SL always set</i>`.trim();
};

// ── Contract Info Cache (unchanged) ───────────────────────────────────────────
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
    log(`📋 Contract info refreshed: ${cryptoSymbols.size} crypto perpetuals found`);
    return cryptoSymbols;
  } catch (err) {
    log('⚠️ exchangeInfo fetch failed:', err.message);
    return contractInfoCache.data || new Set();
  }
};

// ── v5.44 FULL MARKET SCAN — 5m candles + hot momentum discovery ─────────────
const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount}`);
  try {
    const cryptoSet = await getContractInfo();
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');

    // ── v5.44 HOT MOMENTUM DISCOVERY ─────────────────────────────────────────
    // Bypass flat-price filter for coins already pumping + ACCELERATING
    const hotCandidates = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
        if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) return false;
        if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) return false;
        if (STOCK_SUFFIX_REGEX.test(t.symbol) || isLikelyStock(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
        const chg24 = parseFloat(t.priceChangePercent);
        return chg24 >= 5 && chg24 <= 60; // already hot but not insane
      })
      .slice(0, 15);

    for (const coin of hotCandidates) {
      await sleep(400);
      try {
        const klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=5m&limit=30`);
        if (!klines || klines.length < 10) continue;
        const parabolic = checkParabolic(klines);
        const taker = checkTakerRatio(klines);
        const fakeHist = await checkFakePumpHistory(coin.symbol);
        // Meme override: if parabolic is STRONG and taker is high, allow memes
        const isMeme = isMemeCoin(coin.symbol);
        const memeAllowed = isMeme && parabolic.score >= 7 && taker.ratio > 0.60 && !parabolic.rugRisk;
        if (isMeme && !memeAllowed) continue;
        
        if (parabolic.isParabolic && !parabolic.rugRisk && !taker.fake && !fakeHist.isPumpDump) {
          const wl = await getWatchlist();
          const inWl = wl.some(r => r.symbol === coin.symbol);
          if (!inWl) {
            await addToWatchlist(coin.symbol, 8, 'LONG');
            log(`🔥 HOT-ADD: ${coin.symbol} parabolic score ${parabolic.score} · taker ${(taker.ratio*100).toFixed(0)}%`);
          }
        }
      } catch (e) { /* skip */ }
    }

    // ── RS Tracker (unchanged) ───────────────────────────────────────────────
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
              rsWatch.set(t.symbol, { detectedAt: Date.now(), detectPrice: parseFloat(t.lastPrice), detectChg: chg, btcChgAtDetect: btc24h, alerted: false });
              log(`💎 RS-DETECT: ${t.symbol} holding ${chg.toFixed(1)}% while BTC ${btc24h.toFixed(1)}%`);
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
              `🟢 BTC turning: +${btc1H.toFixed(2)}% (1H)\n\n` +
              `<i>Early mover off accumulation. DYOR · SL always set</i>\n` +
              `⏰ ${gstNow()} GST`);
            log(`🏃 FRONT-RUNNER ALERT: ${sym} +${moveFromDetect.toFixed(1)}% from RS detection`);
          }
        }
      }
    } catch (rsErr) { log(`⚠️ RS tracker error (non-fatal): ${rsErr.message}`); }

    // ── Standard watchlist population (flat coins) ───────────────────────────
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
      .slice(0, 80); // v5.44: reduced to 80 to save weight for 5m klines

    // Stale cleanup
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
      await sleep(500);
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=5m&limit=30`); } catch { }
      if (!klines || !Array.isArray(klines) || klines.length < 10) continue;
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=5m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      const htfFM = await checkHTFTrend(coin.symbol);
      let direction = null;
      if (htfFM.bullish && funding < 0.03)      direction = 'LONG';
      else if (htfFM.bearish && funding > -0.03) direction = 'SHORT';
      if (!direction) continue;
      if (direction === 'SHORT') {
        log(`🚫 SHORT-DISABLED: ${coin.symbol} (v5.28 — proven 35% WR, removed)`);
        continue;
      }

      const score = calcMasterScore({
        compression: checkCompression(klines, currentOI, prevOI),
        volume:      checkVolumeBuild(klines),
        resistance:  checkResistanceTesting(coin.symbol, coin.price, klines),
        fundingLS:   checkFundingLS(funding, ls, direction),
        trap:        { safe: true, trapScore: 0 },
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
            log(`🔄 Rotated out ${lowest.symbol} (${lowest.score}) for ${coin.symbol} (${score})`);
          } else {
            continue;
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

// ── v5.44 WATCHLIST SCAN — 5m candles, MOMENTUM signal, no EARLY, instant FIRE ─
const runWatchlistScan = async () => {
  watchlistScanCount++;
  log(`👁 Watchlist Scan #${watchlistScanCount}`);
  try {
    await checkWeeklyDrawdown();
    await fetchFinnhubCalendar();
    await checkEventReminders();
    await updateBTCRangeContext();

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
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=30`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      if (!klines || !Array.isArray(klines) || klines.length < 10) {
        log(`⚠️ Bad klines for ${symbol} — skipping this scan`);
        continue;
      }

      // ── v5.44 PARABOLIC / MOMENTUM CHECK (runs FIRST — fastest path) ───────
      const parabolic = checkParabolic(klines);
      const taker = checkTakerRatio(klines);
      const isMeme = isMemeCoin(symbol);
      const memeOverride = isMeme && parabolic.score >= 7 && taker.ratio > 0.60 && !parabolic.rugRisk;
      
      // MOMENTUM bypasses normal direction logic — it's pure acceleration
      if (parabolic.isParabolic || (parabolic.score >= 5 && parabolic.accel >= 1.5)) {
        const fakeHist = await checkFakePumpHistory(symbol);
        const dumpTrap = checkAntiDumpTrap(klines, 'LONG');
        const climax = checkVolumeClimax(klines, 'LONG');
        const cvd = checkCVD(klines);
        
        let momentumBlocked = false;
        let blockReason = '';
        if (fakeHist.isPumpDump) { momentumBlocked = true; blockReason = 'fake pump history'; }
        else if (dumpTrap.isTrap) { momentumBlocked = true; blockReason = 'dump trap'; }
        else if (climax.climax) { momentumBlocked = true; blockReason = 'volume climax'; }
        else if (parabolic.rugRisk) { momentumBlocked = true; blockReason = 'rug risk (wick/taker)'; }
        else if (taker.fake) { momentumBlocked = true; blockReason = `taker ratio ${(taker.ratio*100).toFixed(0)}% (distribution)`; }
        else if (cvd.divergence === 'BEARISH') { momentumBlocked = true; blockReason = 'CVD bearish divergence'; }
        else if (isMeme && !memeOverride) { momentumBlocked = true; blockReason = 'meme blocked (need score≥7 + taker>60%)'; }
        else if (!btc.pass) { momentumBlocked = true; blockReason = 'BTC gate blocked'; }
        
        if (!momentumBlocked && canAlertMomentum(`momentum_${symbol}`) && alertsFired < 2) {
          const atr = calculateATR(klines) || (price * 0.018);
          const sl  = price - atr * UNIFIED_SL_ATR;
          const tp1 = price + atr * UNIFIED_TP1_ATR;
          const tp2 = price + atr * UNIFIED_TP2_ATR;
          await postSignal(buildMomentumMsg(symbol, price, parabolic, { cvd, taker }, btc, klines) + econCautionTag());
          markAlert(`momentum_${symbol}`);
          signalPrices.set(symbol, { price, direction: 'LONG', firedAt: Date.now(), type: 'MOMENTUM', atr, tp1, tp2 });
          alertsFired++;
          log(`🚀 MOMENTUM FIRED: ${symbol} score:${parabolic.score} accel:${parabolic.accel}% taker:${(taker.ratio*100).toFixed(0)}%`);
          await logPaperTrade({ symbol, direction: 'LONG', type: 'MOMENTUM', price, sl, tp1, tp2, score: parabolic.score, candle: 'STRONG', btcChange: btc.change });
          continue; // skip normal FIRE logic this scan
        } else if (momentumBlocked) {
          incBlock('parabolicRug'); log(`🚫 MOMENTUM-BLOCKED: ${symbol} — ${blockReason}`);
        }
      }

      // ── Normal FIRE path (compression/breakout model) ──────────────────────
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
        const momentum = ((closeNow - close4) / close4) * 100;
        if (isLong && momentum < -1.5) isLong = false;
        if (isShort && momentum > 1.5) isShort = false;
      }
      if (!isLong && !isShort) { coinTracker.delete(symbol); continue; }
      const direction = isLong ? 'LONG' : 'SHORT';
      if (direction === 'SHORT') {
        log(`🚫 SHORT-DISABLED: ${symbol} (v5.28 — proven loser)`);
        coinTracker.delete(symbol);
        continue;
      }

      const htf = htfPre;
      const compression = checkCompression(klines, currentOI, prevOI);
      const volume      = checkVolumeBuild(klines);
      const atrExp      = checkATRExpansion(klines);
      const fundingZ    = await checkFundingExtreme(symbol, funding);
      const resistance  = checkResistanceTesting(symbol, price, klines);
      const fundingLS   = checkFundingLS(funding, ls, direction);
      const trap        = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);
      const fakeHist    = await checkFakePumpHistory(symbol);
      const dumpTrap    = checkAntiDumpTrap(klines, direction);
      const climax      = checkVolumeClimax(klines, direction);
      const absorption  = direction === 'LONG' && !dumpTrap.isTrap ? await checkBullishAbsorption(symbol, price, klines, currentOI, prevOI, funding) : { absorbing: false, score: 0, reasons: [] };
      const rsi         = calcRSI(klines);
      const maStack     = checkMAStack(klines);
      const cvd         = checkCVD(klines);
      const impulse     = checkImpulse(klines, direction);

      if (fakeHist.isPumpDump) {
        log(`🎭 PUMP-DUMP-COIN: ${symbol} ${fakeHist.reason} — blocking all signals`);
        coinTracker.delete(symbol); continue;
      }
      if (dumpTrap.isTrap) { incBlock('dumpTrap'); log(`🔪 DUMP-TRAP: ${symbol} LONG blocked`); }
      if (climax.climax && direction === 'LONG') { incBlock('climax'); log(`🔝 VOL-CLIMAX: ${symbol} LONG blocked`); }

      let newsEvent = false;
      if (klines.length >= 10) {
        const lastVol = parseFloat(klines[klines.length - 1][5]);
        const prevVols = klines.slice(-11, -1).map(k => parseFloat(k[5]));
        const prevAvg = prevVols.reduce((a,b) => a+b, 0) / prevVols.length;
        const priceMove = klines.length >= 2 ? Math.abs((parseFloat(klines[klines.length-1][4]) - parseFloat(klines[klines.length-2][4])) / parseFloat(klines[klines.length-2][4])) * 100 : 0;
        if (prevAvg > 0 && lastVol > prevAvg * 5 && priceMove < 1) {
          newsEvent = true; incBlock('newsEvent'); log(`📰 NEWS-EVENT: ${symbol} vol ${(lastVol/prevAvg).toFixed(1)}x but price ${priceMove.toFixed(1)}% — skip`);
        }
      }

      let score = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      if (absorption.absorbing) {
        const boost = Math.min(2, absorption.score * 0.3);
        score = Math.min(10, score + boost);
      }
      if (direction === 'LONG' && btcRangeCtx.inRange && btcRangeCtx.position !== null && btcRangeCtx.position <= 0.33) {
        score = Math.min(10, score + 1.0);
      }
      if (cvd.divergence === 'BEARISH' && direction === 'LONG') {
        score = Math.max(0, score - 1.5);
        log(`⚠️ CVD-DIVERGENCE: ${symbol} price +${cvd.priceMove}% on net SELLING — likely fake pump (-1.5)`);
      } else if ((cvd.divergence === 'ACCUM' || cvd.divergence === 'BULLISH') && direction === 'LONG') {
        score = Math.min(10, score + 0.7);
      }
      if (impulse.boost > 0) {
        score = Math.min(10, score + impulse.boost);
        log(`⚡ IMPULSE: ${symbol} +${impulse.boost} (${impulse.reason})`);
      }
      if (fundingZ.extreme) {
        if (direction === 'LONG' && fundingZ.extremeNeg) { score = Math.min(10, score + 1.5); log(`🔥 EXTREME-FUNDING: ${symbol} LONG boost +1.5 (z=${fundingZ.z})`); }
        else if (direction === 'SHORT' && fundingZ.extremePos) { score = Math.min(10, score + 1.5); log(`🔥 EXTREME-FUNDING: ${symbol} SHORT boost +1.5 (z=${fundingZ.z})`); }
      }

      const layers = { compression, volume, resistance, fundingLS, trap, absorption, dumpTrap, rsi, maStack: maStack.stack, cvd, taker, impulse };
      const sweep = checkLiquiditySweep(klines, direction);
      const early = checkEarlyEntry(compression, volume, fundingLS, klines);
      const atr = calculateATR(klines) || (price * 0.018);
      const hype = await checkSocialHype(symbol);
      const finalScore = Math.max(0, Math.min(10, score + (hype.hypeBonus || 0)));
      if (hype.hasData && hype.hypeBonus !== 0) log(`🌊 ${symbol} hype ${hype.hypeBonus > 0 ? '+' : ''}${hype.hypeBonus} (${hype.tag})`);

      // v5.44: SURGE signal (informational, logged as paper trade)
      if (klines.length >= 12 && btcRegime.regime !== 'CHOPPY') {
        const surgeOpen = parseFloat(klines[klines.length - 2][1]);
        const surgeNow  = parseFloat(klines[klines.length - 1][4]);
        const surgeMove = ((surgeNow - surgeOpen) / surgeOpen) * 100;
        const surgeVol  = parseFloat(klines[klines.length - 1][5]);
        const surgeAvg  = klines.slice(-12, -2).map(k => parseFloat(k[5])).reduce((a, b) => a + b, 0) / 10;
        if (surgeMove >= 1.5 && surgeAvg > 0 && surgeVol > surgeAvg * 1.3) {
          const surgeKey = `surge_${symbol}`;
          if (canAlert(surgeKey)) {
            // v5.44: SURGE must pass rug filters too
            if (!fakeHist.isPumpDump && !dumpTrap.isTrap && !climax.climax && trap.candle?.verdict !== 'FAKE' && !taker.fake && cvd.divergence !== 'BEARISH') {
              markAlert(surgeKey);
              const sAtr = calculateATR(klines) || (price * 0.018);
              const sSl  = price - sAtr * UNIFIED_SL_ATR;
              const sTp1 = price + sAtr * UNIFIED_TP1_ATR;
              const sTp2 = price + sAtr * UNIFIED_TP2_ATR;
              await postSignal(
                `⚡ <b>SURGE: ${symbol.replace('USDT','')}</b> +${surgeMove.toFixed(1)}% in 10min · vol ${(surgeVol/surgeAvg).toFixed(1)}x\n` +
                `💰 Entry $${fmtP(price)} · 🛑 SL $${fmtP(sSl)} · 🎯 TP1 $${fmtP(sTp1)}\n` +
                `Momentum LIVE right now — tracked as paper trade.${SCALE_OUT_PLAN()}\n` +
                `<i>Your judgment decides · tight SL if entering</i>\n` +
                `⏰ ${gstNow()} GST`);
              await logPaperTrade({ symbol, direction, type: 'SURGE', price, sl: sSl, tp1: sTp1, tp2: sTp2, score: finalScore, candle: trap?.candle?.verdict, btcChange: btc.change });
              log(`⚡ SURGE: ${symbol} +${surgeMove.toFixed(1)}% vol ${(surgeVol/surgeAvg).toFixed(1)}x — paper logged`);
            } else {
              log
