const required = (env, key) => {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const numberFrom = (env, key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = String(env[key] ?? '').trim();
  const value = raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number from ${min} to ${max}`);
  }
  return value;
};

// Lenient variant for optional v6.9 tuning knobs: a typo/out-of-range value in
// an operator-tunable variable must never prevent the whole bot from booting.
// It logs a loud warning and falls back to the safe default instead of throwing.
const numberFromWarn = (env, key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = String(env[key] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[CONFIG WARNING] ${key}="${raw}" is invalid (must be a number from ${min} to ${max}); using safe default ${fallback}`);
    return fallback;
  }
  return value;
};

// Lenient bool variant: an invalid value warns and falls back to the safe
// default instead of aborting boot (same contract as numberFromWarn).
const boolFromWarn = (env, key, fallback) => {
  const raw = String(env[key] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(raw)) {
    return boolFrom(env, key, fallback);
  }
  console.warn(`[CONFIG WARNING] ${key}="${raw}" is invalid; using safe default ${fallback}`);
  return fallback;
};

const boolFrom = (env, key, fallback) => {
  const raw = String(env[key] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be true or false`);
};

export const loadConfig = (env = process.env) => {
  const enableAlphaSignals = boolFrom(env, 'ENABLE_ALPHA_SIGNALS', true);
  const enableEconomicCalendar = boolFrom(env, 'ENABLE_ECONOMIC_CALENDAR', true);
  const onchainRiskApiUrl = String(env.ONCHAIN_RISK_API_URL ?? 'https://api.gopluslabs.io').trim().replace(/\/+$/, '');

  const cfg = {
    botToken: required(env, 'BOT_TOKEN'),
    ownerChatId: required(env, 'OWNER_CHAT_ID'),
    supabaseUrl: required(env, 'SUPABASE_URL').replace(/\/+$/, ''),
    supabaseKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
    paperMode: boolFrom(env, 'PAPER_MODE', true),
    port: numberFrom(env, 'PORT', 3000, { min: 1, max: 65535 }),
    scanIntervalMs: numberFrom(env, 'SCAN_INTERVAL_MS', 30_000, { min: 15_000, max: 300_000 }),
    universeRefreshMs: numberFrom(env, 'UNIVERSE_REFRESH_MS', 300_000, { min: 60_000, max: 3_600_000 }),
    maxUniverse: numberFrom(env, 'MAX_UNIVERSE', 60, { min: 5, max: 100 }),
    universeMomentumSlotsPct: numberFrom(env, 'UNIVERSE_MOMENTUM_SLOTS_PCT', 30, { min: 10, max: 50 }),
    maxUniverse24hGainPct: numberFrom(env, 'MAX_UNIVERSE_24H_GAIN_PCT', 15, { min: 8, max: 25 }),
    btcEma50RetestBufferPct: numberFrom(env, 'BTC_EMA50_RETEST_BUFFER_PCT', 0.35, { min: 0, max: 1 }),
    btcMinEma50Slope6hPct: numberFrom(env, 'BTC_MIN_EMA50_SLOPE_6H_PCT', -0.05, { min: -0.3, max: 0.2 }),
    scanConcurrency: numberFrom(env, 'SCAN_CONCURRENCY', 6, { min: 1, max: 10 }),
    min24hQuoteVolumeUsd: numberFrom(env, 'MIN_24H_QUOTE_VOLUME_USD', 15_000_000, { min: 1_000_000 }),
    minDepthEachSideUsd: numberFrom(env, 'MIN_DEPTH_EACH_SIDE_USD', 50_000, { min: 10_000 }),
    maxSpreadBps: numberFrom(env, 'MAX_SPREAD_BPS', 10, { min: 1, max: 50 }),
    maxEntrySlippageBps: numberFrom(env, 'MAX_ENTRY_SLIPPAGE_BPS', 8, { min: 0, max: 50 }),
    assumedOrderNotionalUsd: numberFrom(env, 'ASSUMED_ORDER_NOTIONAL_USD', 1_000, { min: 50, max: 1_000_000 }),
    minEntryDepthImbalance: numberFrom(env, 'MIN_ENTRY_DEPTH_IMBALANCE', 0.60, { min: 0.4, max: 1.5 }),
    futuresReclaimMinBuyRatio: numberFromWarn(env, 'FUTURES_RECLAIM_MIN_BUY_RATIO', 0.55, { min: 0.50, max: 0.70 }),
    futuresReclaimMinDeltaRatio: numberFromWarn(env, 'FUTURES_RECLAIM_MIN_DELTA_RATIO', 0.10, { min: 0, max: 0.30 }),
    btcBlockHeartbeatMin: numberFromWarn(env, 'BTC_BLOCK_HEARTBEAT_MIN', 120, { min: 0, max: 1_440 }),
    minBidDepthRetention: numberFrom(env, 'MIN_BID_DEPTH_RETENTION', 0.65, { min: 0.3, max: 1 }),
    maxEntrySpreadExpansion: numberFrom(env, 'MAX_ENTRY_SPREAD_EXPANSION', 1.75, { min: 1, max: 5 }),
    takerFeeBps: numberFrom(env, 'ASSUMED_TAKER_FEE_BPS', 5, { min: 0, max: 50 }),
    exitSlippageBps: numberFrom(env, 'ASSUMED_EXIT_SLIPPAGE_BPS', 3, { min: 0, max: 50 }),
    maxOpenTrades: numberFrom(env, 'MAX_OPEN_TRADES', 1, { min: 1, max: 1 }),
    maxTradesPerDay: numberFrom(env, 'MAX_TRADES_PER_DUBAI_DAY', 3, { min: 1, max: 20 }),
    dailyStopPct: numberFrom(env, 'DAILY_STOP_PCT', -1.5, { min: -20, max: 0 }),
    dailyTargetPct: numberFrom(env, 'DAILY_TARGET_PCT', 2, { min: 0.1, max: 20 }),
    weeklyStopPct: numberFrom(env, 'WEEKLY_STOP_PCT', -5, { min: -50, max: 0 }),
    maxConsecutiveLosses: numberFrom(env, 'MAX_CONSECUTIVE_LOSSES', 2, { min: 1, max: 10 }),
    symbolLossCooldownMin: numberFrom(env, 'SYMBOL_LOSS_COOLDOWN_MIN', 180, { min: 30, max: 1_440 }),
    tradeTimeoutMin: numberFrom(env, 'TRADE_TIMEOUT_MIN', 120, { min: 15, max: 720 }),
    breakevenAtR: numberFrom(env, 'BREAKEVEN_AT_R', 0.75, { min: 0.25, max: 1.4 }),
    minNetRR: numberFrom(env, 'MIN_NET_RR', 1.35, { min: 1, max: 5 }),
    futuresCandidateTtlMin: numberFrom(env, 'FUTURES_CANDIDATE_TTL_MIN', 24, { min: 12, max: 45 }),
    minStopPctFloor: numberFrom(env, 'MIN_STOP_PCT_FLOOR', 0.12, { min: 0.05, max: 0.30 }),
    maxStopPct: numberFrom(env, 'MAX_STOP_PCT', 1.60, { min: 0.5, max: 3 }),
    // v6.9.7: extension limits configurable + strong-flow bonus. Set
    // MAX_ENTRY_EXTENSION_ATR=1.60, ..._LIQUID=1.50 and
    // STRONG_FLOW_EXTENSION_BONUS_ATR=0 to restore exact v6.9.6 behaviour.
    fadeMinNetR: numberFromWarn(env, 'FADE_MIN_NET_R', 0.10, { min: 0, max: 1 }),
    maxEntryExtensionAtr: numberFromWarn(env, 'MAX_ENTRY_EXTENSION_ATR', 1.60, { min: 0.8, max: 3 }),
    maxEntryExtensionAtrLiquid: numberFromWarn(env, 'MAX_ENTRY_EXTENSION_ATR_LIQUID', 1.50, { min: 0.8, max: 3 }),
    strongFlowBuyRatio: numberFromWarn(env, 'STRONG_FLOW_BUY_RATIO', 0.62, { min: 0.50, max: 0.90 }),
    strongFlowExtensionBonusAtr: numberFromWarn(env, 'STRONG_FLOW_EXTENSION_BONUS_ATR', 0.35, { min: 0, max: 1.0 }),
    enableRealtimeShock: boolFrom(env, 'ENABLE_REALTIME_BTC_SHOCK', true),
    realtimeShockDropPct: numberFrom(env, 'REALTIME_SHOCK_DROP_PCT', 0.35, { min: 0.1, max: 2 }),
    realtimeShockWindowMs: numberFrom(env, 'REALTIME_SHOCK_WINDOW_MS', 10_000, { min: 2_000, max: 60_000 }),
    realtimeShockCooldownMs: numberFrom(env, 'REALTIME_SHOCK_COOLDOWN_MS', 120_000, { min: 30_000, max: 600_000 }),
    enableFastMoverAlerts: (() => {
      const raw = String(env.ENABLE_FAST_MOVER_ALERTS ?? '').trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(raw)) {
        return boolFrom(env, 'ENABLE_FAST_MOVER_ALERTS', true);
      }
      console.warn(`[CONFIG WARNING] ENABLE_FAST_MOVER_ALERTS="${raw}" is invalid; using safe default true`);
      return true;
    })(),
    fastMoverMin1mPct: numberFromWarn(env, 'FAST_MOVER_MIN_1M_PCT', 0.8, { min: 0.1, max: 10 }),
    fastMoverMin3mPct: numberFromWarn(env, 'FAST_MOVER_MIN_3M_PCT', 1.5, { min: 0.2, max: 20 }),
    fastMoverVolumeAccel: numberFromWarn(env, 'FAST_MOVER_VOLUME_ACCEL', 3.0, { min: 1, max: 20 }),
    fastMoverMinQuoteUsd: numberFromWarn(env, 'FAST_MOVER_MIN_QUOTE_USD', 10_000_000, { min: 100_000 }),
    fastMoverCooldownMin: numberFromWarn(env, 'FAST_MOVER_COOLDOWN_MIN', 30, { min: 1, max: 1_440 }),
    fastMoverMaxAlertsPerHour: numberFromWarn(env, 'FAST_MOVER_MAX_ALERTS_PER_HOUR', 6, { min: 1, max: 60 }),
    fastMoverMaxSpreadBps: numberFromWarn(env, 'FAST_MOVER_MAX_SPREAD_BPS', 30, { min: 1, max: 200 }),
    // v6.9.4 Tier-2 "TRENDING MOVER" radar — all optional and lenient-parsed:
    // a typo warns and falls back to the safe default instead of aborting boot.
    enableTrendingMover: (() => {
      const raw = String(env.ENABLE_TRENDING_MOVER ?? '').trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(raw)) {
        return boolFrom(env, 'ENABLE_TRENDING_MOVER', true);
      }
      console.warn(`[CONFIG WARNING] ENABLE_TRENDING_MOVER="${raw}" is invalid; using safe default true`);
      return true;
    })(),
    trendingMin15mPct: numberFromWarn(env, 'TRENDING_MIN_15M_PCT', 2.0, { min: 0.5, max: 10 }),
    trendingMin30mPct: numberFromWarn(env, 'TRENDING_MIN_30M_PCT', 3.5, { min: 1, max: 20 }),
    trendingMin60mPct: numberFromWarn(env, 'TRENDING_MIN_60M_PCT', 5.0, { min: 1.5, max: 40 }),
    trendingVolumeAccel: numberFromWarn(env, 'TRENDING_VOLUME_ACCEL', 2.0, { min: 1, max: 10 }),
    trendingMinBuyRatio: numberFromWarn(env, 'TRENDING_MIN_BUY_RATIO', 0.50, { min: 0.40, max: 0.70 }),
    trendingMaxSpreadBps: numberFromWarn(env, 'TRENDING_MAX_SPREAD_BPS', 45, { min: 5, max: 200 }),
    trendingCooldownMin: numberFromWarn(env, 'TRENDING_COOLDOWN_MIN', 120, { min: 15, max: 720 }),
    trendingMaxAlertsPerHour: numberFromWarn(env, 'TRENDING_MAX_ALERTS_PER_HOUR', 4, { min: 1, max: 20 }),
    enableEconomicCalendar,
    // v6.9.5 Event Window Guard — all optional and lenient-parsed: a typo warns
    // and falls back to the safe default instead of aborting boot.
    enableEventGuard: (() => {
      const raw = String(env.ENABLE_EVENT_GUARD ?? '').trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(raw)) {
        return boolFrom(env, 'ENABLE_EVENT_GUARD', true);
      }
      console.warn(`[CONFIG WARNING] ENABLE_EVENT_GUARD="${raw}" is invalid; using safe default true`);
      return true;
    })(),
    eventGuardPreMin: numberFromWarn(env, 'EVENT_GUARD_PRE_MIN', 30, { min: 0, max: 240 }),
    eventGuardPostMin: numberFromWarn(env, 'EVENT_GUARD_POST_MIN', 15, { min: 0, max: 240 }),
    // Plain trimmed string, parsed leniently by EventGuard (never throws).
    eventGuardManual: String(env.EVENT_GUARD_MANUAL ?? '').trim(),
    finnhubKey: String(env.FINNHUB_KEY ?? '').trim(),
    economicCalendarRefreshMs: numberFrom(env, 'ECONOMIC_CALENDAR_REFRESH_MS', 6 * 60 * 60_000, { min: 15 * 60_000, max: 24 * 60 * 60_000 }),
    enableAlphaSignals,
    onchainRiskApiUrl,
    onchainRiskApiToken: String(env.ONCHAIN_RISK_API_TOKEN ?? '').trim(),
    alphaScanIntervalMs: numberFrom(env, 'ALPHA_SCAN_INTERVAL_MS', 240_000, { min: 120_000, max: 1_800_000 }),
    alphaMinLiquidityUsd: numberFrom(env, 'ALPHA_MIN_LIQUIDITY_USD', 150_000, { min: 50_000 }),
    alphaMinVolumeUsd: numberFrom(env, 'ALPHA_MIN_VOLUME_USD', 200_000, { min: 50_000 }),
    alphaMinHolders: numberFrom(env, 'ALPHA_MIN_HOLDERS', 800, { min: 100 }),
    alphaMaxPossibleRugScore: numberFrom(env, 'ALPHA_MAX_POSSIBLE_RUG_SCORE', 2, { min: 0, max: 10 }),
    alphaMaxOnchainChecksPerScan: numberFrom(env, 'ALPHA_MAX_ONCHAIN_CHECKS_PER_SCAN', 20, { min: 1, max: 30 }),
    // v6.9.3 Alpha Fast-Mover radar — all optional and lenient-parsed: a typo
    // warns and falls back to the safe default instead of aborting boot.
    enableAlphaFastMover: (() => {
      const raw = String(env.ENABLE_ALPHA_FAST_MOVER ?? '').trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off', ''].includes(raw)) {
        return boolFrom(env, 'ENABLE_ALPHA_FAST_MOVER', true);
      }
      console.warn(`[CONFIG WARNING] ENABLE_ALPHA_FAST_MOVER="${raw}" is invalid; using safe default true`);
      return true;
    })(),
    alphaMoverPollMs: numberFromWarn(env, 'ALPHA_MOVER_POLL_MS', 90_000, { min: 45_000, max: 600_000 }),
    // v6.9.8: earlier-detection window. Default 3m/2.5% is a HIGHER rate of
    // change than the 10m/3% rule, so it fires only on genuine acceleration.
    alphaMoverFastWindowMin: numberFromWarn(env, 'ALPHA_MOVER_FAST_WINDOW_MIN', 3, { min: 1, max: 10 }),
    alphaMoverMinFastPct: numberFromWarn(env, 'ALPHA_MOVER_MIN_FAST_PCT', 2.5, { min: 0.5, max: 20 }),
    alphaMoverMin10mPct: numberFromWarn(env, 'ALPHA_MOVER_MIN_10M_PCT', 3.0, { min: 0.5, max: 20 }),
    alphaMoverMin30mPct: numberFromWarn(env, 'ALPHA_MOVER_MIN_30M_PCT', 6.0, { min: 1, max: 40 }),
    alphaMoverMax24hChangePct: numberFromWarn(env, 'ALPHA_MOVER_MAX_24H_CHANGE_PCT', 60, { min: 20, max: 200 }),
    alphaMoverCooldownMin: numberFromWarn(env, 'ALPHA_MOVER_COOLDOWN_MIN', 60, { min: 5, max: 720 }),
    alphaMoverMaxAlertsPerHour: numberFromWarn(env, 'ALPHA_MOVER_MAX_ALERTS_PER_HOUR', 4, { min: 1, max: 30 }),
    alphaMoverMaxRiskScore: numberFromWarn(env, 'ALPHA_MOVER_MAX_RISK_SCORE', 5, { min: 0, max: 10 }),
    alphaMoverMinLiquidityUsd: numberFromWarn(env, 'ALPHA_MOVER_MIN_LIQUIDITY_USD', 150_000, { min: 25_000 }),
    // v6.9.6 BTC recorder + 15/30m bias engine — all optional and
    // lenient-parsed: a typo warns and falls back to the safe default.
    enableBtcFeed: boolFromWarn(env, 'ENABLE_BTC_FEED', true),
    enableBtcRecorder: boolFromWarn(env, 'ENABLE_BTC_RECORDER', true),
    enableBtcBiasAlerts: boolFromWarn(env, 'ENABLE_BTC_BIAS_ALERTS', true),
    btcBiasFlipCooldownMin: numberFromWarn(env, 'BTC_BIAS_FLIP_COOLDOWN_MIN', 10, { min: 1, max: 120 }),
    enableBtcBiasTag: boolFromWarn(env, 'ENABLE_BTC_BIAS_TAG', true),
    btcBiasBlockLongs: boolFromWarn(env, 'BTC_BIAS_BLOCK_LONGS', false),
  };

  return Object.freeze(cfg);
};


