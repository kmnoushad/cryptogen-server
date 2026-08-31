#!/usr/bin/env node
/**
 * SHORT-SIDE REPLAY EXPERIMENT  (research only — touches nothing in production)
 *
 * Purpose: v6.9 is hardcoded LONG-only (`direction: 'LONG'`, and every BTC regime
 * state is a long state). The old "SHORT loses, 35% WR" verdict came from the
 * pre-audit engine that repainted candles, missed intrabar stops and ignored fees,
 * so that verdict is not valid evidence. This script re-asks the question honestly.
 *
 * It mirrors the LONG state machine exactly:
 *    long:  impulse up   -> breakout above 21m HIGH -> retest -> reclaim  -> BUY
 *    short: impulse down -> breakdown below 21m LOW -> retest -> rejection -> SELL
 *
 * Same thresholds, same volume/flow requirements, same 1.40 net R:R, same
 * closed-candle evaluation with STOP-FIRST when both levels print in one bar.
 *
 * Output is directly comparable to the long-side audit (which produced
 * 15 TP1 / 26 STOP / 3 TIMEOUT = 36.6% WR = -0.12R).
 *
 * Usage:
 *    node scripts/short-replay.js
 *    REPLAY_MINUTES=1440 UNIVERSE=60 node scripts/short-replay.js
 */

import { parseKlines, closedCandles, buildFeatures } from '../src/indicators.js';

const REPLAY_MINUTES = Number(process.env.REPLAY_MINUTES || 1440);
const UNIVERSE = Number(process.env.UNIVERSE || 60);
const MIN_QUOTE_VOL = Number(process.env.MIN_QUOTE_VOL || 50_000_000);
const NET_RR = Number(process.env.NET_RR || 1.40);
const TIMEOUT_BARS = Number(process.env.TIMEOUT_BARS || 120);
const FEE_BPS = Number(process.env.FEE_BPS || 10); // round-trip taker, mirrors live cost
/**
 * Anti-chase floor. The LONG side rejects entries more than +2.2 ATR ABOVE ema20.
 * The faithful mirror is -2.2 ATR BELOW ema20 — but dumps travel further from the
 * mean than rallies do, so a strict mirror may reject the very waterfall moves
 * shorts are meant to capture. Tunable so this can be measured, not assumed.
 */
const EXT_ATR_FLOOR = Number(process.env.SHORT_EXT_ATR_FLOOR || -2.2);
const BASE = 'https://fapi.binance.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = async (path, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'nexio-short-replay' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(600 * (i + 1));
    }
  }
};

/** 21-bar low — the mirror of buildFeatures' breakoutLevel (21-bar high). */
const breakdownLevelOf = candles => {
  const window = candles.slice(-22, -1);
  return window.length ? Math.min(...window.map(c => c.low)) : null;
};

const sellRatio15 = f => 1 - f.buyRatio15;

/**
 * Bearish impulse — an exact mirror of features.fastImpulse / steadyImpulse.
 * Every threshold keeps its magnitude; only the sign and the flow side flip.
 */
const bearishImpulse = (f, breakdownLevel, last) => {
  if (!breakdownLevel || !f.atr) return null;
  const breakdownPct = (last.close - breakdownLevel) / breakdownLevel * 100;
  const sellRatio3 = 1 - f.buyRatio3;
  const sellRatio1 = 1 - f.buyRatio1;
  const lowerWickPct = f.lowerWickPct ?? 0;

  // mirror of fastImpulse
  const fast = f.ret3m <= -0.60 && f.ret3m >= -2.60
    && f.ret5m >= -3.40
    && breakdownPct <= -0.10
    && f.impulseVolumeRatio >= 1.5
    && sellRatio3 >= 0.56
    && lowerWickPct <= 35
    && f.extensionAtr >= EXT_ATR_FLOOR;

  // mirror of steadyImpulse
  const steady = f.ret15m <= -0.45 && f.ret15m >= -3.50
    && f.ret30m <= -0.75
    && breakdownPct <= -0.05
    && f.impulseVolumeRatio >= 1.2
    && sellRatio15(f) >= 0.54
    && f.extensionAtr >= EXT_ATR_FLOOR;

  if (fast) return { type: 'FAST_BREAKDOWN', breakdownLevel, sellRatio1, sellRatio3 };
  if (steady) return { type: 'STEADY_BREAKDOWN', breakdownLevel, sellRatio1, sellRatio3 };
  return null;
};

/** Replay one symbol; returns its completed short trades. */
export const replaySymbol = (symbol, candles) => {
  const trades = [];
  let candidate = null;
  let open = null;

  const warmup = 60;
  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const last = window.at(-1);

    // ---- manage an open short on CLOSED bars, stop-first ----------------
    if (open) {
      open.bars += 1;
      const stopHit = last.high >= open.stop;      // checked FIRST (conservative)
      const targetHit = last.low <= open.tp1;
      if (stopHit) {
        trades.push({ ...open, outcome: 'STOP', rMultiple: -1 - FEE_BPS / 10_000 });
        open = null;
      } else if (targetHit) {
        trades.push({ ...open, outcome: 'TP1', rMultiple: NET_RR });
        open = null;
      } else if (open.bars >= TIMEOUT_BARS) {
        const r = (open.entry - last.close) / (open.stop - open.entry);
        trades.push({ ...open, outcome: 'TIMEOUT', rMultiple: Number(r.toFixed(3)) });
        open = null;
      }
      if (open) continue;
    }

    let features;
    try { features = buildFeatures(window); } catch { continue; }
    if (!features?.atr) continue;
    const level = breakdownLevelOf(window);

    // ---- ARM: bearish impulse breaks support ----------------------------
    if (!candidate) {
      const impulse = bearishImpulse(features, level, last);
      if (impulse) {
        candidate = {
          symbol, setupType: impulse.type,
          breakdownLevel: impulse.breakdownLevel,
          impulseHigh: Math.max(...window.slice(-6).map(c => c.high)),
          atrAtArm: features.atr,
          armedAt: last.closeTime,
          state: 'ARMED', bars: 0, retestHigh: null,
        };
      }
      continue;
    }

    candidate.bars += 1;
    if (candidate.bars > 30) { candidate = null; continue; }     // expiry, mirrors long TTL

    // invalidation: price reclaims the broken level decisively -> thesis dead
    if (last.close > candidate.breakdownLevel + 0.35 * candidate.atrAtArm) { candidate = null; continue; }

    // ---- RETEST: rally back toward the broken support (now resistance) ---
    if (candidate.state === 'ARMED') {
      const nearLevel = last.high >= candidate.breakdownLevel - 0.45 * candidate.atrAtArm;
      const shallowStall = candidate.bars >= 3
        && (last.high - Math.min(...window.slice(-3).map(c => c.low))) >= 0.10 * candidate.atrAtArm;
      if (nearLevel || shallowStall) {
        candidate.state = 'RETESTED';
        candidate.retestHigh = Math.max(last.high, candidate.retestHigh ?? 0);
      }
      continue;
    }

    // ---- REJECTION: closed bar back below the level on real selling ------
    if (candidate.state === 'RETESTED') {
      candidate.retestHigh = Math.max(candidate.retestHigh ?? last.high, last.high);
      const closedBelow = last.close < candidate.breakdownLevel;
      const sellFlow = (1 - features.buyRatio1) >= 0.55;
      const volumeOk = features.quoteVolumeRatio >= 0.8;
      const momentumOk = features.ema20Slope5Pct <= 0.02;
      if (closedBelow && sellFlow && volumeOk && momentumOk) {
        const entry = last.close;
        const stop = Math.max(candidate.retestHigh, candidate.breakdownLevel) + 0.12 * features.atr;
        const risk = stop - entry;
        const stopPct = risk / entry * 100;
        if (risk > 0 && stopPct >= 0.12 && stopPct <= 1.60) {
          open = {
            symbol, setupType: candidate.setupType,
            entry, stop, tp1: entry - NET_RR * risk,
            stopPct: Number(stopPct.toFixed(3)),
            openedAt: last.closeTime, bars: 0,
          };
        }
        candidate = null;
      }
    }
  }
  return trades;
};

const main = async () => {
  console.log(`SHORT REPLAY · ${REPLAY_MINUTES}m · top ${UNIVERSE} by volume · R:R ${NET_RR} · extFloor ${EXT_ATR_FLOOR}\n`);

  const tickers = await get('/fapi/v1/ticker/24hr');
  const universe = tickers
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
    .filter(t => Number(t.quoteVolume) >= MIN_QUOTE_VOL)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, UNIVERSE)
    .map(t => t.symbol);

  const limit = Math.min(1500, REPLAY_MINUTES + 120);
  const all = [];
  for (const [idx, symbol] of universe.entries()) {
    try {
      const raw = await get(`/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
      const candles = closedCandles(parseKlines(raw));
      if (candles.length < 200) continue;
      const trades = replaySymbol(symbol, candles);
      all.push(...trades);
      if ((idx + 1) % 10 === 0) console.log(`  ...${idx + 1}/${universe.length} symbols`);
      await sleep(120);
    } catch (err) {
      console.log(`  ${symbol}: ${err.message}`);
    }
  }

  const wins = all.filter(t => t.outcome === 'TP1');
  const losses = all.filter(t => t.outcome === 'STOP');
  const timeouts = all.filter(t => t.outcome === 'TIMEOUT');
  const decided = wins.length + losses.length;
  const wr = decided ? wins.length / decided : 0;
  const totalR = all.reduce((s, t) => s + t.rMultiple, 0);
  const expectancy = all.length ? totalR / all.length : 0;
  const grossWin = wins.length * NET_RR;
  const grossLoss = losses.length * 1;
  const pf = grossLoss ? grossWin / grossLoss : 0;

  console.log(`\n${'='.repeat(52)}`);
  console.log('SHORT-SIDE RESULT');
  console.log('='.repeat(52));
  console.log(`Trades:       ${all.length}  (${wins.length} TP1 / ${losses.length} STOP / ${timeouts.length} TIMEOUT)`);
  console.log(`Win rate:     ${(wr * 100).toFixed(1)}%   (decided trades only)`);
  console.log(`Expectancy:   ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}R`);
  console.log(`Profit factor:${pf.toFixed(2)}`);
  console.log(`Break-even WR at ${NET_RR}R: ${(1 / (1 + NET_RR) * 100).toFixed(1)}%`);
  console.log('');
  console.log('LONG-side benchmark (same method): 36.6% WR · -0.122R · PF 0.81');
  console.log('');
  const bySetup = {};
  for (const t of all) {
    bySetup[t.setupType] ??= { n: 0, w: 0 };
    bySetup[t.setupType].n++;
    if (t.outcome === 'TP1') bySetup[t.setupType].w++;
  }
  console.log('By setup:');
  for (const [k, v] of Object.entries(bySetup)) {
    console.log(`  ${k}: ${v.n} trades, ${v.w} wins (${(v.w / v.n * 100).toFixed(0)}%)`);
  }
  console.log('');
  console.log('Caveat: replay assumes fills at the closed price with a flat');
  console.log(`${FEE_BPS}bps round-trip cost, and no order-book depth check.`);
  console.log('Real execution can only be worse, never better.');
};

if (process.argv[1] && process.argv[1].endsWith('short-replay.js')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
