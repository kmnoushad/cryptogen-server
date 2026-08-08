import dns from 'node:dns';
import http from 'node:http';
import { loadConfig } from './config.js';
import { BinanceClient } from './binance.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { Engine } from './engine.js';
import { AlphaRadar } from './alpha.js';
import { EconomicCalendar } from './calendar.js';
import { log } from './util.js';
import { APP_VERSION } from './version.js';

dns.setDefaultResultOrder('ipv4first');

const cfg = loadConfig();
const binance = new BinanceClient();
const store = new Store(cfg);
const telegram = new Telegram(cfg);
const alpha = new AlphaRadar({ cfg, store, telegram });
const calendar = new EconomicCalendar({ cfg, store, telegram });
const engine = new Engine({ cfg, binance, store, telegram, alpha, calendar });

const server = http.createServer((request, response) => {
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(engine.health()));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not found' }));
});

const shutdown = signal => {
  log(`${signal} received; shutting down`);
  engine.stop();
  telegram.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => log(`Unhandled rejection: ${error?.stack ?? error}`));
process.on('uncaughtException', error => {
  log(`Uncaught exception: ${error.stack ?? error}`);
  shutdown('uncaughtException');
});

try {
  server.listen(cfg.port, '0.0.0.0', () => log(`Health server listening on :${cfg.port}`));
  await engine.initialize();
  await telegram.send(`🟢 <b>NEXIO v${APP_VERSION} started</b>\n` +
    `Mode: ${cfg.paperMode ? 'PAPER' : 'ALERT-ONLY'}\n` +
    `Closed 1m candles · fast + steady momentum · retest/reclaim\n` +
    `BTC: ${engine.btc.regime} · Universe: ${engine.universe.length}\n` +
    `Alpha: ${cfg.enableAlphaSignals ? '✅ ON · on-chain risk screening active' : 'disabled'}\n` +
    `Calendar: ${calendar.configured() ? '✅ ON · Finnhub high-impact US reminders' : '⚠️ FINNHUB_KEY missing/disabled'}\n` +
    `<i>Trade alerts actionable-only · calendar information kept separate</i>`);
  void telegram.pollLoop(message => engine.command(message));
  void calendar.runLoop();
  void engine.runLoop();
} catch (error) {
  log(`Fatal startup error: ${error.stack ?? error}`);
  server.close();
  process.exit(1);
}
