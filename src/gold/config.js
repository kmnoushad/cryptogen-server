const asBool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const asNumber = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const loadGoldConfig = (env = process.env) => {
  const mode = String(env.GOLD_MODE || 'paper').trim().toLowerCase();
  const liveTradingEnabled = asBool(env.LIVE_TRADING_ENABLED, false);
  const mt5TradingEnabled = asBool(env.MT5_TRADING_ENABLED, false);

  if (mode !== 'paper' || liveTradingEnabled || mt5TradingEnabled) {
    throw new Error('Gold Watch safety lock: only paper mode is supported; live and MT5 trading must remain disabled.');
  }

  const telegramBotToken = String(env.GOLD_TELEGRAM_BOT_TOKEN || '').trim();
  const telegramChatId = String(env.GOLD_TELEGRAM_CHAT_ID || '').trim();
  if (!telegramBotToken || !telegramChatId) {
    throw new Error('GOLD_TELEGRAM_BOT_TOKEN and GOLD_TELEGRAM_CHAT_ID are required.');
  }

  return Object.freeze({
    mode,
    liveTradingEnabled: false,
    mt5TradingEnabled: false,
    telegramBotToken,
    telegramChatId,
    twelveDataApiKey: String(env.TWELVE_DATA_API_KEY || '').trim(),
    symbol: String(env.GOLD_SYMBOL || 'XAU/USD').trim(),
    interval: String(env.GOLD_INTERVAL || '5min').trim(),
    outputSize: Math.round(asNumber(env.GOLD_OUTPUT_SIZE, 160, { min: 80, max: 500 })),
    pollMs: Math.round(asNumber(env.GOLD_POLL_MS, 300_000, { min: 60_000, max: 3_600_000 })),
    heartbeatMs: Math.round(asNumber(env.GOLD_HEARTBEAT_MS, 21_600_000, { min: 3_600_000, max: 86_400_000 })),
    maxBarAgeMs: Math.round(asNumber(env.GOLD_MAX_BAR_AGE_MS, 1_200_000, { min: 300_000, max: 86_400_000 })),
    eventAlertsEnabled: asBool(env.GOLD_EVENT_ALERTS_ENABLED, true),
    eventPollMs: Math.round(asNumber(env.GOLD_EVENT_POLL_MS, 600_000, { min: 300_000, max: 3_600_000 })),
    stateFile: String(env.GOLD_STATE_FILE || '/var/lib/nexio-gold/state.json').trim(),
    paperStartBalance: asNumber(env.PAPER_START_BALANCE_USD, 100, { min: 10, max: 1_000_000 }),
    paperRiskPct: asNumber(env.GOLD_PAPER_RISK_PCT, 0.01, { min: 0.001, max: 0.02 }),
    paperDailyLossUsd: asNumber(env.GOLD_PAPER_DAILY_LOSS_USD, 3, { min: 0.25, max: 100 }),
    paperAutoEntries: asBool(env.GOLD_AUTO_PAPER_ENTRIES, false),
    minimumConfidence: Math.round(asNumber(env.GOLD_MIN_CONFIDENCE, 75, { min: 60, max: 95 })),
    contractOzPerLot: asNumber(env.GOLD_CONTRACT_OZ_PER_LOT, 100, { min: 1, max: 1_000 }),
    brokerMinimumLot: asNumber(env.GOLD_BROKER_MIN_LOT, 0.01, { min: 0.0001, max: 1 }),
    estimatedSpreadUsd: asNumber(env.GOLD_ESTIMATED_SPREAD_USD, 0.35, { min: 0, max: 10 }),
    estimatedSlippageUsd: asNumber(env.GOLD_ESTIMATED_SLIPPAGE_USD, 0.10, { min: 0, max: 10 }),
  });
};
