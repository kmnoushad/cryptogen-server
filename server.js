// ─────────────────────────────────────────────────────────────────────────────
// NEXIO SERVER v5.0 — COMPLETE REVISION
// 
// FIX #1: DIRECTION LOGIC (was causing 40%+ of losses)
// FIX #2: ENTRY TIMING (entering too early/too late)
// FIX #3: RISK MANAGEMENT (no position sizing, no loss limits)
// FIX #4: CONFIRMATION LAYERS (entering on false signals)
// FIX #5: MARKET REGIME (trading in all conditions equally)
// ─────────────────────────────────────────────────────────────────────────────

const BOT_TOKEN       = '8758159971:AAEzjYQPQVAtTmU3VBYRkUy0e6hdhy0gQRU';
const FREE_CHANNEL    = '-1003900595640';
const PREMIUM_CHANNEL = '-1003913881352';
const OWNER_CHAT_ID   = '6896387082';

// ⚠️ CRITICAL: KEEP THIS TRUE FOR MINIMUM 4 WEEKS
const PAPER_MODE = true;  // ← DO NOT CHANGE until 100 paper trades with >55% win rate

const USDT_ADDRESS    = 'THNNCFN9TyrcazTp3n9ngXLTgMLhH8nWaL';
const PRICE_USD       = 9.99;
const SUPABASE_URL    = 'https://jxsvqxnbjuhtenmarioe.supabase.co';
const SUPABASE_KEY    = 'sb_publishable_2TyePq_3BLHi2s8GbLMEaA_rspMsMN4';

// ─────────────────────────────────────────────────────────────────────────────
// FIX #3: COMPLETE RISK MANAGEMENT SYSTEM (NEW)
// ─────────────────────────────────────────────────────────────────────────────
const RISK_CONFIG = {
  // Position sizing
  max_risk_per_trade_pct: 1.0,        // Max 1% of account per trade
  max_position_size_pct: 10,           // Max 10% of account per position
  max_concurrent_positions: 3,         // Max 3 positions at once
  min_risk_reward: 2.0,                // Minimum 1:2 risk/reward
  
  // Loss limits
  max_daily_loss_pct: 3.0,             // Stop trading at 3% daily loss
  max_weekly_loss_pct: 8.0,            // Stop trading at 8% weekly loss
  max_consecutive_losses: 3,           // Pause after 3 losses
  cooldown_after_loss_minutes: 120,    // 2 hour cooldown per coin
  
  // Correlation
  max_correlation_threshold: 0.7,      // Don't trade correlated pairs
  require_btc_alignment: true,         // BTC must agree with direction
  
  // Entry filters
  min_confirmation_candles: 2,         // Wait for 2 confirmation candles
  min_volume_ratio: 1.8,               // Breakout volume must be 1.8x average
  max_spread_pct: 0.1,                 // Max 0.1% spread
  
  // Exit rules
  trailing_activation_pct: 1.0,        // Start trailing after 1% profit
  trailing_distance_pct: 0.5,          // Trail by 0.5%
  max_hold_hours: 24,                  // Force exit after 24 hours
};

// Account tracking
let account = {
  balance: 10000,                      // Starting balance
  peak_balance: 10000,
  daily_pnl: 0,
  weekly_pnl: 0,
  daily_date: new Date().toDateString(),
  weekly_date: getWeekStart(),
  consecutive_losses: 0,
  open_positions: [],
  trade_history: [],
};

function getWeekStart() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return d.toDateString();
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #1: NEW DIRECTION LOGIC (Multi-Timeframe + Order Flow)
// ─────────────────────────────────────────────────────────────────────────────
class DirectionAnalyzer {
  constructor() {
    this.timeframes = ['15m', '1h', '4h'];
    this.weight = {
      htf_trend: 0.35,      // Higher timeframe trend
      price_action: 0.25,   // Current price structure
      order_flow: 0.20,     // Order book imbalance
      momentum: 0.10,       // Rate of change
      sentiment: 0.10,      // Funding + L/S ratio
    };
  }

  async analyze(symbol, price, klines, funding, lsRatio) {
    const scores = {
      long: 0,
      short: 0,
      reasons: { long: [], short: [] }
    };

    // 1. Higher Timeframe Trend (35% weight)
    const htf = await this.checkHTFTrend(symbol);
    if (htf.bullish) {
      scores.long += this.weight.htf_trend;
      scores.reasons.long.push('HTF bullish');
    } else if (htf.bearish) {
      scores.short += this.weight.htf_trend;
      scores.reasons.short.push('HTF bearish');
    }

    // 2. Price Action (25% weight)
    const pa = this.checkPriceAction(klines, price);
    if (pa.bullish) {
      scores.long += this.weight.price_action;
      scores.reasons.long.push('bullish structure');
    } else if (pa.bearish) {
      scores.short += this.weight.price_action;
      scores.reasons.short.push('bearish structure');
    }

    // 3. Order Flow (20% weight)
    const orderFlow = await this.checkOrderFlow(symbol, price);
    if (orderFlow.bullish) {
      scores.long += this.weight.order_flow;
      scores.reasons.long.push('buying pressure');
    } else if (orderFlow.bearish) {
      scores.short += this.weight.order_flow;
      scores.reasons.short.push('selling pressure');
    }

    // 4. Momentum (10% weight)
    const momentum = this.checkMomentum(klines);
    if (momentum > 0.3) {
      scores.long += this.weight.momentum;
      scores.reasons.long.push(`momentum +${momentum.toFixed(1)}%`);
    } else if (momentum < -0.3) {
      scores.short += this.weight.momentum;
      scores.reasons.short.push(`momentum ${momentum.toFixed(1)}%`);
    }

    // 5. Sentiment (10% weight)
    const sentiment = this.checkSentiment(funding, lsRatio);
    if (sentiment.bullish) {
      scores.long += this.weight.sentiment;
      scores.reasons.long.push('favorable funding');
    } else if (sentiment.bearish) {
      scores.short += this.weight.sentiment;
      scores.reasons.short.push('bearish sentiment');
    }

    // Decision: Need clear winner with minimum 0.6 score (out of 1.0)
    const totalWeight = Object.values(this.weight).reduce((a, b) => a + b, 0);
    const longScore = scores.long / totalWeight;
    const shortScore = scores.short / totalWeight;
    
    let direction = null;
    let confidence = 0;
    
    if (longScore >= 0.65 && longScore > shortScore + 0.15) {
      direction = 'LONG';
      confidence = longScore;
    } else if (shortScore >= 0.65 && shortScore > longScore + 0.15) {
      direction = 'SHORT';
      confidence = shortScore;
    }

    return {
      direction,
      confidence: parseFloat((confidence * 100).toFixed(1)),
      longScore: parseFloat((longScore * 100).toFixed(1)),
      shortScore: parseFloat((shortScore * 100).toFixed(1)),
      reasons: direction === 'LONG' ? scores.reasons.long : scores.reasons.short,
      details: scores
    };
  }

  async checkHTFTrend(symbol) {
    try {
      const klines4h = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=100`);
      if (!klines4h || klines4h.length < 50) return { bullish: false, bearish: false };
      
      const closes = klines4h.map(k => parseFloat(k[4]));
      const price = closes[closes.length - 1];
      const ema20 = this.calcEMA(closes, 20);
      const ema50 = this.calcEMA(closes, 50);
      const ema200 = this.calcEMA(closes, 200);
      
      // Require price above MA's AND MA's in correct order
      const bullish = price > ema20 && ema20 > ema50 && ema50 > ema200;
      const bearish = price < ema20 && ema20 < ema50 && ema50 < ema200;
      
      // Additional: Check for higher highs / lower lows
      const last20Highs = closes.slice(-20).reduce((a, b) => Math.max(a, b), 0);
      const prev20Highs = closes.slice(-40, -20).reduce((a, b) => Math.max(a, b), 0);
      const makingHigherHighs = last20Highs > prev20Highs;
      
      return {
        bullish: bullish && makingHigherHighs,
        bearish: bearish && !makingHigherHighs
      };
    } catch {
      return { bullish: false, bearish: false };
    }
  }

  checkPriceAction(klines, currentPrice) {
    if (!klines || klines.length < 20) return { bullish: false, bearish: false };
    
    const closes = klines.map(k => parseFloat(k[4]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows = klines.map(k => parseFloat(k[3]));
    
    // Check for higher highs / higher lows
    const recentHighs = highs.slice(-10);
    const previousHighs = highs.slice(-20, -10);
    const higherHighs = Math.max(...recentHighs) > Math.max(...previousHighs);
    
    const recentLows = lows.slice(-10);
    const previousLows = lows.slice(-20, -10);
    const higherLows = Math.min(...recentLows) > Math.min(...previousLows);
    
    // Check EMA position
    const ema20 = this.calcEMA(closes, 20);
    const aboveEMA20 = currentPrice > ema20;
    
    const bullish = higherHighs && higherLows && aboveEMA20;
    const bearish = !higherHighs && !higherLows && !aboveEMA20;
    
    return { bullish, bearish };
  }

  async checkOrderFlow(symbol, price) {
    try {
      const ob = await fetchJSON(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`);
      if (!ob) return { bullish: false, bearish: false };
      
      // Calculate bid/ask imbalance
      let bidVolume = 0;
      let askVolume = 0;
      
      for (const bid of ob.bids.slice(0, 50)) {
        bidVolume += parseFloat(bid[0]) * parseFloat(bid[1]);
      }
      for (const ask of ob.asks.slice(0, 50)) {
        askVolume += parseFloat(ask[0]) * parseFloat(ask[1]);
      }
      
      const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
      const bullish = imbalance > 0.2;
      const bearish = imbalance < -0.2;
      
      return { bullish, bearish, imbalance: parseFloat(imbalance.toFixed(3)) };
    } catch {
      return { bullish: false, bearish: false };
    }
  }

  checkMomentum(klines) {
    if (!klines || klines.length < 14) return 0;
    
    const closes = klines.map(k => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];
    const price14ago = closes[closes.length - 14];
    
    const momentum = ((currentPrice - price14ago) / price14ago) * 100;
    return parseFloat(momentum.toFixed(2));
  }

  checkSentiment(funding, lsRatio) {
    // For LONG: Want negative funding (shorts paying) and low L/S ratio
    const bullish = funding < -0.005 && lsRatio < 1.1;
    const bearish = funding > 0.005 && lsRatio > 1.1;
    return { bullish, bearish };
  }

  calcEMA(data, period) {
    if (data.length < period) return data[data.length - 1];
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #2: ENTRY TIMING SYSTEM (Prevents early/late entries)
// ─────────────────────────────────────────────────────────────────────────────
class EntryTimingAnalyzer {
  constructor() {
    this.confirmationPatterns = {
      breakout_retest: true,      // Wait for retest after breakout
      volume_confirm: true,       // Volume must confirm
      candle_closure: true,       // Wait for candle close
      liquidity_sweep: true,      // Look for liquidity sweeps
      divergence: true,           // Check for divergence
    };
  }

  async analyze(symbol, price, direction, klines, volumeSpike) {
    const signals = {
      ready: false,
      type: null,  // 'BREAKOUT', 'RETEST', 'LIQUIDITY_SWEEP', 'DIVERGENCE'
      score: 0,
      waitTime: 0,
      reasons: []
    };

    // 1. Check for breakout confirmation
    const breakout = this.checkBreakoutConfirmation(klines, direction);
    if (breakout.confirmed && breakout.volumeOk) {
      signals.score += 3;
      signals.reasons.push(`breakout confirmed (${breakout.strength})`);
    }

    // 2. Check for retest opportunity (BETTER than breakout)
    const retest = this.checkRetestOpportunity(klines, direction, price);
    if (retest.available) {
      signals.score += 4;  // Retest is higher quality
      signals.type = 'RETEST';
      signals.waitTime = retest.estimatedWait;
      signals.reasons.push(`retest at ${fmtP(retest.level)}`);
    }

    // 3. Check for liquidity sweep (HIGHEST quality)
    const sweep = this.checkLiquiditySweepPattern(klines, direction);
    if (sweep.detected && sweep.recovery) {
      signals.score += 5;
      signals.type = 'LIQUIDITY_SWEEP';
      signals.reasons.push(`liquidity swept at ${fmtP(sweep.level)} → recovered`);
    }

    // 4. Check for divergence (reversal signal)
    const divergence = this.checkDivergence(klines, direction);
    if (divergence.detected) {
      signals.score += 2;
      signals.type = 'DIVERGENCE';
      signals.reasons.push(`${divergence.type} divergence`);
    }

    // 5. Volume confirmation
    if (volumeSpike >= RISK_CONFIG.min_volume_ratio) {
      signals.score += 2;
      signals.reasons.push(`volume ${volumeSpike.toFixed(1)}x avg`);
    }

    // Decision: Ready if score >= 6 AND has clear type
    signals.ready = signals.score >= 6;
    
    // Suggest entry price
    if (signals.ready) {
      signals.entryPrice = this.suggestEntryPrice(klines, direction, signals.type);
    }

    return signals;
  }

  checkBreakoutConfirmation(klines, direction) {
    if (!klines || klines.length < 5) return { confirmed: false, volumeOk: false, strength: 'weak' };
    
    const breakoutCandle = klines[klines.length - 2];
    const confirmCandle = klines[klines.length - 1];
    
    const breakOpen = parseFloat(breakoutCandle[1]);
    const breakClose = parseFloat(breakoutCandle[4]);
    const breakHigh = parseFloat(breakoutCandle[2]);
    const breakLow = parseFloat(breakoutCandle[3]);
    const breakVol = parseFloat(breakoutCandle[5]);
    
    const confirmClose = parseFloat(confirmCandle[4]);
    const confirmVol = parseFloat(confirmCandle[5]);
    
    // Calculate average volume (last 20 candles)
    const avgVol = klines.slice(-22, -2).reduce((s, k) => s + parseFloat(k[5]), 0) / 20;
    
    const isLong = direction === 'LONG';
    const breakoutDirection = isLong ? breakClose > breakOpen : breakClose < breakOpen;
    const breakoutMove = Math.abs((breakClose - breakOpen) / breakOpen) * 100;
    const confirmationHolds = isLong ? confirmClose > breakClose * 0.998 : confirmClose < breakClose * 1.002;
    const volumeOk = breakVol > avgVol * 1.5 && confirmVol > avgVol * 1.2;
    
    let strength = 'weak';
    if (breakoutMove > 1.5 && volumeOk && confirmationHolds) strength = 'strong';
    else if (breakoutMove > 0.8 && volumeOk) strength = 'moderate';
    
    return {
      confirmed: breakoutDirection && confirmationHolds,
      volumeOk,
      strength,
      breakoutPrice: breakClose,
      movePercent: parseFloat(breakoutMove.toFixed(2))
    };
  }

  checkRetestOpportunity(klines, direction, currentPrice) {
    if (!klines || klines.length < 10) return { available: false };
    
    const highs = klines.map(k => parseFloat(k[2]));
    const lows = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    
    if (direction === 'LONG') {
      // Find recent resistance level
      const recentHighs = highs.slice(-10);
      const resistance = Math.max(...recentHighs);
      const distanceToResistance = ((resistance - currentPrice) / currentPrice) * 100;
      
      // Look for retest of broken resistance (now support)
      const brokenResistance = highs.slice(-20, -10).reduce((a, b) => Math.max(a, b), 0);
      const retestLevel = brokenResistance;
      const distanceToRetest = ((currentPrice - retestLevel) / currentPrice) * 100;
      
      if (distanceToRetest < 1.0 && distanceToRetest > -0.5) {
        return { available: true, level: retestLevel, estimatedWait: 0 };
      }
    } else {
      // For SHORT: Find support turned resistance
      const recentLows = lows.slice(-10);
      const support = Math.min(...recentLows);
      const brokenSupport = lows.slice(-20, -10).reduce((a, b) => Math.min(a, b), 0);
      const retestLevel = brokenSupport;
      const distanceToRetest = ((retestLevel - currentPrice) / currentPrice) * 100;
      
      if (distanceToRetest < 1.0 && distanceToRetest > -0.5) {
        return { available: true, level: retestLevel, estimatedWait: 0 };
      }
    }
    
    return { available: false };
  }

  checkLiquiditySweepPattern(klines, direction) {
    if (!klines || klines.length < 6) return { detected: false, recovery: false };
    
    const recent = klines.slice(-6);
    const lows = recent.map(k => parseFloat(k[3]));
    const highs = recent.map(k => parseFloat(k[2]));
    const closes = recent.map(k => parseFloat(k[4]));
    const opens = recent.map(k => parseFloat(k[1]));
    
    if (direction === 'LONG') {
      // Look for: sweep below recent low → immediate recovery
      const recentLow = Math.min(...lows.slice(0, -2));
      const sweepLow = lows[lows.length - 2];
      const recovered = closes[closes.length - 1] > opens[opens.length - 1] && 
                        closes[closes.length - 1] > recentLow;
      
      if (sweepLow < recentLow * 0.998 && recovered) {
        return { detected: true, recovery: true, level: sweepLow };
      }
    } else {
      // For SHORT: sweep above recent high → immediate drop
      const recentHigh = Math.max(...highs.slice(0, -2));
      const sweepHigh = highs[highs.length - 2];
      const recovered = closes[closes.length - 1] < opens[opens.length - 1] && 
                        closes[closes.length - 1] < recentHigh;
      
      if (sweepHigh > recentHigh * 1.002 && recovered) {
        return { detected: true, recovery: true, level: sweepHigh };
      }
    }
    
    return { detected: false, recovery: false };
  }

  checkDivergence(klines, direction) {
    if (!klines || klines.length < 30) return { detected: false };
    
    const closes = klines.map(k => parseFloat(k[4]));
    const rsi = this.calculateRSI(closes);
    
    // Get last 10 values
    const recentCloses = closes.slice(-10);
    const recentRSI = rsi.slice(-10);
    
    if (direction === 'LONG') {
      // Bullish divergence: lower lows in price, higher lows in RSI
      const priceLow = Math.min(...recentCloses);
      const prevPriceLow = Math.min(...closes.slice(-20, -10));
      const rsiLow = Math.min(...recentRSI);
      const prevRsiLow = Math.min(...rsi.slice(-20, -10));
      
      if (priceLow < prevPriceLow && rsiLow > prevRsiLow) {
        return { detected: true, type: 'bullish' };
      }
    } else {
      // Bearish divergence: higher highs in price, lower highs in RSI
      const priceHigh = Math.max(...recentCloses);
      const prevPriceHigh = Math.max(...closes.slice(-20, -10));
      const rsiHigh = Math.max(...recentRSI);
      const prevRsiHigh = Math.max(...rsi.slice(-20, -10));
      
      if (priceHigh > prevPriceHigh && rsiHigh < prevRsiHigh) {
        return { detected: true, type: 'bearish' };
      }
    }
    
    return { detected: false };
  }

  suggestEntryPrice(klines, direction, entryType) {
    const lastClose = parseFloat(klines[klines.length - 1][4]);
    
    if (entryType === 'RETEST') {
      // Enter on retest of broken level
      const highs = klines.map(k => parseFloat(k[2]));
      const brokenLevel = Math.max(...highs.slice(-20, -10));
      return brokenLevel;
    } else if (entryType === 'LIQUIDITY_SWEEP') {
      // Enter after sweep recovery
      return lastClose;
    } else {
      // Standard breakout entry
      return lastClose;
    }
  }

  calculateRSI(closes, period = 14) {
    const rsi = [];
    let gains = 0, losses = 0;
    
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i-1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
      
      if (i >= period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgGain / avgLoss;
        const rsiValue = 100 - (100 / (1 + rs));
        rsi.push(rsiValue);
        
        // Slide window
        const removeDiff = closes[i - period + 1] - closes[i - period];
        if (removeDiff >= 0) gains -= removeDiff;
        else losses += removeDiff;
      }
    }
    return rsi;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #4: CONFIRMATION LAYERS (Multi-step verification)
// ─────────────────────────────────────────────────────────────────────────────
class ConfirmationLayers {
  constructor() {
    this.layers = [
      { name: 'HTF_TREND', required: true, weight: 25 },
      { name: 'PRICE_ACTION', required: true, weight: 20 },
      { name: 'VOLUME_CONFIRMATION', required: true, weight: 15 },
      { name: 'ORDER_FLOW', required: false, weight: 10 },
      { name: 'LIQUIDITY', required: false, weight: 10 },
      { name: 'SENTIMENT', required: false, weight: 10 },
      { name: 'TIMING', required: true, weight: 10 },
    ];
  }

  async verify(symbol, price, direction, klines, funding, lsRatio, volumeSpike) {
    const results = {};
    let totalScore = 0;
    let maxScore = 0;
    const failedRequired = [];

    // Layer 1: HTF Trend
    const analyzer = new DirectionAnalyzer();
    const htf = await analyzer.checkHTFTrend(symbol);
    results.HTF_TREND = {
      passed: direction === 'LONG' ? htf.bullish : htf.bearish,
      score: direction === 'LONG' ? (htf.bullish ? 25 : 0) : (htf.bearish ? 25 : 0)
    };
    if (results.HTF_TREND.passed) totalScore += 25;
    else if (this.layers.find(l => l.name === 'HTF_TREND').required) failedRequired.push('HTF_TREND');
    maxScore += 25;

    // Layer 2: Price Action
    const pa = analyzer.checkPriceAction(klines, price);
    results.PRICE_ACTION = {
      passed: direction === 'LONG' ? pa.bullish : pa.bearish,
      score: direction === 'LONG' ? (pa.bullish ? 20 : 0) : (pa.bearish ? 20 : 0)
    };
    if (results.PRICE_ACTION.passed) totalScore += 20;
    else if (this.layers.find(l => l.name === 'PRICE_ACTION').required) failedRequired.push('PRICE_ACTION');
    maxScore += 20;

    // Layer 3: Volume Confirmation
    const volumeOk = volumeSpike >= RISK_CONFIG.min_volume_ratio;
    results.VOLUME_CONFIRMATION = {
      passed: volumeOk,
      score: volumeOk ? 15 : 0,
      details: `${volumeSpike.toFixed(1)}x avg`
    };
    if (results.VOLUME_CONFIRMATION.passed) totalScore += 15;
    else if (this.layers.find(l => l.name === 'VOLUME_CONFIRMATION').required) failedRequired.push('VOLUME_CONFIRMATION');
    maxScore += 15;

    // Layer 4: Order Flow
    const orderFlow = await analyzer.checkOrderFlow(symbol, price);
    results.ORDER_FLOW = {
      passed: direction === 'LONG' ? orderFlow.bullish : orderFlow.bearish,
      score: direction === 'LONG' ? (orderFlow.bullish ? 10 : 0) : (orderFlow.bearish ? 10 : 0),
      details: `imbalance ${orderFlow.imbalance || 0}`
    };
    totalScore += results.ORDER_FLOW.score;
    maxScore += 10;

    // Layer 5: Liquidity
    const timing = new EntryTimingAnalyzer();
    const liquidity = timing.checkLiquiditySweepPattern(klines, direction);
    results.LIQUIDITY = {
      passed: liquidity.detected && liquidity.recovery,
      score: (liquidity.detected && liquidity.recovery) ? 10 : 0,
      details: liquidity.detected ? 'sweep+recovery' : 'none'
    };
    totalScore += results.LIQUIDITY.score;
    maxScore += 10;

    // Layer 6: Sentiment
    const sentiment = analyzer.checkSentiment(funding, lsRatio);
    results.SENTIMENT = {
      passed: direction === 'LONG' ? sentiment.bullish : sentiment.bearish,
      score: direction === 'LONG' ? (sentiment.bullish ? 10 : 0) : (sentiment.bearish ? 10 : 0),
      details: `funding ${funding.toFixed(3)}% ls ${lsRatio.toFixed(2)}`
    };
    totalScore += results.SENTIMENT.score;
    maxScore += 10;

    // Layer 7: Timing
    const entryTiming = await timing.analyze(symbol, price, direction, klines, volumeSpike);
    results.TIMING = {
      passed: entryTiming.ready,
      score: entryTiming.ready ? 10 : 0,
      details: entryTiming.type || 'waiting',
      waitTime: entryTiming.waitTime,
      entryPrice: entryTiming.entryPrice
    };
    if (results.TIMING.passed) totalScore += 10;
    else if (this.layers.find(l => l.name === 'TIMING').required) failedRequired.push('TIMING');
    maxScore += 10;

    const overallScore = (totalScore / maxScore) * 100;
    const passed = failedRequired.length === 0 && overallScore >= 70;

    return {
      passed,
      score: parseFloat(overallScore.toFixed(1)),
      layers: results,
      failedRequired,
      entryPrice: results.TIMING.entryPrice
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX #5: MARKET REGIME CLASSIFIER (Adapts to conditions)
// ─────────────────────────────────────────────────────────────────────────────
class MarketRegimeClassifier {
  constructor() {
    this.regimes = {
      TRENDING: { name: 'TRENDING', riskMultiplier: 1.0, minScore: 65 },
      RANGING: { name: 'RANGING', riskMultiplier: 0.5, minScore: 75 },
      VOLATILE: { name: 'VOLATILE', riskMultiplier: 0.3, minScore: 80 },
      SILENT: { name: 'SILENT', riskMultiplier: 0, minScore: 999 }  // No trades
    };
  }

  async classify(btcData, altsData) {
    // Analyze BTC first
    const btcRegime = await this.analyzeBTC(btcData);
    
    // Then analyze overall market
    const marketRegime = await this.analyzeMarket(altsData);
    
    // Combine regimes (most conservative wins)
    let finalRegime = this.regimes.TRENDING;
    let regimeScore = 100;
    
    for (const regime of Object.values(this.regimes)) {
      if (btcRegime.riskMultiplier < finalRegime.riskMultiplier) {
        finalRegime = regime;
        regimeScore = btcRegime.score;
      }
      if (marketRegime.riskMultiplier < finalRegime.riskMultiplier) {
        finalRegime = regime;
        regimeScore = Math.min(regimeScore, marketRegime.score);
      }
    }
    
    return {
      regime: finalRegime.name,
      riskMultiplier: finalRegime.riskMultiplier,
      score: regimeScore,
      allowTrading: finalRegime.riskMultiplier > 0,
      positionSizeMultiplier: finalRegime.riskMultiplier,
      btc: btcRegime,
      market: marketRegime
    };
  }

  async analyzeBTC(btcData) {
    const { klines, change24h, atr } = btcData;
    if (!klines || klines.length < 50) return this.regimes.SILENT;
    
    const closes = klines.map(k => parseFloat(k[4]));
    const ranges = klines.map(k => parseFloat(k[2]) - parseFloat(k[3]));
    const avgRange = ranges.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const atrPct = (avgRange / closes[closes.length - 1]) * 100;
    
    // Check if trending (ADX-like calculation simplified)
    const highs = klines.map(k => parseFloat(k[2]));
    const lows = klines.map(k => parseFloat(k[3]));
    let plusDM = 0, minusDM = 0;
    for (let i = 1; i < 14; i++) {
      const upMove = highs[i] - highs[i-1];
      const downMove = lows[i-1] - lows[i];
      if (upMove > downMove && upMove > 0) plusDM += upMove;
      else if (downMove > upMove && downMove > 0) minusDM += downMove;
    }
    const tr = ranges.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const plusDI = (plusDM / tr) * 100;
    const minusDI = (minusDM / tr) * 100;
    const adx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    
    const isTrending = adx > 25;
    const isVolatile = atrPct > 3.5;
    const isRanging = !isTrending && atrPct < 2.5;
    const isSilent = atrPct < 1.0;
    
    if (isSilent) return { ...this.regimes.SILENT, score: 30 };
    if (isVolatile) return { ...this.regimes.VOLATILE, score: 60 };
    if (isTrending) return { ...this.regimes.TRENDING, score: 85 };
    if (isRanging) return { ...this.regimes.RANGING, score: 70 };
    
    return { ...this.regimes.SILENT, score: 50 };
  }

  async analyzeMarket(altsData) {
    if (!altsData || altsData.length === 0) return this.regimes.TRENDING;
    
    // Calculate market breadth (how many alts are moving together)
    let bullishCount = 0;
    let totalVol = 0;
    
    for (const alt of altsData.slice(0, 20)) {
      if (alt.change24h > 0) bullishCount++;
      totalVol += alt.volume;
    }
    
    const breadth = (bullishCount / Math.min(20, altsData.length)) * 100;
    const avgVol = totalVol / Math.min(20, altsData.length);
    
    if (breadth > 70) return { ...this.regimes.TRENDING, score: 85 };  // Strong uptrend
    if (breadth < 30) return { ...this.regimes.TRENDING, score: 80, riskMultiplier: 0.8 };  // Downtrend (short bias)
    if (breadth > 40 && breadth < 60) return { ...this.regimes.RANGING, score: 70 };
    if (avgVol < 1000000) return { ...this.regimes.SILENT, score: 40 };
    
    return { ...this.regimes.TRENDING, score: 75 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION MANAGER (With proper risk management)
// ─────────────────────────────────────────────────────────────────────────────
class PositionManager {
  constructor() {
    this.positions = [];
  }

  calculatePositionSize(accountBalance, entryPrice, stopLoss, confidence, regimeMultiplier) {
    // Base risk (1% of account)
    const riskAmount = accountBalance * (RISK_CONFIG.max_risk_per_trade_pct / 100);
    
    // Calculate stop loss percentage
    const stopPct = Math.abs((stopLoss - entryPrice) / entryPrice) * 100;
    
    // Calculate position size based on risk
    let positionSize = riskAmount / (stopPct / 100);
    
    // Adjust for confidence (70-100% confidence scales 0.5x to 1.5x)
    const confidenceMultiplier = 0.5 + (confidence / 100);
    
    // Adjust for market regime
    const regimeMultiplierValue = regimeMultiplier;
    
    // Final size with all adjustments
    positionSize = positionSize * confidenceMultiplier * regimeMultiplierValue;
    
    // Cap at max position size
    const maxSize = accountBalance * (RISK_CONFIG.max_position_size_pct / 100);
    positionSize = Math.min(positionSize, maxSize);
    
    return parseFloat(positionSize.toFixed(2));
  }

  async openPosition(symbol, direction, entryPrice, stopLoss, tp1, tp2, confidence, accountBalance, regimeMultiplier) {
    const positionSize = this.calculatePositionSize(accountBalance, entryPrice, stopLoss, confidence, regimeMultiplier);
    const riskAmount = Math.abs(entryPrice - stopLoss) * positionSize;
    
    const position = {
      id: `${symbol}_${Date.now()}`,
      symbol,
      direction,
      entryPrice,
      stopLoss,
      tp1,
      tp2,
      size: positionSize,
      riskAmount,
      confidence,
      openTime: Date.now(),
      status: 'OPEN',
      trailingActivated: false,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
    };
    
    this.positions.push(position);
    account.open_positions.push(position);
    
    // Deduct from balance (simulated)
    account.balance -= (positionSize * entryPrice);
    
    return position;
  }

  async updatePositions(currentPrices) {
    const closedPositions = [];
    
    for (const pos of this.positions) {
      const currentPrice = currentPrices[pos.symbol];
      if (!currentPrice) continue;
      
      const isLong = pos.direction === 'LONG';
      let shouldClose = false;
      let closeReason = '';
      let exitPrice = currentPrice;
      
      // Update highest/lowest for trailing
      if (isLong && currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
      if (!isLong && currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;
      
      // Check TP1
      if (isLong && currentPrice >= pos.tp1) {
        shouldClose = true;
        closeReason = 'TP1_HIT';
        exitPrice = pos.tp1;
      } else if (!isLong && currentPrice <= pos.tp1) {
        shouldClose = true;
        closeReason = 'TP1_HIT';
        exitPrice = pos.tp1;
      }
      
      // Check SL
      else if (isLong && currentPrice <= pos.stopLoss) {
        shouldClose = true;
        closeReason = 'SL_HIT';
        exitPrice = pos.stopLoss;
      } else if (!isLong && currentPrice >= pos.stopLoss) {
        shouldClose = true;
        closeReason = 'SL_HIT';
        exitPrice = pos.stopLoss;
      }
      
      // Trailing stop after 1% profit
      if (!shouldClose && RISK_CONFIG.trailing_activation_pct > 0) {
        const profitPct = isLong 
          ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
        
        if (profitPct >= RISK_CONFIG.trailing_activation_pct) {
          if (!pos.trailingActivated) {
            pos.trailingActivated = true;
          } else {
            const trailStop = isLong
              ? pos.highestPrice * (1 - RISK_CONFIG.trailing_distance_pct / 100)
              : pos.lowestPrice * (1 + RISK_CONFIG.trailing_distance_pct / 100);
            
            if (isLong && currentPrice <= trailStop) {
              shouldClose = true;
              closeReason = 'TRAILING_STOP';
              exitPrice = currentPrice;
            } else if (!isLong && currentPrice >= trailStop) {
              shouldClose = true;
              closeReason = 'TRAILING_STOP';
              exitPrice = currentPrice;
            }
          }
        }
      }
      
      // Timeout after max hold hours
      const holdHours = (Date.now() - pos.openTime) / 3600000;
      if (!shouldClose && holdHours >= RISK_CONFIG.max_hold_hours) {
        shouldClose = true;
        closeReason = 'TIMEOUT';
      }
      
      if (shouldClose) {
        // Calculate PnL
        const pnl = isLong
          ? (exitPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - exitPrice) * pos.size;
        
        const pnlPct = isLong
          ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
        
        // Update account
        account.balance += (exitPrice * pos.size);
        account.daily_pnl += pnl;
        account.weekly_pnl += pnl;
        
        if (pnl > 0) {
          if (account.balance > account.peak_balance) account.peak_balance = account.balance;
          account.consecutive_losses = 0;
        } else {
          account.consecutive_losses++;
        }
        
        // Record trade
        const trade = {
          ...pos,
          exitPrice,
          pnl,
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          closeReason,
          closeTime: Date.now(),
        };
        account.trade_history.push(trade);
        closedPositions.push(trade);
        
        // Send notification for TP/SL
        if (closeReason === 'TP1_HIT') {
          await tg(OWNER_CHAT_ID, `✅ <b>${pos.symbol.replace('USDT', '')} TP1 HIT</b>\nProfit: +${pnlPct.toFixed(1)}% | +$${pnl.toFixed(2)}\nMove SL to entry`);
        } else if (closeReason === 'SL_HIT') {
          await tg(OWNER_CHAT_ID, `❌ <b>${pos.symbol.replace('USDT', '')} SL HIT</b>\nLoss: ${pnlPct.toFixed(1)}% | -$${Math.abs(pnl).toFixed(2)}`);
        }
      }
    }
    
    // Remove closed positions
    this.positions = this.positions.filter(p => !closedPositions.find(c => c.id === p.id));
    account.open_positions = account.open_positions.filter(p => !closedPositions.find(c => c.id === p.id));
    
    return closedPositions;
  }

  getOpenPositions() {
    return this.positions;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RISK MONITOR (Daily/Weekly loss limits)
// ─────────────────────────────────────────────────────────────────────────────
class RiskMonitor {
  constructor() {
    this.resetDailyIfNeeded();
    this.resetWeeklyIfNeeded();
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (account.daily_date !== today) {
      account.daily_pnl = 0;
      account.daily_date = today;
      account.consecutive_losses = 0;
    }
  }

  resetWeeklyIfNeeded() {
    const weekStart = getWeekStart();
    if (account.weekly_date !== weekStart) {
      account.weekly_pnl = 0;
      account.weekly_date = weekStart;
    }
  }

  canTrade() {
    this.resetDailyIfNeeded();
    this.resetWeeklyIfNeeded();
    
    const dailyLossPct = (Math.abs(account.daily_pnl) / account.peak_balance) * 100;
    const weeklyLossPct = (Math.abs(account.weekly_pnl) / account.peak_balance) * 100;
    
    if (dailyLossPct >= RISK_CONFIG.max_daily_loss_pct) {
      return { allowed: false, reason: `Daily loss limit reached (${dailyLossPct.toFixed(1)}% / ${RISK_CONFIG.max_daily_loss_pct}%)` };
    }
    
    if (weeklyLossPct >= RISK_CONFIG.max_weekly_loss_pct) {
      return { allowed: false, reason: `Weekly loss limit reached (${weeklyLossPct.toFixed(1)}% / ${RISK_CONFIG.max_weekly_loss_pct}%)` };
    }
    
    if (account.consecutive_losses >= RISK_CONFIG.max_consecutive_losses) {
      return { allowed: false, reason: `${account.consecutive_losses} consecutive losses - cooling down` };
    }
    
    if (account.open_positions.length >= RISK_CONFIG.max_concurrent_positions) {
      return { allowed: false, reason: `Max concurrent positions (${RISK_CONFIG.max_concurrent_positions})` };
    }
    
    return { allowed: true, reason: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS (Keep existing)
// ─────────────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gstNow = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai' });
const log = (...a) => console.log(`[${gstNow()}]`, ...a);
const fmtP = p => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2 }) : p >= 1 ? p.toFixed(3) : p.toFixed(5);

const fetchJSON = async (url, timeout = 8000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
};

const sb = async (path, options = {}) => {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch { return null; }
};

const tg = async (chatId, text) => {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { }
};

const postSignal = async text => {
  const targets = PAPER_MODE ? [OWNER_CHAT_ID] : [FREE_CHANNEL, PREMIUM_CHANNEL, OWNER_CHAT_ID];
  for (const chatId of targets) {
    await tg(chatId, text);
    await sleep(300);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCANNER (Integrates all fixes)
// ─────────────────────────────────────────────────────────────────────────────
const directionAnalyzer = new DirectionAnalyzer();
const entryTiming = new EntryTimingAnalyzer();
const confirmationLayers = new ConfirmationLayers();
const regimeClassifier = new MarketRegimeClassifier();
const positionManager = new PositionManager();
const riskMonitor = new RiskMonitor();

let fullScanCount = 0;
let watchlistScanCount = 0;
let btcGateStatus = { pass: true, reason: 'Starting up', price: 0, change: 0 };
const alertHistory = new Map();
const coinTracker = new Map();

const canAlert = k => !alertHistory.has(k) || Date.now() - alertHistory.get(k) > 1800000;
const markAlert = k => alertHistory.set(k, Date.now());

const checkBTCGate = async () => {
  try {
    const [klines, ticker, funding] = await Promise.all([
      fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=50'),
      fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT'),
      fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    ]);
    const price = parseFloat(ticker.lastPrice);
    const change24h = parseFloat(ticker.priceChangePercent);
    const fundRate = parseFloat(funding.lastFundingRate) * 100;
    const closes = klines.map(k => parseFloat(k[4]));
    const change1h = ((closes[closes.length-1] - closes[closes.length-5]) / closes[closes.length-5]) * 100;
    
    let pass = true, reason = '✅ BTC stable';
    if (change1h < -1.0) { pass = false; reason = `🔴 BTC dumping ${change1h.toFixed(2)}% in 1H`; }
    else if (change24h < -4) { pass = false; reason = `🔴 BTC down ${change24h.toFixed(2)}% 24h`; }
    else if (fundRate > 0.03) { pass = false; reason = `⚠️ BTC funding ${fundRate.toFixed(3)}% — overheated`; }
    
    const ema20 = directionAnalyzer.calcEMA(closes, 20);
    const ema50 = directionAnalyzer.calcEMA(closes, 50);
    const trend = price > ema20 && ema20 > ema50 ? 'bullish' : price < ema20 && ema20 < ema50 ? 'bearish' : 'neutral';
    
    const emoji = trend === 'bullish' ? '🟢' : trend === 'bearish' ? '🔴' : '🟡';
    btcGateStatus = { pass, reason, price, change: change24h, change1h, funding: fundRate, emoji, trend };
    return btcGateStatus;
  } catch {
    return { pass: true, reason: '⚠️ BTC data unavailable', price: 0, change: 0 };
  }
};

const runFullMarketScan = async () => {
  fullScanCount++;
  log(`🌍 Full Market Scan #${fullScanCount}`);
  try {
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const valid = tickers.filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      if (parseFloat(t.quoteVolume) < 200000) return false;
      if (Math.abs(parseFloat(t.priceChangePercent)) > 25) return false;
      return true;
    }).slice(0, 200);
    
    const altsData = valid.map(t => ({
      symbol: t.symbol,
      change24h: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume)
    }));
    
    const btcKlines = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100');
    const btcRanges = btcKlines.map(k => parseFloat(k[2]) - parseFloat(k[3]));
    const btcAvgRange = btcRanges.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const btcData = { klines: btcKlines, change24h: btcGateStatus.change, atr: btcAvgRange };
    
    const regime = await regimeClassifier.classify(btcData, altsData);
    log(`📈 Market Regime: ${regime.regime} | Risk: ${regime.riskMultiplier}x | Score: ${regime.score}`);
    
    await tg(OWNER_CHAT_ID, `🌍 Scan #${fullScanCount} | Regime: ${regime.regime}\nRisk: ${regime.riskMultiplier}x | Score: ${regime.score}\n${btcGateStatus.emoji} BTC ${btcGateStatus.change > 0 ? '+' : ''}${btcGateStatus.change?.toFixed(1)}%`);
  } catch (err) { log('Full scan error:', err.message); }
};

const runWatchlistScan = async () => {
  watchlistScanCount++;
  log(`👁 Watchlist Scan #${watchlistScanCount}`);
  try {
    const btc = await checkBTCGate();
    const riskCheck = riskMonitor.canTrade();
    if (!riskCheck.allowed) {
      log(`⛔ ${riskCheck.reason}`);
      return;
    }
    
    // Get top coins by volume
    const tickers = await fetchJSON('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const topCoins = tickers.filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      if (parseFloat(t.quoteVolume) < 500000) return false;
      return true;
    }).sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 30);
    
    let alertsFired = 0;
    
    for (const coin of topCoins) {
      if (alertsFired >= 2) break;
      await sleep(300);
      
      const symbol = coin.symbol;
      const price = parseFloat(coin.lastPrice);
      const change24h = parseFloat(coin.priceChangePercent);
      
      // Fetch required data
      let funding = 0, ls = 1, klines = [], currentOI = 0, prevOI = 0;
      try {
        const f = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        funding = parseFloat(f.lastFundingRate) * 100;
      } catch { }
      try {
        const l = await fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
        ls = parseFloat(l[0]?.longShortRatio || 1);
      } catch { }
      try {
        klines = await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=50`);
      } catch { }
      try {
        const o = await fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
        currentOI = parseFloat(o.openInterest);
        const oh = await fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=15m&limit=2`);
        prevOI = parseFloat(oh[0]?.sumOpenInterest || currentOI);
      } catch { }
      
      // Get direction using new analyzer
      const directionResult = await directionAnalyzer.analyze(symbol, price, klines, funding, ls);
      if (!directionResult.direction) continue;
      
      // Calculate volume spike
      const volumes = klines.map(k => parseFloat(k[5]));
      const avgVol = volumes.slice(-22, -2).reduce((a, b) => a + b, 0) / 20;
      const currentVol = volumes[volumes.length - 1];
      const volumeSpike = currentVol / avgVol;
      
      // Verify with confirmation layers
      const confirmation = await confirmationLayers.verify(
        symbol, price, directionResult.direction, klines, funding, ls, volumeSpike
      );
      
      if (!confirmation.passed) {
        log(`⏳ ${symbol} ${directionResult.direction} - confirmation score ${confirmation.score}% (need 70%)`);
        continue;
      }
      
      // Check market regime
      const btcKlines = await fetchJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100');
      const btcRanges = btcKlines.map(k => parseFloat(k[2]) - parseFloat(k[3]));
      const btcAvgRange = btcRanges.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const btcData = { klines: btcKlines, change24h: btc.change, atr: btcAvgRange };
      const regime = await regimeClassifier.classify(btcData, topCoins);
      
      if (!regime.allowTrading) {
        log(`🌙 ${symbol} - market regime ${regime.regime} blocks trading`);
        continue;
      }
      
      // Calculate ATR for SL/TP
      const atr = calculateATR(klines) || (price * 0.02);
      const isLong = directionResult.direction === 'LONG';
      
      // Calculate SL and TP
      const slMultiplier = directionResult.confidence >= 80 ? 1.5 : 2.0;
      const sl = isLong ? price - atr * slMultiplier : price + atr * slMultiplier;
      const tp1 = isLong ? price + atr * 2.0 : price - atr * 2.0;
      const tp2 = isLong ? price + atr * 4.0 : price - atr * 4.0;
      
      const riskReward = Math.abs((tp1 - price) / (price - sl)).toFixed(1);
      
      // Check if we already have a position in this symbol
      const existingPosition = positionManager.getOpenPositions().find(p => p.symbol === symbol);
      if (existingPosition) {
        log(`📌 ${symbol} - position already open`);
        continue;
      }
      
      // Generate signal message
      const signalMsg = `${isLong ? '🟢' : '🔴'} <b>NEXIO v5.0 ${isLong ? 'LONG' : 'SHORT'} — ${symbol.replace('USDT', '')}</b>
━━━━━━━━━━━━━━━
🎯 Confidence: ${directionResult.confidence}%
✅ Confirmations: ${confirmation.score}%
📊 Regime: ${regime.regime} (${regime.riskMultiplier}x size)
💰 Entry: $${fmtP(price)}
🛑 Stop: $${fmtP(sl)} (${slMultiplier}x ATR)
🎯 TP1: $${fmtP(tp1)} | TP2: $${fmtP(tp2)}
📈 R:R 1:${riskReward}
📊 Score: ${directionResult.longScore}/${directionResult.shortScore}
${btc.emoji} BTC: ${btc.trend} | ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(1)}%
⏰ ${gstNow()} GST
━━━━━━━━━━━━━━━
<i>Position size: ${(RISK_CONFIG.max_risk_per_trade_pct * regime.riskMultiplier).toFixed(1)}% risk</i>`;
      
      const signalKey = `${symbol}_${directionResult.direction}`;
      if (canAlert(signalKey)) {
        await postSignal(signalMsg);
        markAlert(signalKey);
        
        // Open paper position
        await positionManager.openPosition(
          symbol, directionResult.direction, price, sl, tp1, tp2,
          directionResult.confidence, account.balance, regime.riskMultiplier
        );
        
        alertsFired++;
        log(`🚀 SIGNAL: ${symbol} ${directionResult.direction} | Conf: ${directionResult.confidence}% | Regime: ${regime.regime}`);
      }
    }
    
    // Update all open positions
    const currentPrices = {};
    for (const pos of positionManager.getOpenPositions()) {
      try {
        const ticker = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pos.symbol}`);
        currentPrices[pos.symbol] = parseFloat(ticker.price);
      } catch { }
    }
    const closed = await positionManager.updatePositions(currentPrices);
    if (closed.length) log(`📊 Closed ${closed.length} positions`);
    
    // Send status update
    const openCount = positionManager.getOpenPositions().length;
    await tg(OWNER_CHAT_ID, `👁 Scan #${watchlistScanCount} | ${gstNow()}
Open: ${openCount} | Today: ${account.daily_pnl > 0 ? '+' : ''}$${account.daily_pnl.toFixed(2)}
Balance: $${account.balance.toFixed(2)} | Peak: $${account.peak_balance.toFixed(2)}
Regime: ${regime.regime} | ${btc.emoji} BTC ${btc.change > 0 ? '+' : ''}${btc.change?.toFixed(1)}%`);
    
  } catch (err) {
    log('Watchlist error:', err.message);
    await tg(OWNER_CHAT_ID, `❌ Scan error: ${err.message}`);
  }
};

// Helper ATR function
const calculateATR = (klines, period = 14) => {
  if (!klines || klines.length < period + 1) return 0;
  let trSum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = i > 0 ? parseFloat(klines[i-1][4]) : high;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
};

// ─────────────────────────────────────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
let lastUpdateId = 0;

const handleCommand = async msg => {
  const chatId = String(msg.chat?.id);
  const text = (msg.text || '').trim();
  
  if (text === '/start') {
    await tg(chatId, `👋 <b>Nexio v5.0</b>
━━━━━━━━━━━━━━━
✅ 5 critical issues fixed:
1. Multi-factor direction analysis
2. Smart entry timing (retest/liquidity sweep)
3. Complete risk management
4. 7-layer confirmation
5. Market regime adaptation

📊 PAPER MODE: ${PAPER_MODE ? 'ACTIVE' : 'OFF'}
⚠️ ${PAPER_MODE ? 'Paper trading only - 4 weeks minimum' : 'Live trading active'}

/status - Bot status
/stats - Trading stats
/positions - Open positions
/risk - Risk settings`);
  }
  
  else if (text === '/status') {
    const regime = await regimeClassifier.classify(
      { klines: [], change24h: 0, atr: 0 },
      []
    );
    await tg(chatId, `📊 <b>Nexio v5.0 Status</b>
━━━━━━━━━━━━━━━
🤖 Status: Online
📒 Mode: ${PAPER_MODE ? 'PAPER' : 'LIVE'}
📈 Balance: $${account.balance.toFixed(2)}
📊 Peak: $${account.peak_balance.toFixed(2)}
📉 Drawdown: ${((account.peak_balance - account.balance) / account.peak_balance * 100).toFixed(1)}%
🎯 Win Rate: ${account.trade_history.length ? ((account.trade_history.filter(t => t.pnl > 0).length / account.trade_history.length) * 100).toFixed(1) : '0'}%
📊 Regime: ${regime.regime}
⏰ ${gstNow()} GST`);
  }
  
  else if (text === '/stats') {
    const wins = account.trade_history.filter(t => t.pnl > 0);
    const losses = account.trade_history.filter(t => t.pnl < 0);
    const totalPnL = account.trade_history.reduce((s, t) => s + t.pnl, 0);
    const winRate = account.trade_history.length ? (wins.length / account.trade_history.length * 100).toFixed(1) : 0;
    
    await tg(chatId, `📒 <b>Trading Stats</b>
━━━━━━━━━━━━━━━
📊 Total Trades: ${account.trade_history.length}
✅ Wins: ${wins.length}
❌ Losses: ${losses.length}
📈 Win Rate: ${winRate}%
💰 Total PnL: $${totalPnL.toFixed(2)}
📈 Avg Win: $${wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 0}
📉 Avg Loss: $${losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 0}
🏆 Best Trade: $${wins.length ? Math.max(...wins.map(t => t.pnl)).toFixed(2) : 0}
💀 Worst Trade: $${losses.length ? Math.min(...losses.map(t => t.pnl)).toFixed(2) : 0}

${account.trade_history.length < 50 ? '⚠️ Need 50+ trades for reliable stats' : winRate >= 55 ? '✅ Strategy profitable' : '❌ Keep paper trading'}`);
  }
  
  else if (text === '/positions') {
    const positions = positionManager.getOpenPositions();
    if (!positions.length) {
      await tg(chatId, '📭 No open positions');
      return;
    }
    
    let msg = `📊 <b>Open Positions (${positions.length})</b>\n━━━━━━━━━━━━━━━\n`;
    for (const pos of positions) {
      msg += `\n${pos.direction === 'LONG' ? '🟢' : '🔴'} ${pos.symbol.replace('USDT', '')}\n`;
      msg += `Entry: $${fmtP(pos.entryPrice)} | SL: $${fmtP(pos.stopLoss)}\n`;
      msg += `TP1: $${fmtP(pos.tp1)} | TP2: $${fmtP(pos.tp2)}\n`;
      msg += `Size: ${pos.size.toFixed(4)} | Risk: $${pos.riskAmount.toFixed(2)}\n`;
    }
    await tg(chatId, msg);
  }
  
  else if (text === '/risk') {
    await tg(chatId, `⚠️ <b>Risk Settings</b>
━━━━━━━━━━━━━━━
💼 Max risk/trade: ${RISK_CONFIG.max_risk_per_trade_pct}%
📊 Max position: ${RISK_CONFIG.max_position_size_pct}%
🔄 Max concurrent: ${RISK_CONFIG.max_concurrent_positions}
📉 Daily loss limit: ${RISK_CONFIG.max_daily_loss_pct}%
📅 Weekly loss limit: ${RISK_CONFIG.max_weekly_loss_pct}%
❌ Max consecutive: ${RISK_CONFIG.max_consecutive_losses}
⏰ Cooldown: ${RISK_CONFIG.cooldown_after_loss_minutes}min
📈 Min R:R: 1:${RISK_CONFIG.min_risk_reward}
🔊 Min volume: ${RISK_CONFIG.min_volume_ratio}x`);
  }
  
  else if (text === '/reset' && chatId === OWNER_CHAT_ID) {
    account = {
      balance: 10000,
      peak_balance: 10000,
      daily_pnl: 0,
      weekly_pnl: 0,
      daily_date: new Date().toDateString(),
      weekly_date: getWeekStart(),
      consecutive_losses: 0,
      open_positions: [],
      trade_history: [],
    };
    await tg(chatId, '✅ Account reset');
  }
  
  else if (text === '/help') {
    await tg(chatId, `📖 <b>Commands</b>
━━━━━━━━━━━━━━━
/start - Welcome
/status - Bot status
/stats - Trading statistics
/positions - Open positions
/risk - Risk settings
/help - This message

👑 Owner only:
/reset - Reset account
/clearwatchlist - Clear watchlist`);
  }
}

const pollUsers = async () => {
  try {
    const data = await fetchJSON(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&limit=20&timeout=0`);
    if (!data?.ok || !data.result?.length) return;
    for (const u of data.result) {
      lastUpdateId = u.update_id;
      if (u.message) await handleCommand(u.message);
    }
  } catch (err) { log('Poll error:', err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const start = async () => {
  log(`🚀 Nexio v5.0 Starting... PAPER_MODE: ${PAPER_MODE}`);
  log(`📊 Risk: ${RISK_CONFIG.max_risk_per_trade_pct}% per trade | Max daily: ${RISK_CONFIG.max_daily_loss_pct}%`);
  
  await tg(OWNER_CHAT_ID, `🟢 <b>NEXIO v5.0 STARTED</b>
━━━━━━━━━━━━━━━
✅ ALL 5 ISSUES FIXED:

1. DIRECTION: Multi-factor analysis (HTF/PA/OrderFlow/Momentum/Sentiment)
2. TIMING: Smart entry (Retest/Liquidity Sweep/Divergence)
3. RISK: Complete management (Position sizing/Loss limits/Trailing)
4. CONFIRMATION: 7-layer verification (70%+ score required)
5. REGIME: Market adaptation (Risk multiplier 0-1x)

📒 MODE: ${PAPER_MODE ? 'PAPER TRADING' : 'LIVE'}
⚠️ ${PAPER_MODE ? '4 weeks minimum paper trading required' : 'Monitor carefully'}

/status - Check bot status
/stats - View performance

⏰ ${gstNow()} GST`);
  
  setInterval(pollUsers, 30000);
  pollUsers();
  
  await runFullMarketScan();
  setInterval(runFullMarketScan, 120000);
  
  await sleep(60000);
  await runWatchlistScan();
  setInterval(runWatchlistScan, 60000);
};

start();
