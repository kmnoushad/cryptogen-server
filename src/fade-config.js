// Independent configuration: the worker does not load the alert engine.
export function loadFadeConfig(env = process.env) {
  const required = key => {
    const value = String(env[key] ?? '').trim();
    if (!value) throw Error(`Missing ${key}`);
    return value;
  };
  const fadeEnvironment = String(env.FADE_ENVIRONMENT ?? 'testnet').trim();
  if (!['testnet', 'live'].includes(fadeEnvironment)) throw Error('FADE_ENVIRONMENT must be testnet or live');
  const enabled = String(env.ENABLE_FADE_EXECUTION ?? 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(enabled)) throw Error('ENABLE_FADE_EXECUTION must be true or false');
  return {
    fadeEnvironment, enableFadeExecution: enabled === 'true',
    fadeLiveAcknowledgement: String(env.FADE_LIVE_ACKNOWLEDGEMENT ?? '').trim(),
    binanceApiKey: required('BINANCE_API_KEY'), binanceApiSecret: required('BINANCE_API_SECRET'),
    supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    botToken: required('BOT_TOKEN'), ownerChatId: required('OWNER_CHAT_ID'),
  };
}
