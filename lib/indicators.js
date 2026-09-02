'use strict';

// ---------------------------------------------------------------------------
// Pure technical-indicator math. Every function is deterministic, side-effect
// free, and returns null / an all-null series when there is not enough data —
// never NaN, never a partial guess. Candle objects are { time, open, high,
// low, close } with numeric OHLC.
// ---------------------------------------------------------------------------

/** Simple moving average series, null until `period` values exist. */
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average series, SMA-seeded at index `period - 1`.
 * Matches how TradingView / broker platforms report EMA.
 */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);

/** Wilder RSI series. out[i] is null until i >= period. */
function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  const toRsi = (avgGain, avgLoss) => {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

/** True range array. trs[i] corresponds to candles[i + 1]. */
function trueRanges(candles) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close),
    ));
  }
  return trs;
}

/** Wilder ATR series, aligned to `candles` indices (out[period] is the seed). */
function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const trs = trueRanges(candles);
  if (trs.length < period) return out;
  let avg = 0;
  for (let i = 0; i < period; i++) avg += trs[i];
  avg /= period;
  out[period] = avg; // trs[0..period-1] cover candles[1..period]
  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]) / period;
    out[i + 1] = avg;
  }
  return out;
}

/**
 * Wilder ADX with directional indicators. Returns the latest
 * { adx, plusDI, minusDI } or null when there is not enough history
 * (needs ~2*period bars for the ADX itself to be smoothed).
 */
function adxLatest(candles, period = 14) {
  const n = candles.length;
  if (n < 2 * period + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 0; i < period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dx = [];
  let lastPlusDI = 0, lastMinusDI = 0;
  const step = () => {
    lastPlusDI = trS === 0 ? 0 : (100 * pS) / trS;
    lastMinusDI = trS === 0 ? 0 : (100 * mS) / trS;
    const sum = lastPlusDI + lastMinusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(lastPlusDI - lastMinusDI)) / sum);
  };
  step();
  for (let i = period; i < tr.length; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    step();
  }
  if (dx.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i];
  adx /= period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return { adx, plusDI: lastPlusDI, minusDI: lastMinusDI };
}

/** MACD. Returns latest values plus a one-bar-back look for crossover detection. */
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(values, fast);
  const emaSlow = emaSeries(values, slow);
  const macdLine = [];
  for (let i = 0; i < values.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine.push(emaFast[i] - emaSlow[i]);
  }
  if (macdLine.length < signalPeriod + 2) return null;
  const signalCompact = emaSeries(macdLine, signalPeriod);
  const n = macdLine.length;
  const macdNow = macdLine[n - 1];
  const macdPrev = macdLine[n - 2];
  const signalNow = signalCompact[n - 1];
  const signalPrev = signalCompact[n - 2];
  if (signalNow == null || signalPrev == null) return null;
  const histNow = macdNow - signalNow;
  const histPrev = macdPrev - signalPrev;
  return {
    macd: macdNow,
    signal: signalNow,
    histogram: histNow,
    histogramPrev: histPrev,
    crossUp: histPrev <= 0 && histNow > 0,
    crossDown: histPrev >= 0 && histNow < 0,
    rising: histNow > histPrev,
  };
}

/** Bollinger Bands (SMA basis ± mult·stdev) — latest only. */
function bollinger(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  const basisSeries = smaSeries(values, period);
  const i = values.length - 1;
  const basis = basisSeries[i];
  if (basis == null) return null;
  let sq = 0;
  for (let j = i - period + 1; j <= i; j++) sq += (values[j] - basis) ** 2;
  const sd = Math.sqrt(sq / period);
  return { basis, upper: basis + mult * sd, lower: basis - mult * sd, bandwidth: (2 * mult * sd) / basis };
}

/**
 * Fractal swing pivots. A pivot high/low is strictly the most extreme candle
 * among `wing` neighbours on each side. The last `wing` candles are never
 * pivots (not yet confirmed). Returns chronological arrays.
 */
function swings(candles, wing = 2) {
  const highs = [], lows = [];
  for (let i = wing; i < candles.length - wing; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ idx: i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

/**
 * Market structure read from the last two confirmed swing highs & lows:
 *  - trend: UP (HH+HL) / DOWN (LH+LL) / RANGE
 *  - bos:   last close broke structure in the trend direction (continuation)
 *  - choch: last close broke structure against the trend (early reversal)
 */
function marketStructure(candles, wing = 2) {
  const { highs, lows } = swings(candles, wing);
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;
  if (highs.length < 2 || lows.length < 2) {
    return { trend: 'RANGE', bos: null, choch: null, lastHigh, lastLow };
  }
  const h1 = highs[highs.length - 1], h2 = highs[highs.length - 2];
  const l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
  const up = h1.price > h2.price && l1.price > l2.price;
  const down = h1.price < h2.price && l1.price < l2.price;
  const trend = up ? 'UP' : down ? 'DOWN' : 'RANGE';
  const close = candles[candles.length - 1].close;
  let bos = null, choch = null;
  if (close > h1.price) {
    if (trend === 'DOWN') choch = 'UP'; else bos = 'UP';
  } else if (close < l1.price) {
    if (trend === 'UP') choch = 'DOWN'; else bos = 'DOWN';
  }
  return { trend, bos, choch, lastHigh: h1, lastLow: l1 };
}

// --- Price-action primitives -------------------------------------------------

/** Bullish rejection candle: a hammer/pin bar (long lower wick, close in the
 *  top third) or a bullish engulfing that closes strongly. `prev` may be null. */
function isBullishRejection(prev, cur) {
  const range = cur.high - cur.low;
  if (!(range > 0)) return false;
  const body = Math.abs(cur.close - cur.open);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const closeInTopThird = cur.close >= cur.low + range * 0.66;
  const pin = lowerWick >= range * 0.5 && body <= range * 0.4 && upperWick <= range * 0.25 && closeInTopThird;
  const engulf = !!prev && prev.close < prev.open && cur.close > cur.open
    && cur.close >= prev.open && cur.open <= prev.close && body > 0
    && cur.close >= cur.low + range * 0.6;
  return pin || engulf;
}

/** Bearish rejection candle: shooting star / bearish engulfing, close in the
 *  bottom third. */
function isBearishRejection(prev, cur) {
  const range = cur.high - cur.low;
  if (!(range > 0)) return false;
  const body = Math.abs(cur.close - cur.open);
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const closeInBottomThird = cur.close <= cur.high - range * 0.66;
  const pin = upperWick >= range * 0.5 && body <= range * 0.4 && lowerWick <= range * 0.25 && closeInBottomThird;
  const engulf = !!prev && prev.close > prev.open && cur.close < cur.open
    && cur.open >= prev.close && cur.close <= prev.open && body > 0
    && cur.close <= cur.high - range * 0.6;
  return pin || engulf;
}

/**
 * Support/resistance ZONES: swing pivots (and any extra levels passed in)
 * clustered by proximity. A zone tested by more pivots is a stronger level.
 * Returns [{ mid, touches, lo, hi }] sorted low→high.
 */
function srZones(candles, wing = 2, tol = 0, extraLevels = []) {
  const { highs, lows } = swings(candles, wing);
  const raw = [
    ...highs.map(h => h.price),
    ...lows.map(l => l.price),
    ...extraLevels.filter(v => isFinite(v)),
  ].sort((a, b) => a - b);
  if (!raw.length) return [];
  if (!(tol > 0)) {
    // default tolerance: 0.15% of the mid price
    tol = raw[Math.floor(raw.length / 2)] * 0.0015;
  }
  const zones = [];
  for (const p of raw) {
    const z = zones[zones.length - 1];
    if (z && p - z.hi <= tol) {
      z.prices.push(p);
      z.hi = p;
      z.mid = z.prices.reduce((s, v) => s + v, 0) / z.prices.length;
      z.touches = z.prices.length;
    } else {
      zones.push({ prices: [p], lo: p, hi: p, mid: p, touches: 1 });
    }
  }
  return zones.map(z => ({ mid: z.mid, touches: z.touches, lo: z.lo, hi: z.hi }));
}

/**
 * Prior completed UTC-day high / low / close from a candle series whose
 * `time` is "YYYY-MM-DD HH:MM:SS" (UTC). Returns null if fewer than 2 days
 * of data are present.
 */
function priorDayLevels(candles) {
  const dayOf = t => String(t).slice(0, 10);
  const byDay = new Map();
  for (const c of candles) {
    const d = dayOf(c.time);
    let g = byDay.get(d);
    if (!g) { g = { high: c.high, low: c.low, close: c.close, lastTime: c.time }; byDay.set(d, g); }
    else {
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      if (c.time >= g.lastTime) { g.close = c.close; g.lastTime = c.time; }
    }
  }
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return null;
  const prev = byDay.get(days[days.length - 2]);
  return { high: prev.high, low: prev.low, close: prev.close, day: days[days.length - 2] };
}

/**
 * Most recent break of structure and whether it has been retested.
 *  - finds the latest confirmed swing that a subsequent close broke through
 *  - `bos`: 'UP' | 'DOWN' | null (the direction of that break)
 *  - `level`: the swing price that was broken (becomes S/R after the break)
 *  - `barsSinceBreak`: bars since the breaking candle
 *  - `retest`: since the break, price has traded back to within `tol` of the
 *    level and the latest close is back on the breakout side
 *  Only breaks within `recent` bars count (older ones are stale).
 */
function breakAndRetest(candles, wing = 2, tolPct = 0.0012, recent = 12) {
  const { highs, lows } = swings(candles, wing);
  const n = candles.length;
  const closeNow = candles[n - 1].close;
  let best = { bos: null, level: null, barsSinceBreak: null, retest: false };
  let bestBreakIdx = -1;

  const consider = (swing, dir) => {
    for (let i = swing.idx + 1; i < n; i++) {
      const broke = dir === 'UP' ? candles[i].close > swing.price : candles[i].close < swing.price;
      if (broke) {
        if (i > bestBreakIdx) {
          const barsSince = n - 1 - i;
          if (barsSince > recent) return;
          const after = candles.slice(i + 1);
          const tol = swing.price * tolPct;
          const cameBack = after.some(c => (dir === 'UP' ? c.low <= swing.price + tol : c.high >= swing.price - tol));
          const heldSide = dir === 'UP' ? closeNow >= swing.price : closeNow <= swing.price;
          bestBreakIdx = i;
          best = { bos: dir, level: swing.price, barsSinceBreak: barsSince, retest: cameBack && heldSide && barsSince >= 1 };
        }
        return;
      }
    }
  };
  for (let h = highs.length - 1; h >= 0 && h >= highs.length - 4; h--) consider(highs[h], 'UP');
  for (let l = lows.length - 1; l >= 0 && l >= lows.length - 4; l--) consider(lows[l], 'DOWN');
  return best;
}

/** Linear-regression slope of the last `lookback` values, per bar. */
function slope(series, lookback) {
  const vals = series.filter(v => v != null).slice(-lookback);
  const n = vals.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += vals[i]; sxy += i * vals[i]; sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

module.exports = {
  smaSeries,
  emaSeries,
  rsiSeries,
  trueRanges,
  atrSeries,
  adxLatest,
  macd,
  bollinger,
  swings,
  marketStructure,
  isBullishRejection,
  isBearishRejection,
  breakAndRetest,
  srZones,
  priorDayLevels,
  slope,
  last,
};
