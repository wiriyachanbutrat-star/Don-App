'use strict';

const { analyze, higherInterval } = require('./strategy');

// ---------------------------------------------------------------------------
// Twelve Data fetch layer with two caches:
//   rawSeriesCache   — raw candle series keyed by asset+interval, so several
//                      timeframes sharing the same HTF (e.g. 15m/30m/1h all
//                      pull 4h) don't each re-spend an API credit.
//   analysisCache    — the fully computed analysis payload per asset+interval.
// An in-flight map dedupes concurrent identical fetches (the MTF endpoint
// fires many at once via Promise.all).
// ---------------------------------------------------------------------------

const ASSETS = {
  XAU: { symbol: 'XAU/USD', label: 'ทองคำ (XAU/USD)' },
  BTC: { symbol: 'BTC/USD', label: 'บิตคอยน์ (BTC/USD)' },
};

// Intervals a client may request as the *trading* timeframe. '1week' is only
// ever used as a higher-timeframe target (see strategy.HTF_MAP), never here.
const VALID_INTERVALS = ['1min', '5min', '15min', '30min', '1h', '4h', '1day'];
const OUTPUT_SIZE = 320; // enough for EMA200 + ADX smoothing headroom

// Twelve Data free tier is 8 credits/min AND ~800/day. Each raw series is one
// credit; the dashboard touches several timeframes. 5-minute caches keep an
// open tab well under both limits — intraday 15m/1h candles don't meaningfully
// change second-to-second anyway.
const RAW_TTL_MS = 5 * 60 * 1000;
const ANALYSIS_TTL_MS = 5 * 60 * 1000;

const rawSeriesCache = new Map();
const rawSeriesInflight = new Map();
const analysisCache = new Map();

let apiKey = process.env.TWELVE_DATA_API_KEY;
function setApiKey(k) { apiKey = k; }

async function fetchRawSeries(symbol, interval) {
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY');
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', String(OUTPUT_SIZE));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.status === 'error') {
    throw new Error(data.message || `เรียกข้อมูล ${symbol} ${interval} ไม่สำเร็จ`);
  }
  if (!Array.isArray(data.values) || data.values.length === 0) {
    throw new Error(`ไม่มีข้อมูลราคา ${symbol} ${interval}`);
  }
  // Twelve Data returns newest-first — flip to chronological and coerce.
  const candles = data.values.slice().reverse().map(c => ({
    time: c.datetime,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  })).filter(c => isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
  if (candles.length < 30) throw new Error(`ข้อมูลราคา ${symbol} ${interval} น้อยเกินไป (${candles.length} แท่ง)`);
  return candles;
}

function getRawSeriesCached(assetKey, interval) {
  const key = `${assetKey}:${interval}`;
  const cached = rawSeriesCache.get(key);
  if (cached && Date.now() - cached.time < RAW_TTL_MS) return Promise.resolve(cached.candles);
  if (rawSeriesInflight.has(key)) return rawSeriesInflight.get(key);

  const symbol = ASSETS[assetKey].symbol;
  const p = fetchRawSeries(symbol, interval)
    .then(candles => {
      rawSeriesCache.set(key, { time: Date.now(), candles });
      rawSeriesInflight.delete(key);
      return candles;
    })
    .catch(err => {
      rawSeriesInflight.delete(key);
      throw err;
    });
  rawSeriesInflight.set(key, p);
  return p;
}

/**
 * Full analysis for one asset+interval. Serves a slightly stale cached
 * payload rather than a hard error if Twelve Data is momentarily unreachable.
 */
async function getAnalysis(assetKey, interval) {
  if (!ASSETS[assetKey]) assetKey = 'XAU';
  if (!VALID_INTERVALS.includes(interval)) interval = '1h';

  const cacheKey = `${assetKey}:${interval}`;
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.time < ANALYSIS_TTL_MS) {
    return { ...cached.data, fromCache: true };
  }

  try {
    const htfInterval = higherInterval(interval);
    const [candles, htfCandles] = await Promise.all([
      getRawSeriesCached(assetKey, interval),
      getRawSeriesCached(assetKey, htfInterval),
    ]);
    const result = analyze({ assetKey, interval, candles, htfCandles });
    result.assetLabel = ASSETS[assetKey].label;
    result.recentCandles = candles.slice(-60);
    analysisCache.set(cacheKey, { time: Date.now(), data: result });
    return { ...result, fromCache: false };
  } catch (err) {
    if (cached) return { ...cached.data, fromCache: true, stale: true, staleError: err.message };
    throw err;
  }
}

module.exports = { ASSETS, VALID_INTERVALS, getAnalysis, getRawSeriesCached, setApiKey };
