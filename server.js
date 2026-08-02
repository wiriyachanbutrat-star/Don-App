require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const MARKETAUX_API_KEY = process.env.MARKETAUX_API_KEY;
const CLAUDE_MODEL = 'claude-opus-5';

const ASSETS = {
  XAU: { symbol: 'XAU/USD', label: 'ทองคำ (XAUUSD)' },
  BTC: { symbol: 'BTC/USD', label: 'บิตคอยน์ (BTCUSD)' },
};

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'gold.html'));
});

async function fetchTwelveData(path, params) {
  const url = new URL(`https://api.twelvedata.com/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('apikey', TWELVE_DATA_API_KEY);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.status === 'error') {
    throw new Error(data.message || `เรียกข้อมูล ${path} ไม่สำเร็จ`);
  }
  return data;
}

// Marketaux free tier is rate-limited, and gold-moving news doesn't change
// minute-to-minute, so cache per asset for a few minutes instead of calling
// on every /api/analyze request.
const newsCache = new Map();
const NEWS_CACHE_MS = 5 * 60 * 1000;

const NEWS_QUERY = {
  XAU: { symbol: 'XAU/USD', search: 'gold OR XAUUSD OR "Federal Reserve"' },
  BTC: { symbol: 'BTC/USD', search: 'bitcoin OR BTCUSD OR crypto' },
};

async function fetchGoldNews(assetKey) {
  if (!MARKETAUX_API_KEY) return [];

  const cached = newsCache.get(assetKey);
  if (cached && Date.now() - cached.time < NEWS_CACHE_MS) return cached.articles;

  const { symbol: symbols, search } = NEWS_QUERY[assetKey] || NEWS_QUERY.XAU;
  const url = new URL('https://api.marketaux.com/v1/news/all');
  url.searchParams.set('search', search);
  url.searchParams.set('filter_entities', 'true');
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', '8');
  url.searchParams.set('sort', 'published_desc');
  url.searchParams.set('api_token', MARKETAUX_API_KEY);

  try {
    const res = await fetch(url);
    const data = await res.json();
    const articles = (data.data || []).map(a => ({
      title: a.title,
      published: a.published_at,
      source: a.source,
      sentiment: a.entities?.find(e => e.symbol === symbols)?.sentiment_score ?? null,
    }));
    newsCache.set(assetKey, { time: Date.now(), articles });
    return articles;
  } catch (err) {
    console.error('fetchGoldNews failed', err);
    return cached ? cached.articles : [];
  }
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(values.length).fill(null);
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 21) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Same Wilder smoothing as rsi() above, but returns the full rolling series
// (one value per bar once enough history exists) instead of just the latest
// value — used for sparkline tiles on the dashboard.
function rsiSeries(closes, period = 21) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdValues = macdLine.filter(v => v != null);
  const signalSeries = ema(macdValues, 9);
  const signal = signalSeries[signalSeries.length - 1];
  const macdNow = macdValues[macdValues.length - 1];
  const histogram = macdNow - signal;
  // Crossover (not just sign) needs the previous bar's histogram — a signal
  // that's been positive for 20 bars isn't a "cross up", it's just trending.
  const signalPrev = signalSeries[signalSeries.length - 2];
  const macdPrev = macdValues[macdValues.length - 2];
  const histogramPrev = (macdPrev != null && signalPrev != null) ? macdPrev - signalPrev : null;
  const crossUp = histogramPrev != null && histogramPrev <= 0 && histogram > 0;
  const crossDown = histogramPrev != null && histogramPrev >= 0 && histogram < 0;
  // Histogram sparkline series, aligned to macdValues' own index space (both
  // built from the same filtered array so indices line up 1:1).
  const histogramSeries = macdValues.map((v, i) => (signalSeries[i] != null) ? v - signalSeries[i] : null);
  return { macd: macdNow, signal, histogram, crossUp, crossDown, histogramSeries };
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  const relevant = trs.slice(-period);
  return relevant.reduce((a, b) => a + b, 0) / relevant.length;
}

// Rolling Wilder-smoothed ATR (one value per bar) instead of just the latest
// average — used for the ATR sparkline tile on the dashboard.
function atrSeries(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  if (trs.length < period) return out;
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = avg;
  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]) / period;
    out[i + 1] = avg;
  }
  return out;
}

// ADX measures trend *strength* (not direction) — low ADX means the market is
// choppy/sideways, which is exactly when trend-following indicators (EMA/MACD/
// HTF trend, all used above) whipsaw and produce losing signals.
function adx(candles, period = 14) {
  if (candles.length < period * 2) return null;
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  let trSum = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDMSum = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDMSum = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxValues = [];
  for (let i = period; i < trs.length; i++) {
    trSum = trSum - trSum / period + trs[i];
    plusDMSum = plusDMSum - plusDMSum / period + plusDMs[i];
    minusDMSum = minusDMSum - minusDMSum / period + minusDMs[i];
    const plusDI = trSum > 0 ? (plusDMSum / trSum) * 100 : 0;
    const minusDI = trSum > 0 ? (minusDMSum / trSum) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }
  if (dxValues.length < period) return null;
  // Wilder-smoothed ADX: seed with a simple average of the first `period` DX
  // values, then recursively smooth every value after that — a plain SMA of
  // only the last `period` DX values ignores all history before that window
  // and gives a materially different number from the ADX(14) any broker or
  // charting platform reports, which threw off the ADX trade-gate threshold.
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
  }
  return adxVal;
}

// Swing high/low (fractal pivots): a candle whose high/low is the most extreme
// among `wing` candles on either side. Distinct from resistance/support (which
// is just the 30-candle max/min) because it tracks confirmed turning points
// used for reading market structure (HH/HL/LH/LL) rather than a flat range.
function swingPoints(candles, wing = 3) {
  let swingHigh = null, swingLow = null;
  for (let i = candles.length - 1 - wing; i >= wing; i--) {
    const c = candles[i];
    if (swingHigh === null) {
      const isHigh = candles.slice(i - wing, i).every(o => o.high <= c.high)
        && candles.slice(i + 1, i + wing + 1).every(o => o.high <= c.high);
      if (isHigh) swingHigh = { price: c.high, time: c.time, barsAgo: candles.length - 1 - i };
    }
    if (swingLow === null) {
      const isLow = candles.slice(i - wing, i).every(o => o.low >= c.low)
        && candles.slice(i + 1, i + wing + 1).every(o => o.low >= c.low);
      if (isLow) swingLow = { price: c.low, time: c.time, barsAgo: candles.length - 1 - i };
    }
    if (swingHigh !== null && swingLow !== null) break;
  }
  return { high: swingHigh, low: swingLow };
}

function stochasticOscillator(candles, period = 14, smoothK = 3) {
  const kValues = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map(c => c.high));
    const lowest = Math.min(...window.map(c => c.low));
    const close = candles[i].close;
    const k = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }
  const kSmoothed = sma(kValues, smoothK);
  const validK = kSmoothed.filter(v => v != null);
  const dValues = sma(validK, smoothK);
  const k = validK[validK.length - 1];
  const d = dValues[dValues.length - 1];
  const kPrev = validK[validK.length - 2];
  const dPrev = dValues[dValues.length - 2];
  // "Crossed up from oversold" needs the crossover to actually happen near the
  // <20 zone, not just %K>%D anywhere in the 20-80 range.
  const crossUpFromOversold = kPrev != null && dPrev != null && kPrev <= dPrev && k > d && kPrev < 25;
  const crossDownFromOverbought = kPrev != null && dPrev != null && kPrev >= dPrev && k < d && kPrev > 75;
  return { k, d, crossUpFromOversold, crossDownFromOverbought };
}

// Supertrend: ATR-banded trend flip indicator. Flips to "up" when close closes
// above the running upper band, "down" when it closes below the running lower
// band; otherwise the previous trend and band carry forward.
function supertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i - 1];
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
  }
  let trend = 'up';
  let finalUpper = null, finalLower = null;
  for (let i = period; i < candles.length; i++) {
    const atrSlice = trs.slice(i - period, i);
    const atrVal = atrSlice.reduce((a, b) => a + b, 0) / period;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    let basicUpper = mid + multiplier * atrVal;
    let basicLower = mid - multiplier * atrVal;
    if (finalUpper == null) { finalUpper = basicUpper; finalLower = basicLower; }
    else {
      finalUpper = (basicUpper < finalUpper || candles[i - 1].close > finalUpper) ? basicUpper : finalUpper;
      finalLower = (basicLower > finalLower || candles[i - 1].close < finalLower) ? basicLower : finalLower;
    }
    if (trend === 'up' && c.close < finalLower) trend = 'down';
    else if (trend === 'down' && c.close > finalUpper) trend = 'up';
  }
  return { trend, value: trend === 'up' ? finalLower : finalUpper };
}

// Market structure via multiple fractal swing points (not just the single
// nearest one swingPoints() returns): tags the trend as HH/HL (up) or LH/LL
// (down) from the last two swing highs/lows, then flags a break relative to
// the most recent opposing swing — BOS (break of structure, continuation) if
// the break is in the direction of that trend, CHoCH (change of character,
// possible reversal) if the price broke the swing on the *other* side.
function structureBreak(candles, wing = 3, maxPoints = 4, lookback = 80) {
  // Bounded to a recent window (like orderBlocksAndFvg's lookback=30) —
  // without this the fractal scan could walk all the way back to the start
  // of the whole fetched series and call decade-old (in candle terms) swings
  // "recent market structure".
  candles = candles.slice(-lookback);
  const highs = [], lows = [];
  for (let i = candles.length - 1 - wing; i >= wing && (highs.length < maxPoints || lows.length < maxPoints); i--) {
    const c = candles[i];
    if (highs.length < maxPoints) {
      const isHigh = candles.slice(i - wing, i).every(o => o.high <= c.high) && candles.slice(i + 1, i + wing + 1).every(o => o.high <= c.high);
      if (isHigh) highs.push({ idx: i, price: c.high });
    }
    if (lows.length < maxPoints) {
      const isLow = candles.slice(i - wing, i).every(o => o.low >= c.low) && candles.slice(i + 1, i + wing + 1).every(o => o.low >= c.low);
      if (isLow) lows.push({ idx: i, price: c.low });
    }
  }
  if (highs.length < 2 || lows.length < 2) return null;
  const trendUp = highs[0].price > highs[1].price && lows[0].price > lows[1].price;
  const trendDown = highs[0].price < highs[1].price && lows[0].price < lows[1].price;
  const structure = trendUp ? 'HH/HL (ขาขึ้น)' : trendDown ? 'LH/LL (ขาลง)' : 'ไม่ชัดเจน (sideways)';
  const close = candles[candles.length - 1].close;
  let event = null;
  if (trendUp && close < lows[0].price) event = 'CHoCH (สัญญาณเตือนกลับตัวเป็นขาลง หลุด swing low ล่าสุดขณะโครงสร้างเดิมเป็นขาขึ้น)';
  else if (trendDown && close > highs[0].price) event = 'CHoCH (สัญญาณเตือนกลับตัวเป็นขาขึ้น หลุด swing high ล่าสุดขณะโครงสร้างเดิมเป็นขาลง)';
  else if (trendUp && close > highs[0].price) event = 'BOS ขาขึ้น (ราคาทะลุ swing high ล่าสุด ยืนยันแนวโน้มขาขึ้นต่อ)';
  else if (trendDown && close < lows[0].price) event = 'BOS ขาลง (ราคาทะลุ swing low ล่าสุด ยืนยันแนวโน้มขาลงต่อ)';
  return { structure, event, trendUp, trendDown };
}

// Liquidity Sweep: price wicks beyond a recent swing high/low (where stop-loss
// / breakout orders cluster — "liquidity") then closes back inside the range
// within a few bars, signalling a stop-hunt/fakeout rather than a genuine
// breakout. Swing points are taken from the window *before* the recent bars
// so the sweep candle itself can't also be the swing being swept.
function liquiditySweep(candles, wing = 3, lookback = 80, recentBars = 5) {
  candles = candles.slice(-lookback);
  if (candles.length < recentBars + wing * 2 + 2) return null;
  const priorEnd = candles.length - recentBars;
  const prior = candles.slice(0, priorEnd);
  let swingHigh = null, swingLow = null;
  for (let i = prior.length - 1 - wing; i >= wing; i--) {
    const c = prior[i];
    if (swingHigh === null && prior.slice(i - wing, i).every(o => o.high <= c.high) && prior.slice(i + 1, i + wing + 1).every(o => o.high <= c.high)) {
      swingHigh = c.high;
    }
    if (swingLow === null && prior.slice(i - wing, i).every(o => o.low >= c.low) && prior.slice(i + 1, i + wing + 1).every(o => o.low >= c.low)) {
      swingLow = c.low;
    }
    if (swingHigh !== null && swingLow !== null) break;
  }
  if (swingHigh === null && swingLow === null) return null;

  const recent = candles.slice(priorEnd);
  let bullish = null, bearish = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (!bearish && swingHigh !== null && c.high > swingHigh && c.close < swingHigh) {
      bearish = { level: swingHigh, wickHigh: c.high, time: c.time, barsAgo: recent.length - 1 - i };
    }
    if (!bullish && swingLow !== null && c.low < swingLow && c.close > swingLow) {
      bullish = { level: swingLow, wickLow: c.low, time: c.time, barsAgo: recent.length - 1 - i };
    }
    if (bullish && bearish) break;
  }
  return { bullish, bearish };
}

// ICT Premium/Discount + Optimal Trade Entry (OTE): the range between the
// nearest swing high/low is treated as a dealing range. The upper half
// ("premium") is where ICT looks to sell/short, the lower half ("discount")
// is where it looks to buy/long, with the 61.8%-79% Fibonacci retracement of
// that range (the "OTE zone") marking the specific pullback entry pocket
// after an impulsive move, rather than just "somewhere in the discount half".
function ictZones(swing, currentPrice) {
  if (!swing || !swing.high || !swing.low) return null;
  const high = Math.max(swing.high.price, swing.low.price);
  const low = Math.min(swing.high.price, swing.low.price);
  const range = high - low;
  if (!(range > 0)) return null;
  const eq = (high + low) / 2;
  // A small buffer around eq so prices right on the midpoint read as
  // "equilibrium" rather than flipping premium/discount on tiny noise.
  const buffer = range * 0.05;
  const zone = currentPrice > eq + buffer ? 'premium' : currentPrice < eq - buffer ? 'discount' : 'equilibrium';
  // Pullback-to-buy zone after an up-leg (low -> high): 61.8%-79% retracement
  // measured down from the high.
  const oteBuyZone = { low: high - range * 0.79, high: high - range * 0.618 };
  // Pullback-to-sell zone after a down-leg (high -> low): 61.8%-79%
  // retracement measured up from the low.
  const oteSellZone = { low: low + range * 0.618, high: low + range * 0.79 };
  const inOteBuy = currentPrice >= oteBuyZone.low && currentPrice <= oteBuyZone.high;
  const inOteSell = currentPrice >= oteSellZone.low && currentPrice <= oteSellZone.high;
  return { high, low, eq, zone, oteBuyZone, oteSellZone, inOteBuy, inOteSell };
}

// Per-asset gating — kept as a lookup rather than bare constants so each
// asset can plug in its own thresholds without touching computeSignalScore.
const ASSET_CONFIG = {
  // Reverted 2026-07-31: adxGate 18->20 and strongFactor 0.22->0.3 had been
  // lowered earlier in search of more frequent signals, but with no closed
  // trade history yet to confirm the looser gate actually holds up, rolled
  // back to the previous, more selective values pending real win-rate data.
  XAU: { adxGate: 20, strongFactor: 0.3, strongFactorAgainst200: 0.44, requireStrong: true, rr: 1.5, atrMult: 1.5 },
  // BTC starts on the same thresholds as XAU as a baseline — untuned for
  // crypto's different volatility/session behavior (trades 24/7, no
  // session gaps). Use /api/config-suggestion once real BTC trade history
  // exists rather than guessing crypto-specific numbers up front.
  BTC: { adxGate: 20, strongFactor: 0.3, strongFactorAgainst200: 0.44, requireStrong: true, rr: 1.5, atrMult: 1.5 },
};

function computeSignalScore(m) {
  const config = ASSET_CONFIG[m.assetKey] || ASSET_CONFIG.XAU;
  const reasons = [];

  // --- Trend confluence block (EMA cascade, Supertrend, higher-timeframe) ---
  // These three are all "what's the dominant trend" votes and tend to move
  // together, so they're collapsed into one confluence vote rather than each
  // inflating the score independently.
  let trendVotes = 0, trendVoters = 0;

  // Full cascade (EMA20>EMA50>EMA200), not just EMA20 vs EMA50 — a partial
  // alignment (e.g. EMA20>EMA50 but price<EMA200) is exactly the kind of
  // mixed signal that should NOT count as a clean trend vote.
  if (m.ema200 != null) {
    trendVoters += 1;
    if (m.ema20 > m.ema50 && m.ema50 > m.ema200) { trendVotes += 1; reasons.push('EMA20>EMA50>EMA200 cascade (trend vote buy)'); }
    else if (m.ema20 < m.ema50 && m.ema50 < m.ema200) { trendVotes -= 1; reasons.push('EMA20<EMA50<EMA200 cascade (trend vote sell)'); }
    else { reasons.push('EMA cascade ไม่ครบ (0)'); }
  } else if (m.ema20 > m.ema50) { trendVotes += 1; trendVoters += 1; reasons.push('EMA20>EMA50 (trend vote buy, ยังไม่มี EMA200)'); }
  else { trendVotes -= 1; trendVoters += 1; reasons.push('EMA20<EMA50 (trend vote sell, ยังไม่มี EMA200)'); }

  if (m.supertrend) {
    trendVoters += 1;
    if (m.supertrend.trend === 'up') { trendVotes += 1; reasons.push('Supertrend เขียว (trend vote buy)'); }
    else { trendVotes -= 1; reasons.push('Supertrend แดง (trend vote sell)'); }
  }

  if (m.higherTimeframe.trend.includes('Uptrend')) { trendVotes += 1; trendVoters += 1; reasons.push('Higher timeframe uptrend (trend vote buy)'); }
  else { trendVotes -= 1; trendVoters += 1; reasons.push('Higher timeframe downtrend (trend vote sell)'); }

  let score = 0;
  const trendMajority = Math.ceil((trendVoters + 1) / 2);
  if (trendVotes >= trendMajority) { score += 1; reasons.push('=> Trend confluence BUY (+1)'); }
  else if (trendVotes <= -trendMajority) { score -= 1; reasons.push('=> Trend confluence SELL (+1)'); }
  else { reasons.push('=> Trend confluence mixed (0)'); }

  const ema200Direction = m.ema200 != null ? (m.currentPrice > m.ema200 ? 'BUY' : 'SELL') : null;

  // --- Momentum block: only vote on the event actually happening (crossover
  // / threshold), not on the indicator's ambient level — matches the "ตัดขึ้น
  // / ตัดลง" (crossover) rules rather than "is currently above/below".
  if (m.rsi >= 52) { score += 1; reasons.push('RSI>=52 (+1 buy)'); }
  else if (m.rsi <= 48) { score -= 1; reasons.push('RSI<=48 (+1 sell)'); }
  else { reasons.push('RSI neutral (0) — โซนห้ามเข้า 48-52'); }

  if (m.macd.crossUp) { score += 1; reasons.push('MACD ตัดขึ้น (+1 buy)'); }
  else if (m.macd.crossDown) { score -= 1; reasons.push('MACD ตัดลง (+1 sell)'); }
  else { reasons.push('MACD ไม่มี crossover รอบนี้ (0)'); }

  if (m.stochastic.crossUpFromOversold) { score += 1; reasons.push('Stochastic ตัดขึ้นจากโซน oversold (+1 buy)'); }
  else if (m.stochastic.crossDownFromOverbought) { score -= 1; reasons.push('Stochastic ตัดลงจากโซน overbought (+1 sell)'); }
  else { reasons.push('Stochastic ไม่มี crossover ที่โซนสุดขั้ว (0)'); }

  // --- Structure / price-action block ---
  if (m.structure && m.structure.event) {
    if (m.structure.event.startsWith('BOS ขาขึ้น') || m.structure.event.includes('กลับตัวเป็นขาขึ้น')) { score += 1; reasons.push(`${m.structure.event} (+1 buy)`); }
    else { score -= 1; reasons.push(`${m.structure.event} (+1 sell)`); }
  } else { reasons.push('ไม่มี BOS/CHoCH ใหม่ (0)'); }

  // Liquidity sweep: a stop-hunt reversal signal, independent of BOS/CHoCH
  // (which look at the close breaking structure, not a wick-and-reject).
  if (m.liquiditySweep && (m.liquiditySweep.bullish || m.liquiditySweep.bearish)) {
    if (m.liquiditySweep.bullish) { score += 1; reasons.push(`Liquidity sweep ใต้ swing low ${m.liquiditySweep.bullish.level.toFixed ? m.liquiditySweep.bullish.level.toFixed(2) : m.liquiditySweep.bullish.level} แล้วปิดกลับขึ้น (+1 buy)`); }
    else { score -= 1; reasons.push(`Liquidity sweep เหนือ swing high ${m.liquiditySweep.bearish.level.toFixed ? m.liquiditySweep.bearish.level.toFixed(2) : m.liquiditySweep.bearish.level} แล้วปิดกลับลง (+1 sell)`); }
  } else { reasons.push('ไม่มี Liquidity Sweep ใหม่ (0)'); }

  // No real tick volume exists for spot XAU via this data source, so
  // candle-count momentum stands in as the closest available price-action
  // proxy for "volume above average" rather than a fabricated volume number.
  const candleDiff = m.candleCounts.up - m.candleCounts.down;
  if (candleDiff >= 2) { score += 1; reasons.push('More up candles recently — proxy for volume/price action (+1 buy)'); }
  else if (candleDiff <= -2) { score -= 1; reasons.push('More down candles recently — proxy for volume/price action (+1 sell)'); }
  else { reasons.push('Candle count neutral (0)'); }

  // RSI divergence is a reversal signal that trend-following votes above can't
  // see (price and momentum are actively disagreeing), so it gets its own point.
  if (m.divergence) {
    if (m.divergence.bullish) { score += 1; reasons.push('Bullish RSI divergence (+1 buy)'); }
    else if (m.divergence.bearish) { score -= 1; reasons.push('Bearish RSI divergence (+1 sell)'); }
    else { reasons.push('No RSI divergence (0)'); }
  }

  // ICT Optimal Trade Entry: being inside the 61.8-79% pullback pocket of the
  // last swing leg is treated as its own confluence vote, separate from the
  // premium/discount half-range check below — OTE is a tighter, higher-
  // conviction entry pocket than simply "somewhere in the discount half".
  if (m.ict) {
    if (m.ict.inOteBuy) { score += 1; reasons.push('ราคาอยู่ใน ICT OTE zone (61.8-79% retracement) ฝั่งซื้อ (+1 buy)'); }
    else if (m.ict.inOteSell) { score -= 1; reasons.push('ราคาอยู่ใน ICT OTE zone (61.8-79% retracement) ฝั่งขาย (+1 sell)'); }
    else if (m.ict.zone === 'discount') { score += 1; reasons.push('ราคาอยู่โซน Discount ของ dealing range (+1 buy)'); }
    else if (m.ict.zone === 'premium') { score -= 1; reasons.push('ราคาอยู่โซน Premium ของ dealing range (+1 sell)'); }
    else { reasons.push('ราคาอยู่โซน Equilibrium (0)'); }
  }

  // Bollinger Bands: a mean-reversion vote — price outside its own recent
  // 2-std-dev range is "stretched" and more likely to snap back, independent
  // of trend direction (unlike the trend-confluence block above).
  if (m.bollinger) {
    if (m.currentPrice > m.bollinger.upper) { score -= 1; reasons.push('ราคาหลุดกรอบบนของ Bollinger Bands — ยืดเกินค่าเฉลี่ย (+1 sell, mean-reversion)'); }
    else if (m.currentPrice < m.bollinger.lower) { score += 1; reasons.push('ราคาหลุดกรอบล่างของ Bollinger Bands — ยืดเกินค่าเฉลี่ย (+1 buy, mean-reversion)'); }
    else { reasons.push('ราคาอยู่ในกรอบ Bollinger Bands (0)'); }
  }

  // Keltner Channel: the opposite read from Bollinger above — breaking the
  // ATR-based channel is a volatility breakout (trend continuation), not a
  // stretch to fade. The two together can and do disagree by design.
  if (m.keltner) {
    if (m.currentPrice > m.keltner.upper) { score += 1; reasons.push('ราคาทะลุกรอบบนของ Keltner Channel — breakout ตามเทรนด์ (+1 buy)'); }
    else if (m.currentPrice < m.keltner.lower) { score -= 1; reasons.push('ราคาทะลุกรอบล่างของ Keltner Channel — breakout ตามเทรนด์ (+1 sell)'); }
    else { reasons.push('ราคาอยู่ในกรอบ Keltner Channel (0)'); }
  }

  // Squeeze (Bollinger Bands pinched inside the Keltner Channel) flags low
  // volatility that often precedes a breakout — informational only, no
  // score vote, since a squeeze has no direction of its own yet.
  const squeeze = !!(m.bollinger && m.keltner && m.bollinger.upper < m.keltner.upper && m.bollinger.lower > m.keltner.lower);
  if (squeeze) reasons.push('=> Bollinger Bands หดตัวเข้าไปในกรอบ Keltner Channel (squeeze) — ความผันผวนต่ำ อาจมี breakout เร็วๆ นี้');

  const maxScore = 6 + (m.divergence ? 1 : 0) + (m.liquiditySweep ? 1 : 0) + (m.ict ? 1 : 0) + (m.bollinger ? 1 : 0) + (m.keltner ? 1 : 0);
  const direction = score > 0 ? 'BUY' : score < 0 ? 'SELL' : null;
  const against200 = ema200Direction != null && direction != null && direction !== ema200Direction;
  if (against200) { reasons.push(`=> ทิศทาง ${direction} สวนทาง EMA200 (long-term trend) — ต้องใช้ threshold สูงขึ้นจึงจะถือว่าสัญญาณแรง`); }
  const strongThreshold = Math.ceil(maxScore * (against200 ? config.strongFactorAgainst200 : config.strongFactor));
  const strong = Math.abs(score) >= strongThreshold;

  // ADX >= gate is the trade gate — Wilder's "strong trend" threshold —
  // needed alongside the ATR-scaled TP/SL so trades only fire in conditions
  // strong enough to actually reach that target. Also requires a "strong"
  // confluence score (config.requireStrong), not just any nonzero score.
  let tradable = true;
  let waitReason = null;
  if (m.adx == null || m.adx < config.adxGate) {
    tradable = false;
    waitReason = `ADX=${m.adx != null ? m.adx.toFixed(1) : 'N/A'} (<${config.adxGate}) — ตลาดไม่มีเทรนด์แข็งแรงพอ ระบบนี้ไม่เข้าเทรดเว้นแต่ ADX>=${config.adxGate}`;
  } else if (score === 0) {
    tradable = false;
    waitReason = `สัญญาณ BUY/SELL หักล้างกันพอดี (score=0) — ไม่มีทิศทางที่ชัดเจนพอให้เข้าเทรด`;
  } else if (config.requireStrong && !strong) {
    tradable = false;
    waitReason = `สัญญาณยังไม่ชัดเจนพอ (score=${score}, ต้องการอย่างน้อย ${strongThreshold}/${maxScore}) — รอสัญญาณที่มั่นใจกว่านี้`;
  }
  if (waitReason) reasons.push(`=> WAIT: ${waitReason}`);

  // "Developing" tier: surfaces setups that are close to (but don't yet
  // clear) the trade gate, without loosening the gate itself — tradable
  // still means the same thing it always did. Two ways in: ADX is nearly at
  // the trend-strength threshold, or the confluence score already has a
  // direction and is within one point of the "strong" bar.
  let developing = false;
  let developingReason = null;
  if (!tradable) {
    const adxNear = m.adx != null && m.adx < config.adxGate && m.adx >= config.adxGate - 3;
    const scoreNear = direction != null && config.requireStrong && !strong && Math.abs(score) >= strongThreshold - 1;
    if (adxNear) {
      developing = true;
      developingReason = `ADX=${m.adx.toFixed(1)} ใกล้เกณฑ์ ${config.adxGate} — เทรนด์กำลังก่อตัว ยังไม่ถึงเกณฑ์เข้าเทรด`;
    } else if (scoreNear) {
      developing = true;
      developingReason = `คะแนน confluence ${score}/${maxScore} ใกล้เกณฑ์ ${strongThreshold} (ทิศทาง ${direction}) — สัญญาณกำลังก่อตัว ยังไม่ชัดพอ`;
    }
  }

  return { score, direction, strong, strongThreshold, against200, reasons, maxScore, tradable, waitReason, adx: m.adx, developing, developingReason, squeeze };
}

// Regular divergence: price makes a lower low / higher high while the
// oscillator (RSI here) makes the opposite, using the two most recent swing
// points from swingPoints(). Signals a likely reversal that trend-following
// indicators (EMA/MACD) won't see coming.
function detectDivergence(candles, closes, wing = 3, lookback = 80) {
  // Bounded like structureBreak/orderBlocksAndFvg — indices stay absolute
  // (into the full `candles`/`closes` arrays, not a sliced copy) because
  // rsiAt() below needs the real preceding history to compute RSI correctly.
  const earliestIdx = Math.max(wing, candles.length - lookback);
  const swingLows = [], swingHighs = [];
  for (let i = candles.length - 1 - wing; i >= earliestIdx; i--) {
    const c = candles[i];
    const isLow = candles.slice(i - wing, i).every(o => o.low >= c.low) && candles.slice(i + 1, i + wing + 1).every(o => o.low >= c.low);
    if (isLow) swingLows.push({ idx: i, price: c.low });
    const isHigh = candles.slice(i - wing, i).every(o => o.high <= c.high) && candles.slice(i + 1, i + wing + 1).every(o => o.high <= c.high);
    if (isHigh) swingHighs.push({ idx: i, price: c.high });
    if (swingLows.length >= 2 && swingHighs.length >= 2) break;
  }
  const rsiAt = (idx) => rsi(closes.slice(0, idx + 1));
  let bullish = null, bearish = null;
  if (swingLows.length >= 2) {
    const [recent, prior] = swingLows;
    if (recent.price < prior.price && rsiAt(recent.idx) > rsiAt(prior.idx)) {
      bullish = { recentPrice: recent.price, priorPrice: prior.price };
    }
  }
  if (swingHighs.length >= 2) {
    const [recent, prior] = swingHighs;
    if (recent.price > prior.price && rsiAt(recent.idx) < rsiAt(prior.idx)) {
      bearish = { recentPrice: recent.price, priorPrice: prior.price };
    }
  }
  return { bullish, bearish };
}

// Order Block: last opposite-colour candle before a strong impulsive move
// (Smart Money Concepts). Fair Value Gap: a 3-candle imbalance where candle 1's
// high/low doesn't overlap candle 3's low/high, leaving a gap price tends to
// revisit. Both scanned over the recent window, most recent unmitigated one wins.
function orderBlocksAndFvg(candles, lookback = 30) {
  const recent = candles.slice(-lookback);
  let bullishOB = null, bearishOB = null;
  for (let i = recent.length - 2; i >= 1; i--) {
    const c = recent[i], next = recent[i + 1];
    const impulsive = Math.abs(next.close - next.open) > (next.high - next.low) * 0.6;
    if (!bullishOB && c.close < c.open && next.close > next.open && impulsive && next.close > c.high) {
      bullishOB = { low: c.low, high: c.high, time: c.time };
    }
    if (!bearishOB && c.close > c.open && next.close < next.open && impulsive && next.close < c.low) {
      bearishOB = { low: c.low, high: c.high, time: c.time };
    }
    if (bullishOB && bearishOB) break;
  }
  let bullishFvg = null, bearishFvg = null;
  for (let i = recent.length - 1; i >= 2; i--) {
    const a = recent[i - 2], b = recent[i];
    if (!bullishFvg && b.low > a.high) bullishFvg = { gapLow: a.high, gapHigh: b.low, time: b.time };
    if (!bearishFvg && b.high < a.low) bearishFvg = { gapLow: b.high, gapHigh: a.low, time: b.time };
    if (bullishFvg && bearishFvg) break;
  }
  return { bullishOB, bearishOB, bullishFvg, bearishFvg };
}

function isValidJson(str) {
  try { JSON.parse(str); return true; } catch { return false; }
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

// SMA20 +/- 2 std dev — the standard Bollinger parameters. Used as a
// mean-reversion read: price outside the bands is "stretched" relative to
// its own recent volatility, independent of trend direction.
function bollingerBands(closes, period = 20, mult = 2) {
  const smaSeries = sma(closes, period);
  let latest = null;
  const i = closes.length - 1;
  if (smaSeries[i] != null) {
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - smaSeries[i]) ** 2;
    const stdDev = Math.sqrt(sumSq / period);
    latest = { middle: smaSeries[i], upper: smaSeries[i] + mult * stdDev, lower: smaSeries[i] - mult * stdDev };
  }
  return latest;
}

// EMA20 +/- ATR x2 — reads as a trend/breakout channel rather than
// Bollinger's mean-reversion read, since it's centered on volatility (ATR)
// rather than standard deviation of price itself.
function keltnerChannel(closes, atrSeriesFull, period = 20, mult = 2) {
  const emaSeries = ema(closes, period);
  const i = closes.length - 1;
  if (emaSeries[i] == null || atrSeriesFull[i] == null) return null;
  return { middle: emaSeries[i], upper: emaSeries[i] + mult * atrSeriesFull[i], lower: emaSeries[i] - mult * atrSeriesFull[i] };
}

function volatilityStats(candles, period = 20) {
  const recent = candles.slice(-period);
  const ranges = recent.map(c => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const bodyRatios = recent.map(c => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
  });
  const avgBodyRatio = bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length;
  return { avgRange, avgBodyRatio };
}

// Twelve Data's free tier caps requests per minute (8 credits/min), and each
// call here burns 2 credits (current interval + higher timeframe). Caching
// the computed response per asset+interval means repeated clicks or the
// win/loss price-check poll don't re-spend credits for data that's still
// fresh, instead of hitting the rate limit like "9 credits used, limit 8".
const marketDataCache = new Map();
const MARKET_DATA_CACHE_MS = 45 * 1000;

// Raw candle series are cached one level below the computed payload above,
// keyed only by asset+interval (not by which role — "main" vs "higher
// timeframe" — requested it). Several timeframes share the same higher-
// timeframe context (15min/30min/1h all use 4h), so without this a page
// that checks all 7 timeframes at once (the dashboard's multi-timeframe
// table) fires up to 14 credits in one burst and blows the 8/min cap. An
// in-flight map dedupes concurrent requests for the same key too — the
// 7 timeframes are fetched via Promise.all, so several would otherwise
// race to fetch the same interval before any of them finished caching it.
const rawSeriesCache = new Map();
const rawSeriesInflight = new Map();

async function fetchSeriesCached(assetKey, symbol, interval) {
  const key = `${assetKey}:${interval}`;
  const cached = rawSeriesCache.get(key);
  if (cached && Date.now() - cached.time < MARKET_DATA_CACHE_MS) return cached.data;
  if (rawSeriesInflight.has(key)) return rawSeriesInflight.get(key);

  const promise = fetchTwelveData('time_series', { symbol, interval, outputsize: 210, timezone: 'UTC' })
    .then(data => {
      rawSeriesCache.set(key, { time: Date.now(), data });
      rawSeriesInflight.delete(key);
      return data;
    })
    .catch(err => {
      rawSeriesInflight.delete(key);
      throw err;
    });
  rawSeriesInflight.set(key, promise);
  return promise;
}

// Shared by /api/market-data and /api/quick-check — fetches + computes every
// indicator, using the same cache, without either route needing to know how
// the other gets its data. Throws on a hard failure (caller decides whether
// stale cache is an acceptable fallback).
async function getMarketDataPayload(assetKey, interval) {
  const asset = ASSETS[assetKey];
  const cacheKey = `${assetKey}:${interval}`;
  const cached = marketDataCache.get(cacheKey);
  if (cached && Date.now() - cached.time < MARKET_DATA_CACHE_MS) {
    return { payload: cached.data, fromCache: true };
  }

  const higherIntervalMap = { '1min': '15min', '5min': '1h', '15min': '4h', '30min': '4h', '1h': '4h', '4h': '1day', '1day': '1week' };
  const higherInterval = higherIntervalMap[interval] || '4h';

  try {
    const [series, higherSeries] = await Promise.all([
      // timezone=UTC pins candle datetimes to a known zone — without it Twelve
      // Data defaults to the exchange's local time (observed ~10h ahead of
      // UTC), which the client was parsing as if it were the browser's own
      // local time. That mismatch shifted every candle's timestamp by however
      // far the browser's timezone differs from the exchange's, so the
      // win/loss checker could scan the wrong candles entirely and flag a
      // "loss" that never actually happened at the real price.
      fetchSeriesCached(assetKey, asset.symbol, interval),
      fetchSeriesCached(assetKey, asset.symbol, higherInterval),
    ]);

    // Twelve Data returns newest-first; put oldest-first for trend reading.
    const candles = series.values.slice().reverse().map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume) || 0,
    }));
    const higherCandles = higherSeries.values.slice().reverse().map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const recent = candles.slice(-30);
    const resistance = Math.max(...recent.map(c => c.high));
    const support = Math.min(...recent.map(c => c.low));

    const recentUp = candles.slice(-15).filter(c => c.close >= c.open).length;
    const recentDown = 15 - recentUp;

    const ema20Series = ema(closes, 20);
    const ema50Series = ema(closes, 50);
    const ema200Series = closes.length >= 200 ? ema(closes, 200) : null;

    const higherCloses = higherCandles.map(c => c.close);
    const higherEma20Series = ema(higherCloses, 20);
    const higherEma50Series = ema(higherCloses, 50);
    const higherEma20 = higherEma20Series[higherEma20Series.length - 1];
    const higherEma50 = higherEma50Series[higherEma50Series.length - 1];
    const higherTrend = higherEma20 > higherEma50 ? 'ขาขึ้น (Uptrend)' : 'ขาลง (Downtrend)';

    const macdResult = macd(closes);
    const rsiSeriesFull = rsiSeries(closes, 21);
    const atrSeriesFull = atrSeries(candles);
    const swingResult = swingPoints(candles);

    const payload = {
      symbol: asset.symbol,
      assetKey,
      assetLabel: asset.label,
      interval,
      currentPrice,
      support,
      resistance,
      candleCounts: { up: recentUp, down: recentDown },
      recentCandles: recent,
      rsi: rsiSeriesFull[rsiSeriesFull.length - 1],
      macd: macdResult,
      ema20: ema20Series[ema20Series.length - 1],
      ema50: ema50Series[ema50Series.length - 1],
      ema200: ema200Series ? ema200Series[ema200Series.length - 1] : null,
      atr: atr(candles),
      adx: adx(candles),
      // Rolling series (last 30 bars) for the dashboard's sparkline tiles —
      // reuses the same indicator math above rather than recomputing on the
      // client, which doesn't have the full candle history to do so anyway.
      sparklines: {
        closes: closes.slice(-30),
        ema20: ema20Series.slice(-30),
        ema50: ema50Series.slice(-30),
        rsi: rsiSeriesFull.slice(-30),
        macdHistogram: macdResult.histogramSeries.slice(-30),
        atr: atrSeriesFull.slice(-30),
        range: candles.slice(-30).map(c => c.high - c.low), // volume proxy (no real tick volume for spot XAU)
      },
      stochastic: stochasticOscillator(candles),
      swing: swingResult,
      volatility: volatilityStats(candles),
      bollinger: bollingerBands(closes),
      keltner: keltnerChannel(closes, atrSeriesFull),
      divergence: detectDivergence(candles, closes),
      smc: orderBlocksAndFvg(candles),
      supertrend: supertrend(candles),
      structure: structureBreak(candles),
      liquiditySweep: liquiditySweep(candles),
      ict: ictZones(swingResult, currentPrice),
      higherTimeframe: {
        interval: higherInterval,
        trend: higherTrend,
        ema20: higherEma20,
        ema50: higherEma50,
      },
    };
    marketDataCache.set(cacheKey, { time: Date.now(), data: payload });
    return { payload, fromCache: false };
  } catch (err) {
    // Serve stale cache rather than a hard error if Twelve Data itself is
    // rate-limited/unreachable — better a slightly old price than a WAIT
    // error screen when we already had good data moments ago.
    if (cached) return { payload: cached.data, fromCache: true, stale: true };
    throw err;
  }
}

app.get('/api/market-data', async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const interval = ['1min', '5min', '15min', '30min', '1h', '4h', '1day'].includes(req.query.interval)
    ? req.query.interval
    : '1h';
  const assetKey = ASSETS[req.query.asset] ? req.query.asset : 'XAU';

  try {
    const { payload } = await getMarketDataPayload(assetKey, interval);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'ดึงราคาจริงไม่สำเร็จ: ' + err.message });
  }
});

// Cheap pre-check: is the current setup even worth spending a Claude call on?
// Runs the same deterministic signal (ADX gate, EMA cascade, crossovers, etc.)
// used inside /api/analyze, but returns immediately without touching the AI
// or the news API — so the UI can show "เทรดได้ตอนนี้" / "รอก่อน" for free
// before the user commits to a full (paid) analysis.
app.get('/api/quick-check', async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const interval = ['1min', '5min', '15min', '30min', '1h', '4h', '1day'].includes(req.query.interval)
    ? req.query.interval
    : '1h';
  const assetKey = ASSETS[req.query.asset] ? req.query.asset : 'XAU';

  try {
    const { payload } = await getMarketDataPayload(assetKey, interval);
    const signal = computeSignalScore(payload);
    res.json({
      assetKey,
      interval,
      currentPrice: payload.currentPrice,
      tradable: signal.tradable,
      direction: signal.direction,
      strong: signal.strong,
      score: signal.score,
      maxScore: signal.maxScore,
      adx: signal.adx,
      waitReason: signal.waitReason,
      developing: signal.developing,
      developingReason: signal.developingReason,
      squeeze: signal.squeeze,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'เช็คสัญญาณไม่สำเร็จ: ' + err.message });
  }
});

// Exposes the same cached news lookup /api/analyze already uses internally,
// so a page can show real headlines without paying for a full AI analysis.
// Headline translation is cached separately from the raw news fetch (same
// TTL) so repeated /api/news requests within the window don't re-spend a
// Claude call — only a fresh set of headlines triggers a new translation.
const newsTranslationCache = new Map();

async function translateHeadlines(assetKey, articles) {
  if (!ANTHROPIC_API_KEY || !articles.length) return articles;
  const cacheKeySource = articles.map(a => a.title).join('|');
  const cached = newsTranslationCache.get(assetKey);
  if (cached && cached.source === cacheKeySource) return cached.translated;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: 'แปลหัวข้อข่าวต่อไปนี้เป็นภาษาไทยแบบกระชับ ตอบกลับเป็น JSON array ของ string เรียงลำดับเดิม ไม่ต้องมีข้อความอื่นนอกจาก JSON array:\n' +
            JSON.stringify(articles.map(a => a.title)),
        }],
      }),
    });
    const data = await response.json();
    const textBlock = Array.isArray(data?.content) ? data.content.find(b => b.type === 'text') : null;
    let text = textBlock?.text;
    if (!text) return articles;
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const titlesTh = JSON.parse(text);
    if (!Array.isArray(titlesTh) || titlesTh.length !== articles.length) return articles;
    const translated = articles.map((a, i) => ({ ...a, titleTh: titlesTh[i] }));
    newsTranslationCache.set(assetKey, { source: cacheKeySource, translated });
    return translated;
  } catch (err) {
    console.error('translateHeadlines failed', err);
    return articles;
  }
}

app.get('/api/news', async (req, res) => {
  const assetKey = ASSETS[req.query.asset] ? req.query.asset : 'XAU';
  try {
    const articles = await fetchGoldNews(assetKey);
    const translated = await translateHeadlines(assetKey, articles);
    res.json({ assetKey, articles: translated });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'ดึงข่าวไม่สำเร็จ: ' + err.message });
  }
});

// Suggests new ASSET_CONFIG thresholds (ADX gate, strong-signal fraction, RR)
// from the client's own closed win/loss history — not a price backtest.
// Backtesting years of historical candles would let thresholds overfit to
// noise in the past; the trader's actual closed trades on this exact system
// reflect current market behavior and how the tool is really being used.
// Deterministic (no AI call) since this is plain win-rate arithmetic, not
// reasoning — a model would just be restating the same numbers.
const MIN_SAMPLE_FOR_SUGGESTION = 15;

function winRate(records) {
  if (!records.length) return null;
  return records.filter(r => r.status === 'win').length / records.length;
}

app.post('/api/config-suggestion', (req, res) => {
  const assetKey = ASSETS[req.body.assetKey] ? req.body.assetKey : 'XAU';
  const history = Array.isArray(req.body.history) ? req.body.history : [];
  const config = ASSET_CONFIG[assetKey] || ASSET_CONFIG.XAU;

  const closed = history.filter(r => (r.status === 'win' || r.status === 'loss') && r.snapshot);
  if (closed.length < MIN_SAMPLE_FOR_SUGGESTION) {
    return res.json({
      assetKey,
      sampleSize: closed.length,
      minSampleRequired: MIN_SAMPLE_FOR_SUGGESTION,
      ready: false,
      message: `มีประวัติเทรดที่ปิดแล้วแค่ ${closed.length} รายการ (ต้องการอย่างน้อย ${MIN_SAMPLE_FOR_SUGGESTION}) — ยังน้อยเกินไปที่จะแนะนำค่าตั้งค่าใหม่ได้อย่างน่าเชื่อถือ เทรดต่อไปเรื่อยๆ แล้วกลับมาเช็คอีกครั้ง`,
    });
  }

  const overall = winRate(closed);
  const strongRecords = closed.filter(r => r.snapshot.signalStrong === true);
  const weakRecords = closed.filter(r => r.snapshot.signalStrong === false);
  const strongWinRate = winRate(strongRecords);
  const weakWinRate = winRate(weakRecords);

  // ADX buckets around the current gate, so the suggestion is grounded in
  // "what actually happened in each band" rather than a single average.
  const adxRecords = closed.filter(r => isFinite(r.snapshot.adx));
  const bucketDefs = [
    { label: `<${config.adxGate}`, match: v => v < config.adxGate },
    { label: `${config.adxGate}-${config.adxGate + 5}`, match: v => v >= config.adxGate && v < config.adxGate + 5 },
    { label: `${config.adxGate + 5}-${config.adxGate + 10}`, match: v => v >= config.adxGate + 5 && v < config.adxGate + 10 },
    { label: `>=${config.adxGate + 10}`, match: v => v >= config.adxGate + 10 },
  ];
  const adxBuckets = bucketDefs.map(b => {
    const records = adxRecords.filter(r => b.match(r.snapshot.adx));
    return { range: b.label, count: records.length, winRate: winRate(records) };
  }).filter(b => b.count > 0);

  const reasons = [];
  const suggestion = { adxGate: config.adxGate, strongFactor: config.strongFactor, rr: config.rr };

  // If non-strong setups are meaningfully worse than strong ones, the
  // strong-signal fraction is doing its job — no change needed there. If
  // they're about the same, the current fraction isn't actually filtering
  // anything, so raise the bar. Require both buckets to have enough samples
  // before comparing, otherwise the gap is just noise.
  if (strongRecords.length >= 5 && weakRecords.length >= 5) {
    if (strongWinRate - weakWinRate < 0.05) {
      suggestion.strongFactor = Math.min(config.strongFactor + 0.1, 0.85);
      reasons.push(`สัญญาณ "strong" (win rate ${(strongWinRate * 100).toFixed(0)}%) กับ "ไม่ strong" (win rate ${(weakWinRate * 100).toFixed(0)}%) ผลใกล้เคียงกันมาก — เกณฑ์ strong ปัจจุบันไม่ได้กรองอะไรจริงๆ แนะนำปรับ strongFactor จาก ${config.strongFactor} เป็น ${suggestion.strongFactor.toFixed(2)} ให้เข้มขึ้น`);
    } else {
      reasons.push(`สัญญาณ "strong" (win rate ${(strongWinRate * 100).toFixed(0)}%) ดีกว่า "ไม่ strong" (win rate ${(weakWinRate * 100).toFixed(0)}%) ชัดเจน — เกณฑ์ strongFactor ปัจจุบัน (${config.strongFactor}) ใช้ได้ดีอยู่แล้ว ไม่ต้องปรับ`);
    }
  } else {
    reasons.push(`ยังมีข้อมูลไม่พอแยกเปรียบเทียบ strong vs ไม่ strong (strong=${strongRecords.length}, ไม่strong=${weakRecords.length} รายการ ต้องการอย่างน้อยฝั่งละ 5)`);
  }

  // If trades taken right at/just above the current ADX gate lose more than
  // trades taken well above it, the gate itself is too loose.
  const nearGateBucket = adxBuckets.find(b => b.range === `${config.adxGate}-${config.adxGate + 5}`);
  const wellAboveBucket = adxBuckets.find(b => b.range === `${config.adxGate + 5}-${config.adxGate + 10}` || b.range === `>=${config.adxGate + 10}`);
  if (nearGateBucket && wellAboveBucket && nearGateBucket.count >= 5 && wellAboveBucket.count >= 5) {
    if (wellAboveBucket.winRate - nearGateBucket.winRate > 0.15) {
      suggestion.adxGate = config.adxGate + 5;
      reasons.push(`เทรดที่ ADX อยู่โซน ${nearGateBucket.range} (win rate ${(nearGateBucket.winRate * 100).toFixed(0)}%) แพ้บ่อยกว่าเทรดที่ ADX สูงกว่า (win rate ${(wellAboveBucket.winRate * 100).toFixed(0)}%) มาก — แนะนำยก ADX gate จาก ${config.adxGate} เป็น ${suggestion.adxGate}`);
    } else {
      reasons.push(`เทรดใกล้เกณฑ์ ADX gate ปัจจุบัน (${nearGateBucket.range}) win rate ไม่ได้แย่กว่าโซนสูงกว่าอย่างมีนัยสำคัญ — เกณฑ์ ADX gate ปัจจุบัน (${config.adxGate}) ใช้ได้อยู่`);
    }
  } else {
    reasons.push('ยังมีข้อมูลไม่พอแยกเปรียบเทียบ win rate ตามช่วง ADX');
  }

  // RR: if the system is winning more than half its trades at the current
  // RR, a wider RR would very likely still hit TP just as often while paying
  // out more per win — suggest widening. If win rate is below what the
  // current RR needs to break even, suggest narrowing rather than raising
  // risk further.
  const breakEvenWinRate = 1 / (1 + config.rr);
  if (overall != null) {
    if (overall > breakEvenWinRate + 0.15) {
      suggestion.rr = Math.round((config.rr + 0.5) * 100) / 100;
      reasons.push(`win rate โดยรวม ${(overall * 100).toFixed(0)}% สูงกว่าจุดคุ้มทุนของ RR ปัจจุบัน (${(breakEvenWinRate * 100).toFixed(0)}%) มาก — มีช่องขยาย RR จาก 1:${config.rr} เป็น 1:${suggestion.rr} เพื่อเพิ่มกำไรต่อไม้โดยไม่กระทบอัตราชนะมากนัก`);
    } else if (overall < breakEvenWinRate - 0.05) {
      reasons.push(`win rate โดยรวม ${(overall * 100).toFixed(0)}% ต่ำกว่าจุดคุ้มทุนของ RR ปัจจุบัน (${(breakEvenWinRate * 100).toFixed(0)}%) — ระบบขาดทุนสุทธิที่ RR นี้ ควรเข้มงวดเงื่อนไขเข้าเทรดเพิ่ม (ADX gate/strongFactor) มากกว่าลด RR ลง เพราะ RR ต่ำเกินไปจะยิ่งทำให้ต้อง win rate สูงขึ้นไปอีก`);
    } else {
      reasons.push(`win rate โดยรวม ${(overall * 100).toFixed(0)}% ใกล้เคียงจุดคุ้มทุนของ RR ปัจจุบัน (${(breakEvenWinRate * 100).toFixed(0)}%) — RR 1:${config.rr} ยังเหมาะสมอยู่ ไม่แนะนำให้ปรับตอนนี้`);
    }
  }

  const changed = suggestion.adxGate !== config.adxGate || suggestion.strongFactor !== config.strongFactor || suggestion.rr !== config.rr;

  res.json({
    assetKey,
    sampleSize: closed.length,
    minSampleRequired: MIN_SAMPLE_FOR_SUGGESTION,
    ready: true,
    overallWinRate: overall,
    strongWinRate,
    weakWinRate,
    adxBuckets,
    currentConfig: { adxGate: config.adxGate, strongFactor: config.strongFactor, rr: config.rr },
    suggestedConfig: suggestion,
    changed,
    reasons,
  });
});

// Mirrors the bucket definitions in gold.html's analyzeLossPatterns so a
// historically bad setup (sent from the client as lossPatternKeys) can be
// enforced deterministically here, instead of only hinted to the AI as prose
// that it may or may not act on.
function matchesLossPatternKey(key, direction, m, signal) {
  switch (key) {
    case 'counterTrend':
      return m.higherTimeframe
        ? (direction === 'BUY' ? m.higherTimeframe.trend.includes('Downtrend') : m.higherTimeframe.trend.includes('Uptrend'))
        : false;
    case 'rsiNeutral':
      return isFinite(m.rsi) && m.rsi > 45 && m.rsi < 55;
    case 'weakScore':
      return Math.abs(signal.score) <= 1;
    case 'emaMisaligned':
      // Matches the EMA20>EMA50>EMA200 cascade used in computeSignalScore now
      // (previously just EMA20 vs EMA50), so this loss-pattern bucket lines
      // up with what "aligned" actually means to the current scoring system.
      if (m.ema20 == null || m.ema50 == null) return false;
      if (m.ema200 != null) {
        return direction === 'BUY'
          ? !(m.ema20 > m.ema50 && m.ema50 > m.ema200)
          : !(m.ema20 < m.ema50 && m.ema50 < m.ema200);
      }
      return direction === 'BUY' ? m.ema20 < m.ema50 : m.ema20 > m.ema50;
    default:
      return false;
  }
}

app.post('/api/analyze', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์' });
  }

  const { marketData } = req.body || {};
  if (!marketData) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลราคาทองส่งมาให้วิเคราะห์' });
  }

  // Everything below reads fields off the client-supplied marketData object
  // without guarding each one — wrapping the whole handler (not just the
  // Anthropic fetch) means a malformed/incomplete marketData throws a caught
  // 500 instead of an uncaught rejection that crashes the entire Node
  // process (and takes the site down for every user, not just this request).
  try {
    const signal = computeSignalScore(marketData);
    const assetLabel = marketData.assetLabel || ASSETS[marketData.assetKey]?.label || ASSETS.XAU.label;
    const news = await fetchGoldNews(marketData.assetKey || 'XAU');

    // News blackout: block trading for a window after a high-impact release.
    // Marketaux only gives us published_at, not a forward-looking economic
    // calendar, so this can only catch the "just after news" half of the
    // requested ±15-30min window, not "15min before" — there's no calendar
    // feed wired up to know a release is imminent.
    const highImpactPattern = /non-?farm|nfp|\bcpi\b|fomc|federal reserve|fed interest rate|interest rate decision|\bpce\b|powell/i;
    const blackoutMinutes = 30;
    const recentHighImpact = news.find(a => highImpactPattern.test(a.title || '') && a.published && (Date.now() - new Date(a.published).getTime()) < blackoutMinutes * 60 * 1000);
    if (recentHighImpact && signal.tradable) {
      signal.tradable = false;
      signal.waitReason = `ข่าวผลกระทบสูงเพิ่งประกาศ ("${recentHighImpact.title}") ภายใน ${blackoutMinutes} นาทีที่ผ่านมา — งดเข้าเทรดช่วงตลาดผันผวนจากข่าว`;
      signal.reasons.push(`=> WAIT: ${signal.waitReason}`);
    }

    const lossPatterns = Array.isArray(req.body.lossPatterns) ? req.body.lossPatterns : [];
    const prompt = buildPrompt(marketData, signal, assetLabel, news, lossPatterns);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        // xhigh effort spends more reasoning on reconciling the ~20 indicators
        // in the prompt before answering, instead of the "high" default —
        // worth the extra latency/cost for a trade call, not a chat reply.
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'เรียก Claude API ไม่สำเร็จ' });
    }

    // Don't assume content[0] is the text block — newer models can prepend
    // other block types (e.g. a "thinking" block) before the actual text.
    const textBlock = Array.isArray(data?.content) ? data.content.find(b => b.type === 'text') : null;
    let text = textBlock?.text;
    if (!text) {
      return res.status(502).json({ error: 'ไม่ได้รับข้อความตอบกลับจาก AI' });
    }
    // Claude isn't given a hard JSON-only response mode like Gemini's
    // response_mime_type, so it may wrap the JSON in a ```json code fence, or
    // add stray prose before/after it, despite being told not to — strip
    // fences, then fall back to slicing out the outermost {...} block if the
    // text still isn't valid JSON on its own.
    text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    if (!isValidJson(text)) {
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first !== -1 && last > first) {
        const sliced = text.slice(first, last + 1);
        if (isValidJson(sliced)) text = sliced;
      }
    }
    if (!isValidJson(text)) {
      console.error('Claude returned non-JSON analysis response (stop_reason=' + data.stop_reason + '):', text.slice(0, 2000));
    }

    // Server-side veto: if the deterministic indicator score strongly disagrees
    // with the AI's call, the AI's answer is contradicting the actual data —
    // flip the recommendation and cap confidence instead of trusting free text blindly.
    try {
      const parsed = JSON.parse(text);
      const aiIsBuy = String(parsed.recommendation).toUpperCase().indexOf('BUY') !== -1;
      const aiDirection = aiIsBuy ? 'BUY' : 'SELL';
      // Expose the deterministic signal so the client can snapshot it alongside
      // each trade in its win/loss history for later loss-pattern analysis.
      parsed._signal = { score: signal.score, direction: signal.direction, strong: signal.strong };
      if (signal.strong && signal.direction && signal.direction !== aiDirection) {
        parsed.recommendation = signal.direction;
        const flippedIsBuy = signal.direction === 'BUY';
        // Scale the overridden probability/confidence with how many indicators
        // actually agree, relative to the strong-signal threshold and the
        // maximum possible score — not a hardcoded 3-4 range, since maxScore
        // and strongThreshold both move as indicators are added/removed.
        const magnitude = Math.abs(signal.score);
        const skewRange = Math.max(signal.maxScore - signal.strongThreshold, 1);
        const skew = Math.round(60 + Math.min(1, (magnitude - signal.strongThreshold) / skewRange) * 35); // strongThreshold -> 60, maxScore -> 95
        parsed.buy_probability = flippedIsBuy ? skew : 100 - skew;
        parsed.sell_probability = flippedIsBuy ? 100 - skew : skew;
        parsed.confidence_percent = Math.min(Number(parsed.confidence_percent) || skew, skew);
        parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;

        // The AI's entry/tp/sl were all structured for its original (now-overridden)
        // direction — e.g. a SELL entry placed up near resistance is a bad BUY entry.
        // Re-anchor entry to the live market price for the corrected direction instead
        // of reusing a price level that was chosen for the opposite trade, then rebuild
        // tp/sl the same distance from that new entry so risk/reward stays intact.
        const oldEntry = Number(parsed.entry);
        const oldTp = Number(parsed.tp);
        const oldSl = Number(parsed.sl);
        if (isFinite(oldEntry) && isFinite(oldTp) && isFinite(oldSl) && isFinite(marketData.currentPrice)) {
          const tpDistance = Math.abs(oldTp - oldEntry);
          const slDistance = Math.abs(oldEntry - oldSl);
          const entry = marketData.currentPrice;
          parsed.entry = entry;
          parsed.tp = flippedIsBuy ? entry + tpDistance : entry - tpDistance;
          parsed.sl = flippedIsBuy ? entry - slDistance : entry + slDistance;
          const reward = Math.abs(parsed.tp - entry);
          const risk = Math.abs(entry - parsed.sl);
          parsed.risk_reward = risk > 0 ? `1 : ${(reward / risk).toFixed(2)}` : parsed.risk_reward;
        }

        parsed.reasons = [
          `ระบบตรวจพบว่าคำตอบของ AI ขัดแย้งกับสัญญาณอินดิเคเตอร์เชิงปริมาณ (score=${signal.score}) จึงปรับคำแนะนำเป็น ${signal.direction} ตามข้อมูลจริง`,
          ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
        ];
      }

      // Deterministic loss-pattern enforcement: if the current setup matches a
      // bucket the client's own trade history flagged as a recurring loser,
      // cap confidence instead of just hoping the AI honors the prose hint.
      const lossPatternKeys = Array.isArray(req.body.lossPatternKeys) ? req.body.lossPatternKeys : [];
      const finalIsBuy = String(parsed.recommendation).toUpperCase().indexOf('BUY') !== -1;
      const finalDirection = finalIsBuy ? 'BUY' : 'SELL';
      const matchedKeys = lossPatternKeys.filter(key => matchesLossPatternKey(key, finalDirection, marketData, signal));
      if (matchedKeys.length) {
        // Each matched bad-pattern bucket knocks the confidence ceiling down further.
        const cap = Math.max(70 - matchedKeys.length * 15, 25);
        const currentConf = Number(parsed.confidence_percent) || cap;
        parsed.confidence_percent = Math.min(currentConf, cap);
        parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;
        const skew = Math.max(parsed.confidence_percent, 50);
        parsed.buy_probability = finalIsBuy ? Math.max(Number(parsed.buy_probability) || skew, 100 - skew) : Math.min(Number(parsed.buy_probability) || (100 - skew), 100 - skew);
        parsed.sell_probability = 100 - parsed.buy_probability;
        parsed.reasons = [
          `⚠ สถานการณ์ปัจจุบันตรงกับจุดที่ระบบนี้เคยแพ้บ่อย (${matchedKeys.join(', ')}) — จำกัด confidence ไม่เกิน ${cap}%`,
          ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
        ];
      }

      // Deterministic entry-quality gate: entry is always set to the live
      // market price below (never a level the AI invents), but "current
      // price" can itself be a bad place to chase into — buying while price
      // sits in the ICT Premium half of the range (or selling in Discount)
      // means paying up for/selling into the worse half of the dealing
      // range even when the broader direction call is correct. Cap
      // confidence when the entry itself isn't in a favorable zone, instead
      // of only checking direction.
      if (marketData.ict && marketData.ict.zone !== 'equilibrium') {
        const entryAgainstZone = (finalDirection === 'BUY' && marketData.ict.zone === 'premium')
          || (finalDirection === 'SELL' && marketData.ict.zone === 'discount');
        if (entryAgainstZone) {
          const entryCap = 60;
          const currentConf = Number(parsed.confidence_percent) || entryCap;
          parsed.confidence_percent = Math.min(currentConf, entryCap);
          parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;
          parsed.reasons = [
            `⚠ ราคาปัจจุบัน (จุดเข้า) อยู่โซน ${marketData.ict.zone === 'premium' ? 'Premium' : 'Discount'} ของ dealing range ซึ่งเป็นโซนที่ไม่เหมาะกับทิศทาง ${finalDirection} ตามหลัก ICT (เข้าตอนนี้คือไล่ราคาเข้าไปในโซนที่แพงกว่า/ถูกกว่าที่ควร) — จำกัด confidence ไม่เกิน ${entryCap}% ควรรอราคาย่อกลับเข้าโซน ${finalDirection === 'BUY' ? 'Discount หรือ OTE ฝั่งซื้อ' : 'Premium หรือ OTE ฝั่งขาย'} ก่อนเข้าจริง`,
            ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
          ];
        }
      }

      // Deterministic news-sentiment weighting: Marketaux gives a per-article
      // sentiment score, but the prompt only asked the AI to "consider" it as
      // prose, which it may or may not actually act on. Average the real
      // sentiment scores and cap confidence when they clearly contradict the
      // final call, the same way the loss-pattern check does.
      const sentimentScores = news.filter(a => a.sentiment != null).map(a => a.sentiment);
      if (sentimentScores.length) {
        const avgSentiment = sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length;
        // Exposed so the UI can show a news-direction summary independent of
        // the trade recommendation — this is "which way is news leaning",
        // not "does news agree with the AI's call" (that's opposesFinal below).
        parsed._newsSentiment = {
          avg: Math.round(avgSentiment * 100) / 100,
          count: sentimentScores.length,
          direction: avgSentiment >= 0.15 ? 'BUY' : avgSentiment <= -0.15 ? 'SELL' : 'NEUTRAL',
        };
        const opposesFinal = (finalDirection === 'BUY' && avgSentiment <= -0.2) || (finalDirection === 'SELL' && avgSentiment >= 0.2);
        if (opposesFinal) {
          const newsCap = 65;
          const currentConf = Number(parsed.confidence_percent) || newsCap;
          parsed.confidence_percent = Math.min(currentConf, newsCap);
          parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;
          parsed.reasons = [
            `⚠ ข่าวล่าสุดมี sentiment เฉลี่ย ${avgSentiment.toFixed(2)} ขัดแย้งกับทิศทาง ${finalDirection} — จำกัด confidence ไม่เกิน ${newsCap}%`,
            ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
          ];
        }
      }

      // Deterministic SL/TP: SL = ATR×multiplier, TP = SL × fixed RR instead
      // of letting the AI pick arbitrary entry/tp/sl levels — keeps risk
      // sizing consistent and tied to actual measured volatility. TP scales
      // with SL (both off ATR) rather than a flat point distance, since a
      // flat TP against an ATR-scaled SL let the ratio drift below 1:1 in
      // high volatility (risking more than the potential reward) precisely
      // when the ADX strong-trend gate is most likely to be open.
      const assetConfig = ASSET_CONFIG[marketData.assetKey] || ASSET_CONFIG.XAU;
      const RR = assetConfig.rr;
      if (signal.tradable && isFinite(marketData.atr) && isFinite(marketData.currentPrice)) {
        const entry = marketData.currentPrice;
        const slDistance = marketData.atr * assetConfig.atrMult;
        const tpDistance = slDistance * RR;
        parsed.entry = entry;
        parsed.sl = finalIsBuy ? entry - slDistance : entry + slDistance;
        parsed.tp = finalIsBuy ? entry + tpDistance : entry - tpDistance;
        parsed.risk_reward = `1 : ${RR}`;
      }

      // Deterministic no-trade veto: when the quantitative signal says there's
      // no real edge (choppy market / weak confluence, see computeSignalScore),
      // override to WAIT instead of letting the AI force a BUY/SELL call.
      if (!signal.tradable) {
        parsed.recommendation = 'WAIT';
        parsed.buy_probability = 50;
        parsed.sell_probability = 50;
        parsed.confidence_percent = Math.min(Number(parsed.confidence_percent) || 35, 35);
        parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;
        parsed.entry = null;
        parsed.tp = null;
        parsed.sl = null;
        parsed.risk_reward = '—';
        parsed.reasons = [
          `⏸ ระบบแนะนำ "รอ" ไม่เข้าเทรดรอบนี้: ${signal.waitReason}`,
          ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
        ];
      }

      text = JSON.stringify(parsed);
    } catch (parseErr) {
      console.error('veto check failed to parse AI response', parseErr);
    }

    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์: ' + err.message });
  }
});

function buildPrompt(m, signal, assetLabel, news, lossPatterns) {
  const adxGate = (ASSET_CONFIG[m.assetKey] || ASSET_CONFIG.XAU).adxGate;
  const newsBlock = news && news.length
    ? news.map(a => `- [${a.published}] ${a.title}${a.sentiment != null ? ` (sentiment=${a.sentiment.toFixed(2)})` : ''}`).join('\n')
    : 'ไม่มีข้อมูลข่าวล่าสุด';

  const lossPatternBlock = lossPatterns && lossPatterns.length
    ? lossPatterns.map(p => `- ${p}`).join('\n')
    : null;

  return `คุณคือนักวิเคราะห์เทคนิค ${assetLabel} ข้อมูลด้านล่างนี้คือค่าจริงที่คำนวณจากราคาตลาดจริง (ไม่ใช่การประมาณจากภาพ) ให้ใช้ตัวเลขเหล่านี้เป็นหลักฐานหลักในการให้เหตุผล ห้ามสร้างตัวเลขราคาหรืออินดิเคเตอร์ขึ้นใหม่เอง:

ข่าวล่าสุดที่เกี่ยวข้อง (เรียงใหม่สุดก่อน, sentiment_score จาก -1 ลบ=ข่าวลบ ถึง +1 บวก=ข่าวบวก):
${newsBlock}
${lossPatternBlock ? `\nสถิติจุดที่ระบบนี้เคย "แพ้" บ่อยจากประวัติเทรดจริง (ใช้ประกอบการลด confidence ถ้าสถานการณ์ปัจจุบันตรงกับรูปแบบเหล่านี้):\n${lossPatternBlock}\n` : ''}
สัญญาณเชิงปริมาณเบื้องต้น (คำนวณจากอินดิเคเตอร์ล้วนๆ ไม่ใช่ความเห็น AI): score=${signal.score} จาก -${signal.maxScore} ถึง +${signal.maxScore} (บวก=เอนไปทาง BUY, ลบ=เอนไปทาง SELL, เทรนด์จาก EMA/MACD/กรอบเวลาใหญ่นับรวมเป็น 1 คะแนนเดียวเพราะสัมพันธ์กันสูง) → ${signal.direction ? `เอนไปทาง ${signal.direction}` : 'ก้ำกึ่ง'}${signal.strong ? ' (สัญญาณชัดเจนมาก ควรให้คำแนะนำสอดคล้องกับทิศทางนี้เป็นหลัก)' : ''}
รายละเอียด: ${signal.reasons.join(', ')}

ราคาปัจจุบัน: ${m.currentPrice}
กรอบเวลา: ${m.interval}
แนวต้าน (high สูงสุดใน 30 แท่งล่าสุด): ${m.resistance}
แนวรับ (low ต่ำสุดใน 30 แท่งล่าสุด): ${m.support}
แท่งเทียนขึ้น/ลง ใน 15 แท่งล่าสุด: ขึ้น ${m.candleCounts.up} แท่ง / ลง ${m.candleCounts.down} แท่ง
RSI (14): ${m.rsi.toFixed(2)}
MACD: macd=${m.macd.macd.toFixed(4)}, signal=${m.macd.signal.toFixed(4)}, histogram=${m.macd.histogram.toFixed(4)}
EMA20: ${m.ema20.toFixed(2)}
EMA50: ${m.ema50.toFixed(2)}
${m.ema200 != null ? `EMA200: ${m.ema200.toFixed(2)}\n` : ''}ATR (14): ${m.atr.toFixed(2)} (วัดความผันผวนเฉลี่ยต่อแท่ง)
${m.adx != null ? `ADX (14): ${m.adx.toFixed(1)} (ระบบนี้ต้องการ ADX>=${adxGate} จึงจะถือว่าเทรนด์แข็งแรงพอให้เข้าเทรด ต่ำกว่านั้น=ไซด์เวย์)\n` : ''}
Stochastic Oscillator: %K=${m.stochastic.k.toFixed(2)}, %D=${m.stochastic.d.toFixed(2)}
${m.swing ? `Swing High ล่าสุด (จุดกลับตัวขาขึ้น→ลง): ${m.swing.high ? `${m.swing.high.price} (${m.swing.high.barsAgo} แท่งก่อนหน้า)` : 'ไม่พบในช่วงข้อมูล'}\nSwing Low ล่าสุด (จุดกลับตัวขาลง→ขึ้น): ${m.swing.low ? `${m.swing.low.price} (${m.swing.low.barsAgo} แท่งก่อนหน้า)` : 'ไม่พบในช่วงข้อมูล'}\n` : ''}
ความผันผวน 20 แท่งล่าสุด: ช่วงราคาเฉลี่ย/แท่ง=${m.volatility.avgRange.toFixed(2)}, สัดส่วนตัวแท่งเทียนเฉลี่ย=${(m.volatility.avgBodyRatio*100).toFixed(1)}%
แนวโน้มกรอบเวลาใหญ่กว่า (${m.higherTimeframe.interval}): ${m.higherTimeframe.trend} (EMA20=${m.higherTimeframe.ema20.toFixed(2)}, EMA50=${m.higherTimeframe.ema50.toFixed(2)})
${m.divergence && (m.divergence.bullish || m.divergence.bearish) ? `Divergence: ${m.divergence.bullish ? `Bullish (ราคาทำ low ใหม่ต่ำกว่าเดิมที่ ${m.divergence.bullish.recentPrice} แต่ RSI สูงขึ้น)` : `Bearish (ราคาทำ high ใหม่สูงกว่าเดิมที่ ${m.divergence.bearish.recentPrice} แต่ RSI ต่ำลง)`}\n` : ''}${m.smc ? `Order Block: ${m.smc.bullishOB ? `Bullish OB ${m.smc.bullishOB.low.toFixed(2)}-${m.smc.bullishOB.high.toFixed(2)}` : 'ไม่พบ'} / ${m.smc.bearishOB ? `Bearish OB ${m.smc.bearishOB.low.toFixed(2)}-${m.smc.bearishOB.high.toFixed(2)}` : 'ไม่พบ'}\nFair Value Gap: ${m.smc.bullishFvg ? `Bullish FVG ${m.smc.bullishFvg.gapLow.toFixed(2)}-${m.smc.bullishFvg.gapHigh.toFixed(2)}` : 'ไม่พบ'} / ${m.smc.bearishFvg ? `Bearish FVG ${m.smc.bearishFvg.gapLow.toFixed(2)}-${m.smc.bearishFvg.gapHigh.toFixed(2)}` : 'ไม่พบ'}\n` : ''}${m.supertrend ? `Supertrend (10,3): ${m.supertrend.trend === 'up' ? 'ขาขึ้น (เขียว)' : 'ขาลง (แดง)'} เส้นอยู่ที่ ${m.supertrend.value.toFixed(2)}\n` : ''}${m.structure ? `โครงสร้างตลาด (multi-swing): ${m.structure.structure}${m.structure.event ? ` — ${m.structure.event}` : ' — ไม่มี BOS/CHoCH ใหม่'}\n` : ''}${m.liquiditySweep && (m.liquiditySweep.bullish || m.liquiditySweep.bearish) ? `Liquidity Sweep: ${m.liquiditySweep.bullish ? `กวาดใต้ swing low ${m.liquiditySweep.bullish.level.toFixed(2)} (wick ต่ำสุด ${m.liquiditySweep.bullish.wickLow.toFixed(2)}) แล้วปิดกลับเข้ากรอบ — สัญญาณ stop-hunt ฝั่งซื้อ` : `กวาดเหนือ swing high ${m.liquiditySweep.bearish.level.toFixed(2)} (wick สูงสุด ${m.liquiditySweep.bearish.wickHigh.toFixed(2)}) แล้วปิดกลับเข้ากรอบ — สัญญาณ stop-hunt ฝั่งขาย`}\n` : ''}${m.ict ? `ICT Premium/Discount: dealing range ${m.ict.low.toFixed(2)}-${m.ict.high.toFixed(2)} (equilibrium=${m.ict.eq.toFixed(2)}) → ราคาปัจจุบันอยู่โซน ${m.ict.zone === 'premium' ? 'Premium (โซนขายของ ICT)' : m.ict.zone === 'discount' ? 'Discount (โซนซื้อของ ICT)' : 'Equilibrium (กึ่งกลาง ยังไม่ชัดเจน)'}\nICT OTE (Optimal Trade Entry, fib 61.8-79%): โซนซื้อ ${m.ict.oteBuyZone.low.toFixed(2)}-${m.ict.oteBuyZone.high.toFixed(2)} / โซนขาย ${m.ict.oteSellZone.low.toFixed(2)}-${m.ict.oteSellZone.high.toFixed(2)} → ${m.ict.inOteBuy ? 'ราคาปัจจุบันอยู่ใน OTE ฝั่งซื้อพอดี' : m.ict.inOteSell ? 'ราคาปัจจุบันอยู่ใน OTE ฝั่งขายพอดี' : 'ราคาปัจจุบันยังไม่เข้าโซน OTE'}\n` : ''}

หน้าที่ของคุณ:
- ก่อนสรุปคำแนะนำ ให้ทวนรายการอินดิเคเตอร์ทั้งหมดข้างต้นทีละตัวในใจว่าแต่ละตัวเอนไปทาง BUY, SELL หรือเป็นกลาง แล้วตรวจสอบว่าคำแนะนำสุดท้ายสอดคล้องกับเสียงส่วนใหญ่จริงหรือไม่ ถ้ามีอินดิเคเตอร์สำคัญ (เช่น เทรนด์กรอบเวลาใหญ่, ADX, ICT zone) ขัดแย้งกับคำแนะนำที่จะให้ ต้องลด confidence_percent ลงและระบุความขัดแย้งนั้นใน reasons อย่างตรงไปตรงมา ห้ามเลือกหยิบเฉพาะอินดิเคเตอร์ที่สนับสนุนทิศทางที่อยากแนะนำ (cherry-picking)
- พิจารณาข่าวล่าสุดข้างต้นประกอบด้วย ถ้าข่าวมีผลกระทบสูงต่อทองคำ/สินทรัพย์นี้ (เช่น ผลการประชุม Fed, ตัวเลขเงินเฟ้อ, ความตึงเครียดภูมิรัฐศาสตร์) และ sentiment ขัดแย้งกับสัญญาณทางเทคนิค ให้ลด confidence_percent ลงและระบุความขัดแย้งนี้ใน reasons ห้ามให้ข่าวมีน้ำหนักเกินกว่าข้อมูลราคาจริง แต่ใช้เป็นปัจจัยเสริมความเสี่ยง
- ถ้ามีสถิติจุดที่เคยแพ้บ่อยด้านบน และสถานการณ์ปัจจุบันเข้าเงื่อนไขเดียวกัน ให้ลด confidence_percent ลงและเตือนไว้ใน reasons อย่างชัดเจน
- สรุปแนวโน้ม (trend) และ pattern จากข้อมูลข้างต้นเท่านั้น โดยพิจารณาแนวโน้มกรอบเวลาใหญ่กว่าประกอบด้วยเสมอ (ถ้าแนวโน้มเล็กสวนทางกับแนวโน้มใหญ่ ถือเป็นสัญญาณขัดแย้งที่ต้องลด confidence)
- ใช้ ATR และความผันผวนเฉลี่ยประกอบการประเมินความเสี่ยง และช่วยกำหนดระยะ tp/sl ให้สมเหตุสมผลกับความผันผวนจริง (อย่าตั้ง sl แคบกว่า ATR มากเกินไป)
- ใช้ Stochastic Oscillator (%K, %D) ยืนยันโซน overbought (>80) / oversold (<20) และสัญญาณ crossover
- ใช้ Swing High/Low ประเมินโครงสร้างตลาด (higher high/higher low = ขาขึ้น, lower high/lower low = ขาลง) และใช้เป็นแนวรับ-แนวต้านระยะสั้นประกอบการวาง tp/sl
- ใช้ Pivot Point (P/R1/R2/S1/S2) เป็นแนวรับ-แนวต้านอ้างอิงเพิ่มเติมสำหรับวาง entry/tp/sl แบบ day trading
- ใช้ VWAP ประเมินว่าราคาปัจจุบันอยู่เหนือหรือใต้ราคาเฉลี่ยถ่วงน้ำหนักของตลาด (เหนือ VWAP=โน้มเอียงฝั่งซื้อ, ใต้ VWAP=โน้มเอียงฝั่งขาย)
- ใช้ Volume Profile POC เป็นแนวรับ/แนวต้านที่ราคามีการซื้อขาย/พักตัวมากที่สุด
- ถ้ามี Divergence (RSI) ให้ถือเป็นสัญญาณเตือนการกลับตัวที่สำคัญ และอธิบายไว้ใน reasons อย่างชัดเจนถ้าขัดแย้งกับ trend หลัก
- ถ้ามี Order Block หรือ Fair Value Gap ให้ใช้ระดับราคานั้นประกอบการวาง entry/tp/sl (โซนที่ราคามักย้อนกลับไปทดสอบ)
- ใช้ Supertrend ยืนยันทิศทางเทรนด์หลักเพิ่มเติมจาก EMA cascade
- ใช้โครงสร้างตลาด BOS/CHoCH ประกอบการยืนยันว่าเทรนด์เดิมยังดำเนินต่อ (BOS) หรือมีสัญญาณกลับตัว (CHoCH)
- ถ้ามี Liquidity Sweep ให้ถือเป็นสัญญาณ stop-hunt/reversal ที่สำคัญ (ราคาแทงทะลุ swing high/low ไปกวาดสภาพคล่องแล้วปิดกลับเข้ากรอบ) และใช้ระดับที่ถูกกวาดนั้นประกอบการวาง entry/sl
- ใช้หลัก ICT (Inner Circle Trader): พิจารณาว่าราคาปัจจุบันอยู่โซน Premium หรือ Discount ของ dealing range (Premium=เอนเอียงหาจังหวะขาย, Discount=เอนเอียงหาจังหวะซื้อ, Equilibrium=ยังไม่ชัดเจน) และถ้าราคาอยู่ใน OTE zone (fib retracement 61.8-79% ของ swing leg ล่าสุด) ให้ถือเป็นจุดเข้าที่มีคุณภาพสูงตามหลัก ICT โดยเฉพาะเมื่อสอดคล้องกับ Order Block/FVG/Liquidity Sweep ในทิศทางเดียวกัน (confluence ของ ICT concepts หลายตัวพร้อมกัน = ความมั่นใจสูงขึ้นมาก) ถ้าอยู่ระหว่าง ICT Killzone (London/New York/Asian session) ให้ถือเป็นปัจจัยบวกเสริมความน่าเชื่อถือของสัญญาณ เพราะเป็นช่วงที่สภาพคล่องสถาบันสูง แต่ไม่ใช่เงื่อนไขบังคับ
- ระบบต้องการ ADX>=${adxGate} จึงจะถือว่ามี edge เพียงพอให้เข้าเทรด — ถ้า ADX<${adxGate} ให้เอนเอียงไปทางแนะนำ WAIT/ลด confidence แม้สัญญาณอื่นจะดูดี ระบบนี้ยังต้องการสัญญาณ confluence ระดับ "strong" เท่านั้นจึงจะแนะนำเข้าเทรดจริง (ไม่ใช่แค่ score ≠ 0) — ถ้าคะแนนไม่ถึงเกณฑ์ strong ให้เอนเอียงไปทาง WAIT/ลด confidence แม้ทิศทางจะดูมีเหตุผล
- กำหนด entry ใกล้ราคาปัจจุบัน, tp และ sl โดยอ้างอิงแนวรับ-แนวต้านและ ATR ที่ให้มาจริง (ห้ามให้ tp/sl ขัดกับทิศทางคำแนะนำ) — ตัวเลข entry/tp/sl สุดท้ายที่ผู้ใช้เห็นจะถูกคำนวณใหม่โดยระบบด้วยสูตร SL=ATR×1.5, RR 1:3-1:5 อยู่ดี แต่ให้คุณประมาณค่าที่สมเหตุสมผลไว้ก่อนเพื่อความสอดคล้องของเหตุผลที่อธิบาย
- risk_reward ต้องคำนวณจาก |tp-entry| ต่อ |entry-sl| ให้ตรงกับตัวเลข entry/tp/sl ที่คุณให้จริง
- เขียน detailed_analysis เป็นย่อหน้าภาษาไทยอย่างละเอียด (อย่างน้อย 4-6 ประโยค) อธิบายภาพรวมทั้งหมด: โครงสร้างแนวโน้มหลัก/รอง, โมเมนตัมจาก RSI/MACD/Stochastic, ความผันผวนจาก ATR, และเหตุผลเชิงลึกว่าทำไมจึงให้คำแนะนำ BUY/SELL นี้พร้อมความเสี่ยงที่ควรระวัง

กติกาการให้คะแนน confidence_percent (0-100) พิจารณาจาก "ความสอดคล้องกัน" ของสัญญาณทั้งหมดข้างต้น:
- ถ้า trend, RSI, MACD, EMA20/50 และแท่งเทียนขึ้น/ลง ทุกตัวชี้ไปทิศทางเดียวกันอย่างชัดเจน (confluence สูง) ให้ confidence_percent อยู่ในช่วง 90-99
- ถ้าส่วนใหญ่สอดคล้องกันแต่มี 1 ตัวขัดแย้งหรือไม่ชัดเจน ให้อยู่ในช่วง 70-89
- ถ้าสัญญาณขัดแย้งกันมาก ให้อยู่ในช่วง 40-69 และควรลดขนาดคำแนะนำ (position size) ใน reasons
buy_probability/sell_probability ต้องรวมกันได้ 100 และสอดคล้องกับ confidence_percent (ยิ่ง confidence สูง ส่วนต่างระหว่าง buy/sell ยิ่งควรห่างกันมาก)

ตอบกลับเป็น JSON เท่านั้น ห้ามมีข้อความอื่นใดนอกเหนือจาก JSON วัตถุ ห้ามใส่ code fence ใช้โครงสร้างนี้เป๊ะๆ:
{
  "recommendation": "BUY หรือ SELL",
  "buy_probability": ตัวเลข 0-100,
  "sell_probability": ตัวเลข 0-100,
  "confidence_score": ตัวเลข 0-10 ทศนิยม 1 ตำแหน่ง,
  "confidence_percent": ตัวเลข 0-100,
  "trend": "ข้อความสั้นๆ ภาษาไทย เช่น ขาขึ้น (Uptrend)",
  "pattern": "ชื่อ pattern ที่พบ เช่น Bull Flag",
  "rsi": "${m.rsi.toFixed(1)}",
  "macd": "สถานะ MACD เช่น Bullish Cross",
  "ema_relation": "ความสัมพันธ์ EMA20/50 เช่น EMA20 > EMA50",
  "ema200_relation": "${m.ema200 != null ? 'ตำแหน่งราคาเทียบ EMA200 เช่น ราคาอยู่เหนือ EMA200 (ขาขึ้นระยะยาว)' : 'ไม่มีข้อมูลเพียงพอ'}",
  "volume": "ลักษณะ momentum จากแท่งเทียนขึ้น/ลง",
  "stochastic": "สถานะ Stochastic เช่น %K ตัดขึ้นเหนือ %D ในโซน oversold",
  "swing_structure": "โครงสร้างตลาดจาก Swing High/Low เช่น Higher High / Higher Low (ขาขึ้น) พร้อมระบุราคา swing high/low ล่าสุด",
  "higher_timeframe": "สรุปแนวโน้มกรอบเวลาใหญ่กว่าและว่าสอดคล้องหรือขัดแย้งกับกรอบเวลาปัจจุบัน",
  "divergence": "สรุป divergence ที่พบ (bullish/bearish) หรือ \\"ไม่พบ divergence\\"",
  "smart_money": "สรุป Order Block และ Fair Value Gap ที่พบและนัยต่อ entry/tp/sl หรือ \\"ไม่พบ\\"",
  "supertrend": "สถานะ Supertrend เช่น ขาขึ้น (เขียว) และราคาอยู่เหนือเส้นหรือไม่",
  "structure_break": "สรุปโครงสร้างตลาดและ BOS/CHoCH ที่พบ หรือ \\"ไม่มี BOS/CHoCH ใหม่\\"",
  "liquidity_sweep": "สรุป Liquidity Sweep ที่พบ (ระดับที่ถูกกวาดและทิศทาง reversal) หรือ \\"ไม่พบ\\"",
  "ict_analysis": "สรุปหลัก ICT: โซน Premium/Discount/Equilibrium ปัจจุบัน, อยู่ใน OTE zone หรือไม่, และอยู่ใน Killzone ช่วงไหนหรือไม่ พร้อมนัยต่อ entry/tp/sl",
  "news_summary": "สรุปข่าวสำคัญที่มีผลต่อการตัดสินใจสั้นๆ ภาษาไทย และว่าสอดคล้องหรือขัดแย้งกับสัญญาณเทคนิค (ถ้าไม่มีข่าวสำคัญ ให้ตอบว่า \\"ไม่มีข่าวสำคัญ\\")",
  "entry": ราคาตัวเลข,
  "tp": ราคาตัวเลข,
  "sl": ราคาตัวเลข,
  "risk_reward": "อัตราส่วน เช่น 1 : 2.5",
  "reasons": ["เหตุผลข้อ 1 ภาษาไทย อ้างอิงตัวเลขจริงข้างต้น", "เหตุผลข้อ 2", "..."],
  "detailed_analysis": "ย่อหน้าวิเคราะห์เชิงลึกภาษาไทย อย่างน้อย 4-6 ประโยค ตามที่อธิบายไว้ข้างต้น"
}`;
}

app.listen(PORT, () => {
  console.log(`Gold AI analyzer running at http://localhost:${PORT}`);
});
