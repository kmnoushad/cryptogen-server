// Separate account credentials. Never falls back to the fade API variables.
export function loadFuturesAutoConfig(env = process.env) {
  const required = name => { const v = String(env[name] ?? '').trim(); if (!v) throw Error(`Missing ${name}`); return v; };
  const environment = String(env.FUTURES_AUTO_ENVIRONMENT ?? 'testnet').trim();
  if (!['testnet', 'live'].includes(environment)) throw Error('FUTURES_AUTO_ENVIRONMENT must be testnet or live');
  const enabled = String(env.ENABLE_FUTURES_AUTO ?? 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(enabled)) throw Error('ENABLE_FUTURES_AUTO must be true or false');
  const key = required('FUTURES_BINANCE_API_KEY');
  if (key === env.BINANCE_API_KEY) throw Error('Futures and fade API keys must be separate');
  if (required('FUTURES_ACCOUNT_CONFIRMATION') !== 'SEPARATE_FUTURES_SUBACCOUNT') throw Error('Dedicated Futures subaccount confirmation required');
  const ack = String(env.FUTURES_AUTO_LIVE_ACKNOWLEDGEMENT ?? '').trim();
  if (environment === 'live' && ack !== 'I_ACCEPT_LIVE_FUTURES_ORDERS') throw Error('Live Futures acknowledgement missing');
  return { environment, enabled: enabled === 'true', binanceApiKey: key,
    binanceApiSecret: required('FUTURES_BINANCE_API_SECRET'),
    supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''), supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    botToken: required('BOT_TOKEN'), ownerChatId: required('OWNER_CHAT_ID'),
    finnhubKey: String(env.FINNHUB_KEY ?? '').trim(), fadeManualEvents: String(env.FUTURES_EVENT_GUARD_MANUAL ?? '').trim(),
    // Base execution plumbing only. No fade strategy/gates run on this worker.
    fadeEnvironment: environment, enableFadeExecution: enabled === 'true',
    fadeLiveAcknowledgement: environment === 'live' && ack === 'I_ACCEPT_LIVE_FUTURES_ORDERS' ? 'I_ACCEPT_LIVE_FADE_ORDERS' : '',
  };
}
