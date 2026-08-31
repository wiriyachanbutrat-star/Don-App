'use strict';

const I = require('./indicators');

// ---------------------------------------------------------------------------
// XAUUSD Smart Entry — a top-down multi-timeframe price-action model.
//
//   Trend TF (H4)      → the only thing that sets direction. EMA50 + slope.
//   Structure TF (H1)  → market structure must agree: HH/HL for BUY, LH/LL
//                        for SELL.
//   Entry TF (M15)     → the trade is located here: price at a key swing S/R,
//                        a break of structure, its retest, and a rejection
//                        candle.
//
// One indicator only: EMA50. Everything else is pure price action.
//
// Score out of 9:
//   H4 trend aligned .......... +2
//   H1 structure aligned ...... +2
//   price at key S/R .......... +2
//   break of structure (BOS) .. +1
//   retest of the break ....... +1
//   rejection candle .......... +1
//
//   8–9  STRONG   → tradable
//   6–7  WATCH    → developing, not tradable
//   0–5  NO_TRADE → wait
// ---------------------------------------------------------------------------

const DEFAULTS = {
  rr: 1.6,               // ~35% hit rate on the backtest needs a realistic RR
  atrSlMult: { min: 1.0, max: 3.0, fallback: 1.5 },
  swingBufferAtr: 0.3,
  strongScore: 8,
  watchScore: 6,
  emaSlopeMin: 0.0002,   // EMA50 slope, fraction of price per bar, to call a trend
};

const ASSET_CONFIG = {
  XAU: { ...DEFAULTS },
  BTC: { ...DEFAULTS },
};

// entry TF → { structure TF, trend TF }. Matches the H4/H1/M15 spec when the
// entry TF is 15min; generalised for the other selectable timeframes.
const SIGNAL_STACK = {
  '5min':  { structure: '15min', trend: '1h' },
  '15min': { structure: '1h',    trend: '4h' },
  '30min': { structure: '1h',    trend: '4h' },
  '1h':    { structure: '4h',    trend: '1day' },
  '4h':    { structure: '1day',  trend: '1week' },
  '1day':  { structure: '1week', trend: '1week' },
};

// Kept for backwards compatibility with callers that expect a single "higher"
// timeframe (marketData's stale-cache paths, /api/mtf labels, …).
const HTF_MAP = {
  '1min': '15min', '5min': '15min', '15min': '1h', '30min': '1h',
  '1h': '4h', '4h': '1day', '1day': '1week',
};

function tfStack(interval) { return SIGNAL_STACK[interval] || SIGNAL_STACK['1h']; }
function higherInterval(interval) { return tfStack(interval).structure || HTF_MAP[interval] || '4h'; }
function trendInterval(interval) { return tfStack(interval).trend || '1day'; }
function assetConfig(assetKey) { return ASSET_CONFIG[assetKey] || ASSET_CONFIG.XAU; }

/** EMA50 direction of a candle series: UP / DOWN / NEUTRAL. */
function emaTrend(candles, cfg, period = 50) {
  const closes = candles.map(c => c.close);
  const emaArr = I.emaSeries(closes, period);
  const ema = I.last(emaArr);
  const price = I.last(closes);
  if (ema == null || price == null) return { dir: 'NEUTRAL', ema, slope: 0 };
  const norm = I.slope(emaArr, 8) / ema;
  let dir = 'NEUTRAL';
  if (price > ema && norm > cfg.emaSlopeMin) dir = 'UP';
  else if (price < ema && norm < -cfg.emaSlopeMin) dir = 'DOWN';
  return { dir, ema, slope: norm };
}

/**
 * @param {object} p
 * @param {Array}  p.entryCandles      chronological OHLC on the trading TF
 * @param {Array}  p.structureCandles  chronological OHLC on the structure TF
 * @param {Array}  p.trendCandles      chronological OHLC on the trend TF
 */
function analyze({ assetKey = 'XAU', interval = '1h', entryCandles, structureCandles, trendCandles }) {
  const cfg = assetConfig(assetKey);
  const stack = tfStack(interval);
  const closes = entryCandles.map(c => c.close);
  const n = entryCandles.length;
  const price = closes[n - 1];
  const atr = I.last(I.atrSeries(entryCandles, 14));
  const a1 = isFinite(atr) && atr > 0 ? atr : null;
  const ema50Entry = I.last(I.emaSeries(closes, 50));

  const trend = emaTrend(trendCandles || [], cfg);
  const structTF = I.marketStructure(structureCandles || [], 2);
  const structEntry = I.marketStructure(entryCandles, 2);
  const bar = breakAndRetestFor(entryCandles);

  const trendDirWord = trend.dir === 'UP' ? 'ขาขึ้น (Bullish)' : trend.dir === 'DOWN' ? 'ขาลง (Bearish)' : 'ไม่ชัดเจน';
  const structWord = structTF.trend === 'UP' ? 'HH/HL (ขาขึ้น)' : structTF.trend === 'DOWN' ? 'LH/LL (ขาลง)' : 'sideways';

  const direction = trend.dir === 'UP' ? 'BUY' : trend.dir === 'DOWN' ? 'SELL' : null;

  const checklist = [];
  let score = 0;
  const row = (name, points, got, note) => {
    if (got) score += points;
    checklist.push({ name, points, got: !!got, note });
  };

  if (!direction) {
    checklist.push({ name: 'H4 Trend', points: 2, got: false, note: `เทรนด์ ${stack.trend} ไม่ชัดเจน (ราคาคร่อม EMA50 / ความชันน้อย) — ยังไม่มี setup` });
    return buildResult({ assetKey, interval, stack, price, atr, ema50Entry, trend, trendDirWord, structTF, structWord, structEntry, bar, direction: null, score: 0, checklist, cfg, entryTime: entryCandles[n - 1].time });
  }

  const isBuy = direction === 'BUY';

  // 1) H4 trend — direction came from here, so it's aligned by construction (+2)
  row('H4 Trend', 2, true, `เทรนด์ ${stack.trend} = ${isBuy ? 'ขาขึ้น' : 'ขาลง'} (ราคา${isBuy ? 'เหนือ' : 'ใต้'} EMA50, ความชัน${isBuy ? 'บวก' : 'ลบ'})`);

  // 2) H1 structure aligned (+2)
  const h1Aligned = (isBuy && structTF.trend === 'UP') || (!isBuy && structTF.trend === 'DOWN')
    || (isBuy && structTF.bos === 'UP') || (!isBuy && structTF.bos === 'DOWN');
  row('H1 Structure', 2, h1Aligned,
    h1Aligned ? `โครงสร้าง ${stack.structure} = ${isBuy ? 'Higher High / Higher Low' : 'Lower High / Lower Low'}`
              : `โครงสร้าง ${stack.structure} ยังไม่เป็น ${isBuy ? 'HH/HL' : 'LH/LL'} (${structWord})`);

  // 3) price at a key swing S/R on the entry TF (+2). "At" = within 1 ATR of
  //    the level, OR the last 3 bars wicked into it (a touch-and-go still
  //    counts as trading from the level).
  const srLevel = isBuy
    ? (structEntry.lastLow ? structEntry.lastLow.price : null)
    : (structEntry.lastHigh ? structEntry.lastHigh.price : null);
  let atSR = false;
  if (srLevel != null && a1) {
    const near = Math.abs(price - srLevel) <= a1 * 1.0;
    const last3 = entryCandles.slice(-3);
    const wicked = isBuy
      ? last3.some(c => c.low <= srLevel + a1 * 0.5 && c.close > srLevel)
      : last3.some(c => c.high >= srLevel - a1 * 0.5 && c.close < srLevel);
    atSR = near || wicked;
  }
  row('At S/R', 2, atSR,
    atSR ? `ราคาอยู่ที่แนว${isBuy ? 'รับ' : 'ต้าน'}สำคัญ ${srLevel.toFixed(2)} (swing ${isBuy ? 'low' : 'high'} ล่าสุด)`
         : srLevel != null ? `ราคายังห่างแนว${isBuy ? 'รับ' : 'ต้าน'} ${srLevel.toFixed(2)} (${Math.abs(price - srLevel).toFixed(2)} จุด)` : 'ยังไม่พบ swing S/R ที่ชัดเจน');

  // 4) break of structure on the entry TF in the trade direction (+1)
  const bos = bar.bos === (isBuy ? 'UP' : 'DOWN');
  row('BOS', 1, bos,
    bos ? `Break of Structure ${isBuy ? 'ขาขึ้น' : 'ขาลง'} ที่ ${bar.level != null ? bar.level.toFixed(2) : '-'} (${bar.barsSinceBreak} แท่งก่อน)`
        : 'ยังไม่มี Break of Structure ตามทิศทาง');

  // 5) retest of the broken level (+1)
  const retest = bos && bar.retest;
  row('Retest', 1, retest,
    retest ? `ราคาย่อกลับมาทดสอบระดับ ${bar.level.toFixed(2)} ที่ทะลุ แล้วยืนได้` : 'ยังไม่เห็นการ retest ระดับที่ทะลุ');

  // 6) rejection candle on one of the last 2 closed entry-TF bars (+1)
  const rej = (isBuy
    ? I.isBullishRejection(entryCandles[n - 2], entryCandles[n - 1]) || I.isBullishRejection(entryCandles[n - 3], entryCandles[n - 2])
    : I.isBearishRejection(entryCandles[n - 2], entryCandles[n - 1]) || I.isBearishRejection(entryCandles[n - 3], entryCandles[n - 2]));
  row('Price Action', 1, rej,
    rej ? `แท่ง Rejection ${isBuy ? 'ฝั่งซื้อ (hammer/bullish engulfing)' : 'ฝั่งขาย (shooting star/bearish engulfing)'} ยืนยัน` : 'ยังไม่มีแท่ง Rejection ยืนยันจังหวะเข้า');

  return buildResult({ assetKey, interval, stack, price, atr, ema50Entry, trend, trendDirWord, structTF, structWord, structEntry, bar, direction, score, checklist, srLevel, atSR, bos, retest, rej, cfg, entryTime: entryCandles[n - 1].time });
}

function breakAndRetestFor(candles) {
  const b = I.breakAndRetest(candles, 2);
  return b || { bos: null, level: null, barsSinceBreak: null, retest: false };
}

function buildResult(x) {
  const { interval, stack, price, atr, direction, score, checklist, cfg, entryTime } = x;
  const tier = score >= cfg.strongScore ? 'STRONG' : score >= cfg.watchScore ? 'WATCH' : 'NO_TRADE';
  const tradable = tier === 'STRONG';
  const developing = tier === 'WATCH';
  const confidence = Math.round((score / 9) * 100);

  let waitReason = null;
  if (!direction) {
    waitReason = `เทรนด์ ${stack.trend} ยังไม่ชัดเจน — ระบบเข้าเฉพาะเมื่อ H4 เป็นเทรนด์ชัด`;
  } else if (tier === 'WATCH') {
    waitReason = `Setup ${score}/9 (Watch) — ยังไม่ครบ 8/9 รอ ${missingBits(checklist)}`;
  } else if (tier === 'NO_TRADE') {
    waitReason = `Setup ${score}/9 — เงื่อนไขยังไม่พอ (${missingBits(checklist)})`;
  }

  const levels = buildLevels({ direction, tradable, price, atr, x, cfg });

  const reasons = checklist.map(c => `${c.got ? '✅' : '⬜'} ${c.name} (${c.got ? '+' : ''}${c.got ? c.points : 0}/${c.points}) — ${c.note}`);

  // A stable id for the current setup so clients / the email loop can avoid
  // re-alerting the same setup in the same zone.
  const zone = x.srLevel != null ? Math.round(x.srLevel / (atr && atr > 0 ? atr : 1)) : 'na';
  const setupId = direction ? `${x.assetKey}:${interval}:${direction}:${zone}` : null;

  return {
    assetKey: x.assetKey,
    interval,
    higherInterval: stack.structure,
    trendInterval: stack.trend,
    stack,
    price,
    generatedAt: new Date().toISOString(),
    candleTime: entryTime,
    signal: {
      direction,
      tradable,
      strong: tradable,
      developing,
      tier,
      score,
      net: direction ? (direction === 'BUY' ? score : -score) : 0,
      maxScore: 9,
      maxWeight: 9,
      totalWeight: 9,
      strongThreshold: cfg.strongScore,
      confidence,
      against200: false,
      setupId,
      waitReason,
      reasons,
      checklist,
    },
    levels,
    indicators: {
      ema50: x.ema50Entry,
      ema50Entry: x.ema50Entry,
      atr,
      trendTF: { tf: stack.trend, direction: x.trend.dir, ema50: x.trend.ema, label: x.trendDirWord },
      structureTF: { tf: stack.structure, direction: x.structTF.trend, label: x.structWord },
      srLevel: x.srLevel != null ? x.srLevel : null,
      atSR: !!x.atSR,
      bos: x.bar.bos, bosLevel: x.bar.level, retest: !!x.retest,
      rejection: !!x.rej,
      support: x.structEntry.lastLow ? x.structEntry.lastLow.price : null,
      resistance: x.structEntry.lastHigh ? x.structEntry.lastHigh.price : null,
    },
    structure: x.structEntry,
    regime: { direction: x.trend.dir, label: x.trendDirWord, ema50: x.trend.ema },
  };
}

function missingBits(checklist) {
  const miss = checklist.filter(c => !c.got).map(c => c.name);
  return miss.length ? miss.join(', ') : '—';
}

function buildLevels({ direction, tradable, price, atr, x, cfg }) {
  if (!direction || !isFinite(price)) {
    return { entry: null, sl: null, tp: null, slDistance: null, tpDistance: null, riskReward: null, slBasis: null };
  }
  const isBuy = direction === 'BUY';
  const a = isFinite(atr) && atr > 0 ? atr : null;
  const buffer = a ? a * cfg.swingBufferAtr : 0;

  // SL sits beyond the swing S/R the setup formed at (or the entry-TF last
  // swing), clamped to a sane ATR band.
  let slAnchor = null, slBasis = null;
  const swingLow = x.structEntry.lastLow ? x.structEntry.lastLow.price : null;
  const swingHigh = x.structEntry.lastHigh ? x.structEntry.lastHigh.price : null;
  if (isBuy) {
    const ref = (x.srLevel != null && x.srLevel < price) ? x.srLevel : (swingLow != null && swingLow < price ? swingLow : null);
    if (ref != null) { slAnchor = ref - buffer; slBasis = 'ใต้ Swing Low / แนวรับ'; }
  } else {
    const ref = (x.srLevel != null && x.srLevel > price) ? x.srLevel : (swingHigh != null && swingHigh > price ? swingHigh : null);
    if (ref != null) { slAnchor = ref + buffer; slBasis = 'เหนือ Swing High / แนวต้าน'; }
  }

  let slDistance;
  if (slAnchor != null && Math.abs(price - slAnchor) > 0) {
    slDistance = Math.abs(price - slAnchor);
  } else if (a) {
    slDistance = a * cfg.atrSlMult.fallback;
    slBasis = `ATR × ${cfg.atrSlMult.fallback}`;
  } else {
    return { entry: price, sl: null, tp: null, slDistance: null, tpDistance: null, riskReward: null, slBasis: null };
  }

  if (a) {
    const minD = a * cfg.atrSlMult.min, maxD = a * cfg.atrSlMult.max;
    if (slDistance < minD) { slDistance = minD; slBasis += ` (ขยายเป็น ATR × ${cfg.atrSlMult.min})`; }
    else if (slDistance > maxD) { slDistance = maxD; slBasis += ` (จำกัดที่ ATR × ${cfg.atrSlMult.max})`; }
  }

  // TP: fixed RR, or the opposing entry-TF swing if that's farther — but never
  // beyond 3R (a target price rarely reaches doesn't help the expectancy).
  let tpDistance = slDistance * cfg.rr;
  let tpBasis = `RR 1:${cfg.rr}`;
  const opp = isBuy ? swingHigh : swingLow;
  if (opp != null) {
    const oppDist = Math.abs(opp - price);
    if (oppDist > tpDistance && oppDist <= slDistance * 3 && (isBuy ? opp > price : opp < price)) {
      tpDistance = oppDist;
      tpBasis = `swing ${isBuy ? 'high' : 'low'} ตรงข้าม`;
    }
  }

  const sl = isBuy ? price - slDistance : price + slDistance;
  const tp = isBuy ? price + tpDistance : price - tpDistance;
  return {
    entry: price, sl, tp,
    slDistance, tpDistance,
    riskReward: `1 : ${(tpDistance / slDistance).toFixed(2)}`,
    slBasis, tpBasis,
  };
}

module.exports = {
  analyze, emaTrend, tfStack, higherInterval, trendInterval,
  assetConfig, ASSET_CONFIG, SIGNAL_STACK, HTF_MAP,
};
