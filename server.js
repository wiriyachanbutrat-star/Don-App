require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const MARKETAUX_API_KEY = process.env.MARKETAUX_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

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

async function fetchGoldNews(assetKey) {
  if (!MARKETAUX_API_KEY) return [];

  const cached = newsCache.get(assetKey);
  if (cached && Date.now() - cached.time < NEWS_CACHE_MS) return cached.articles;

  const symbols = assetKey === 'BTC' ? 'BTC/USD' : 'XAU/USD';
  const search = assetKey === 'BTC' ? 'bitcoin OR crypto' : 'gold OR XAUUSD OR "Federal Reserve"';
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

function rsi(closes, period = 14) {
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

function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdValues = macdLine.filter(v => v != null);
  const signalSeries = ema(macdValues, 9);
  const signal = signalSeries[signalSeries.length - 1];
  const macdNow = macdValues[macdValues.length - 1];
  return { macd: macdNow, signal, histogram: macdNow - signal };
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

function bollingerBands(closes, period = 20, mult = 2) {
  const middle = sma(closes, period);
  const idx = closes.length - 1;
  const mid = middle[idx];
  const slice = closes.slice(idx - period + 1, idx + 1);
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - mid, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { middle: mid, upper: mid + mult * stdDev, lower: mid - mult * stdDev, stdDev };
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
  const recentDx = dxValues.slice(-period);
  return recentDx.reduce((a, b) => a + b, 0) / recentDx.length;
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
  return { k, d };
}

function computeSignalScore(m) {
  const reasons = [];

  // EMA20/50, MACD histogram and higher-timeframe trend are all trend-following
  // and tend to move together, so counting each separately inflates the score
  // during ordinary trending markets (exactly when trend indicators lag a reversal
  // the most). Collapse them into a single trend vote instead.
  let trendVotes = 0;
  if (m.ema20 > m.ema50) { trendVotes += 1; reasons.push('EMA20>EMA50 (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('EMA20<EMA50 (trend vote sell)'); }

  if (m.macd.histogram > 0) { trendVotes += 1; reasons.push('MACD histogram>0 (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('MACD histogram<0 (trend vote sell)'); }

  if (m.higherTimeframe.trend.includes('Uptrend')) { trendVotes += 1; reasons.push('Higher timeframe uptrend (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('Higher timeframe downtrend (trend vote sell)'); }

  // EMA200 is the standard long-term trend filter; only vote when we have
  // enough history (200 candles) to compute it.
  if (m.ema200 != null) {
    if (m.currentPrice > m.ema200) { trendVotes += 1; reasons.push('Price>EMA200 (trend vote buy)'); }
    else { trendVotes -= 1; reasons.push('Price<EMA200 (trend vote sell)'); }
  }

  let score = 0;
  if (trendVotes >= 2) { score += 1; reasons.push('=> Trend confluence BUY (+1)'); }
  else if (trendVotes <= -2) { score -= 1; reasons.push('=> Trend confluence SELL (+1)'); }
  else { reasons.push('=> Trend confluence mixed (0)'); }

  // EMA200 is the long-term trend filter and is meant to be a hard veto, not
  // just one vote among several correlated trend indicators — otherwise a
  // "strong" score can still fire straight into the dominant long-term trend.
  const ema200Direction = m.ema200 != null ? (m.currentPrice > m.ema200 ? 'BUY' : 'SELL') : null;

  if (m.rsi >= 55) { score += 1; reasons.push('RSI>=55 (+1 buy)'); }
  else if (m.rsi <= 45) { score -= 1; reasons.push('RSI<=45 (+1 sell)'); }
  else { reasons.push('RSI neutral (0)'); }

  if (m.stochastic.k > m.stochastic.d && m.stochastic.k < 80) { score += 1; reasons.push('Stoch %K>%D not overbought (+1 buy)'); }
  else if (m.stochastic.k < m.stochastic.d && m.stochastic.k > 20) { score -= 1; reasons.push('Stoch %K<%D not oversold (+1 sell)'); }
  else { reasons.push('Stochastic neutral (0)'); }

  const candleDiff = m.candleCounts.up - m.candleCounts.down;
  if (candleDiff >= 3) { score += 1; reasons.push('More up candles recently (+1 buy)'); }
  else if (candleDiff <= -3) { score -= 1; reasons.push('More down candles recently (+1 sell)'); }
  else { reasons.push('Candle count neutral (0)'); }

  // RSI divergence is a reversal signal that trend-following votes above can't
  // see (price and momentum are actively disagreeing), so it gets its own point.
  if (m.divergence) {
    if (m.divergence.bullish) { score += 1; reasons.push('Bullish RSI divergence (+1 buy)'); }
    else if (m.divergence.bearish) { score -= 1; reasons.push('Bearish RSI divergence (+1 sell)'); }
    else { reasons.push('No RSI divergence (0)'); }
  }

  const direction = score > 0 ? 'BUY' : score < 0 ? 'SELL' : null;
  const against200 = ema200Direction != null && direction != null && direction !== ema200Direction;
  if (against200) { reasons.push(`=> ทิศทาง ${direction} สวนทาง EMA200 (long-term trend) — ต้องใช้ threshold สูงขึ้นจึงจะถือว่าสัญญาณแรง`); }
  // Require a higher bar (all 4 points) to call a signal "strong" when it goes
  // against EMA200, instead of the normal 3-of-4 threshold.
  const strong = against200 ? Math.abs(score) >= 4 : Math.abs(score) >= 3;

  // ADX < 18 means the market has no real trend (choppy/sideways) — trading
  // trend-following signals here is where this system loses most, regardless
  // of which direction it picks. Combined with a weak confluence score
  // (|score|<=1), there's no real edge, so mark the setup as not tradable
  // instead of forcing a BUY/SELL call.
  const choppy = m.adx != null && m.adx < 20;
  const weakScore = Math.abs(score) <= 2;
  let tradable = true;
  let waitReason = null;
  if (choppy && weakScore) {
    tradable = false;
    waitReason = `ADX=${m.adx.toFixed(1)} (<20, ตลาดไม่มีเทรนด์ชัดเจน) และสัญญาณอ่อน/กลางๆ (score=${score}) — ไม่มี edge เพียงพอให้เข้าเทรด`;
  } else if (m.adx != null && m.adx < 12) {
    tradable = false;
    waitReason = `ADX=${m.adx.toFixed(1)} (<12, ตลาดไซด์เวย์ชัดเจน) — ไม่แนะนำเข้าเทรดไม่ว่าสัญญาณจะชี้ทางไหน`;
  } else if (score === 0) {
    tradable = false;
    waitReason = `สัญญาณ BUY/SELL หักล้างกันพอดี (score=0) — ไม่มีทิศทางที่ชัดเจนพอให้เข้าเทรด`;
  }
  if (waitReason) reasons.push(`=> WAIT: ${waitReason}`);

  return { score, direction, strong, against200, reasons, maxScore: m.divergence ? 5 : 4, tradable, waitReason, adx: m.adx };
}

// Classical (Floor Trader) pivot points computed from the prior period's H/L/C.
// Gives static support/resistance levels independent of the lookback-window
// max/min used elsewhere, useful for day-trading style entries.
function pivotPoints(candles) {
  if (candles.length < 2) return null;
  const prev = candles[candles.length - 2];
  const pivot = (prev.high + prev.low + prev.close) / 3;
  const r1 = 2 * pivot - prev.low;
  const s1 = 2 * pivot - prev.high;
  const r2 = pivot + (prev.high - prev.low);
  const s2 = pivot - (prev.high - prev.low);
  return { pivot, r1, r2, s1, s2 };
}

// VWAP anchored to the visible window. Twelve Data doesn't return real volume
// for spot FX/metals, so when volume is missing/zero for every candle we fall
// back to an unweighted typical-price average and flag it as an approximation
// rather than silently pretending it's volume-weighted.
function vwap(candles) {
  const hasVolume = candles.some(c => c.volume > 0);
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const w = hasVolume ? c.volume : 1;
    cumPV += typical * w;
    cumV += w;
  }
  return { value: cumV > 0 ? cumPV / cumV : null, approx: !hasVolume };
}

// Volume Profile Point of Control: the price bucket with the most traded
// volume (or, without real volume data, the most time spent) over the window.
// Falls back to a time-at-price proxy for the same reason as vwap() above.
function volumeProfile(candles, buckets = 20) {
  const hasVolume = candles.some(c => c.volume > 0);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  if (!(max > min)) return null;
  const bucketSize = (max - min) / buckets;
  const weights = new Array(buckets).fill(0);
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((typical - min) / bucketSize)));
    weights[idx] += hasVolume ? c.volume : 1;
  }
  let pocIdx = 0;
  for (let i = 1; i < buckets; i++) if (weights[i] > weights[pocIdx]) pocIdx = i;
  const poc = min + bucketSize * (pocIdx + 0.5);
  return { poc, approx: !hasVolume };
}

// Regular divergence: price makes a lower low / higher high while the
// oscillator (RSI here) makes the opposite, using the two most recent swing
// points from swingPoints(). Signals a likely reversal that trend-following
// indicators (EMA/MACD) won't see coming.
function detectDivergence(candles, closes, wing = 3) {
  const swingLows = [], swingHighs = [];
  for (let i = candles.length - 1 - wing; i >= wing; i--) {
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

app.get('/api/market-data', async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const interval = ['1min', '5min', '15min', '1h', '4h', '1day'].includes(req.query.interval)
    ? req.query.interval
    : '1h';
  const assetKey = ASSETS[req.query.asset] ? req.query.asset : 'XAU';
  const asset = ASSETS[assetKey];

  const higherIntervalMap = { '1min': '15min', '5min': '1h', '15min': '4h', '1h': '4h', '4h': '1day', '1day': '1week' };
  const higherInterval = higherIntervalMap[interval] || '4h';

  try {
    const [series, higherSeries] = await Promise.all([
      fetchTwelveData('time_series', { symbol: asset.symbol, interval, outputsize: 210 }),
      fetchTwelveData('time_series', { symbol: asset.symbol, interval: higherInterval, outputsize: 150 }),
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

    res.json({
      symbol: asset.symbol,
      assetKey,
      assetLabel: asset.label,
      interval,
      currentPrice,
      support,
      resistance,
      candleCounts: { up: recentUp, down: recentDown },
      recentCandles: recent,
      rsi: rsi(closes),
      macd: macd(closes),
      ema20: ema20Series[ema20Series.length - 1],
      ema50: ema50Series[ema50Series.length - 1],
      ema200: ema200Series ? ema200Series[ema200Series.length - 1] : null,
      bollinger: bollingerBands(closes),
      atr: atr(candles),
      adx: adx(candles),
      stochastic: stochasticOscillator(candles),
      swing: swingPoints(candles),
      volatility: volatilityStats(candles),
      pivot: pivotPoints(candles),
      vwap: vwap(candles.slice(-30)),
      volumeProfile: volumeProfile(candles.slice(-60)),
      divergence: detectDivergence(candles, closes),
      smc: orderBlocksAndFvg(candles),
      higherTimeframe: {
        interval: higherInterval,
        trend: higherTrend,
        ema20: higherEma20,
        ema50: higherEma50,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'ดึงราคาจริงไม่สำเร็จ: ' + err.message });
  }
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
      return m.ema20 != null && m.ema50 != null
        ? (direction === 'BUY' ? m.ema20 < m.ema50 : m.ema20 > m.ema50)
        : false;
    default:
      return false;
  }
}

app.post('/api/analyze', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์' });
  }

  const { marketData } = req.body || {};
  if (!marketData) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลราคาทองส่งมาให้วิเคราะห์' });
  }

  const signal = computeSignalScore(marketData);
  const assetLabel = marketData.assetLabel || ASSETS[marketData.assetKey]?.label || ASSETS.XAU.label;
  const news = await fetchGoldNews(marketData.assetKey || 'XAU');
  const lossPatterns = Array.isArray(req.body.lossPatterns) ? req.body.lossPatterns : [];
  const prompt = buildPrompt(marketData, signal, assetLabel, news, lossPatterns);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            response_mime_type: 'application/json',
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'เรียก Gemini API ไม่สำเร็จ' });
    }

    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'ไม่ได้รับข้อความตอบกลับจาก AI' });
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
        // actually agree (score 3 of 4 vs. all 4) instead of a flat 65/35 for
        // every override regardless of signal strength.
        const magnitude = Math.abs(signal.score); // 3 or 4 given strong threshold
        const skew = 60 + (magnitude - 3) * 10; // 3 -> 60, 4 -> 70
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

      // Deterministic news-sentiment weighting: Marketaux gives a per-article
      // sentiment score, but the prompt only asked the AI to "consider" it as
      // prose, which it may or may not actually act on. Average the real
      // sentiment scores and cap confidence when they clearly contradict the
      // final call, the same way the loss-pattern check does.
      const sentimentScores = news.filter(a => a.sentiment != null).map(a => a.sentiment);
      if (sentimentScores.length) {
        const avgSentiment = sentimentScores.reduce((a, b) => a + b, 0) / sentimentScores.length;
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
${m.ema200 != null ? `EMA200: ${m.ema200.toFixed(2)}\n` : ''}Bollinger Bands (20,2): upper=${m.bollinger.upper.toFixed(2)}, middle=${m.bollinger.middle.toFixed(2)}, lower=${m.bollinger.lower.toFixed(2)}
ATR (14): ${m.atr.toFixed(2)} (วัดความผันผวนเฉลี่ยต่อแท่ง)
${m.adx != null ? `ADX (14): ${m.adx.toFixed(1)} (<18 = ไม่มีเทรนด์ชัดเจน/ไซด์เวย์, >25 = เทรนด์แข็งแรง)\n` : ''}
Stochastic Oscillator: %K=${m.stochastic.k.toFixed(2)}, %D=${m.stochastic.d.toFixed(2)}
${m.swing ? `Swing High ล่าสุด (จุดกลับตัวขาขึ้น→ลง): ${m.swing.high ? `${m.swing.high.price} (${m.swing.high.barsAgo} แท่งก่อนหน้า)` : 'ไม่พบในช่วงข้อมูล'}\nSwing Low ล่าสุด (จุดกลับตัวขาลง→ขึ้น): ${m.swing.low ? `${m.swing.low.price} (${m.swing.low.barsAgo} แท่งก่อนหน้า)` : 'ไม่พบในช่วงข้อมูล'}\n` : ''}
ความผันผวน 20 แท่งล่าสุด: ช่วงราคาเฉลี่ย/แท่ง=${m.volatility.avgRange.toFixed(2)}, สัดส่วนตัวแท่งเทียนเฉลี่ย=${(m.volatility.avgBodyRatio*100).toFixed(1)}%
แนวโน้มกรอบเวลาใหญ่กว่า (${m.higherTimeframe.interval}): ${m.higherTimeframe.trend} (EMA20=${m.higherTimeframe.ema20.toFixed(2)}, EMA50=${m.higherTimeframe.ema50.toFixed(2)})
${m.pivot ? `Pivot Point: P=${m.pivot.pivot.toFixed(2)}, R1=${m.pivot.r1.toFixed(2)}, R2=${m.pivot.r2.toFixed(2)}, S1=${m.pivot.s1.toFixed(2)}, S2=${m.pivot.s2.toFixed(2)}\n` : ''}${m.vwap && m.vwap.value != null ? `VWAP${m.vwap.approx ? ' (โดยประมาณ ไม่มีข้อมูล volume จริง)' : ''}: ${m.vwap.value.toFixed(2)} (ราคาปัจจุบัน${m.currentPrice > m.vwap.value ? 'อยู่เหนือ' : 'อยู่ใต้'} VWAP)\n` : ''}${m.volumeProfile ? `Volume Profile POC${m.volumeProfile.approx ? ' (โดยประมาณจากเวลาที่ราคาพักอยู่ เพราะไม่มี volume จริง)' : ''}: ${m.volumeProfile.poc.toFixed(2)}\n` : ''}${m.divergence && (m.divergence.bullish || m.divergence.bearish) ? `Divergence: ${m.divergence.bullish ? `Bullish (ราคาทำ low ใหม่ต่ำกว่าเดิมที่ ${m.divergence.bullish.recentPrice} แต่ RSI สูงขึ้น)` : `Bearish (ราคาทำ high ใหม่สูงกว่าเดิมที่ ${m.divergence.bearish.recentPrice} แต่ RSI ต่ำลง)`}\n` : ''}${m.smc ? `Order Block: ${m.smc.bullishOB ? `Bullish OB ${m.smc.bullishOB.low.toFixed(2)}-${m.smc.bullishOB.high.toFixed(2)}` : 'ไม่พบ'} / ${m.smc.bearishOB ? `Bearish OB ${m.smc.bearishOB.low.toFixed(2)}-${m.smc.bearishOB.high.toFixed(2)}` : 'ไม่พบ'}\nFair Value Gap: ${m.smc.bullishFvg ? `Bullish FVG ${m.smc.bullishFvg.gapLow.toFixed(2)}-${m.smc.bullishFvg.gapHigh.toFixed(2)}` : 'ไม่พบ'} / ${m.smc.bearishFvg ? `Bearish FVG ${m.smc.bearishFvg.gapLow.toFixed(2)}-${m.smc.bearishFvg.gapHigh.toFixed(2)}` : 'ไม่พบ'}\n` : ''}

หน้าที่ของคุณ:
- พิจารณาข่าวล่าสุดข้างต้นประกอบด้วย ถ้าข่าวมีผลกระทบสูงต่อทองคำ/สินทรัพย์นี้ (เช่น ผลการประชุม Fed, ตัวเลขเงินเฟ้อ, ความตึงเครียดภูมิรัฐศาสตร์) และ sentiment ขัดแย้งกับสัญญาณทางเทคนิค ให้ลด confidence_percent ลงและระบุความขัดแย้งนี้ใน reasons ห้ามให้ข่าวมีน้ำหนักเกินกว่าข้อมูลราคาจริง แต่ใช้เป็นปัจจัยเสริมความเสี่ยง
- ถ้ามีสถิติจุดที่เคยแพ้บ่อยด้านบน และสถานการณ์ปัจจุบันเข้าเงื่อนไขเดียวกัน ให้ลด confidence_percent ลงและเตือนไว้ใน reasons อย่างชัดเจน
- สรุปแนวโน้ม (trend) และ pattern จากข้อมูลข้างต้นเท่านั้น โดยพิจารณาแนวโน้มกรอบเวลาใหญ่กว่าประกอบด้วยเสมอ (ถ้าแนวโน้มเล็กสวนทางกับแนวโน้มใหญ่ ถือเป็นสัญญาณขัดแย้งที่ต้องลด confidence)
- ใช้ Bollinger Bands ประเมินว่าราคาอยู่ใกล้ขอบบน/ล่าง/กลาง (โซน overbought/oversold หรือ breakout)
- ใช้ ATR และความผันผวนเฉลี่ยประกอบการประเมินความเสี่ยง และช่วยกำหนดระยะ tp/sl ให้สมเหตุสมผลกับความผันผวนจริง (อย่าตั้ง sl แคบกว่า ATR มากเกินไป)
- ใช้ Stochastic Oscillator (%K, %D) ยืนยันโซน overbought (>80) / oversold (<20) และสัญญาณ crossover
- ใช้ Swing High/Low ประเมินโครงสร้างตลาด (higher high/higher low = ขาขึ้น, lower high/lower low = ขาลง) และใช้เป็นแนวรับ-แนวต้านระยะสั้นประกอบการวาง tp/sl
- ใช้ Pivot Point (P/R1/R2/S1/S2) เป็นแนวรับ-แนวต้านอ้างอิงเพิ่มเติมสำหรับวาง entry/tp/sl แบบ day trading
- ใช้ VWAP ประเมินว่าราคาปัจจุบันอยู่เหนือหรือใต้ราคาเฉลี่ยถ่วงน้ำหนักของตลาด (เหนือ VWAP=โน้มเอียงฝั่งซื้อ, ใต้ VWAP=โน้มเอียงฝั่งขาย)
- ใช้ Volume Profile POC เป็นแนวรับ/แนวต้านที่ราคามีการซื้อขาย/พักตัวมากที่สุด
- ถ้ามี Divergence (RSI) ให้ถือเป็นสัญญาณเตือนการกลับตัวที่สำคัญ และอธิบายไว้ใน reasons อย่างชัดเจนถ้าขัดแย้งกับ trend หลัก
- ถ้ามี Order Block หรือ Fair Value Gap ให้ใช้ระดับราคานั้นประกอบการวาง entry/tp/sl (โซนที่ราคามักย้อนกลับไปทดสอบ)
- กำหนด entry ใกล้ราคาปัจจุบัน, tp และ sl โดยอ้างอิงแนวรับ-แนวต้านและ ATR ที่ให้มาจริง (ห้ามให้ tp/sl ขัดกับทิศทางคำแนะนำ)
- risk_reward ต้องคำนวณจาก |tp-entry| ต่อ |entry-sl| ให้ตรงกับตัวเลข entry/tp/sl ที่คุณให้จริง
- เขียน detailed_analysis เป็นย่อหน้าภาษาไทยอย่างละเอียด (อย่างน้อย 4-6 ประโยค) อธิบายภาพรวมทั้งหมด: โครงสร้างแนวโน้มหลัก/รอง, ตำแหน่งราคาเทียบ Bollinger Bands, โมเมนตัมจาก RSI/MACD/Stochastic, ความผันผวนจาก ATR, และเหตุผลเชิงลึกว่าทำไมจึงให้คำแนะนำ BUY/SELL นี้พร้อมความเสี่ยงที่ควรระวัง

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
  "bollinger": "ตำแหน่งราคาเทียบ Bollinger Bands เช่น ราคาใกล้ขอบบน (overbought zone)",
  "stochastic": "สถานะ Stochastic เช่น %K ตัดขึ้นเหนือ %D ในโซน oversold",
  "swing_structure": "โครงสร้างตลาดจาก Swing High/Low เช่น Higher High / Higher Low (ขาขึ้น) พร้อมระบุราคา swing high/low ล่าสุด",
  "higher_timeframe": "สรุปแนวโน้มกรอบเวลาใหญ่กว่าและว่าสอดคล้องหรือขัดแย้งกับกรอบเวลาปัจจุบัน",
  "pivot_point": "สรุประดับ pivot/R1/R2/S1/S2 ที่เกี่ยวข้องกับการวาง entry/tp/sl",
  "vwap_relation": "ตำแหน่งราคาปัจจุบันเทียบ VWAP เช่น ราคาอยู่เหนือ VWAP (โน้มเอียงฝั่งซื้อ)",
  "volume_profile": "สรุประดับ POC (Volume Profile) และนัยสำคัญต่อแนวรับ-แนวต้าน",
  "divergence": "สรุป divergence ที่พบ (bullish/bearish) หรือ \\"ไม่พบ divergence\\"",
  "smart_money": "สรุป Order Block และ Fair Value Gap ที่พบและนัยต่อ entry/tp/sl หรือ \\"ไม่พบ\\"",
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
