// ─────────────────────────────────────────────────────────────────────────────
// v5.35 NETWORK FIX: Force IPv4-first DNS resolution.
// Railway containers often have broken IPv6 egress; Supabase/Cloudflare
// publish IPv6 (AAAA) records; Node fetch tries IPv6 first → instant
// "fetch failed" with no HTTP status. Telegram (IPv4-only) unaffected —
// which is exactly the observed symptom pattern. One line ends it.
import('node:dns').then(m => (m.default || m).setDefaultResultOrder('ipv4first')).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v5.35 — Elite Recovery Edition + Smart Regime
//
// LAYER 1  — BTC Momentum Gate (direction-aware) + HTF EMA50/200 trend filter
// LAYER 2  — Full coin universe (crypto only, anti-pump, dump-trap, climax)
// LAYER 3  — Price Compression + OI Buildup
// LAYER 4  — Volume Buildup + Climax Detection
// LAYER 5  — Repeated Resistance Testing (Breakout Pressure)
// LAYER 6  — Funding + L/S + Funding z-score (mean reversion)
// LAYER 7  — Trap Risk + Candle Wick + Liquidity Sweep + Bullish Absorption
// LAYER 8  — THREE-Stage Alert: EARLY → WATCH → FIRE
// LAYER 9  — Position Manager (breakeven, trailing, force-exit, recovery)
//
// VERSION HISTORY:
// v5.0 — Daily caps, breakeven, trailing stops, force exit, recovery system
// v5.1 — Rate-limit safe scans (5min/2min), BTC fetch error handling
// v5.2 — BTC Regime Predictor (BULLISH/BEARISH/CHOPPY), RSI, MA stack
// v5.3 — Daily auto-summary at 21:00 Dubai, anomaly alerts
// v5.4 — Pump-Dump coin detector (7-day fake pump history)
// v5.5 — Looser regime detection (above/below EMA50 = directional)
//        Bug fixes: recordWin in trailing/timeout, klines validation, RSI continue
// v5.7 — Coin behavior tracker — records every observation to Supabase
//        For long-term per-coin pattern analysis (no impact on alerts)
//
// API LOAD: ~462 weight/min (19% of 2400 Binance limit)
// PAPER MODE: alerts logged to Supabase paper_trades table
// COMMANDS: /stats /regime /diagnostics /summary /history SYMBOL
// ─────────────────────────────────────────────────────────────────────────────


// ── v5.26 SECURITY: All secrets loaded from Railway environment variables ─────
// Set these in Railway → Variables tab. Never hardcode secrets in this file.
const BOT_TOKEN       = (process.env.BOT_TOKEN || '').trim();
const FREE_CHANNEL    = (process.env.FREE_CHANNEL    || '-1003900595640').trim();
const PREMIUM_CHANNEL = (process.env.PREMIUM_CHANNEL || '-1003913881352').trim();
const OWNER_CHAT_ID   = (process.env.OWNER_CHAT_ID   || '6896387082').trim();

// v5.16+ — Paper test users: friends who receive alerts during PAPER_MODE
// Add chat IDs here to give friends test access without going live to channels
// To find a friend's chat ID: have them /start the bot, check /users command
const PAPER_TEST_USERS = [
  // Add friend chat IDs here, e.g.:
  // '1234567890',
];

// ── PAPER TRADING MODE ───────────────────────────────────────────────────────
// When true: alerts go ONLY to owner (no channels), every signal logged to Supabase
// Bot researches silently, outcomes tracked, real stats after 1-2 weeks
const PAPER_MODE = true;
const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = (process.env.SUPABASE_URL || 'https://jxsvqxnbjuhtenmarioe.supabase.co').trim().replace(/\/+$/, '');
const SUPABASE_KEY    = (process.env.SUPABASE_KEY || '').trim();
const FINNHUB_KEY     = (process.env.FINNHUB_KEY || '').trim();

// v5.26: Validate critical secrets are present — fail loud, not silent
(() => {
  const missing = [];
  if (!BOT_TOKEN)    missing.push('BOT_TOKEN');
  if (!SUPABASE_KEY) missing.push('SUPABASE_KEY');
  if (missing.length) {
    console.error(`[FATAL] Missing required env variables: ${missing.join(', ')}`);
    console.error('[FATAL] Set these in Railway → Variables tab. Bot cannot start.');
    process.exit(1);
  }
  if (!FINNHUB_KEY) {
    console.warn('[WARN] FINNHUB_KEY not set — economic calendar will use fallback hardcoded dates only.');
  }
})();

const FULL_MARKET_INTERVAL_MS = 300000; // v5.1 — 5 min (recover from 418)
const WATCHLIST_SCAN_INTERVAL = 120000; // v5.1 — 2 min (recover from 418)
const POLL_INTERVAL_MS        = 30000;
const ALERT_COOLDOWN_MS       = 1800000;
const MIN_VOLUME_USD          = 200000; // was 500K — catch low caps before pump
const MAX_WATCHLIST           = 50; // quality over quantity
const MAX_TRACKED             = 20;
const FADE_THRESHOLD_PCT      = 1.2;
const MIN_ALERT_SCORE         = 6.5; // v5.8 — slightly looser to allow signals in tight markets
const MIN_FIRE_SCORE          = 7.5; // v5.22 — moderated from 8.0 (too tight, blocked all FIRE) to 7.5 (stricter than 6.5 but achievable)

// v5.14 — Meme coin blacklist (entirely skipped from scanning)
// Add new memes here as they appear. To trade one, remove from list.
const MEME_BLACKLIST = new Set([
  // Dog memes
  'DOGEUSDT', 'SHIBUSDT', 'BABYDOGEUSDT', '1MBABYDOGEUSDT', 'FLOKIUSDT',
  'BONKUSDT', 'WIFUSDT', '1000BONKUSDT', '1000FLOKIUSDT', '1000SHIBUSDT',
  'NEIROUSDT', 'NEIROETHUSDT', '1000XECUSDT', 'DOGSUSDT',
  // Frog/animal memes
  'PEPEUSDT', '1000PEPEUSDT', 'TURBOUSDT', 'BOMEUSDT', 'POPCATUSDT',
  'BRETTUSDT', 'MEWUSDT', 'PNUTUSDT', 'CHILLGUYUSDT', 'MOODENGUSDT',
  // Generic memes
  'MEMEUSDT', '1000RATSUSDT', 'SLERFUSDT', 'MYROUSDT', 'BANANAUSDT',
  'GOATUSDT', 'ACTUSDT', 'PEOPLEUSDT', '1000SATSUSDT',
  // Celebrity/political memes
  'TRUMPUSDT', 'MELANIA1USDT', 'MELANIAUSDT', 'BIDENUSDT', 'JELLYJELLYUSDT',
  // Pump-and-dump prone (highly speculative)
  'WLDUSDT', 'GMTUSDT', 'GALAUSDT',
]);

const isMemeCoin = (symbol) => MEME_BLACKLIST.has(symbol.toUpperCase());
const PUMP_EXCLUDE_PCT        = 25.0; // was 15% — coins up 15% can still pump

// Unified risk parameters — same SL/TP for both EARLY and FIRE (per user preference)
const UNIFIED_SL_ATR  = 1.8;
const UNIFIED_TP1_ATR = 2.0;
const UNIFIED_TP2_ATR = 3.5;
const UNIFIED_TP3_ATR = 5.0;

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

// Cleanup old signal tracking (prevents stale correlation counts)
// v5.31: alertHistory grew unbounded (one key per coin alert, never pruned)
const cleanupAlertHistory = () => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let cleaned = 0;
  for (const [k, ts] of alertHistory) if (ts < cutoff) { alertHistory.delete(k); cleaned++; }
  if (economicEventNotified.size > 200) economicEventNotified.clear();
  if (cleaned > 0) log(`🧹 alertHistory pruned: ${cleaned} stale keys`);
};

const cleanupSignalPrices = () => {
  const cutoff = Date.now() - 4 * 3600 * 1000; // 4h
  let cleaned = 0;
  for (const [k, v] of signalPrices.entries()) {
    if (v.firedAt < cutoff) { signalPrices.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`🧹 Signal prices cleaned: ${cleaned} expired signals`);
};

// v5.1 — coinTracker cleanup (prevents memory leak)
// Removes coins from tracker that have been stale for 60+ minutes
// (didn't get refreshed by recent watchlist scans)
const cleanupCoinTracker = () => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1h
  let cleaned = 0;
  for (const [symbol, state] of coinTracker.entries()) {
    const lastSeen = state.lastUpdated || state.firstSeen || 0;
    if (lastSeen < cutoff) {
      coinTracker.delete(symbol);
      cleaned++;
    }
  }
  if (cleaned > 0) log(`🧹 Coin tracker cleaned: ${cleaned} stale entries (size: ${coinTracker.size})`);
};

// ── Correlation Filter (v4.2) ─────────────────────────────────────────────────
// Limits directional exposure — too many same-direction signals = correlated risk
// When BTC dumps, all LONG alts dump together. Cap at 3 open same-direction signals
const getOpenDirectionCount = (direction) => {
  let count = 0;
  const cutoffMs = Date.now() - 4 * 3600 * 1000; // count signals from last 4h
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

// ── Session Filter — skip low liquidity windows ──────────────────────────────
// Dubai time (UAE) used because server/user in UAE
// Low liquidity windows (GST): 01:00-05:00 (Asia dead zone between close & London open)
const isLowLiquiditySession = () => {
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  return hour >= 1 && hour < 5;
};
const canAlert  = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > ALERT_COOLDOWN_MS;
const markAlert = k => alertHistory.set(k, Date.now());

// ── v5.25 ECONOMIC EVENT CALENDAR ────────────────────────────────────────────
// High-impact scheduled US data that causes volatility bursts.
// All times stored in UTC. Bot converts to Dubai for display.
// Recurring events computed dynamically; one-off events hardcoded.
// PURPOSE: warn of volatility windows so user can size down + set tight SL.
// Does NOT predict direction — only timing of expected volatility.

// Recurring weekly: Initial Jobless Claims — every Thursday 12:30 UTC (16:30 Dubai)
// Recurring monthly: CPI, NFP, PMI, FOMC — approximate, refined by hardcoded dates
const ECONOMIC_EVENTS = [
  // Format: { date: 'YYYY-MM-DD', timeUTC: 'HH:MM', name: '...', impact: 'HIGH'|'MED' }
  // 2026 FOMC meeting decision days (2:00 PM ET = 18:00 UTC)
  { date: '2026-06-17', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-07-29', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-09-16', timeUTC: '18:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-11-04', timeUTC: '19:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  { date: '2026-12-16', timeUTC: '19:00', name: 'FOMC Rate Decision', impact: 'HIGH' },
  // CPI releases (8:30 AM ET = 12:30 UTC) — approximate monthly
  { date: '2026-05-12', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-06-10', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-07-14', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  { date: '2026-08-12', timeUTC: '12:30', name: 'CPI Inflation Data', impact: 'HIGH' },
  // NFP / Jobs Report (8:30 AM ET first Friday)
  { date: '2026-06-05', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
  { date: '2026-07-02', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
  { date: '2026-08-07', timeUTC: '12:30', name: 'Nonfarm Payrolls (Jobs)', impact: 'HIGH' },
];

// Returns active event if we're within the danger window, else null
// windowBeforeMin: minutes before event to start warning
// windowAfterMin: minutes after event to keep warning
// (Definition moved below — see Finnhub live calendar section)

// Format event time in Dubai for display
const eventTimeDubai = (evTime) => new Date(evTime).toLocaleTimeString('en-US', {
  hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Dubai'
});

// ── v5.26 FINNHUB LIVE ECONOMIC CALENDAR ─────────────────────────────────────
// Fetches real economic calendar from Finnhub (free tier), refreshed every 6h.
// Replaces sparse hardcoded list with live, complete US high-impact events.
// Falls back to hardcoded ECONOMIC_EVENTS if Finnhub unavailable.
let liveEconomicEvents = [];   // populated from Finnhub
let lastFinnhubFetch = 0;

const fetchFinnhubCalendar = async () => {
  if (!FINNHUB_KEY) return; // no key → stay on hardcoded fallback
  // Refresh at most every 6 hours
  if (Date.now() - lastFinnhubFetch < 6 * 60 * 60 * 1000 && liveEconomicEvents.length) return;
  try {
    const now = new Date();
    const from = now.toISOString().slice(0, 10);
    const toDate = new Date(now.getTime() + 14 * 24 * 60 * 60000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${toDate}&token=${FINNHUB_KEY}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.economicCalendar)) {
      // Keep only US high-impact events
      liveEconomicEvents = data.economicCalendar
        .filter(e => e.country === 'US' && (e.impact === 'high' || e.impact === 3))
        .map(e => {
          // Finnhub time format: "2026-05-21 12:30:00" (UTC)
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

// Track which events we've already DM'd about (avoid spam)
const economicEventNotified = new Set();

// Returns active event if we're within the danger window, else null
// Checks LIVE Finnhub events first, then hardcoded fallback
const getActiveEconomicEvent = (windowBeforeMin = 60, windowAfterMin = 90) => {
  const now = Date.now();
  // v5.26: Check live Finnhub events first
  for (const ev of liveEconomicEvents) {
    if (now >= ev.evTime - windowBeforeMin*60000 && now <= ev.evTime + windowAfterMin*60000) {
      const minsUntil = Math.round((ev.evTime - now) / 60000);
      return { ...ev, minsUntil, phase: minsUntil > 0 ? 'BEFORE' : 'DURING' };
    }
  }
  // Fallback: hardcoded one-off events
  for (const ev of ECONOMIC_EVENTS) {
    const evTime = new Date(`${ev.date}T${ev.timeUTC}:00Z`).getTime();
    if (now >= evTime - windowBeforeMin*60000 && now <= evTime + windowAfterMin*60000) {
      const minsUntil = Math.round((evTime - now) / 60000);
      return { ...ev, evTime, minsUntil, phase: minsUntil > 0 ? 'BEFORE' : 'DURING' };
    }
  }
  // Fallback: recurring weekly jobless claims (Thursday 12:30 UTC)
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

// Append a caution tag to alerts during event window (Option B: warn, don't block)
const econCautionTag = () => {
  const ev = getActiveEconomicEvent();
  if (!ev) return '';
  return `\n\n⚠️ <b>CAUTION:</b> ${ev.name} ${ev.phase === 'BEFORE' ? `in ~${ev.minsUntil}min` : 'happening now'} — high-impact data window. Use tight SL, reduce size, the move is fast.`;
};

// ── v5.27 MULTI-STAGE EVENT REMINDERS ────────────────────────────────────────
// Fires staggered reminders so user (busy at work) doesn't miss the window:
//   Morning 08:00 Dubai heads-up + T-4hr + T-60/45/30/15min + at-event
// Each stage dedup'd so it sends exactly once per event.
const eventReminderSent = new Set(); // keys: "evKey@stage"

// Get all events within next 5 hours (for reminder scanning)
const getUpcomingEventsForReminders = () => {
  const now = Date.now();
  const events = [];
  const seen = new Set();
  const add = (name, evTime) => {
    const k = `${name}-${new Date(evTime).toISOString().slice(0,13)}`;
    if (seen.has(k)) return; seen.add(k);
    events.push({ name, evTime, key: k });
  };
  // Live Finnhub events
  for (const ev of liveEconomicEvents) {
    if (ev.evTime > now - 5*60000 && ev.evTime < now + 5*60*60000) add(ev.name, ev.evTime);
  }
  // Hardcoded fallback
  for (const ev of ECONOMIC_EVENTS) {
    const evTime = new Date(`${ev.date}T${ev.timeUTC}:00Z`).getTime();
    if (evTime > now - 5*60000 && evTime < now + 5*60*60000) add(ev.name, evTime);
  }
  // Weekly jobless claims (Thursday)
  const d = new Date();
  if (d.getUTCDay() === 4) {
    const claimsTime = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 30, 0)).getTime();
    if (claimsTime > now - 5*60000 && claimsTime < now + 5*60*60000) add('US Jobless Claims + Data', claimsTime);
  }
  return events;
};

// Check and fire staggered reminders — called every scan
const checkEventReminders = async () => {
  const now = Date.now();
  // Morning heads-up: 08:00 Dubai if any event today
  const dubaiHour = parseInt(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  const dubaiDate = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dubai' });

  // Gather today's events for morning summary
  const allUpcoming = [];
  const seenM = new Set();
  for (const ev of liveEconomicEvents) {
    const evDubaiDate = new Date(ev.evTime).toLocaleDateString('en-US', { timeZone: 'Asia/Dubai' });
    if (evDubaiDate === dubaiDate && ev.evTime > now) {
      const k = `${ev.name}-${new Date(ev.evTime).toISOString().slice(0,13)}`;
      if (!seenM.has(k)) { seenM.add(k); allUpcoming.push(ev); }
    }
  }
  // Morning heads-up at 08:00 Dubai (fires during the 08:00 hour, once)
  const morningKey = `morning-${dubaiDate}`;
  if (dubaiHour === 8 && allUpcoming.length && !eventReminderSent.has(morningKey)) {
    eventReminderSent.add(morningKey);
    let msg = `📅 <b>TODAY'S HIGH-IMPACT EVENTS</b>\n━━━━━━━━━━━━━━━\n\n`;
    for (const ev of allUpcoming) {
      msg += `🕐 ${eventTimeDubai(ev.evTime)} Dubai — ${ev.name}\n`;
    }
    msg += `\nReminders will follow at 4hr, 1hr, then every 15min.\n<i>Plan your positions around these windows.</i>`;
    await tg(OWNER_CHAT_ID, msg);
  }

  // Staggered reminders per event
  const events = getUpcomingEventsForReminders();
  for (const ev of events) {
    const minsUntil = Math.round((ev.evTime - now) / 60000);
    // Define reminder stages (minutes before): 240, 60, 45, 30, 15, 0
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
          `🕐 ${eventTimeDubai(ev.evTime)} Dubai\n\n` +
          `${st.extra}\n\n` +
          `<i>Tight SL · reduce size · don't chase the first candle</i>\n` +
          `⏰ ${gstNow()} GST`);
        break; // one stage per scan per event
      }
    }
  }
  // Cleanup old reminder keys (older than 24h) to prevent unbounded growth
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
    // EMA50 is the gate. Requires 0.5% separation (avoid choppy EMA hugging)
    const pctAbove  = ((price - ema50) / ema50) * 100;
    const bullish   = pctAbove > 0.5;   // at least 0.5% above
    const bearish   = pctAbove < -0.5;  // at least 0.5% below
    const ema200ok  = ema200 ? (bullish ? ema50 > ema200 : ema50 < ema200) : true;
    return {
      bullish, bearish, ema50, ema200, ema200ok,
      pctAbove: parseFloat(pctAbove.toFixed(2)),
      reason: bullish
        ? `${pctAbove.toFixed(1)}% above EMA50${ema200ok ? ' ✅' : ' ⚡'}`
        : bearish
        ? `${Math.abs(pctAbove).toFixed(1)}% below EMA50${ema200ok ? ' ✅' : ' ⚡'}`
        : `hugging EMA50 ±0.5% — choppy ⚠️`,
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
const PUMP_COOLDOWN_MIN = 30;

// ── v5.0 Recovery System — track consecutive losses and adjust risk ──────────
const recoveryState = { consecutiveLosses: 0, lastTradeWin: null };

// v5.4 — Block reason counter for diagnostics
const blockReasons = {
  btcDrag: 0, pumped: 0, pumpCooldown: 0, dumpTrap: 0, newsEvent: 0,
  climax: 0, lowLiq: 0, correlation: 0, atrFlat: 0, weakCandle: 0,
  notExtended: 0, scoreLow: 0, htfMisaligned: 0, momentumAgainst: 0,
  hostileDirection: 0, fireCaution: 0  // v5.24 — Supabase decision layer
};
const incBlock = (reason) => { if (blockReasons[reason] !== undefined) blockReasons[reason]++; };

// v5.30 — Relative Strength watch: coins holding strong during BTC dumps
// Map<symbol, { detectedAt, detectPrice, detectChg, btcChgAtDetect, alerted }>
const rsWatch = new Map();

const getPositionSizeHint = () => {
  if (recoveryState.consecutiveLosses >= 2) return { pct: 50, label: '⚠️ REDUCED 50% (2 losses)' };
  return { pct: 100, label: 'NORMAL 100%' };
};

// Periodic cleanup of stale pump records (prevents memory leak)
const cleanupPumpTracker = () => {
  const cutoff = Date.now() - (PUMP_COOLDOWN_MIN * 2 * 60000); // 2x cooldown window
  let cleaned = 0;
  for (const [k, v] of pumpTracker.entries()) {
    if (v.pumpedAt < cutoff) { pumpTracker.delete(k); cleaned++; }
  }
  if (cleaned > 0) log(`🧹 Pump tracker cleaned: ${cleaned} stale entries`);
};

// Tighter pump detection — checks 3 timeframes, any trigger blocks
// ── RSI Helper (v5.4) ────────────────────────────────────────────────────────
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

// ── MA Stack Analysis (v5.4) ─────────────────────────────────────────────────
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

// ── BTC Cycle Position (v5.10) — WARNING ONLY, no blocking ───────────────────
// Tells us where BTC is in its weekly cycle: bottom / mid / top / falling
// Used to add warning labels to alerts when entry timing might be risky
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

// ── BTC Early Warning (v5.17) ────────────────────────────────────────────────
// Faster detection layer using 15m EMA20 + momentum slope
// Runs ALONGSIDE the slower regime predictor (does not replace it)
// Sends DM warning BEFORE official regime change occurs
// Only OWNER + PAPER_TEST_USERS receive these warnings
let btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
const EARLY_WARNING_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between same-direction warnings

const checkBTCEarlyWarning = async () => {
  try {
    // Fetch 15m candles (last 30 = ~7.5 hours of data)
    const klines15m = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=30');
    if (!klines15m || klines15m.length < 25) return;

    const closes = klines15m.map(k => parseFloat(k[4]));
    const opens = klines15m.map(k => parseFloat(k[1]));
    const volumes = klines15m.map(k => parseFloat(k[5]));
    const price = closes[closes.length - 1];

    // 15m EMA20 (faster than 1H EMA50)
    const ema20_15m = calcEMAFromCloses(closes, 20);

    // Recent momentum (last 4 × 15m = 1 hour)
    const lastHour = ((price - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
    // Previous hour (5-9 candles ago) for slope comparison
    const prevHour = ((closes[closes.length - 5] - closes[closes.length - 9]) / closes[closes.length - 9]) * 100;
    // Slope: is momentum accelerating or decelerating?
    const momentumSlope = lastHour - prevHour;

    // Count recent red candles
    let redStreak = 0, greenStreak = 0;
    for (let i = closes.length - 1; i >= closes.length - 8; i--) {
      if (closes[i] < opens[i]) redStreak++; else break;
    }
    for (let i = closes.length - 1; i >= closes.length - 8; i--) {
      if (closes[i] > opens[i]) greenStreak++; else break;
    }

    // Volume on red vs green candles
    const redCandles = []; const greenCandles = [];
    for (let i = closes.length - 8; i < closes.length; i++) {
      if (closes[i] < opens[i]) redCandles.push(volumes[i]);
      else greenCandles.push(volumes[i]);
    }
    const avgRedVol = redCandles.length > 0 ? redCandles.reduce((s,v)=>s+v,0) / redCandles.length : 0;
    const avgGreenVol = greenCandles.length > 0 ? greenCandles.reduce((s,v)=>s+v,0) / greenCandles.length : 0;

    // ─── EARLY WARNING TRIGGERS ────────────────────────────────────
    let warningType = null;
    let warningMsg = '';
    let direction = null;

    // BEARISH early warning: price below 15m EMA20 + negative momentum + accelerating
    if (price < ema20_15m && lastHour < -0.3 && momentumSlope < -0.1 && redStreak >= 3) {
      warningType = 'BEARISH_EARLY';
      direction = 'down';
      warningMsg = `📉 <b>BTC EARLY WARNING — Bearish momentum building</b>\n`
                 + `━━━━━━━━━━━━━━━\n`
                 + `Price: $${price.toFixed(0)} (below 15m EMA20: $${ema20_15m.toFixed(0)})\n`
                 + `Last hour: ${lastHour.toFixed(2)}% · Slope: ${momentumSlope.toFixed(2)}%\n`
                 + `Red streak: ${redStreak} consecutive 15m candles\n`
                 + `Volume on reds vs greens: ${avgRedVol > avgGreenVol ? '↑ stronger (sellers active)' : 'normal'}\n\n`
                 + `⚠️ <b>Action suggestions:</b>\n`
                 + `• Tighten trailing stops on open LONG positions\n`
                 + `• Don't open new LONG even if FIRE alert fires\n`
                 + `• Watch for regime change to BEARISH soon\n\n`
                 + `<i>Note: Official regime still ${btcRegime.regime}. This is a faster heads-up.</i>\n`
                 + `⏰ ${gstNow()} GST`;
    }
    // BULLISH early warning: price above 15m EMA20 + positive momentum + accelerating  
    else if (price > ema20_15m && lastHour > 0.3 && momentumSlope > 0.1 && greenStreak >= 3) {
      warningType = 'BULLISH_EARLY';
      direction = 'up';
      warningMsg = `📈 <b>BTC EARLY WARNING — Bullish momentum building</b>\n`
                 + `━━━━━━━━━━━━━━━\n`
                 + `Price: $${price.toFixed(0)} (above 15m EMA20: $${ema20_15m.toFixed(0)})\n`
                 + `Last hour: +${lastHour.toFixed(2)}% · Slope: +${momentumSlope.toFixed(2)}%\n`
                 + `Green streak: ${greenStreak} consecutive 15m candles\n\n`
                 + `🟢 <b>Action suggestions:</b>\n`
                 + `• LONG opportunities forming, watch for FIRE alerts\n`
                 + `• Don't open SHORTs even if signal fires\n`
                 + `• Watch for regime change to BULLISH soon\n\n`
                 + `<i>Note: Official regime still ${btcRegime.regime}. This is a faster heads-up.</i>\n`
                 + `⏰ ${gstNow()} GST`;
    }

    // Send warning if triggered (with cooldown to avoid spam)
    if (warningType && direction !== btcEarlyWarning.lastDirection) {
      const sinceLast = Date.now() - btcEarlyWarning.notifiedAt;
      if (sinceLast > EARLY_WARNING_COOLDOWN_MS) {
        const recipients = [OWNER_CHAT_ID, ...PAPER_TEST_USERS];
        for (const r of recipients) {
          await tg(r, warningMsg);
        }
        btcEarlyWarning = { state: warningType, notifiedAt: Date.now(), lastDirection: direction };
        log(`⚡ EARLY WARNING: ${warningType} — 1H ${lastHour.toFixed(2)}%, slope ${momentumSlope.toFixed(2)}%`);
      }
    }
    // Reset state when conditions normalize
    else if (!warningType && btcEarlyWarning.state !== 'normal') {
      const sinceLast = Date.now() - btcEarlyWarning.notifiedAt;
      // Only reset after 30 min of calm
      if (sinceLast > EARLY_WARNING_COOLDOWN_MS) {
        btcEarlyWarning = { state: 'normal', notifiedAt: 0, lastDirection: null };
        log(`✅ Early warning cleared — conditions normalized`);
      }
    }
  } catch (err) {
    log(`⚠️ Early warning check failed: ${err.message}`);
  }
};

// ── BTC Regime Predictor (v5.4) ───────────────────────────────────────────────
// Classifies BTC into BULLISH / BEARISH / CHOPPY based on multiple TF + momentum
// Blocks all signals during CHOPPY (where most losses happen)
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

    // Momentum: 4-candle (4h on 1H, 16h on 4H)
    const momentum1H = ((price - closes1H[closes1H.length - 5]) / closes1H[closes1H.length - 5]) * 100;
    const momentum4H = ((price - closes4H[closes4H.length - 4]) / closes4H[closes4H.length - 4]) * 100;

    // Range tightness (1H last 24 candles)
    const recent24h = closes1H.slice(-24);
    const rangePct = ((Math.max(...recent24h) - Math.min(...recent24h)) / price) * 100;

    let regime = 'CHOPPY';
    let confidence = 0;
    const reasons = [];

    const above1H = price > ema50_1h;
    const above4H = price > ema50_4h;
    const trendUp = ema50_4h > ema200_4h;

    // v5.5 — Looser regime detection. Defaults to direction based on price vs EMA50.
    // Only marks CHOPPY when truly sideways (both TFs disagree AND tight range)
    
    // BULLISH: price above EMA50 1H, optionally above 4H — momentum can be small
    if (above1H && (above4H || momentum1H > 0.2)) {
      regime = 'BULLISH';
      confidence = (above1H && above4H && trendUp) ? 80 : 60;
      reasons.push(above4H ? `above EMA50 1H+4H` : `above EMA50 1H`, `momentum +${momentum1H.toFixed(1)}%/+${momentum4H.toFixed(1)}%`);
    }
    // BEARISH: price below EMA50 1H, optionally below 4H
    else if (!above1H && (!above4H || momentum1H < -0.2)) {
      regime = 'BEARISH';
      confidence = (!above1H && !above4H && !trendUp) ? 80 : 60;
      reasons.push(!above4H ? `below EMA50 1H+4H` : `below EMA50 1H`, `momentum ${momentum1H.toFixed(1)}%/${momentum4H.toFixed(1)}%`);
    }
    // CHOPPY: only when 1H/4H disagree AND range is genuinely tight
    else {
      regime = 'CHOPPY';
      confidence = 70;
      reasons.push(`range ${rangePct.toFixed(1)}% in 24h`, `1H/4H mixed`);
    }

    const changed = regime !== btcRegime.regime;
    btcRegime = {
      regime, confidence,
      reason: reasons.join(' · '),
      changedAt: changed ? Date.now() : btcRegime.changedAt,
      lastNotified: btcRegime.lastNotified,
      momentum1H: parseFloat(momentum1H.toFixed(2)),
      momentum4H: parseFloat(momentum4H.toFixed(2)),
      rangePct: parseFloat(rangePct.toFixed(2)),
    };

    // v5.17 fix: Notify on EVERY regime change, not just first occurrence
    // Previous bug: if regime flipped BULLISH→CHOPPY→BULLISH, only first DM sent
    // Now: notify whenever 'changed' is true (regime differs from previous check)
    if (changed) {
      const emoji = regime === 'BULLISH' ? '🟢' : regime === 'BEARISH' ? '🔴' : '🟡';
      const msg = regime === 'BULLISH'
        ? 'LONG signals enabled · SHORT blocked'
        : regime === 'BEARISH'
        ? 'SHORT signals enabled · LONG blocked'
        : '⚠️ ALL signals blocked — sit out';
      // Send to owner + paper test users (so friend sees regime changes too)
      const recipients = [OWNER_CHAT_ID, ...PAPER_TEST_USERS];
      for (const r of recipients) {
        await tg(r, `${emoji} <b>BTC REGIME CHANGE: ${regime}</b>\n━━━━━━━━━━━━━━━\n${reasons.join('\n')}\n\nConfidence: ${confidence}%\n${msg}\n⏰ ${gstNow()} GST`);
      }
      btcRegime.lastNotified = regime;
      log(`📡 BTC REGIME: ${regime} (${confidence}%) — ${reasons.join(', ')}`);
    }

    return btcRegime;
  } catch (err) {
    log(`⚠️ BTC regime check failed: ${err.message}`);
    return btcRegime;
  }
};

// ── Fake Pump History Detector (v5.4) ────────────────────────────────────────
// Looks at last 7 days of 4H candles
// Counts how many times this coin pumped 5%+ then dumped back within 8 hours
// If 3+ instances → flag as PUMP_DUMP coin → block all signals
const fakePumpCache = new Map(); // symbol → { result, ts }
const FAKE_PUMP_CACHE_MS = 4 * 3600 * 1000; // 4h cache

const checkFakePumpHistory = async (symbol) => {
  const cached = fakePumpCache.get(symbol);
  if (cached && Date.now() - cached.ts < FAKE_PUMP_CACHE_MS) return cached.result;

  try {
    // Fetch last 7 days of 4H candles (42 candles)
    const klines4h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=42`);
    if (!klines4h || klines4h.length < 20) {
      const result = { isPumpDump: false, fakeCount: 0, reason: 'insufficient history' };
      fakePumpCache.set(symbol, { result, ts: Date.now() });
      return result;
    }

    let fakeCount = 0;
    const events = [];

    // Walk through history — find pump candles followed by dumps
    for (let i = 0; i < klines4h.length - 2; i++) {
      const open = parseFloat(klines4h[i][1]);
      const high = parseFloat(klines4h[i][2]);
      const low  = parseFloat(klines4h[i][3]);
      const close = parseFloat(klines4h[i][4]);

      // Did this candle pump 5%+ from open?
      const pumpPct = ((high - open) / open) * 100;
      if (pumpPct < 5) continue;

      // Did the next 2 candles dump back below the original open?
      const next1Low = parseFloat(klines4h[i+1][3]);
      const next2Low = parseFloat(klines4h[i+2][3]);
      const lowestAfter = Math.min(next1Low, next2Low);
      const dumpedBack = lowestAfter < open;

      if (dumpedBack) {
        fakeCount++;
        events.push(`+${pumpPct.toFixed(1)}% → dumped`);
      }
    }

    // 3+ fake pumps in 7 days = pump-dump scheme coin
    const isPumpDump = fakeCount >= 3;

    const result = {
      isPumpDump,
      fakeCount,
      events: events.slice(-3), // keep last 3 for logging
      reason: isPumpDump ? `🚨 ${fakeCount} fake pumps in 7d` : `${fakeCount} fake pumps in 7d (clean)`,
    };

    fakePumpCache.set(symbol, { result, ts: Date.now() });
    return result;
  } catch (err) {
    log(`⚠️ Fake pump history check failed for ${symbol}: ${err.message}`);
    return { isPumpDump: false, fakeCount: 0, reason: 'fetch failed' };
  }
};

// ── ATR Expansion Check (v5.0) ───────────────────────────────────────────────
// Real moves have EXPANDING volatility (wider candles)
// Flat/shrinking ATR = sideways chop = fakeouts
const checkATRExpansion = (klines) => {
  if (!klines || klines.length < 30) return { expanding: false, reason: 'insufficient data', expansion: 0 };
  const atr10 = calculateATR(klines.slice(-10), 10);
  const atr20 = calculateATR(klines.slice(-30, -10), 10);
  if (atr20 === 0) return { expanding: false, reason: 'zero ATR', expansion: 0 };
  const expansion = ((atr10 - atr20) / atr20) * 100;
  const expanding = expansion > 5; // v5.9 — loosened from 10% to 5%
  return {
    expanding,
    expansion: parseFloat(expansion.toFixed(1)),
    atr10: parseFloat(atr10.toFixed(6)),
    atr20: parseFloat(atr20.toFixed(6)),
    reason: expanding ? `ATR +${expansion.toFixed(1)}%` : `ATR flat ${expansion.toFixed(1)}%`,
  };
};

// ── Funding Mean Reversion (v4.2) ─────────────────────────────────────────────
// Fetches last 50 funding rates (≈16 hours) and flags extreme readings
// Extreme negative = shorts heavily paying = squeeze setup
// Extreme positive = longs heavily paying = short setup primed
// Cached 1h per coin to limit API load
const fundingHistCache = new Map();
const FUNDING_CACHE_MS = 3600000; // 1h

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

    // z-score of current vs history
    const z = std > 0 ? (currentFunding - avg) / std : 0;
    const extremeNeg = z < -2;  // 2 std dev below avg = squeeze-ready
    const extremePos = z > 2;   // 2 std dev above avg = short-ready
    return {
      extreme: extremeNeg || extremePos,
      extremeNeg, extremePos,
      z: parseFloat(z.toFixed(2)),
      avg: parseFloat(avg.toFixed(4)),
      current: currentFunding,
    };
  } catch {
    return { extreme: false };
  }
};

const checkRecentPump = (klines, price) => {
  if (klines.length < 8) return { pumped: false, pct: 0, window: null };

  // Window 1: last 2 candles (~30min on 15m) — blocks fresh pumps
  const price30m = parseFloat(klines[klines.length - 2][4]);
  const pct30m = Math.abs((price - price30m) / price30m) * 100;

  // Window 2: last 4 candles (~1h) — blocks recent pumps
  const price1h = parseFloat(klines[klines.length - 4][4]);
  const pct1h = Math.abs((price - price1h) / price1h) * 100;

  // Window 3: last 8 candles (~2h) — blocks bigger moves
  const price2h = parseFloat(klines[klines.length - 8][4]);
  const pct2h = Math.abs((price - price2h) / price2h) * 100;

  // Stricter thresholds: any window triggers
  let pumped = false;
  let pct = 0;
  let window = null;
  if (pct30m >= 3)        { pumped = true; pct = pct30m; window = '30m'; }
  else if (pct1h >= 4)    { pumped = true; pct = pct1h;  window = '1h'; }
  else if (pct2h >= 6)    { pumped = true; pct = pct2h;  window = '2h'; }

  return { pumped, pct: parseFloat(pct.toFixed(2)), window, pct30m: +pct30m.toFixed(1), pct1h: +pct1h.toFixed(1), pct2h: +pct2h.toFixed(1) };
};
const dailyLosses   = { count: 0, date: '', totalPnlPct: 0, dailyProfitPct: 0, dailyTrades: 0 };

// v5.0 daily limits — stop trading on target OR stop-loss
const DAILY_PNL_KILL      = -5.0;  // hard kill at -5% estimated daily
const DAILY_LOSS_STOP_PCT = -1.5;  // stop trading at -1.5% loss
const DAILY_PROFIT_STOP   = 2.0;   // stop trading at +2% profit (preservation)
const MAX_TRADES_PER_DAY  = 3;     // hard cap on daily signals
const LOSS_COOLDOWN = 90;
const DAILY_KILL    = 3;
const HARD_KILL_24H = 5; // absolute cap across 24h regardless of date

const recordLoss = (symbol) => {
  const today = new Date().toDateString();
  if (dailyLosses.date !== today) { dailyLosses.count = 0; dailyLosses.totalPnlPct = 0; dailyLosses.dailyProfitPct = 0; dailyLosses.dailyTrades = 0; dailyLosses.date = today; }
  dailyLosses.count++;
  dailyLosses.totalPnlPct -= 1.8;
  recoveryState.consecutiveLosses++;
  recoveryState.lastTradeWin = false;
  lossTracker.set(symbol, { lossTime: Date.now() });
  const sizeHint = getPositionSizeHint();
  log(`❌ Loss: ${symbol} | Daily: ${dailyLosses.count}/${DAILY_KILL} | Est PnL: ${dailyLosses.totalPnlPct.toFixed(1)}% | Consecutive: ${recoveryState.consecutiveLosses} | Next size: ${sizeHint.label}`);
};

const recordWin = (symbol, pnlPct) => {
  recoveryState.consecutiveLosses = 0; // reset on win
  recoveryState.lastTradeWin = true;
  log(`✅ Win: ${symbol} | +${pnlPct.toFixed(2)}% | Consecutive losses reset`);
};

// 7-day rolling PnL from paper trades (counts LOSS outcomes, estimates -1.8% each)
let weeklyDrawdown = 0;
let weeklyDrawdownCheckedAt = 0;
const WEEKLY_DD_CACHE_MS = 600000; // 10 min cache
const WEEKLY_DD_KILL = -15.0;       // -15% = stop all

const checkWeeklyDrawdown = async () => {
  const now = Date.now();
  if (now - weeklyDrawdownCheckedAt < WEEKLY_DD_CACHE_MS) return weeklyDrawdown;
  try {
    const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const losses = await sb(`paper_trades?outcome=eq.LOSS&created_at=gte.${since}&select=id`) || [];
    const wins   = await sb(`paper_trades?outcome=eq.WIN&created_at=gte.${since}&select=id`) || [];
    // v5.31 FIX: old formula counted ONLY losses — 9 losses blocked ALL trading
    // even in a net-winning week (e.g. 15W/9L). Drawdown must be NET.
    const netLosses = Math.max(0, losses.length - wins.length);
    weeklyDrawdown = netLosses * -1.8; // each NET loss ≈ -1.8%
    weeklyDrawdownCheckedAt = now;
    if (weeklyDrawdown <= WEEKLY_DD_KILL) log(`🛑 WEEKLY DRAWDOWN: ${weeklyDrawdown.toFixed(1)}% — all trading blocked`);
    return weeklyDrawdown;
  } catch {
    return weeklyDrawdown;
  }
};

const isBlocked = (symbol) => {
  if (weeklyDrawdown <= WEEKLY_DD_KILL) return { blocked: true, reason: `Weekly drawdown ${weeklyDrawdown.toFixed(1)}% — trading halted` };
  if (dailyLosses.totalPnlPct <= DAILY_PNL_KILL) return { blocked: true, reason: `Daily PnL kill (${dailyLosses.totalPnlPct.toFixed(1)}%)` };
  if (dailyLosses.count >= DAILY_KILL) return { blocked: true, reason: `Daily kill switch (${dailyLosses.count} losses)` };
  // Hard 24h kill — count rolling 24h losses from lossTracker
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
const checkEarlyEntry = (compression, volume, fundingLS, klines) => {
  const quietAccum   = compression.compressed && compression.oiBuilding;
  const notBrokenOut = volume.spike < 1.5;
  const fundingReady = fundingLS.funding < 0 || fundingLS.ls < 1.0;

  // FIX 3: Early interest — volume ticking up in last 2 candles vs prior 4
  // Prevents firing on "dead compression" (flat + no interest = no pending move)
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

// ── COIN BEHAVIOR RECORDER (v5.7) ────────────────────────────────────────────
// Records every coin observation to Supabase for long-term analysis
// Runs ALONGSIDE existing logic — does not affect current alerts or filters
// After 14-30 days of data, we can analyze each coin's "personality"
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
  } catch (err) {
    // Silent fail — never affects main scanning
  }
};

// ── ROLLING COIN INTELLIGENCE (v5.8) ─────────────────────────────────────────
// Uses last 7 days of paper_trades + coin_behavior to build live coin profiles
// Cached 30 min per coin. Display only — does NOT auto-block any coin.
const coinProfileCache = new Map(); // symbol → { profile, ts }
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

    // v5.12 — split by signal type
    const earlyTrades = closed.filter(t => t.signal_type === 'EARLY');
    const fireTrades = closed.filter(t => t.signal_type === 'FIRE');
    const earlyWins = earlyTrades.filter(t => t.outcome === 'WIN').length;
    const fireWins = fireTrades.filter(t => t.outcome === 'WIN').length;
    const earlyWR = earlyTrades.length > 0 ? (earlyWins / earlyTrades.length) : null;
    const fireWR = fireTrades.length > 0 ? (fireWins / fireTrades.length) : null;

    // v5.20 — split by direction (LONG vs SHORT separately)
    const longTrades = closed.filter(t => t.direction === 'LONG');
    const shortTrades = closed.filter(t => t.direction === 'SHORT');
    const longWins = longTrades.filter(t => t.outcome === 'WIN').length;
    const shortWins = shortTrades.filter(t => t.outcome === 'WIN').length;
    const longLosses = longTrades.length - longWins;
    const shortLosses = shortTrades.length - shortWins;
    const longWR = longTrades.length > 0 ? (longWins / longTrades.length) : null;
    const shortWR = shortTrades.length > 0 ? (shortWins / shortTrades.length) : null;

    // 7-day behavior data (extended from 24h to 7d for better insight)
    const behavior = (await sb(`coin_behavior?symbol=eq.${symbol}&recorded_at=gte.${since}&select=candle_color,score,vol_vs_avg,rsi,ma_stack,btc_regime,session`)) || [];
    const obsCount = behavior.length;
    const greens = behavior.filter(b => b.candle_color === 'green').length;
    const greenRatio = obsCount > 0 ? (greens / obsCount) : null;
    const scores = behavior.map(b => parseFloat(b.score || 0)).filter(s => !isNaN(s));
    const avgScore = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
    const peakScore = scores.length > 0 ? Math.max(...scores) : null;

    // Volume signature
    const volRatios = behavior.map(b => parseFloat(b.vol_vs_avg || 0)).filter(v => !isNaN(v) && v > 0);
    const avgVolRatio = volRatios.length > 0 ? volRatios.reduce((s, v) => s + v, 0) / volRatios.length : null;

    // RSI baseline
    const rsis = behavior.map(b => parseFloat(b.rsi || 0)).filter(r => !isNaN(r) && r > 0);
    const avgRsi = rsis.length > 0 ? rsis.reduce((s, v) => s + v, 0) / rsis.length : null;

    // Session distribution
    const sessions = { ASIA: 0, LONDON: 0, NY: 0, OFF: 0 };
    behavior.forEach(b => { if (sessions[b.session] !== undefined) sessions[b.session]++; });

    // Verdict reasoning — v5.19: more sensitive to early loss patterns
    let verdict = 'INSUFFICIENT_DATA';
    let verdictEmoji = '⚪';
    let verdictReason = 'Need more data';
    if (total >= 3) {
      if (winRate >= 0.65 && greenRatio >= 0.5) {
        verdict = 'TRUSTED'; verdictEmoji = '🟢';
        verdictReason = 'Strong WR + bullish bias';
      } else if (winRate >= 0.5) {
        verdict = 'NORMAL'; verdictEmoji = '🟡';
        verdictReason = 'Average performance';
      } else if (winRate < 0.4) {
        verdict = 'HOSTILE'; verdictEmoji = '🔴';
        verdictReason = `Poor WR (${(winRate*100).toFixed(0)}%)`;
      }
    } else if (total === 2 && wins === 0) {
      // v5.19 — Early warning: 2 losses, no wins yet
      verdict = 'WARNING'; verdictEmoji = '🟠';
      verdictReason = `Lost 2/2 recent trades — caution`;
    } else if (total === 1 && losses === 1) {
      // v5.19 — Early note: 1 loss so far
      verdict = 'CAUTION'; verdictEmoji = '🟡';
      verdictReason = `1 loss recorded, watch closely`;
    } else if (obsCount >= 100 && greenRatio !== null) {
      // No trade history yet, but enough observations
      if (greenRatio >= 0.55) {
        verdict = 'PROMISING'; verdictEmoji = '🟢';
        verdictReason = `${(greenRatio*100).toFixed(0)}% green (no trades yet)`;
      } else if (greenRatio < 0.4) {
        verdict = 'WEAK'; verdictEmoji = '🔴';
        verdictReason = `Mostly red (${(greenRatio*100).toFixed(0)}% green)`;
      }
    }

    let tier = 'UNKNOWN';
    let action = 'normal';
    if (total >= 3) {
      if (winRate >= 0.7)      { tier = 'A'; action = 'boost'; }
      else if (winRate >= 0.5) { tier = 'B'; action = 'normal'; }
      else if (winRate < 0.4)  { tier = 'C'; action = 'normal'; }
    }

    const profile = {
      symbol, tier, action,
      winRate, wins, losses, totalTrades: total,
      // EARLY/FIRE breakdown
      earlyWR, earlyWins, earlyLosses: earlyTrades.length - earlyWins, earlyTotal: earlyTrades.length,
      fireWR, fireWins, fireLosses: fireTrades.length - fireWins, fireTotal: fireTrades.length,
      // v5.20 — direction-specific WR
      longWR, longWins, longLosses, longTotal: longTrades.length,
      shortWR, shortWins, shortLosses, shortTotal: shortTrades.length,
      // Behavior stats
      greenRatio, avgScore, peakScore, avgVolRatio, avgRsi,
      observations: obsCount, sessions,
      // Verdict
      verdict, verdictEmoji, verdictReason,
      hasData: total >= 1 || obsCount >= 10,
    };

    coinProfileCache.set(symbol, { profile, ts: Date.now() });
    return profile;
  } catch (err) {
    return { symbol, tier: 'UNKNOWN', action: 'normal', hasData: false, totalTrades: 0, wins: 0, losses: 0, winRate: null, verdict: 'ERROR', verdictEmoji: '⚪', verdictReason: 'Profile fetch failed' };
  }
};

// ── v5.24 SUPABASE DECISION LAYER ────────────────────────────────────────────
// Uses profile data to make actual blocking/adjusting decisions, not just display

// Layer 1: Check if coin should be hard-blocked due to hostile direction history
// Returns { block: bool, reason: string }
const checkHostileDirection = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') {
    return { block: false, reason: '' };
  }
  const isLong = direction === 'LONG';
  const dirWR = isLong ? profile.longWR : profile.shortWR;
  const dirTotal = isLong ? profile.longTotal : profile.shortTotal;
  const dirWins = isLong ? profile.longWins : profile.shortWins;
  const dirLosses = isLong ? profile.longLosses : profile.shortLosses;

  // Need at least 3 trades on this direction with WR < 35%
  if (dirTotal >= 3 && dirWR !== null && dirWR < 0.35) {
    return {
      block: true,
      reason: `${direction} WR ${(dirWR*100).toFixed(0)}% (${dirWins}W/${dirLosses}L)`
    };
  }
  return { block: false, reason: '' };
};

// Layer 2: Calculate score adjustment based on coin track record
// Returns { adjustment: number, reason: string }
// Positive adjustment = coin is trusted, lower bar
// Negative adjustment = coin is risky, higher bar
const calcScoreAdjustment = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') {
    return { adjustment: 0, reason: '' };
  }
  const isLong = direction === 'LONG';
  const dirWR = isLong ? profile.longWR : profile.shortWR;
  const dirTotal = isLong ? profile.longTotal : profile.shortTotal;

  // TRUSTED: 5+ trades with WR >= 60% → -1 score required (easier to fire)
  if (dirTotal >= 5 && dirWR !== null && dirWR >= 0.60) {
    return { adjustment: -1.0, reason: `TRUSTED ${(dirWR*100).toFixed(0)}% WR` };
  }
  // CAUTION: 3+ trades with WR between 35-45% → +1 score required (harder to fire)
  if (dirTotal >= 3 && dirWR !== null && dirWR >= 0.35 && dirWR < 0.45) {
    return { adjustment: +1.0, reason: `CAUTION ${(dirWR*100).toFixed(0)}% WR` };
  }
  return { adjustment: 0, reason: '' };
};

// Layer 3: Should FIRE signal be blocked on a CAUTION-rated coin?
// FIRE is supposed to be high conviction — don't fire on marginal coins
const shouldBlockFireOnCaution = (profile, direction) => {
  if (!profile || profile.verdict === 'ERROR' || profile.verdict === 'INSUFFICIENT_DATA') {
    return false;
  }
  // Block FIRE if coin has CAUTION or worse verdict overall
  if (profile.verdict === 'CAUTION' || profile.verdict === 'WARNING') {
    return true;
  }
  return false;
};

// ── PAPER TRADE LOGGER ───────────────────────────────────────────────────────
// Logs every signal to Supabase 'paper_trades' table for outcome tracking
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
    log(`✅ Paper trade saved: ${signal.symbol} (response: ${JSON.stringify(result).slice(0,100)})`);
    lastSignalLogTime = Date.now();
  } catch (err) {
    log(`❌ Paper log FAILED for ${signal.symbol}: ${err.message || err}`);
    log(`   Full error: ${JSON.stringify(err).slice(0, 200)}`);
  }
};

// ── Daily Summary + Anomaly Alerts (v5.4) ────────────────────────────────────
// Auto-pushes summary at 21:00 Dubai daily — no need to remember /stats
// Also pings on critical anomalies (paper logger broken, BTC fetch dead, etc)

let lastSummaryDate = '';
let lastAnomalyCheck = 0;
let lastSignalLogTime = Date.now();
let btcFetchFails = 0;

const sendDailySummary = async () => {
  try {
    // Stats
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

    // Top block reasons today
    const sortedBlocks = Object.entries(blockReasons).sort((a,b) => b[1] - a[1]).filter(([_,v]) => v > 0).slice(0, 3);
    const topBlocks = sortedBlocks.length > 0
      ? sortedBlocks.map(([k,v]) => `  ${k}: ${v}`).join('\n')
      : '  none';

    // Health
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

    // Reset block counters for next day
    Object.keys(blockReasons).forEach(k => blockReasons[k] = 0);
    btcFetchFails = 0;
  } catch (err) {
    log(`⚠️ Daily summary failed: ${err.message}`);
  }
};

// Schedule check every 30 min — fires summary at 21:00 Dubai
const checkDailySummary = async () => {
  const now = new Date();
  const dubaiHour = parseInt(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Dubai' }));
  const today = now.toDateString();
  if (dubaiHour === 21 && lastSummaryDate !== today) {
    lastSummaryDate = today;
    await sendDailySummary();
  }
};

// Anomaly checker — runs every hour
const checkAnomalies = async () => {
  try {
    const alerts = [];

    // 1. Paper logger silent — v5.17 smarter check
    // Only alert if BTC was tradeable AND filters weren't blocking everything
    // The block counter (resets daily at 21:00) tells us if filters were active
    const minsSinceLog = (Date.now() - lastSignalLogTime) / 60000;
    const btcWasTradeable = btcRegime.regime === 'BULLISH' || btcRegime.regime === 'BEARISH';
    const totalBlocksToday = Object.values(blockReasons).reduce((a,b) => a+b, 0);
    // Real bug indicator: BTC tradeable AND tracker active AND <30 blocks (bot not really scanning)
    if (minsSinceLog > 1440 && fullScanCount > 10 && btcWasTradeable && totalBlocksToday < 30 && coinTracker.size > 0) {
      alerts.push(`⚠️ No paper trade logged in ${Math.floor(minsSinceLog/60)}h despite tradeable BTC and active tracker — logger may be broken`);
    }
    // Soft notice if it's been quiet but bot was actively filtering (correct behavior)
    else if (minsSinceLog > 1440 && (btcRegime.regime === 'CHOPPY' || totalBlocksToday >= 30)) {
      log(`ℹ️ No signals in ${Math.floor(minsSinceLog/60)}h — bot filtered ${totalBlocksToday} setups (correct behavior)`);
    }

    // 2. BTC fetch failing — only alert if BTC is CURRENTLY broken AND lots of recent failures
    // The counter resets on each successful BTC fetch in checkBTCGate
    if (btcFetchFails >= 20 && btcGateStatus.price === 0) {
      alerts.push(`⚠️ BTC fetch currently broken (${btcFetchFails} fails) — check Railway/Binance`);
    }

    // 3. Tracker stuck (no growth in 2+ hours of scans)
    // v5.23: Smarter — don't false-alarm when both LONG and SHORT are blocked
    // Examples: BEARISH regime + SHORT disabled, or CHOPPY blocks all
    if (fullScanCount > 30 && coinTracker.size === 0) {
      const isBearish = btcRegime.regime === 'BEARISH';
      const isChoppy = btcRegime.regime === 'CHOPPY';
      const inRegimeMin = Math.floor((Date.now() - (btcRegime.changedAt || Date.now())) / 60000);
      // Real bug: bot scanning but tracker empty when SHOULD be finding things
      if (isChoppy) {
        log(`ℹ️ Tracker empty (${fullScanCount} scans) — CHOPPY blocks all (correct)`);
      } else if (isBearish) {
        // v5.28.1: SHORT disabled in v5.28 + LONG blocked in BEARISH = empty tracker is EXPECTED
        log(`ℹ️ Tracker empty — BEARISH regime, SHORT disabled (v5.28), LONG blocked (correct)`);
      } else {
        alerts.push(`⚠️ Coin tracker empty despite ${fullScanCount} scans + ${btcRegime.regime} regime — possible filter issue`);
      }
    }

    // 4. BTC regime stuck UNKNOWN for 1+ hour
    if (btcRegime.regime === 'UNKNOWN' && Date.now() - btcRegime.changedAt > 3600000) {
      alerts.push(`⚠️ BTC regime stuck UNKNOWN — regime predictor not updating`);
    }

    // 5. Watchlist drained to near-zero
    const wl = await getWatchlist();
    if (wl.length < 5 && fullScanCount > 5) {
      alerts.push(`⚠️ Watchlist only ${wl.length} coins — may need /clearwatchlist + /fullscan`);
    }

    if (alerts.length > 0) {
      const msg = `🚨 <b>NEXIO ANOMALY DETECTED</b>\n━━━━━━━━━━━━━━━\n${alerts.join('\n\n')}\n\n⏰ ${gstNow()} GST`;
      await tg(OWNER_CHAT_ID, msg);
      log('🚨 Anomaly alert sent: ' + alerts.length + ' issue(s)');
    }
  } catch (err) {
    log(`⚠️ Anomaly check failed: ${err.message}`);
  }
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
  // In PAPER_MODE: owner + designated test users (friends), no public channels
  // In LIVE_MODE: owner + free channel + premium channel
  const targets = PAPER_MODE
    ? [OWNER_CHAT_ID, ...PAPER_TEST_USERS]
    : [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID];
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
    // v4.2 — DIRECTION-AWARE BTC GATE
    // General pass = only blocked when BTC is doing something extreme (flash crash, overheated)
    // Then per-direction flags check alignment
    // v5.15 — Label now reflects RECENT 1H momentum, not just 24h "stability"
    let pass = true, reason;
    if (change1H >= 0.5)       reason = `📈 BTC pumping +${change1H.toFixed(2)}% (1H)`;
    else if (change1H >= 0.1)  reason = `🟢 BTC drifting up +${change1H.toFixed(2)}% (1H)`;
    else if (change1H > -0.1)  reason = `⚪ BTC flat ${change1H.toFixed(2)}% (1H)`;
    else if (change1H > -0.5)  reason = `🟡 BTC drifting down ${change1H.toFixed(2)}% (1H)`;
    else                       reason = `🔴 BTC dumping ${change1H.toFixed(2)}% (1H)`;

    // Extreme conditions that block BOTH directions (flash crash / extreme volatility)
    const extremeMove = Math.abs(change1H) > 2.5 || Math.abs(change24h) > 7;
    if (extremeMove) {
      pass = false;
      reason = `⚡ BTC extreme move (1H ${change1H.toFixed(2)}%) — skip all`;
    } else if (fundRate > 0.04) {
      pass = false;
      reason = `⚠️ BTC funding extreme ${fundRate.toFixed(3)}%`;
    }

    // Direction-specific flags
    const bullishOk = change1H > -1.2 && change24h > -4; // v5.1 loosened
    const bearishOk = change1H < 1.2 && change24h < 4; // v5.1 loosened
    const emoji = change24h < -2 ? '🔴' : change24h < 0 ? '🟡' : '🟢';
    btcGateStatus = { pass, reason, price, change: change24h, change1H, funding: fundRate, emoji, bullishOk, bearishOk };
    return btcGateStatus;
  } catch (err) {
    // Log the actual error so we can diagnose
    log(`⚠️ BTC gate fetch failed: ${err.message || err}`);
    btcFetchFails++;
    // Keep last known good status if we have one — better than zeros
    if (btcGateStatus.price > 0) {
      btcGateStatus.reason = `⚠️ BTC fetch failed (using cached: ${btcGateStatus.change?.toFixed(2)}%)`;
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

// ── Volume Climax Detector (v4.2) ─────────────────────────────────────────────
// Detects buying exhaustion — the TOP before reversal
// Peak volume spike 2-4 candles ago + volume declining + price stalled = climax
// Blocks LONG entries (we'd be buying at the top)
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
  return {
    climax,
    peakRatio: avgVol > 0 ? parseFloat((maxVol/avgVol).toFixed(1)) : 0,
    peakCandlesAgo: 7 - maxVolIdx,
  };
};

// ── Anti-Dump Trap Detector (v4.2) ────────────────────────────────────────────
// Blocks LONG signals after a recent dump even if volume/OI suggests buying
// This catches "falling knife" fakeouts — bounces that fail and dump more
// Checks:
//   1. Price dropped 3-5%+ recently (last ~2 hours)
//   2. Short-term MA below mid-term MA (MA7 < MA25)
//   3. Price still in lower third of recent range
// If ALL bearish → block LONG, this is a trap not accumulation
const checkAntiDumpTrap = (klines, direction) => {
  if (direction !== 'LONG' || !klines || klines.length < 25) {
    return { isTrap: false, reasons: [] };
  }

  const closes = klines.map(k => parseFloat(k[4]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const price  = closes[closes.length - 1];
  const reasons = [];

  // 1. Recent dump check — price dropped 3%+ in last 8 candles (~2h on 15m)
  const priceAgo = closes[closes.length - 9] || closes[0];
  const pctDrop = ((priceAgo - price) / priceAgo) * 100;
  const recentDump = pctDrop >= 3;

  // 2. MA structure — MA7 below MA25 = bearish short-term
  const ma7  = closes.slice(-7).reduce((a,b) => a+b, 0) / 7;
  const ma25 = closes.slice(-25).reduce((a,b) => a+b, 0) / 25;
  const bearishStructure = ma7 < ma25;

  // 3. Price in lower third of recent 25-candle range
  const rangeHigh = Math.max(...highs.slice(-25));
  const rangeLow  = Math.min(...lows.slice(-25));
  const rangeSize = rangeHigh - rangeLow;
  const pricePosition = rangeSize > 0 ? (price - rangeLow) / rangeSize : 0.5;
  const inLowerThird = pricePosition < 0.33;

  // 4. Lower highs pattern — recent highs declining (extra confirmation)
  const recentHighs = highs.slice(-6);
  const firstHalfHigh = Math.max(...recentHighs.slice(0, 3));
  const secondHalfHigh = Math.max(...recentHighs.slice(3));
  const lowerHighs = secondHalfHigh < firstHalfHigh * 0.98;

  // Collect bearish signals
  if (recentDump) reasons.push(`💥 dumped ${pctDrop.toFixed(1)}% recently`);
  if (bearishStructure) reasons.push(`📉 MA7<MA25`);
  if (inLowerThird) reasons.push(`⬇️ lower ${(pricePosition*100).toFixed(0)}% of range`);
  if (lowerHighs) reasons.push(`📉 lower highs`);

  // TRAP = recent dump + (bearish MA OR lower third position)
  const isTrap = recentDump && (bearishStructure || inLowerThird);

  return {
    isTrap,
    reasons,
    pctDrop: parseFloat(pctDrop.toFixed(2)),
    ma7: parseFloat(ma7.toFixed(6)),
    ma25: parseFloat(ma25.toFixed(6)),
    pricePosition: parseFloat(pricePosition.toFixed(2)),
  };
};

// ── Bullish Absorption Detector (v4.2) ────────────────────────────────────────
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
  if (layers?.rsi)                    tags.push(`📊RSI${layers.rsi.toFixed(0)}`);
  if (layers?.maStack === 'bullish_full') tags.push('📈MA-Stack✅');
  else if (layers?.maStack === 'bearish_full') tags.push('📉MA-Stack✅');

  return `👀 ${symbol.replace('USDT','')} ${tag}  ${score}/10 ${confBar(score)}${cv}
${tags.join(' · ')}
${direction === 'LONG' ? '⏳ Waiting for breakout (up)' : '⏳ Waiting for breakdown (down)'}
${FOOTER(btc, symbol)}`.trim();
};

// EARLY — compact pre-breakout
const buildEarlyMsg = (symbol, price, score, direction, layers, htf, sweep, atr, btc, hype = null, profile = null) => {
  const isLong = direction === 'LONG';
  const sl  = isLong ? price - atr * UNIFIED_SL_ATR  : price + atr * UNIFIED_SL_ATR;
  const tp1 = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
  const tp2 = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
  const tp3 = isLong ? price + atr * UNIFIED_TP3_ATR : price - atr * UNIFIED_TP3_ATR;
  const rr  = ((Math.abs(tp1 - price)) / Math.abs(price - sl)).toFixed(1);

  const tags = [];
  if (layers.compression.compressed && layers.compression.oiBuilding) tags.push('📦Coiling+OI');
  if (layers.compression.tightening)  tags.push('🎯Tightening');
  if (layers.fundingLS.funding < 0)   tags.push(`💸Fund${layers.fundingLS.funding.toFixed(3)}%`);
  if (layers.fundingLS.ls < 1)        tags.push(`⚖️L/S${layers.fundingLS.ls.toFixed(2)}`);
  if (sweep?.swept && sweep?.recovery) tags.push('🌊Swept');
  if (hype?.isTrending)                tags.push(hype.tag);

  // v5.13: Show coin context even when data is thin
  // v5.20: direction-specific WR + SHORT warning
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
    if (profile.avgVolRatio !== null && profile.observations >= 30) {
      const liqEmoji = profile.avgVolRatio < 0.6 ? '🔴 low liq' : profile.avgVolRatio < 1.0 ? '🟡' : '🟢';
      lines.push(`   Volume: ${profile.avgVolRatio.toFixed(2)}x avg ${liqEmoji}`);
    }
    // v5.20: direction-specific past trades
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
    // v5.20: SHORT in non-BEARISH regime warning
    if (!isLong && btcRegime.regime !== 'BEARISH') {
      lines.push(`   ⚠️ SHORT outside BEARISH regime — risky timing`);
    }
    // v5.23: SHORT testing warning — use HALF size for first 10 SHORT trades
    if (!isLong) {
      lines.push(`   🟡 <b>SHORT testing phase — USE HALF SIZE ($5-7 margin)</b>`);
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

// FIRE — full signal with SL/TP
const buildFireMsg = (symbol, price, score, direction, layers, scanCount, btc, klines = [], hype = null, profile = null) => {
  const isLong   = direction === 'LONG';
  const atr      = calculateATR(klines) || (price * 0.018);
  // Wider SL for FIRE — breakout trades need breathing room
  const sl       = isLong ? price - atr * UNIFIED_SL_ATR  : price + atr * UNIFIED_SL_ATR;
  const tp1      = isLong ? price + atr * UNIFIED_TP1_ATR : price - atr * UNIFIED_TP1_ATR;
  const tp2      = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
  const tp3      = isLong ? price + atr * UNIFIED_TP3_ATR : price - atr * UNIFIED_TP3_ATR;
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
  // v5.0 position size hint based on recovery state
  const sizeHint = getPositionSizeHint();

  // v5.13: Show coin context even when data is thin
  // v5.20: direction-specific WR + SHORT warning
  const reliability = (() => {
    if (!profile || profile.verdict === 'ERROR') return '';
    const lines = [];

    // Header with verdict
    if (profile.verdict !== 'INSUFFICIENT_DATA') {
      lines.push(`🎯 <b>Coin Reliability: ${profile.verdictEmoji} ${profile.verdict}</b>`);
    } else if (profile.observations >= 30) {
      lines.push(`🎯 <b>Coin Profile: ⚪ LIMITED DATA</b>`);
    } else {
      lines.push(`🎯 <b>Coin Profile: ⚪ NEW (${profile.observations || 0} obs)</b>`);
    }

    // Always show what we have
    if (profile.greenRatio !== null && profile.observations >= 30) {
      lines.push(`   7d trend: ${(profile.greenRatio*100).toFixed(0)}% green ${profile.greenRatio >= 0.55 ? '🟢' : profile.greenRatio >= 0.45 ? '🟡' : '🔴'}`);
    }
    if (profile.avgVolRatio !== null && profile.observations >= 30) {
      const liqEmoji = profile.avgVolRatio < 0.6 ? '🔴 low liq' : profile.avgVolRatio < 1.0 ? '🟡' : '🟢';
      lines.push(`   Volume: ${profile.avgVolRatio.toFixed(2)}x avg ${liqEmoji}`);
    }
    // v5.20: direction-specific past trades
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
    // v5.20: SHORT in non-BEARISH regime warning
    if (!isLong && btcRegime.regime !== 'BEARISH') {
      lines.push(`   ⚠️ SHORT outside BEARISH regime — risky timing`);
    }
    // v5.23: SHORT testing warning — use HALF size for first 10 SHORT trades
    if (!isLong) {
      lines.push(`   🟡 <b>SHORT testing phase — USE HALF SIZE ($5-7 margin)</b>`);
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
📊 Score: ${score}/10 ${confBar(score)}
${conf.join(' · ')}${reliability}
${FOOTER(btc, symbol)}`.trim();
};

// BREAKEVEN — after TP1 hit
const buildBreakevenMsg = (symbol, entryPrice, tp1Price, direction) => {
  return `✅ <b>${symbol.replace('USDT','')} TP1 HIT</b> — Move SL to entry $${fmtP(entryPrice)}
🎯 TP1: $${fmtP(tp1Price)} reached · Let TP2 run
⏰ ${gstNow()} GST`.trim();
};

// PRIORITY LIST — grouped, with v5.20 coin intelligence layer
const buildPriorityList = async (btc) => {
  // v5.18: filter out stale entries (not updated in 10+ min)
  const now = Date.now();
  const sorted = [...coinTracker.values()]
    .filter(c => c.state !== 'FADING' && c.score >= 6)
    .filter(c => {
      const lastUpdate = c.lastUpdated || c.firstSeen || 0;
      return (now - lastUpdate) < 15 * 60 * 1000; // exclude entries older than 15 min
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!sorted.length) return null;

  // v5.20: fetch coin profile for each coin in parallel
  const profiles = await Promise.all(sorted.map(c => getCoinProfile(c.symbol).catch(() => null)));

  const lines = sorted.map((s, i) => {
    const rank  = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'][i];
    const dir   = s.direction === 'LONG' ? '📈 LONG' : '📉 SHORT';
    const state = s.state === 'FIRE' ? '🔥 HIGH CONF' : s.state === 'CONFIRMING' ? '⚡ CONFIRMED' : '👀 WATCHING';
    const bar   = confBar(s.score);
    // v5.18: show data freshness
    const ageMin = Math.floor((now - (s.lastUpdated || s.firstSeen || now)) / 60000);
    const freshness = ageMin <= 3 ? '🟢' : ageMin <= 8 ? '🟡' : '🔴';

    // v5.20: build intelligence info from coin profile
    const p = profiles[i];
    let infoLine = '';
    let recommendation = '';

    if (p) {
      const isLong = s.direction === 'LONG';
      const dirWR = isLong ? p.longWR : p.shortWR;
      const dirWins = isLong ? p.longWins : p.shortWins;
      const dirLosses = isLong ? p.longLosses : p.shortLosses;
      const dirTotal = isLong ? p.longTotal : p.shortTotal;

      // Direction-specific history line
      if (dirTotal >= 1) {
        const wrPct = dirWR !== null ? (dirWR * 100).toFixed(0) : '—';
        const emoji = dirWR >= 0.6 ? '🟢' : dirWR >= 0.4 ? '🟡' : '🔴';
        infoLine = `     📒 ${s.direction}: ${dirWins}W/${dirLosses}L (${wrPct}%) ${emoji}`;
      } else if (p.totalTrades >= 1) {
        const wrPct = (p.winRate * 100).toFixed(0);
        const emoji = p.winRate >= 0.6 ? '🟢' : p.winRate >= 0.4 ? '🟡' : '🔴';
        infoLine = `     📒 Overall: ${p.wins}W/${p.losses}L (${wrPct}%) ${emoji}`;
      } else if (p.greenRatio !== null && p.observations >= 30) {
        const greenPct = (p.greenRatio * 100).toFixed(0);
        infoLine = `     📊 7d: ${greenPct}% green · no trades yet`;
      }

      // Bot recommendation logic
      const liqWarn = p.avgVolRatio !== null && p.avgVolRatio < 0.6;
      if (dirTotal >= 2 && dirWR !== null && dirWR < 0.4) {
        recommendation = ' ❌ AVOID';
      } else if (dirTotal >= 3 && dirWR >= 0.6) {
        recommendation = ' ✅ ENTER';
      } else if (p.totalTrades >= 3 && p.winRate < 0.4) {
        recommendation = ' ❌ AVOID';
      } else if (liqWarn) {
        recommendation = ' 🟡 LOW-LIQ';
      } else if (p.totalTrades === 0 && p.observations < 30) {
        recommendation = ' ⚪ NEW';
      }
    }

    // Late entry warning (v5.20: track price drift since detection)
    let lateWarning = '';
    const priceMove = s.priceChangePct || 0;
    if (priceMove > 3) {
      lateWarning = ` ⚠️ +${priceMove.toFixed(1)}%`;
    }

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

    // ── v5.30 RELATIVE STRENGTH FRONT-RUNNER TRACKER ─────────────────────────
    // User insight: coins that STAND STILL while BTC dumps = quiet accumulation.
    // When BTC turns, these are often the early front-runners.
    // Uses the tickers already fetched above — ZERO new API calls.
    try {
      const btc24h = btcGateStatus.change || 0;
      const btc1H  = btcGateStatus.change1H || 0;
      // PHASE 1 — DETECT: BTC dumping meaningfully → find coins holding strong
      if (btc24h <= -1.5) {
        for (const t of tickers) {
          if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) continue;
          if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) continue;
          if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) continue;
          if (isMemeCoin(t.symbol)) continue;
          if (STOCK_SUFFIX_REGEX.test(t.symbol) || isLikelyStock(t.symbol)) continue;
          if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) continue;
          const chg = parseFloat(t.priceChangePercent);
          // Holding strong: outperforming BTC by 1.5%+ AND not actually red beyond -0.5%
          if (chg >= btc24h + 1.5 && chg >= -0.5 && chg <= 6) {
            if (!rsWatch.has(t.symbol)) {
              if (rsWatch.size >= 15) continue; // cap at 15
              rsWatch.set(t.symbol, {
                detectedAt: Date.now(),
                detectPrice: parseFloat(t.lastPrice),
                detectChg: chg,
                btcChgAtDetect: btc24h,
                alerted: false,
              });
              log(`💎 RS-DETECT: ${t.symbol} holding ${chg.toFixed(1)}% while BTC ${btc24h.toFixed(1)}%`);
            }
          }
        }
      }
      // Expire RS entries older than 48h
      for (const [sym, rs] of rsWatch) {
        if (Date.now() - rs.detectedAt > 48 * 3600000) rsWatch.delete(sym);
      }
      // PHASE 2 — ALERT: BTC turning up → check if RS coins are running
      if (btc1H >= 0.4 && rsWatch.size > 0) {
        for (const [sym, rs] of rsWatch) {
          if (rs.alerted) continue;
          const tk = tickers.find(t => t.symbol === sym);
          if (!tk) continue;
          const nowPrice = parseFloat(tk.lastPrice);
          const moveFromDetect = ((nowPrice - rs.detectPrice) / rs.detectPrice) * 100;
          // Front-runner: up 1.5%+ from where it stood during the dump
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
    // ── end RS tracker ───────────────────────────────────────────────────────

    const valid = tickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || t.symbol.includes('_')) return false;
        // WHITELIST: must be in Binance's crypto perpetuals list
        if (cryptoSet.size > 0 && !cryptoSet.has(t.symbol)) return false;
        // Blacklist fallback
        if (EXCLUDE.has(t.symbol) || EXCLUDE_REGEX.test(t.symbol)) return false;
        if (isMemeCoin(t.symbol)) return false; // v5.14 — never include memes
        if (STOCK_SUFFIX_REGEX.test(t.symbol)) return false;
        if (isLikelyStock(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) < MIN_VOLUME_USD) return false;
        if (Math.abs(parseFloat(t.priceChangePercent)) >= PUMP_EXCLUDE_PCT) return false;
        return true;
      })
      .map(t => ({ symbol: t.symbol, price: parseFloat(t.lastPrice), change: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume), isMid: MID_CAP.has(t.symbol) }))
      .sort((a, b) => Math.abs(a.change) - Math.abs(b.change)) // flat price first = early movers
      .slice(0, 100); // v4.2 — 100 highest quality coins only

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
      await sleep(500); // v5.1 — 500ms (avoid 418)
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin.symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin.symbol}&interval=15m&limit=12`); } catch { }
      // v5.7: validate klines — skip coins with bad data
      if (!klines || !Array.isArray(klines) || klines.length < 8) {
        continue;
      }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin.symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin.symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      // Fetch HTF trend to decide direction by structure
      const htfFM = await checkHTFTrend(coin.symbol);
      let direction = null;
      if (htfFM.bullish && funding < 0.03)      direction = 'LONG';
      else if (htfFM.bearish && funding > -0.03) direction = 'SHORT';
      if (!direction) continue; // skip coins with no clear HTF direction
      // v5.28: SHORT DISABLED — proven losing strategy
      // Data: 35% WR over 17 trades (grew from 3→17, WR stayed ~35%)
      // Sample is now adequate. SHORT does not work in this system.
      // Tested across a full week of BTC dumping (ideal SHORT conditions) — still lost.
      // Re-enable only if a fundamentally different SHORT approach is designed + backtested.
      if (direction === 'SHORT') {
        log(`🚫 SHORT-DISABLED: ${coin.symbol} (v5.28 — proven 35% WR, removed)`);
        continue;
      }
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
    await checkWeeklyDrawdown(); // update weekly DD cache
    await fetchFinnhubCalendar(); // v5.26: refresh live economic calendar (6h cache)

    // v5.27: Multi-stage event reminders (morning + 4hr + 60/45/30/15min + at-event)
    await checkEventReminders();

    const btc       = await checkBTCGate();
    const watchlist = await getWatchlist();
    const symbols   = watchlist.map(r => r.symbol);
    if (!symbols.length) { log('Watchlist empty'); return; }

    let alertsFired = 0;

    for (const symbol of symbols) {
      await sleep(400); // v5.1 — 400ms (avoid 418)
      let price = 0, funding = 0, ls = 1, currentOI = 0, prevOI = 0, klines = [];
      try { const t = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`); price = parseFloat(t.price); } catch { }
      if (!price) continue;
      try { const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`); funding = parseFloat(f.lastFundingRate) * 100; } catch { }
      try { const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`); ls = parseFloat(l[0]?.longShortRatio || 1); } catch { }
      try { klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=20`); } catch { }
      try { const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`); currentOI = parseFloat(o.openInterest); const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`); prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI); } catch { }

      // Fix #3: Validate klines — skip if Binance returned bad data
      if (!klines || !Array.isArray(klines) || klines.length < 10) {
        log(`⚠️ Bad klines for ${symbol} — skipping this scan`);
        continue;
      }

      // Direction — PRICE STRUCTURE decides, funding/LS only block bad setups
      // Fetch HTF trend first
      const htfPre = await checkHTFTrend(symbol);
      // Structure decides direction (not funding)
      let isLong  = false;
      let isShort = false;
      if (htfPre.bullish && btcRegime.regime !== 'BEARISH') {
        if (funding < 0.03) isLong = true;
      } else if (htfPre.bearish && btcRegime.regime !== 'BULLISH') {
        if (funding > -0.03) isShort = true;
      }
      // Also require 15m momentum aligned with HTF
      if (klines.length >= 4) {
        const close4 = parseFloat(klines[klines.length - 4][4]);
        const closeNow = parseFloat(klines[klines.length - 1][4]);
        const momentum = ((closeNow - close4) / close4) * 100;
        // Block LONG if 15m momentum strongly against HTF
        if (isLong && momentum < -1.5) isLong = false;
        if (isShort && momentum > 1.5) isShort = false;
      }
      // If HTF not aligned or momentum against, skip
      if (!isLong && !isShort) { coinTracker.delete(symbol); continue; }
      const direction = isLong ? 'LONG' : 'SHORT';

      // v5.28: SHORT DISABLED — proven 35% WR over 17 trades (adequate sample)
      // Tested through a full week of BTC dumping, still lost. Removed.
      if (direction === 'SHORT') {
        log(`🚫 SHORT-DISABLED: ${symbol} (v5.28 — proven loser)`);
        coinTracker.delete(symbol);
        continue;
      }

      // HTF already checked above when deciding direction
      const htf = htfPre;

      const compression = checkCompression(klines, currentOI, prevOI);
      const volume      = checkVolumeBuild(klines);
      const atrExp      = checkATRExpansion(klines);
      const fundingZ    = await checkFundingExtreme(symbol, funding);
      const resistance  = checkResistanceTesting(symbol, price, klines);
      const fundingLS   = checkFundingLS(funding, ls, direction);
      const trap        = await checkTrapRisk(symbol, price, direction, volume.spike, compression.oiBuilding, klines);

      // FAKE PUMP HISTORY check — coins with repeated pump-dump pattern
      const fakeHist = await checkFakePumpHistory(symbol);
      if (fakeHist.isPumpDump) {
        log(`🎭 PUMP-DUMP-COIN: ${symbol} ${fakeHist.reason} — blocking all signals`);
        coinTracker.delete(symbol);
        continue; // skip this coin entirely
      }

      // Anti-dump trap check — block LONG after recent dump
      const dumpTrap = checkAntiDumpTrap(klines, direction);
      if (dumpTrap.isTrap) {
        incBlock('dumpTrap'); log(`🔪 DUMP-TRAP: ${symbol} LONG blocked — ${dumpTrap.reasons.join(', ')}`);
      }

      // FIX 6: News/event detector — skip coins with extreme volume spike
      // 5x+ volume with small price move = listing announcement, news, or manipulation
      let newsEvent = false;
      if (klines.length >= 10) {
        const lastVol = parseFloat(klines[klines.length - 1][5]);
        const prevVols = klines.slice(-11, -1).map(k => parseFloat(k[5]));
        const prevAvg = prevVols.reduce((a,b) => a+b, 0) / prevVols.length;
        const priceMove = klines.length >= 2 
          ? Math.abs((parseFloat(klines[klines.length-1][4]) - parseFloat(klines[klines.length-2][4])) / parseFloat(klines[klines.length-2][4])) * 100
          : 0;
        // Massive volume but small price move = news/event (unpredictable)
        if (prevAvg > 0 && lastVol > prevAvg * 5 && priceMove < 1) {
          newsEvent = true;
          incBlock('newsEvent'); log(`📰 NEWS-EVENT: ${symbol} vol ${(lastVol/prevAvg).toFixed(1)}x but price ${priceMove.toFixed(1)}% — skip`);
        }
      }

      // Volume climax check — blocks LONG if buying exhaustion detected
      const climax = checkVolumeClimax(klines, direction);
      if (climax.climax && direction === 'LONG') {
        incBlock('climax'); log(`🔝 VOL-CLIMAX: ${symbol} LONG blocked — buying exhaustion (peak ${climax.peakRatio}x, ${climax.peakCandlesAgo} candles ago)`);
      }

      // Bullish absorption check — only for LONG (stealth accumulation)
      // Skipped if dump trap detected
      let absorption = { absorbing: false, score: 0, reasons: [] };
      if (direction === 'LONG' && !dumpTrap.isTrap) {
        absorption = await checkBullishAbsorption(symbol, price, klines, currentOI, prevOI, funding);
        if (absorption.absorbing) log(`🤫 ABSORPTION: ${symbol} score:${absorption.score} [${absorption.reasons.join(', ')}]`);
      }

      const rsi = calcRSI(klines);
      const maStack = checkMAStack(klines);
      // RSI extremes block trades in wrong direction (chasing)
      // Fix #4: Just skip this scan, keep coin tracked for re-evaluation later
      if (direction === 'LONG' && rsi > 75) {
        log(`🚫 RSI-OVERBOUGHT: ${symbol} LONG skipped (RSI ${rsi.toFixed(1)}) — re-eval next scan`);
        continue;
      }
      if (direction === 'SHORT' && rsi < 25) {
        log(`🚫 RSI-OVERSOLD: ${symbol} SHORT skipped (RSI ${rsi.toFixed(1)}) — re-eval next scan`);
        continue;
      }
      let score = calcMasterScore({ compression, volume, resistance, fundingLS, trap });
      // Absorption boost — add up to +2 for stealth accumulation
      if (absorption.absorbing) {
        const boost = Math.min(2, absorption.score * 0.3);
        score = Math.min(10, score + boost);
      }
      // Funding extremeness boost — z-score > 2 = squeeze / short primed
      if (fundingZ.extreme) {
        if (direction === 'LONG' && fundingZ.extremeNeg) {
          score = Math.min(10, score + 1.5);
          log(`🔥 EXTREME-FUNDING: ${symbol} LONG boost +1.5 (z=${fundingZ.z})`);
        } else if (direction === 'SHORT' && fundingZ.extremePos) {
          score = Math.min(10, score + 1.5);
          log(`🔥 EXTREME-FUNDING: ${symbol} SHORT boost +1.5 (z=${fundingZ.z})`);
        }
      }
      const layers      = { compression, volume, resistance, fundingLS, trap, absorption, dumpTrap, rsi, maStack: maStack.stack };

      // ── Liquidity sweep check (Fix 4) ─────────────────────────────────────
      const sweep = checkLiquiditySweep(klines, direction);

      // ── Early entry check (Fix 1) ─────────────────────────────────────────
      const early = checkEarlyEntry(compression, volume, fundingLS, klines);

      const atr = calculateATR(klines) || (price * 0.018);

      // Social hype cross-check — bonus score if trending on CoinGecko
      const hype = await checkSocialHype(symbol);
      const finalScore = Math.max(0, Math.min(10, score + (hype.hypeBonus || 0)));
      if (hype.hasData && hype.hypeBonus !== 0) log(`🌊 ${symbol} hype ${hype.hypeBonus > 0 ? '+' : ''}${hype.hypeBonus} (${hype.tag})`);

      // v5.7 BEHAVIOR LOG — record this observation (non-blocking, silent)
      try {
        const lastK = klines[klines.length - 1];
        const candleOpen = parseFloat(lastK[1]);
        const candleClose = parseFloat(lastK[4]);
        const candleHigh = parseFloat(lastK[2]);
        const candleLow = parseFloat(lastK[3]);
        const bodyAbsPct = candleOpen > 0 ? Math.abs(candleClose - candleOpen) / candleOpen * 100 : 0;
        const candleColor = candleClose >= candleOpen ? 'green' : 'red';
        const recentVols = klines.slice(-20).map(k => parseFloat(k[5]));
        const avgVol = recentVols.reduce((a,b) => a+b, 0) / recentVols.length;
        const lastVol = parseFloat(lastK[5]);
        recordCoinBehavior({
          symbol,
          price,
          candleColor,
          bodyPct: parseFloat(bodyAbsPct.toFixed(2)),
          volume: lastVol,
          volVsAvg: avgVol > 0 ? parseFloat((lastVol / avgVol).toFixed(2)) : null,
          funding: funding,
          lsRatio: ls,
          oi: currentOI,
          oiChangePct: prevOI > 0 ? parseFloat(((currentOI - prevOI) / prevOI * 100).toFixed(2)) : null,
          rsi: parseFloat(rsi.toFixed(1)),
          score: parseFloat(finalScore.toFixed(1)),
          maStack: maStack.stack,
          wasAlerted: false, // updated below if alert fires
        });
      } catch (e) { /* silent */ }

      log(`📊 ${symbol} ${direction} score:${score}${hype.hypeBonus !== 0 ? (hype.hypeBonus > 0 ? '+' : '') + hype.hypeBonus : ''}=${finalScore} candle:${trap.candle?.verdict || 'N/A'} ${hype.tag ? '['+hype.tag+']' : ''}`);

      const existing = coinTracker.get(symbol);
      const snap = { price, funding, oi: currentOI, ls, vol: volume.spike, score, time: Date.now() };

      if (!existing) {
        // v5.20: track firstSeenPrice to detect late entries
        coinTracker.set(symbol, { symbol, direction, state: 'WATCHING', scanCount: 1, score: finalScore, layers, hype, absorption, firstSeen: Date.now(), firstSeenPrice: price, priceChangePct: 0, lastUpdated: Date.now(), history: [snap], entryPrice: null, earlyEntry: null, tp1Price: null });
      } else {
        if (direction !== existing.direction) {
          if (existing.entryPrice) await postSignal(`⚠️ <b>NEXIO — SIGNAL FADING</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n❌ Direction reversed — exit now\n📍 Entry: $${fmtP(existing.entryPrice)} → Now: $${fmtP(price)}\n⏰ ${gstNow()} GST\n<i>DYOR · SL always set · Paper mode active</i>`);
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
        // v5.20: track price change since first detected
        if (!existing.firstSeenPrice) existing.firstSeenPrice = price;
        existing.priceChangePct = ((price - existing.firstSeenPrice) / existing.firstSeenPrice) * 100;
        // For SHORT, flip sign so positive = move against direction
        if (direction === 'SHORT') existing.priceChangePct = -existing.priceChangePct;
        coinTracker.set(symbol, existing);
      }

      const state = coinTracker.get(symbol);
      if (!state) continue;

      // v5.14 — Hard skip meme coins entirely
      if (isMemeCoin(symbol)) {
        log(`🚫 MEME-SKIP: ${symbol} blocked (meme blacklist)`);
        coinTracker.delete(symbol);
        continue;
      }

      // v5.8: Get rolling coin profile (display only — no auto-blocking)
      const profile = await getCoinProfile(symbol);
      // NOTE: We do NOT block on profile.action — we just attach to alert for user visibility

      // v5.24 LAYER 1: Hard block on HOSTILE direction history
      // If coin has 3+ trades on this direction with WR < 35% → SKIP entirely
      const hostile = checkHostileDirection(profile, direction);
      if (hostile.block) {
        incBlock('hostileDirection');
        log(`🚫 HOSTILE-BLOCK: ${symbol} ${direction} — ${hostile.reason}`);
        coinTracker.delete(symbol);
        continue;
      }

      // v5.24 LAYER 2: Calculate score adjustment based on coin track record
      // TRUSTED coins get -1 score relief, CAUTION coins get +1 score penalty
      const scoreAdj = calcScoreAdjustment(profile, direction);
      if (scoreAdj.adjustment !== 0) {
        log(`🎯 SCORE-ADJ: ${symbol} ${direction} ${scoreAdj.adjustment > 0 ? '+' : ''}${scoreAdj.adjustment} (${scoreAdj.reason})`);
      }
      const effectiveMinFire = MIN_FIRE_SCORE + scoreAdj.adjustment;
      const effectiveMinAlert = MIN_ALERT_SCORE + scoreAdj.adjustment;

      // ── GUARDS (must be declared BEFORE EARLY and FIRE checks) ──────────
      // Post-loss block check
      const block = isBlocked(symbol);

      // BTC direction alignment
      const btcSupportive = isLong ? (btc.bullishOk !== false) : (btc.bearishOk !== false);
      if (!btcSupportive) { incBlock('btcDrag'); log(`🚫 BTC-DRAG: ${symbol} ${direction} — BTC 1H ${btc.change1H?.toFixed(2)}% against us`); }

      // Recent pump check — no-chase rule (checks 30m/1h/2h windows)
      const pumpCheck = checkRecentPump(klines, price);
      if (pumpCheck.pumped) {
        incBlock('pumped'); log(`🚫 NO-CHASE: ${symbol} pumped ${pumpCheck.pct}% in ${pumpCheck.window} (30m:${pumpCheck.pct30m}% 1h:${pumpCheck.pct1h}% 2h:${pumpCheck.pct2h}%)`);
        pumpTracker.set(symbol, { pumpedAt: Date.now(), pct: pumpCheck.pct });
      }
      // Pump cooldown — skip if pumped within last PUMP_COOLDOWN_MIN
      const pumpCD = pumpTracker.get(symbol);
      const inPumpCooldown = pumpCD && (Date.now() - pumpCD.pumpedAt) < (PUMP_COOLDOWN_MIN * 60000);
      if (inPumpCooldown) {
        const minsLeft = Math.ceil(PUMP_COOLDOWN_MIN - (Date.now() - pumpCD.pumpedAt) / 60000);
        incBlock('pumpCooldown'); log(`⏳ PUMP-COOLDOWN: ${symbol} skip ${minsLeft}min more`);
      }

      // Session filter
      const lowLiq = isLowLiquiditySession();
      if (lowLiq && state.scanCount === 1) { incBlock('lowLiq'); log(`🌙 LOW-LIQ: ${symbol} — Dubai dead hours`); }

      // Market regime, OI classification, extension filter
      const regime    = classifyRegime(klines);
      const prevPrice = klines.length >= 2 ? parseFloat(klines[klines.length-2][4]) : price;
      const oiClass   = classifyOI(currentOI, prevOI, price, prevPrice, funding, trap.candle);
      const ext       = checkExtension(klines, price, atr);

      // ── STAGE 0 — EARLY ENTRY alert ───────────────────────────────────────
      // Pre-breakout: compression + OI building + low volume + HTF aligned
      // Best R:R — enter before the crowd
      const earlyBtcOk = isLong ? (btc.change1H > -0.3) : (btc.change1H < 0.3);
      if (
        btc.pass &&
        earlyBtcOk &&
        (early.isEarly || absorption.absorbing) &&
        (early.earlyScore >= 2 || absorption.absorbing) &&
        finalScore >= (5 + scoreAdj.adjustment) &&
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
          log(`⚡ EARLY: ${symbol} ${direction} finalScore:${finalScore} (raw:${score}) earlyScore:${early.earlyScore}`);
          // Paper trade log
          const slEarly = isLong ? price - atr * UNIFIED_SL_ATR : price + atr * UNIFIED_SL_ATR;
          const tp2Early = isLong ? price + atr * UNIFIED_TP2_ATR : price - atr * UNIFIED_TP2_ATR;
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

      // regime, prevPrice, oiClass, ext, block, btcSupportive, pumpCheck, lowLiq all declared earlier before EARLY alert

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
        // FIX 5: Breakout volume must spike vs last 10 candles avg (not just prev)
        const lastVols = klines.slice(-11, -1).map(k => parseFloat(k[5]));
        const avgVol   = lastVols.reduce((a,b) => a+b, 0) / lastVols.length;
        const breakVol = parseFloat(breakoutCandle[5]);
        const volSpike = avgVol > 0 && breakVol > avgVol * 1.5; // v5.9 — loosened from 1.8x to 1.5x
        // Valid breakout candle: direction + 0.5% move + 45% body + vol spike
        const validBreak = (isLong ? breakC > breakO : breakC < breakO) && breakMove >= 0.3 && breakBody >= 35 && volSpike; // v5.9 — 0.5%→0.3%, 45%→35%
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

      // v5.28: Faster entry in confirmed BULLISH — fixes "fires after 4-5 candles" delay
      // In stable BULLISH regime (60+ min), allow FIRE on first detection for LONG.
      // Bullish is the user's proven money-maker; waiting 2 scans = late entry.
      // Choppy/uncertain still needs scanCount >= 2 (safety preserved).
      const bullConfirmed = btcRegime.regime === 'BULLISH' && direction === 'LONG'
        && (Date.now() - (btcRegime.changedAt || 0)) > 60*60000;
      const scanCountOk = bullConfirmed ? (state.scanCount >= 1) : (state.scanCount >= 2 || finalScore >= 8.5);

      if (block.blocked) {
        log(`🛑 BLOCKED: ${symbol} — ${block.reason}`);
      } else if (finalScore >= effectiveMinFire && shouldBlockFireOnCaution(profile, direction)) {
        // v5.24 LAYER 3: FIRE-worthy score but verdict is CAUTION/WARNING — block FIRE
        incBlock('fireCaution');
        log(`🚫 FIRE-CAUTION: ${symbol} ${direction} score=${finalScore} but verdict=${profile?.verdict}`);
      } else if (btc.pass && btcRegime.regime !== 'CHOPPY' && btcSupportive && !pumpCheck.pumped && !inPumpCooldown && !(direction === 'LONG' && climax.climax) && getOpenDirectionCount(direction) < MAX_SAME_DIRECTION && !lowLiq && !dumpTrap.isTrap && !newsEvent && (atrExp.expanding || finalScore >= 7.5) && finalScore >= effectiveMinFire && !shouldBlockFireOnCaution(profile, direction) && scanCountOk && trap.safe && candleOk && breakoutConfirmed && !ext.tooExtended && alertsFired < 2) {
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
          log(`🚀 FIRED: ${symbol} ${direction} finalScore:${finalScore} (raw:${score}) candle:${trap.candle?.verdict}`);
          // v5.7 BUGFIX — FIRE alerts must also log to paper_trades (was missing)
          const slFire = isLong ? price - atr * UNIFIED_SL_ATR : price + atr * UNIFIED_SL_ATR;
          const tp2Fire = isLong ? price + atr * 3.5 : price - atr * 3.5;
          await logPaperTrade({ symbol, direction, type: 'FIRE', price, sl: slFire, tp1: tp1f, tp2: tp2Fire, score: finalScore, candle: trap.candle?.verdict, btcChange: btc.change });
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

        // v5.0: Breakeven at +0.5% profit — lock in "no loss" early
        const inProfitPct = sig.direction === 'LONG'
          ? ((price - sig.price) / sig.price) * 100
          : ((sig.price - price) / sig.price) * 100;

        if (inProfitPct >= 0.5 && !sig.breakevenEarly) {
          await postSignal(`✅ <b>${symbol.replace('USDT','')} BREAKEVEN</b> — Move SL to entry $${fmtP(sig.price)}\n💰 +0.5% secured · Risk now zero\n⏰ ${gstNow()} GST`);
          sig.breakevenEarly = true;
          signalPrices.set(symbol, sig);
          log(`✅ BREAKEVEN-EARLY: ${symbol} +${inProfitPct.toFixed(2)}%`);
        }

        // v5.16: MOMENTUM MILESTONE ALERTS — push update at +1%, +2%, +3%, +4%, +5%
        // Tells you when to consider partial close or hold
        const milestones = [
          { level: 1.0, key: 'm1', emoji: '💚', msg: 'Building momentum — hold for TP1', action: 'HOLD' },
          { level: 2.0, key: 'm2', emoji: '🟢', msg: 'TP1 zone — consider closing 30%', action: 'PARTIAL' },
          { level: 3.0, key: 'm3', emoji: '🚀', msg: 'Strong move — close 30% more, trail rest tight', action: 'PARTIAL' },
          { level: 4.0, key: 'm4', emoji: '💎', msg: 'Big move — secure 50% profit', action: 'BIG' },
          { level: 5.0, key: 'm5', emoji: '🏆', msg: 'Huge move — close most, keep small runner', action: 'HUGE' },
          { level: 7.0, key: 'm7', emoji: '⭐', msg: 'Exceptional move — close all, you won', action: 'EXIT' },
        ];
        for (const m of milestones) {
          if (inProfitPct >= m.level && !sig[m.key]) {
            sig[m.key] = true;
            signalPrices.set(symbol, sig);
            await postSignal(`${m.emoji} <b>${symbol.replace('USDT','')} +${m.level}%</b>\n${m.msg}\nCurrent: +${inProfitPct.toFixed(2)}% · Peak: +${(sig.trailingHigh || inProfitPct).toFixed(2)}%\n⏰ ${gstNow()} GST`);
            log(`📈 MILESTONE +${m.level}%: ${symbol} action=${m.action}`);
          }
        }

        // v5.16: MOMENTUM FADE WARNING — alert when profit retracing significantly
        // Only fires if we're in profit but pulling back from peak
        if (sig.trailingHigh && sig.trailingHigh > 1.5) {
          const retracedFromPeak = sig.trailingHigh - inProfitPct;
          if (retracedFromPeak >= 0.7 && !sig.fadeAlert && inProfitPct > 0) {
            sig.fadeAlert = true;
            signalPrices.set(symbol, sig);
            await postSignal(`⚠️ <b>${symbol.replace('USDT','')} MOMENTUM FADING</b>\n🎯 Peak was: +${sig.trailingHigh.toFixed(2)}%\n📉 Current: +${inProfitPct.toFixed(2)}% (down ${retracedFromPeak.toFixed(2)}% from peak)\n💡 Consider closing — pump may have ended\n⏰ ${gstNow()} GST`);
            log(`⚠️ FADE-ALERT: ${symbol} peak=${sig.trailingHigh.toFixed(2)} now=${inProfitPct.toFixed(2)}`);
          }
        }

        // v5.21: Looser trailing stop — let winners run further before locking
        // OLD: activated at +1%, trailed 0.3% (clipped wins too early)
        // NEW: activated at +1.5%, trails 0.5% (captures more upside)
        if (inProfitPct >= 1.5) {
          if (!sig.trailingHigh || inProfitPct > sig.trailingHigh) {
            sig.trailingHigh = inProfitPct;
            signalPrices.set(symbol, sig);
          }
          // If we retraced 0.5% from peak, alert trailing stop hit
          if (sig.trailingHigh && sig.trailingHigh - inProfitPct > 0.5 && !sig.trailingExitSent) {
            await postSignal(`📉 <b>${symbol.replace('USDT','')} TRAILING STOP</b>\n🎯 Peak: +${sig.trailingHigh.toFixed(2)}%  Current: +${inProfitPct.toFixed(2)}%\n💰 Lock in profit — exit position\n⏰ ${gstNow()} GST`);
            sig.trailingExitSent = true;
            signalPrices.set(symbol, sig);
            // Track as win for daily stats
            const pnl = Math.max(0.5, inProfitPct - 0.5);
            dailyLosses.dailyProfitPct += pnl;
            recordWin(symbol, pnl);
            log(`💰 TRAILING-WIN: ${symbol} +${pnl.toFixed(2)}%`);
            // v5.7 FIX: Update paper_trades — trailing exit = WIN
            try {
              await sb(`paper_trades?symbol=eq.${symbol}&status=eq.OPEN`, {
                method: 'PATCH',
                body: JSON.stringify({
                  status: 'TRAILING_EXIT',
                  outcome: 'WIN',
                  closed_price: price,
                  closed_at: new Date().toISOString(),
                }),
              });
            } catch (e) { log(`Paper trail update failed: ${e.message}`); }
          }
        }

        // v5.0: Force exit after 6 hours
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
          log(`⏰ TIME-EXIT: ${symbol} ${inProfitPct.toFixed(2)}% after 6h`);
          // v5.7 FIX: Update paper_trades — timeout exit
          try {
            await sb(`paper_trades?symbol=eq.${symbol}&status=eq.OPEN`, {
              method: 'PATCH',
              body: JSON.stringify({
                status: 'TIMEOUT',
                outcome: inProfitPct > 0 ? 'WIN' : 'LOSS',
                closed_price: price,
                closed_at: new Date().toISOString(),
              }),
            });
          } catch (e) { log(`Paper timeout update failed: ${e.message}`); }
          continue;
        }

        // ATR-based fade threshold — adapts to each coin's volatility
        const fadeThreshold = sig.atr ? (sig.atr / sig.price) * 100 * 1.2 : FADE_THRESHOLD_PCT;

        if (!btc.pass && Date.now() - sig.firedAt < 3600000) {
          await postSignal(`🚨 <b>NEXIO — EMERGENCY EXIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n⚠️ BTC momentum reversed!\n${btc.reason}\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n⚡ <b>Exit immediately</b>\n⏰ ${gstNow()} GST\n<i>DYOR · SL always set · Paper mode active</i>`);
          recordLoss(symbol);
          signalPrices.delete(symbol);
        } else if (chg >= fadeThreshold && !sig.breakevenSent) {
          await postSignal(`⚠️ <b>NEXIO — SL HIT</b>\n━━━━━━━━━━━━━━━\n🪙 <b>${symbol.replace('USDT','')}</b>\n📉 Down ${chg.toFixed(1)}% from entry (${fadeThreshold.toFixed(1)}% threshold)\n📍 Entry: $${fmtP(sig.price)} → Now: $${fmtP(price)}\n🛑 Stop triggered — ${symbol.replace('USDT','')} blocked ${LOSS_COOLDOWN}min\n⏰ ${gstNow()} GST\n<i>DYOR · SL always set · Paper mode active</i>`);
          recordLoss(symbol);
          signalPrices.delete(symbol);
        }
      }
    }

    if (watchlistScanCount % 3 === 0 && coinTracker.size > 0) {
      const msg = await buildPriorityList(btc);
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
  else if (text === '/summary') {
    await sendDailySummary();
  }
  else if (text.startsWith('/profile')) {
    const parts = text.split(' ');
    const sym = parts[1] ? parts[1].toUpperCase() + (parts[1].toUpperCase().endsWith('USDT') ? '' : 'USDT') : null;
    if (!sym) {
      await tg(chatId, `Usage: /profile KAITO\n\nShows rolling 7-day profile for a coin`);
    } else {
      const p = await getCoinProfile(sym);
      const tierEmoji = p.tier === 'A' ? '🟢' : p.tier === 'B' ? '🟡' : p.tier === 'C' ? '🔴' : '⚪';
      const wrStr = p.winRate !== null ? `${(p.winRate*100).toFixed(0)}%` : 'no data';
      const greenStr = p.greenRatio !== null ? `${(p.greenRatio*100).toFixed(0)}%` : 'no data';
      const avgStr = p.avgScore !== null ? p.avgScore.toFixed(1) : 'no data';
      await tg(chatId, `${tierEmoji} <b>${sym} 7-day profile</b>\n━━━━━━━━━━━━━━━\nTier: <b>${p.tier}</b> · Action: ${p.action}\n\n📊 Trades: ${p.totalTrades} (${p.wins}W / ${p.losses}L)\n🎯 Win rate: ${wrStr}\n\n📈 24h observations: ${p.observations24h}\n🟩 Green ratio: ${greenStr}\n📊 Avg score: ${avgStr}\n\n${p.action === 'block' ? '🚫 Bot will BLOCK this coin' : p.action === 'boost' ? '✅ Bot may fire at lower score' : '✅ Normal filtering applies'}`);
    }
  }
  else if (text.startsWith('/history')) {
    const parts = text.split(' ');
    const sym = parts[1] ? parts[1].toUpperCase() + (parts[1].toUpperCase().endsWith('USDT') ? '' : 'USDT') : null;
    if (!sym) {
      await tg(chatId, `Usage: /history KAITO\n\nChecks if a coin has fake pump/dump history`);
    } else {
      const h = await checkFakePumpHistory(sym);
      const emoji = h.isPumpDump ? '🚨' : '✅';
      await tg(chatId, `${emoji} <b>${sym}</b> 7-day history\n━━━━━━━━━━━━━━━\n${h.reason}\n\nFake pumps detected: ${h.fakeCount}\n${h.events ? '\nLast events:\n' + h.events.join('\n') : ''}\n\n${h.isPumpDump ? '⚠️ Bot will BLOCK signals on this coin' : '✅ Coin appears clean'}`);
    }
  }
  else if (text === '/memes') {
    const list = Array.from(MEME_BLACKLIST).sort().map(s => s.replace('USDT','')).join(', ');
    await tg(chatId, `🚫 <b>Meme Coin Blacklist</b>\n━━━━━━━━━━━━━━━\n${MEME_BLACKLIST.size} coins blocked\n\n${list}\n\n<i>These coins will NEVER fire alerts.\nEdit MEME_BLACKLIST in server.js to change.</i>`);
  }
  else if (text.startsWith('/coin')) {
    const parts = text.split(' ');
    const sym = parts[1] ? parts[1].toUpperCase() + (parts[1].toUpperCase().endsWith('USDT') ? '' : 'USDT') : null;
    if (!sym) {
      await tg(chatId, `Usage: /coin KAS\n\nDeep 7-day behavior + trade analysis`);
    } else {
      const p = await getCoinProfile(sym);
      if (!p.hasData && p.observations < 10) {
        await tg(chatId, `📊 ${sym}\n━━━━━━━━━━━━━━━\nNot enough data yet (${p.observations || 0} observations).\nThis coin hasn't been in our radar much.`);
      } else {
        const sessionList = Object.entries(p.sessions || {}).map(([k,v]) => {
          const total = Object.values(p.sessions).reduce((s,n) => s+n, 0);
          const pct = total > 0 ? Math.round(v*100/total) : 0;
          return `   ${k}: ${pct}%`;
        }).join('\n');

        let msg = `📊 <b>${sym} 7-day Profile</b>\n━━━━━━━━━━━━━━━\n\n`;
        msg += `📈 Observations: ${p.observations}\n`;
        if (p.greenRatio !== null) msg += `🟢 Green candles: ${(p.greenRatio*100).toFixed(0)}%\n`;
        if (p.avgScore !== null) msg += `📊 Avg score: ${p.avgScore.toFixed(1)}/10 · Peak: ${p.peakScore?.toFixed(1)}\n`;
        if (p.avgVolRatio !== null) msg += `📦 Avg vol ratio: ${p.avgVolRatio.toFixed(2)}x\n`;
        if (p.avgRsi !== null) msg += `📊 Avg RSI: ${p.avgRsi.toFixed(0)}\n`;
        msg += `\n⏰ <b>Sessions:</b>\n${sessionList}\n`;

        if (p.totalTrades >= 1) {
          msg += `\n📒 <b>Trade record:</b>\n`;
          msg += `   Total: ${p.totalTrades} (${p.wins}W / ${p.losses}L) — ${p.winRate ? (p.winRate*100).toFixed(0)+'%' : '—'}\n`;
          if (p.earlyTotal > 0) msg += `   EARLY: ${p.earlyWins}W/${p.earlyLosses}L (${p.earlyWR ? (p.earlyWR*100).toFixed(0)+'%' : '—'})\n`;
          if (p.fireTotal > 0) msg += `   FIRE:  ${p.fireWins}W/${p.fireLosses}L (${p.fireWR ? (p.fireWR*100).toFixed(0)+'%' : '—'})\n`;
        } else {
          msg += `\n📒 No trade history yet on this coin\n`;
        }

        msg += `\n🎯 <b>Verdict: ${p.verdictEmoji} ${p.verdict}</b>\n`;
        msg += `   ${p.verdictReason}\n`;

        await tg(chatId, msg);
      }
    }
  }
  else if (text === '/rs' || text === '/frontrunners') {
    if (!rsWatch.size) {
      await tg(chatId, `💎 <b>RS Watch</b>\n━━━━━━━━━━━━━━━\nEmpty — no coins detected holding strong during a dump yet.\n<i>Populates when BTC drops -1.5%+ and coins stand still.</i>`);
    } else {
      let msg = `💎 <b>RS Watch (${rsWatch.size})</b> — held strong during dump\n━━━━━━━━━━━━━━━\n\n`;
      for (const [sym, rs] of rsWatch) {
        const ageH = Math.round((Date.now() - rs.detectedAt) / 3600000);
        msg += `${rs.alerted ? '🏃' : '💎'} ${sym.replace('USDT','')} — held ${rs.detectChg.toFixed(1)}% vs BTC ${rs.btcChgAtDetect.toFixed(1)}% · ${ageH}h ago${rs.alerted ? ' · FIRED' : ''}\n`;
      }
      msg += `\n<i>🏃 = front-runner alert fired. Watch these when BTC turns up.</i>`;
      await tg(chatId, msg);
    }
  }
  else if (text === '/events' || text === '/calendar') {
    await fetchFinnhubCalendar(); // ensure fresh
    const now = Date.now();
    const upcoming = [];
    // v5.26: Use live Finnhub events first
    if (liveEconomicEvents.length) {
      for (const ev of liveEconomicEvents) {
        if (ev.evTime > now && ev.evTime < now + 14*24*60*60000) {
          upcoming.push({ name: ev.name, evTime: ev.evTime });
        }
      }
    } else {
      // Fallback: hardcoded events
      for (const ev of ECONOMIC_EVENTS) {
        const evTime = new Date(`${ev.date}T${ev.timeUTC}:00Z`).getTime();
        if (evTime > now && evTime < now + 14*24*60*60000) {
          upcoming.push({ name: ev.name, evTime });
        }
      }
      // Add next few Thursday jobless claims
      for (let i = 0; i < 14; i++) {
        const d = new Date(now + i*24*60*60000);
        if (d.getUTCDay() === 4) {
          const claimsTime = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 30, 0)).getTime();
          if (claimsTime > now) upcoming.push({ name: 'US Jobless Claims + Data', evTime: claimsTime });
        }
      }
    }
    upcoming.sort((a,b) => a.evTime - b.evTime);
    const srcLabel = liveEconomicEvents.length ? '🟢 live (Finnhub)' : '🟡 fallback (hardcoded)';
    let msg = `📅 <b>Upcoming High-Impact Events (14d)</b>\n${srcLabel}\n━━━━━━━━━━━━━━━\n\n`;
    if (!upcoming.length) {
      msg += `No major scheduled events in the next 14 days.`;
    } else {
      for (const ev of upcoming.slice(0, 12)) {
        const dateStr = new Date(ev.evTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Dubai' });
        msg += `• ${dateStr} ${eventTimeDubai(ev.evTime)} — ${ev.name}\n`;
      }
      msg += `\n<i>Bot warns 1hr before each. Use tight SL during these windows — fast volatility.</i>`;
    }
    await tg(chatId, msg);
  }
  else if (text.startsWith('/verdict')) {
    const parts = text.split(' ');
    const sym = parts[1] ? parts[1].toUpperCase() + (parts[1].toUpperCase().endsWith('USDT') ? '' : 'USDT') : null;
    if (!sym) {
      await tg(chatId, `Usage: /verdict KAS\n\nDeep recommendation on whether to trade this coin`);
    } else {
      const p = await getCoinProfile(sym);
      let msg = `🎯 <b>${sym} — Trade Verdict</b>\n━━━━━━━━━━━━━━━\n\n`;

      if (p.totalTrades >= 1) {
        msg += `📒 <b>Trade history (7d):</b>\n`;
        msg += `   Total: ${p.totalTrades} (${p.wins}W/${p.losses}L) — ${(p.winRate*100).toFixed(0)}%\n`;
        if (p.longTotal > 0) {
          const emoji = p.longWR >= 0.6 ? '🟢' : p.longWR >= 0.4 ? '🟡' : '🔴';
          msg += `   LONG:  ${p.longWins}W/${p.longLosses}L (${(p.longWR*100).toFixed(0)}%) ${emoji}\n`;
        }
        if (p.shortTotal > 0) {
          const emoji = p.shortWR >= 0.6 ? '🟢' : p.shortWR >= 0.4 ? '🟡' : '🔴';
          msg += `   SHORT: ${p.shortWins}W/${p.shortLosses}L (${(p.shortWR*100).toFixed(0)}%) ${emoji}\n`;
        }
        if (p.earlyTotal > 0) msg += `   EARLY: ${p.earlyWins}W/${p.earlyLosses}L (${(p.earlyWR*100).toFixed(0)}%)\n`;
        if (p.fireTotal > 0) msg += `   FIRE:  ${p.fireWins}W/${p.fireLosses}L (${(p.fireWR*100).toFixed(0)}%)\n`;
      } else {
        msg += `📒 No closed trades yet on this coin\n`;
      }

      msg += `\n📊 <b>Behavior (7d):</b>\n`;
      if (p.greenRatio !== null) msg += `   Green candles: ${(p.greenRatio*100).toFixed(0)}%\n`;
      if (p.avgScore !== null) msg += `   Avg score: ${p.avgScore.toFixed(1)} · Peak: ${p.peakScore?.toFixed(1)}\n`;
      if (p.avgVolRatio !== null) {
        const liq = p.avgVolRatio < 0.6 ? '🔴 LOW' : p.avgVolRatio < 1.0 ? '🟡' : '🟢';
        msg += `   Volume: ${p.avgVolRatio.toFixed(2)}x avg ${liq}\n`;
      }
      msg += `   Observations: ${p.observations}\n`;

      // Recommendation logic
      msg += `\n🎯 <b>Verdict:</b>\n`;
      const liqWarn = p.avgVolRatio !== null && p.avgVolRatio < 0.6;
      if (p.longWR !== null && p.longTotal >= 3 && p.longWR >= 0.6) {
        msg += `   ✅ LONG: take with confidence (${(p.longWR*100).toFixed(0)}% historical WR)\n`;
      } else if (p.longWR !== null && p.longTotal >= 2 && p.longWR < 0.4) {
        msg += `   ❌ LONG: avoid (only ${(p.longWR*100).toFixed(0)}% WR on ${p.longTotal} trades)\n`;
      } else if (p.longTotal >= 1) {
        msg += `   🟡 LONG: limited data (${p.longTotal} trades)\n`;
      }
      if (p.shortWR !== null && p.shortTotal >= 3 && p.shortWR >= 0.6) {
        msg += `   ✅ SHORT: take with confidence (${(p.shortWR*100).toFixed(0)}% historical WR)\n`;
      } else if (p.shortWR !== null && p.shortTotal >= 2 && p.shortWR < 0.4) {
        msg += `   ❌ SHORT: avoid (only ${(p.shortWR*100).toFixed(0)}% WR on ${p.shortTotal} trades)\n`;
      } else if (p.shortTotal >= 1) {
        msg += `   🟡 SHORT: limited data (${p.shortTotal} trades)\n`;
      }
      if (liqWarn) msg += `   ⚠️ LOW LIQUIDITY — size down or skip\n`;
      if (p.totalTrades === 0) msg += `   ⚪ Unproven coin — wait for first trade data\n`;

      await tg(chatId, msg);
    }
  }
  else if (text === '/warning' || text === '/warn') {
    const w = btcEarlyWarning;
    const minsAgo = w.notifiedAt > 0 ? Math.floor((Date.now() - w.notifiedAt) / 60000) : null;
    let msg = `⚡ <b>BTC Early Warning Status</b>\n━━━━━━━━━━━━━━━\n`;
    if (w.state === 'normal') {
      msg += `✅ No active warning\nMarket in normal state\n`;
    } else if (w.state === 'BEARISH_EARLY') {
      msg += `📉 BEARISH momentum building\nLast warning: ${minsAgo}min ago\n\nAction: tighten stops, avoid LONG\n`;
    } else if (w.state === 'BULLISH_EARLY') {
      msg += `📈 BULLISH momentum building\nLast warning: ${minsAgo}min ago\n\nAction: watch for LONG opportunities\n`;
    }
    msg += `\nOfficial regime: ${btcRegime.regime} (slower indicator)\n⏰ ${gstNow()} GST`;
    await tg(chatId, msg);
  }
  else if (text === '/cycle') {
    const cp = btcCyclePosition;
    if (!cp || cp.stage === 'UNKNOWN') {
      await tg(chatId, '📊 BTC Cycle data not yet available. Check back in 15 min.');
    } else {
      const riskEmoji = cp.risk === 'extreme' ? '🔴🔴' : cp.risk === 'high' ? '🔴' : cp.risk === 'medium' ? '🟡' : '🟢';
      await tg(chatId, `📊 <b>BTC Cycle Position</b>\n━━━━━━━━━━━━━━━\nStage: <b>${cp.stage}</b> ${riskEmoji}\nRisk level: ${cp.risk}\n\n${cp.reason}\n\n📈 Position in 7d range: ${cp.positionInRange?.toFixed(0)}%\n📊 7d move: ${cp.move7d > 0 ? '+' : ''}${cp.move7d?.toFixed(1)}%\n⏱ Recent momentum: ${cp.recentMomentum > 0 ? '+' : ''}${cp.recentMomentum?.toFixed(2)}%\n${cp.slowing ? '⚠️ Momentum slowing' : '✅ Momentum healthy'}\n\n<i>Updated ${Math.floor((Date.now() - cp.updated)/60000)}min ago</i>`);
    }
  }
  else if (text === '/regime') {
    const r = btcRegime;
    const emoji = r.regime === 'BULLISH' ? '🟢' : r.regime === 'BEARISH' ? '🔴' : '🟡';
    const action = r.regime === 'BULLISH' ? 'LONG only · SHORT blocked'
                  : r.regime === 'BEARISH' ? 'SHORT only · LONG blocked'
                  : '⚠️ ALL signals blocked';
    const minsAgo = r.changedAt ? Math.floor((Date.now() - r.changedAt) / 60000) : 0;
    await tg(chatId, `${emoji} <b>BTC Regime: ${r.regime}</b>\n━━━━━━━━━━━━━━━\n${r.reason || 'no data'}\n\nConfidence: ${r.confidence}%\nMomentum 1H: ${r.momentum1H || 0}%\nMomentum 4H: ${r.momentum4H || 0}%\n24h range: ${r.rangePct || 0}%\n\nAction: ${action}\nIn this regime ${minsAgo}min`);
  }
  else if (text === '/diagnostics' || text === '/diag') {
    const total = Object.values(blockReasons).reduce((a,b) => a+b, 0);
    const sorted = Object.entries(blockReasons).sort((a,b) => b[1] - a[1]);
    const lines = sorted.filter(([_,v]) => v > 0).map(([k,v]) => `${k}: ${v} (${(v/total*100).toFixed(1)}%)`).join('\n');
    await tg(chatId, `🔬 <b>Block Reasons (since restart)</b>\n━━━━━━━━━━━━━━━\nTotal blocks: ${total}\n\n${lines || 'No blocks recorded'}\n\nUse this to see which filter is most active.`);
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
    await tg(chatId, `📖 <b>Commands</b>\n/start /status /watchlist /tracking /btc /stats /test /help\n🐆 Nexio v5.35`);
  }

  if (text === '/test') {
    const btc = await checkBTCGate();
    await postSignal(`🧪 <b>NEXIO v5.35 — TEST</b>\n━━━━━━━━━━━━━━━\n✅ Bot online (PAPER MODE)\n✅ Elite scanner active\n✅ Daily caps: +2%/-1.5%/3 trades\n✅ Recovery system active\n✅ ATR expansion required\n${btc.emoji} BTC Gate: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n📊 Watchlist: ${(await getWatchlist()).length}\n🔍 Tracking: ${coinTracker.size}\n⏰ ${gstNow()} GST\n🐆 Nexio v5.35 is watching`);
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
  log(`🚀 Nexio v5.35 — Signal Intelligence Engine starting... ${modeLabel}`);
  const btc = await checkBTCGate();
  await tg(OWNER_CHAT_ID, `🟢 <b>Nexio v5.35 Started</b>\n━━━━━━━━━━━━━━━\n🧠 9-Layer Scanner active\n📈 HTF EMA50 filter (EMA200 advisory)\n🕯 STRONG candle gate\n📐 ATR-based SL/TP (R:R ≥ 1.5)\n🔄 1-bar confirmation\n🛡 Post-loss protection (90min)\n☠️ Daily kill switch (3 losses)\n🚦 BTC gate\n📊 Min score: ${MIN_ALERT_SCORE}/10\n⚡ Max alerts/scan: 2\n${btc.emoji} BTC: ${btc.pass?'✅ PASS':'❌ BLOCKED'}\n⏰ ${gstNow()} GST\n━━━━━━━━━━━━━━━\n/fullscan /scan /btc /pending /users /activate /broadcast /watchlist /tracking /clearwatchlist /test`);

  setInterval(pollUsers, POLL_INTERVAL_MS);
  pollUsers();
  await runFullMarketScan();
  setInterval(runFullMarketScan, FULL_MARKET_INTERVAL_MS);
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, WATCHLIST_SCAN_INTERVAL);

  // Memory cleanup — every 10 min
  setInterval(() => { cleanupPumpTracker(); cleanupSignalPrices(); cleanupCoinTracker(); cleanupAlertHistory(); }, 600000);

  // v5.4 Daily summary check every 30 min (fires at 21:00 Dubai)
  setInterval(checkDailySummary, 1800000);

  // v5.4 Anomaly check every hour
  setInterval(checkAnomalies, 3600000);

  // BTC regime check — every 5 min
  await checkBTCRegime();
  setInterval(checkBTCRegime, 300000);

  // v5.10 BTC Cycle Position check every 15 min (warning-only)
  await checkBTCCycle();
  setInterval(checkBTCCycle, 900000);

  // v5.17 BTC Early Warning — every 5 min (faster than regime predictor)
  // Uses 15m EMA20 + momentum slope to warn BEFORE official regime change
  await checkBTCEarlyWarning();
  setInterval(checkBTCEarlyWarning, 300000);

  // Paper trade outcome checker — every 10 min
  setInterval(checkPaperOutcomes, 600000);
};

start();
