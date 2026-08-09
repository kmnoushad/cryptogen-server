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
    minDepthEachSideUsd: numberFrom(env, 'MIN_DEPTH_EACH_SIDE_USD', 100_000, { min: 10_000 }),
    maxSpreadBps: numberFrom(env, 'MAX_SPREAD_BPS', 10, { min: 1, max: 50 }),
    maxEntrySlippageBps: numberFrom(env, 'MAX_ENTRY_SLIPPAGE_BPS', 8, { min: 0, max: 50 }),
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
    enableEconomicCalendar,
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
  };

  return Object.freeze(cfg);
};
