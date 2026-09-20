import dns from 'node:dns';
import { loadGoldConfig } from './gold/config.js';
import { GoldEventWatch } from './gold/event-watch.js';
import { analyzeGoldBars } from './gold/indicators.js';
import { GoldPaperAccount } from './gold/paper-account.js';
import { GoldTelegram } from './gold/telegram.js';
import { TwelveDataGoldFeed } from './gold/twelve-data.js';

dns.setDefaultResultOrder('ipv4first');

const cfg = loadGoldConfig();
const telegram = new GoldTelegram(cfg);
const feed = new TwelveDataGoldFeed(cfg);
const eventWatch = new GoldEventWatch(cfg);
const paper = new GoldPaperAccount(cfg);
await paper.load();

let busy = false;
let stopped = false;
let lastErrorAlertAt = 0;

const dubaiTime = (timestamp = Date.now()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(timestamp));

const money = (value) => `USD ${Number(value).toFixed(2)}`;

const sendSafely = async (message) => {
  try {
    await telegram.send(message);
  } catch (error) {
    console.error('Telegram error:', error?.message || error);
  }
};

const paperStatus = () => {
  const summary = paper.summary();
  return `Balance: ${money(summary.balance)} | Closed: ${summary.closed} | W/L: ${summary.wins}/${summary.losses} | Daily: ${money(summary.dailyPnl)}`;
};

const setupMessage = (analysis, trade = null) => {
  const setup = analysis.setup;
  const lines = [
    'GOLD WATCH - PAPER SETUP',
    `Time (Dubai): ${dubaiTime(analysis.time)}`,
    `Bias: ${setup.direction} | Confidence: ${analysis.confidence}/100`,
    `XAU/USD: ${setup.entry.toFixed(2)}`,
    `Paper stop: ${setup.stop.toFixed(2)} | TP1: ${setup.target1.toFixed(2)} | TP2: ${setup.target2.toFixed(2)}`,
    `RSI14: ${analysis.rsi.toFixed(1)} | ATR14: ${analysis.atr.toFixed(2)}`,
    `Support: ${analysis.support.toFixed(2)} | Resistance: ${analysis.resistance.toFixed(2)}`,
    `Evidence: ${analysis.evidence.join('; ')}`,
  ];
  if (trade) {
    lines.push(`Simulated size: ${trade.lots.toFixed(4)} lot | Risk: ${money(trade.initialRiskUsd)}`);
    if (!trade.brokerViable) lines.push(`Reality check: simulated size is below broker minimum ${trade.brokerMinimumLot} lot.`);
  } else {
    lines.push('Observation only: automatic paper entries are OFF.');
  }
  lines.push('TEST MODE ONLY - no trade was sent to MT5 or any broker.');
  return lines.join('\n');
};

const eventMessage = (event) => {
  const trade = event.trade;
  if (event.type === 'PARTIAL_CLOSE') {
    return [
      'GOLD WATCH - PAPER PARTIAL',
      `Time (Dubai): ${dubaiTime()}`,
      `${trade.direction} | ${event.reason}`,
      `Paper PnL: ${money(event.pnl)} | Balance: ${money(event.balance)}`,
      'Remaining paper position moved to break-even stop.',
      'TEST MODE ONLY.',
    ].join('\n');
  }
  return [
    'GOLD WATCH - PAPER CLOSED',
    `Time (Dubai): ${dubaiTime()}`,
    `${trade.direction} | ${event.reason}`,
    `Final paper PnL: ${money(event.totalPnl)} | Balance: ${money(event.balance)}`,
    'TEST MODE ONLY.',
  ].join('\n');
};

const newsMessage = (event) => [
  'GOLD WATCH - MATERIAL EVENT',
  `Report time (Dubai): ${dubaiTime(event.timestamp)}`,
  `Likely gold pressure: ${event.pressure}`,
  `Confidence: ${event.confidence}`,
  `Report status: ${event.status}`,
  `What changed: ${event.title}`,
  `Reasoning: ${event.reasoning}`,
  `Source: ${event.url}`,
  'Information only - no trade recommendation and no broker action.',
].join('\n');

const heartbeatMessage = (analysis = null) => [
  'GOLD WATCH - TEST STATUS',
  `Time (Dubai): ${dubaiTime()}`,
  `Price feed: ${feed.ready ? 'Twelve Data connected' : 'waiting for Twelve Data API key'}`,
  analysis?.ready ? `XAU/USD: ${analysis.price.toFixed(2)} | Bias: ${analysis.direction}` : 'Market analysis: unavailable',
  `Paper entries: ${cfg.paperAutoEntries ? 'ENABLED' : 'OFF'}`,
  paperStatus(),
  'Live trading: DISABLED | MT5: DISABLED',
].filter(Boolean).join('\n');

const tick = async () => {
  if (busy || stopped) return;
  busy = true;
  try {
    if (cfg.eventAlertsEnabled && Date.now() - paper.state.lastEventPollAt >= cfg.eventPollMs) {
      try {
        const events = await eventWatch.latest();
        const seen = new Set(paper.state.seenEventIds || []);
        for (const event of events.sort((a, b) => a.timestamp - b.timestamp)) {
          if (seen.has(event.id)) continue;
          await sendSafely(newsMessage(event));
          seen.add(event.id);
        }
        paper.state.seenEventIds = [...seen].slice(-500);
        paper.state.lastEventPollAt = Date.now();
        await paper.save();
      } catch (error) {
        console.error('Gold event scan failed:', error?.message || error);
      }
    }

    if (!feed.ready) {
      if (Date.now() - paper.state.lastHeartbeatAt >= cfg.heartbeatMs) {
        await sendSafely(heartbeatMessage());
        paper.state.lastHeartbeatAt = Date.now();
        await paper.save();
      }
      return;
    }

    const bars = await feed.bars();
    const newBars = paper.state.lastBarTime
      ? bars.filter((bar) => bar.time > paper.state.lastBarTime)
      : [bars.at(-1)];

    for (const bar of newBars) {
      const events = paper.applyBar(bar);
      for (const event of events) await sendSafely(eventMessage(event));
      paper.state.lastBarTime = Math.max(paper.state.lastBarTime, bar.time);
    }

    const analysis = analyzeGoldBars(bars);
    const barFresh = analysis.ready && (Date.now() - analysis.time) <= cfg.maxBarAgeMs;
    if (barFresh && analysis.setup && analysis.confidence >= cfg.minimumConfidence) {
      const signature = `${analysis.time}:${analysis.direction}:${analysis.setup.entry}`;
      if (paper.state.lastAlertSignature !== signature) {
        const trade = cfg.paperAutoEntries ? paper.open(analysis.setup, analysis.time) : null;
        await sendSafely(setupMessage(analysis, trade));
        paper.state.lastAlertSignature = signature;
      }
    }

    if (Date.now() - paper.state.lastHeartbeatAt >= cfg.heartbeatMs) {
      await sendSafely(heartbeatMessage(analysis));
      paper.state.lastHeartbeatAt = Date.now();
    }
    await paper.save();
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      bar: bars.at(-1)?.datetime,
      price: analysis.price,
      bias: analysis.direction,
      confidence: analysis.confidence,
      paper: paper.summary(),
    }));
  } catch (error) {
    console.error('Gold Watch tick failed:', error?.stack || error);
    if (Date.now() - lastErrorAlertAt >= 3_600_000) {
      await sendSafely([
        'GOLD WATCH - DATA WARNING',
        `Time (Dubai): ${dubaiTime()}`,
        String(error?.message || error).slice(0, 500),
        'No paper setup was created from this failed cycle.',
      ].join('\n'));
      lastErrorAlertAt = Date.now();
    }
  } finally {
    busy = false;
  }
};

console.log(`Gold Watch starting: mode=${cfg.mode}; autoPaper=${cfg.paperAutoEntries}; live=false; mt5=false`);
await sendSafely([
  'CRYPTONERD GOLD WATCH - WORKER STARTED',
  `Time (Dubai): ${dubaiTime()}`,
  `Price feed: ${feed.ready ? 'configured' : 'waiting for Twelve Data API key'}`,
  `Paper entries: ${cfg.paperAutoEntries ? 'ENABLED' : 'OFF during feed validation'}`,
  paperStatus(),
  'Live trading: DISABLED | MT5: DISABLED',
].join('\n'));
paper.state.lastHeartbeatAt = Date.now();
await paper.save();
await tick();

const timer = setInterval(() => { void tick(); }, cfg.pollMs);
const stop = async (signal) => {
  stopped = true;
  clearInterval(timer);
  console.log(`Gold Watch received ${signal}; stopping.`);
  while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
  await paper.save().catch(() => {});
  process.exit(0);
};
process.once('SIGTERM', () => { void stop('SIGTERM'); });
process.once('SIGINT', () => { void stop('SIGINT'); });
