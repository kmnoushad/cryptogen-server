import { FadeExchange } from '../src/fade-orders.js';
const exchange = new FadeExchange({ environment: 'live' });
const start = Date.now();
try {
  await exchange.syncTime();
  console.log('Binance clock check passed:', JSON.stringify({ ...exchange.timeSample, elapsedMs: Date.now()-start }));
  console.log('Public time reads only. No credentials used or orders placed.');
} catch (e) { console.error('Binance clock check failed:', e.message); process.exitCode = 1; }
