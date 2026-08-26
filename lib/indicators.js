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
  slope,
  last,
};
