import dns from 'node:dns';
import http from 'node:http';
import { loadConfig } from './config.js';
import { BinanceClient } from './binance.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { Engine } from './engine.js';
import { AlphaRadar } from './alpha.js';
import { EconomicCalendar } from './calendar.js';
import { EventGuard } from './event-guard.js';
import { RealtimeShockGuard } from './realtime-shock.js';
import { FastMoverDetector } from './pump-detector.js';
import { AlphaFastMover } from './alpha-mover.js';
import { BtcFeed } from './btc-feed.js';
import { BtcBiasEngine } from './btc-bias.js';
import { BtcRecorder } from './btc-recorder.js';
import { log } from './util.js';
import { APP_VERSION } from './version.js';

dns.setDefaultResultOrder('ipv4first');

const cfg = loadConfig();
const binance = new BinanceClient({
  btcEma50RetestBufferPct: cfg.btcEma50RetestBufferPct,
  btcMinEma50Slope6hPct: cfg.btcMinEma50Slope6hPct,
});
const store = new Store(cfg);
const telegram = new Telegram(cfg);
// v6.9.6: BTC combined-stream feed → 15m/30m bias engine → per-candle
// recorder. The bias engine is injected into every alert producer so each
// outbound long alert carries the current BTC bias tag.
const btcFeed = new BtcFeed({ cfg, binance });
const btcBias = new BtcBiasEngine({ cfg, feed: btcFeed, binance, telegram });
const btcRecorder = new BtcRecorder({ cfg, store, feed: btcFeed, bias: btcBias });
btcFeed.onCandle = candle => {
  void btcBias.handleCandle(candle);
  void btcRecorder.onCandle(candle);
};
const alpha = new AlphaRadar({ cfg, store, telegram, btcBias });
const calendar = new EconomicCalendar({ cfg, store, telegram });
const eventGuard = new EventGuard({ cfg, calendar });
let engine = null;
const realtimeShock = new RealtimeShockGuard({
  cfg,
  onShock: event => engine?.handleRealtimeShock(event),
});
const fastMover = new FastMoverDetector({
  cfg,
  binance,
  store,
  telegram,
  realtimeShock,
  btcBias,
  isPaused: () => engine?.paused ?? false,
  isEventGuarded: () => Boolean(eventGuard.activeWindow()),
});
const alphaMover = new AlphaFastMover({
  cfg,
  store,
  telegram,
  btcBias,
  isPaused: () => engine?.paused ?? false,
  isEventGuarded: () => Boolean(eventGuard.activeWindow()),
});
engine = new Engine({ cfg, binance, store, telegram, alpha, calendar, realtimeShock, fastMover, alphaMover, eventGuard, btcFeed, btcBias, btcRecorder });

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
  btcFeed.stop();
  realtimeShock.stop();
  fastMover.stop();
  alphaMover.stop();
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
  await btcFeed.seed(); // one-time REST warm-up (~4 weight); failure only logs
  btcFeed.start();
  realtimeShock.start();
  fastMover.start();
  alphaMover.start();
  await telegram.send(`🟢 <b>NEXIO v${APP_VERSION} started</b>\n` +
    `Mode: ${cfg.paperMode ? 'PAPER' : 'ALERT-ONLY'}\n` +
    `[FUTURES] Closed 1m candles · setup-aware retest · reclaim/book recovery\n` +
    `BTC: ${engine.btc.regime} · Universe: ${engine.universe.length}\n` +
    `BTC gate: HTF trend + ${cfg.enableRealtimeShock ? `${cfg.realtimeShockDropPct}%/${Math.round(cfg.realtimeShockWindowMs / 1000)}s realtime shock guard` : 'realtime guard disabled'}\n` +
    `[FAST MOVER] ${cfg.enableFastMoverAlerts ? '✅ ON · live pump radar (info alerts only)' : 'disabled'}\n` +
    `[ALPHA] ${cfg.enableAlphaSignals ? '✅ ON · on-chain risk screening active' : 'disabled'}\n` +
    `[ALPHA MOVER] ${cfg.enableAlphaFastMover ? '✅ ON · early runner radar (info alerts only)' : 'disabled'}\n` +
    `[BTC BIAS] ${cfg.enableBtcFeed ? `✅ ON · 15m/30m gauge${cfg.btcBiasBlockLongs ? ' · LONG-BLOCK GATE ON' : ''}` : 'disabled'} · recorder ${cfg.enableBtcRecorder ? '✅' : '⚠️ off'}\n` +
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
