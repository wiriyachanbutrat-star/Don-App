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
// Score out of 9 — the four core price-action reads (Breakout, Pullback,
// Action Zone, QM) carry the weight; H4/H1 are context:
//   H4 trend aligned .......... +2   (context — sets direction)
//   H1 structure aligned ...... +1   (context)
//   ACTION ZONE (at key S/R) .. +2
//   BREAKOUT (BOS) ............ +1
//   PULLBACK (retest) ........ +1
//   QM pattern ............... +1
//   rejection candle ......... +1
//
//   8–9  STRONG   → tradable
//   6–7  WATCH    → developing, not tradable
//   0–5  NO_TRADE → wait
// ---------------------------------------------------------------------------

const DEFAULTS = {
  rr: 1.6,               // ~35% hit rate on the backtest needs a realistic RR
  atrSlMult: { min: 1.0, max: 3.0, fallback: 1.5 },
  swingBufferAtr: 0.3,
  strongScore: 8,        // BUY: 8/9 to trade
  strongScoreShort: 9,   // SELL: 9/9 — backtest shows shorts underperform on
                         //   the lower TFs; make the bar a full house
  watchScore: 6,
  emaSlopeMin: 0.0002,   // EMA50 slope, fraction of price per bar, to call a trend
  // Trade only while London + New York are active (UTC hours, inclusive
  // start, exclusive end). Gold's clean trends happen here; the Asian session
  // chops. Backtest-tuned; set enabled:false to take every hour.
  session: { enabled: true, startUTC: 7, endUTC: 21 },
  srZoneTolAtr: 0.35,    // swing pivots within this many ATR merge into one zone
  srNearAtr: 1.0,        // "at" a zone = price within this many ATR of it
  roundStep: 25,         // gold respects $25 / $50 round numbers
};

const ASSET_CONFIG = {
  XAU: { ...DEFAULTS },
  // Crypto trades 24/7 and ignores round numbers the same way — no session
  // gate, wider round step.
  BTC: { ...DEFAULTS, session: { enabled: false, startUTC: 0, endUTC: 24 }, roundStep: 1000, strongScoreShort: 8 },
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
 * Moving-average stack read (fast→slow: EMA 9 / 21 / 50 / 200 + price).
 * A fully stacked bull tape is Price > 9 > 21 > 50 > 200; bear is the mirror.
 * `aligned` (0..4) counts consecutive fast-to-slow relationships in the
 * dominant direction — 4 = perfect, 3 = strong, <3 = mixed / choppy.
 */
function maStackState(price, e9, e21, e50, e200) {
  const vals = [price, e9, e21, e50, e200];
  if (vals.some(v => v == null || !isFinite(v))) {
    return { dir: 'NA', aligned: 0, label: 'MA ยังคำนวณไม่ครบ (ข้อมูลสั้น)', ema9: e9, ema21: e21, ema50: e50, ema200: e200 };
  }
  const upSeq = (price > e9 ? 1 : 0) + (e9 > e21 ? 1 : 0) + (e21 > e50 ? 1 : 0) + (e50 > e200 ? 1 : 0);
  const downSeq = (price < e9 ? 1 : 0) + (e9 < e21 ? 1 : 0) + (e21 < e50 ? 1 : 0) + (e50 < e200 ? 1 : 0);
  let dir, aligned, label;
  if (upSeq === 4) { dir = 'UP'; aligned = 4; label = 'MA เรียงตัวขาขึ้นสมบูรณ์ (ราคา>9>21>50>200)'; }
  else if (downSeq === 4) { dir = 'DOWN'; aligned = 4; label = 'MA เรียงตัวขาลงสมบูรณ์ (ราคา<9<21<50<200)'; }
  else if (upSeq >= downSeq) { dir = upSeq >= 3 ? 'UP' : 'MIXED'; aligned = upSeq; label = `MA เรียงตัวขาขึ้นบางส่วน (${upSeq}/4)`; }
  else { dir = downSeq >= 3 ? 'DOWN' : 'MIXED'; aligned = downSeq; label = `MA เรียงตัวขาลงบางส่วน (${downSeq}/4)`; }
  return { dir, aligned, label, ema9: e9, ema21: e21, ema50: e50, ema200: e200 };
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
  const ema9 = I.last(I.emaSeries(closes, 9));
  const ema21 = I.last(I.emaSeries(closes, 21));
  const ema50Entry = I.last(I.emaSeries(closes, 50));
  const ema200 = I.last(I.emaSeries(closes, 200));
  const rsiArr = I.rsiSeries(closes, 14);
  const rsi = I.last(rsiArr);
  const macd = I.macd(closes);
  const maStack = maStackState(price, ema9, ema21, ema50Entry, ema200);
  const vprofile = I.volumeProfile(entryCandles.slice(-120), 24);
  const adxEntry = I.adxLatest(entryCandles, 14);
  const sessionOK = inSession(entryCandles[n - 1].time, cfg);

  const trend = emaTrend(trendCandles || [], cfg);
  const structTF = I.marketStructure(structureCandles || [], 2);
  const structEntry = I.marketStructure(entryCandles, 2);
  const bar = breakAndRetestFor(entryCandles);
  const qm = I.quasimodo(entryCandles, 2);

  const trendDirWord = trend.dir === 'UP' ? 'ขาขึ้น (Bullish)' : trend.dir === 'DOWN' ? 'ขาลง (Bearish)' : 'ไม่ชัดเจน';
  const structWord = structTF.trend === 'UP' ? 'HH/HL (ขาขึ้น)' : structTF.trend === 'DOWN' ? 'LH/LL (ขาลง)' : 'sideways';

  const direction = trend.dir === 'UP' ? 'BUY' : trend.dir === 'DOWN' ? 'SELL' : null;

  const checklist = [];
  let score = 0;
  // `earned` is the points actually scored (0..maxPoints); a partial score is
  // allowed (e.g. a weak S/R zone scores 1 of 2).
  const row = (name, maxPoints, earned, note) => {
    const e = earned === true ? maxPoints : earned === false ? 0 : earned;
    score += e;
    checklist.push({ name, points: maxPoints, earned: e, got: e > 0, partial: e > 0 && e < maxPoints, note });
  };

  if (!direction) {
    checklist.push({ name: 'H4 Trend', points: 2, got: false, note: `เทรนด์ ${stack.trend} ไม่ชัดเจน (ราคาคร่อม EMA50 / ความชันน้อย) — ยังไม่มี setup` });
    return buildResult({ assetKey, interval, stack, price, atr, ema9, ema21, ema50Entry, ema200, rsi, macd, maStack, vprofile, trend, trendDirWord, structTF, structWord, structEntry, bar, direction: null, score: 0, checklist, cfg, entryTime: entryCandles[n - 1].time });
  }

  const isBuy = direction === 'BUY';

  // 1) H4 trend — direction came from here, so it's aligned by construction (+2)
  row('H4 Trend', 2, true, `เทรนด์ ${stack.trend} = ${isBuy ? 'ขาขึ้น' : 'ขาลง'} (ราคา${isBuy ? 'เหนือ' : 'ใต้'} EMA50, ความชัน${isBuy ? 'บวก' : 'ลบ'})`);

  // 2) H1 structure aligned (+2)
  const h1Aligned = (isBuy && structTF.trend === 'UP') || (!isBuy && structTF.trend === 'DOWN')
    || (isBuy && structTF.bos === 'UP') || (!isBuy && structTF.bos === 'DOWN');
  row('H1 Structure', 1, h1Aligned,
    h1Aligned ? `โครงสร้าง ${stack.structure} = ${isBuy ? 'Higher High / Higher Low' : 'Lower High / Lower Low'}`
              : `โครงสร้าง ${stack.structure} ยังไม่เป็น ${isBuy ? 'HH/HL' : 'LH/LL'} (${structWord})`);

  // 3) price at a key S/R (+2 for a level tested 2+ times / an HTF level,
  //    +1 for a fresh single swing, 0 otherwise). S/R is now a clustered
  //    ZONE, seeded with prior-day H/L/C and the nearest round numbers — a
  //    level that has been respected before is worth far more than the last
  //    swing alone.
  const pdl = I.priorDayLevels(entryCandles);
  const rStep = cfg.roundStep;
  const roundLevels = rStep > 0 ? [Math.floor(price / rStep) * rStep, Math.ceil(price / rStep) * rStep] : [];
  const htfLevels = [
    ...(pdl ? [pdl.high, pdl.low, pdl.close] : []),
    ...roundLevels,
  ];
  const zones = a1 ? I.srZones(entryCandles, 2, a1 * cfg.srZoneTolAtr, htfLevels) : [];
  // the zone we'd be trading from: nearest one on the correct side
  const relevantZones = zones.filter(z => isBuy ? z.mid <= price + a1 * 0.3 : z.mid >= price - a1 * 0.3);
  let srZone = null;
  for (const z of relevantZones) {
    const d = Math.abs(price - z.mid);
    if (a1 && d <= a1 * cfg.srNearAtr && (!srZone || d < Math.abs(price - srZone.mid))) srZone = z;
  }
  const srLevel = srZone ? srZone.mid : (isBuy
    ? (structEntry.lastLow ? structEntry.lastLow.price : null)
    : (structEntry.lastHigh ? structEntry.lastHigh.price : null));
  const isHtfLevel = srZone && htfLevels.some(v => Math.abs(v - srZone.mid) <= (a1 || 1) * cfg.srZoneTolAtr);
  let srPts = 0, srNote;
  if (srZone && (srZone.touches >= 2 || isHtfLevel)) {
    srPts = 2;
    srNote = `ราคาอยู่ที่แนว${isBuy ? 'รับ' : 'ต้าน'}แข็ง ${srZone.mid.toFixed(2)} (${isHtfLevel ? 'ระดับ HTF/เลขกลม' : 'ทดสอบ ' + srZone.touches + ' ครั้ง'})`;
  } else if (srZone) {
    srPts = 1;
    srNote = `ราคาอยู่ที่แนว${isBuy ? 'รับ' : 'ต้าน'} ${srZone.mid.toFixed(2)} — แต่ทดสอบครั้งเดียว (แนวอ่อน)`;
  } else {
    srNote = srLevel != null ? `ราคายังห่างแนว${isBuy ? 'รับ' : 'ต้าน'} ${srLevel.toFixed(2)} (${a1 ? Math.abs(price - srLevel).toFixed(2) : '?'} จุด)` : 'ยังไม่พบแนว S/R ที่ชัดเจน';
  }
  row('Action Zone', 2, srPts, srNote);
  const atSR = srPts > 0;

  // 4) BREAKOUT — break of structure on the entry TF in the trade direction (+1)
  const bos = bar.bos === (isBuy ? 'UP' : 'DOWN');
  row('Breakout', 1, bos,
    bos ? `Breakout (BOS) ${isBuy ? 'ขาขึ้น' : 'ขาลง'} ที่ ${bar.level != null ? bar.level.toFixed(2) : '-'} (${bar.barsSinceBreak} แท่งก่อน)`
        : 'ยังไม่มี Breakout ตามทิศทาง');

  // 5) PULLBACK — retest of the broken level (+1)
  const retest = bos && bar.retest;
  row('Pullback', 1, retest,
    retest ? `ราคาย่อ (Pullback) กลับมาทดสอบระดับ ${bar.level.toFixed(2)} ที่ทะลุ แล้วยืนได้` : 'ยังไม่เห็น Pullback กลับมาทดสอบระดับที่ทะลุ');

  // 6) QM (Quasimodo) pattern in the trade direction (+1)
  const qmSide = isBuy ? qm.bull : qm.bear;
  const qmMatch = !!(qmSide && qmSide.confirmed);
  row('QM Pattern', 1, qmMatch,
    qmSide
      ? (qmMatch
          ? `QM ${isBuy ? 'ฝั่งซื้อ' : 'ฝั่งขาย'} ครบ — ไหล่ซ้าย ${qmSide.leftShoulder.toFixed(2)} · หัว ${qmSide.head.toFixed(2)} · ทะลุ ${qmSide.broken.toFixed(2)} แล้ว`
          : `QM ${isBuy ? 'ฝั่งซื้อ' : 'ฝั่งขาย'} กำลังก่อตัว — ยังไม่ทะลุ ${qmSide.broken.toFixed(2)}`)
      : 'ยังไม่พบรูปแบบ QM (Quasimodo) ตามทิศทาง');

  // 7) rejection candle on one of the last 2 closed entry-TF bars (+1)
  const rej = (isBuy
    ? I.isBullishRejection(entryCandles[n - 2], entryCandles[n - 1]) || I.isBullishRejection(entryCandles[n - 3], entryCandles[n - 2])
    : I.isBearishRejection(entryCandles[n - 2], entryCandles[n - 1]) || I.isBearishRejection(entryCandles[n - 3], entryCandles[n - 2]));
  row('Price Action', 1, rej,
    rej ? `แท่ง Rejection ${isBuy ? 'ฝั่งซื้อ (hammer/bullish engulfing)' : 'ฝั่งขาย (shooting star/bearish engulfing)'} ยืนยัน` : 'ยังไม่มีแท่ง Rejection ยืนยันจังหวะเข้า');

  const institutional = institutionalModel({
    side: direction, entryCandles, trendCandles, a1, price, trend, structTF, structEntry, bar,
    qm: isBuy ? qm.bull : qm.bear, srZone, priorDay: pdl, rsi, rsiArr, macd, maStack, vprofile,
    adx: adxEntry, sessionOK, ema9, ema21, ema50: ema50Entry, ema200,
  });

  return buildResult({ assetKey, interval, stack, price, atr, ema9, ema21, ema50Entry, ema200, rsi, macd, maStack, vprofile, trend, trendDirWord, structTF, structWord, structEntry, bar, direction, score, checklist, srLevel, srZone, isHtfLevel, priorDay: pdl, atSR, bos, retest, rej, qm: qmSide, qmMatch, institutional, cfg, entryTime: entryCandles[n - 1].time });
}

/**
 * Institutional Accumulation / Distribution score, /100 — the "smart money"
 * playbook, direction-aware:
 *   BUY  (ACCUMULATION):  HTF up   → liquidity below → sweep + reclaim a low  →
 *                         demand/QM → MSS up   → bullish displacement → retest
 *   SELL (DISTRIBUTION):  HTF down → liquidity above → sweep + reject a high  →
 *                         supply/QM → MSS down → bearish displacement → retest
 * >=80 = STRONG ZONE. side === null → NO_TREND (returned by the caller default).
 */
function institutionalModel(p) {
  const { side, entryCandles, trendCandles, a1, price, trend, structTF, structEntry, bar, qm, srZone, priorDay, rsi, rsiArr, macd, maStack, vprofile, adx, sessionOK, ema9, ema21, ema50, ema200 } = p;
  if (side !== 'BUY' && side !== 'SELL') {
    return { state: 'NO_TREND', side: null, score: 0, maxScore: 100, tier: 'WAIT', ready: false,
      components: [], targets: [], checklist: [], sweepLevel: null, entryPlan: null,
      maStack: maStack || null, macd: macd ? { histogram: macd.histogram, rising: macd.rising, crossUp: macd.crossUp, crossDown: macd.crossDown } : null,
      poc: vprofile ? vprofile.poc : null, valueArea: vprofile ? { vah: vprofile.vah, val: vprofile.val } : null,
      rsi: rsi != null ? Math.round(rsi * 10) / 10 : null, rsiRising: null, rsiOk: false,
      note: 'เทรนด์ H4 ยังไม่ชัดเจน — ยังไม่มีโซนสะสม/กระจาย' };
  }
  const buy = side === 'BUY';
  const rClean = Array.isArray(rsiArr) ? rsiArr.filter(v => v != null) : [];
  const rsiMoving = rClean.length >= 3 ? rClean[rClean.length - 1] - rClean[rClean.length - 3] : null;
  const rsiRising = rsiMoving == null ? null : rsiMoving > 0;
  const ms = maStack || { dir: 'NA', aligned: 0, label: 'MA ไม่พร้อม' };
  const dir = buy ? 'UP' : 'DOWN';
  const w = buy
    ? { zone: 'Demand', side: 'ซื้อ', mss: 'ขาขึ้น', struct: 'HH/HL', bar: 'เขียว', trendW: 'ขาขึ้น', over: 'เหนือ', under: 'ใต้' }
    : { zone: 'Supply', side: 'ขาย', mss: 'ขาลง', struct: 'LH/LL', bar: 'แดง', trendW: 'ขาลง', over: 'ใต้', under: 'เหนือ' };
  const atr = a1 && a1 > 0 ? a1 : (price ? price * 0.002 : 1);
  const n = entryCandles.length;
  const comps = [];
  const add = (key, name, max, earned, note) => {
    const e = Math.max(0, Math.min(max, Math.round(earned)));
    comps.push({ key, name, max, earned: e, got: e >= max, partial: e > 0 && e < max, note });
  };
  const cmp = buy ? ((x, y) => x > y) : ((x, y) => x < y);   // "beyond" price in trade direction

  // 0) Trend & MA Stack (+15): higher-TF EMA trend carries the weight; the
  // 9/21/50/200 stack is confluence on top.
  let htf = 0; const htfBits = [];
  if (trend.dir === dir) { htf += 9; htfBits.push(`เทรนด์หลัก ${w.trendW}`); }
  else if (ema200 != null && cmp(price, ema200)) { htf += 4; htfBits.push(`ราคา${w.over} EMA200`); }
  if (ms.dir === dir && ms.aligned === 4) { htf += 6; htfBits.push(ms.label); }
  else if (ms.dir === dir && ms.aligned === 3) { htf += 4; htfBits.push(ms.label); }
  else if (ema50 != null && cmp(price, ema50)) { htf += 2; htfBits.push(`ราคา${w.over} EMA50 (MA ยังไม่เรียงเต็ม)`); }
  add('htf', 'Trend & MA Stack', 15, htf, htfBits.length ? htfBits.join(' · ') : `MA 9/21/50/200 ยังไม่เรียงตัว${w.trendW}`);

  // 1) Liquidity Sweep (+20): a prior high/low swept then rejected/reclaimed
  const sw = I.swings(entryCandles, 2);
  const refSwing = buy
    ? (sw.lows.length ? sw.lows[sw.lows.length - 1].price : (structEntry.lastLow ? structEntry.lastLow.price : null))
    : (sw.highs.length ? sw.highs[sw.highs.length - 1].price : (structEntry.lastHigh ? structEntry.lastHigh.price : null));
  const pdRef = priorDay ? (buy ? priorDay.low : priorDay.high) : null;
  const sweepTargets = [refSwing, pdRef].filter(v => v != null && (buy ? v < price : v > price));
  let sweep = 0, sweepLevel = null;
  let sweepNote = `ยังไม่เห็นการกวาดสภาพคล่อง${w.under} ${buy ? 'Low' : 'High'} เดิม`;
  const swWindow = entryCandles.slice(-10);
  for (const lvl of sweepTargets) {
    const pierced = buy ? swWindow.some(c => c.low < lvl - atr * 0.1) : swWindow.some(c => c.high > lvl + atr * 0.1);
    const reclaimed = buy ? price > lvl : price < lvl;
    if (pierced && reclaimed) { sweep = 20; sweepLevel = lvl; sweepNote = `กวาด ${buy ? 'Low' : 'High'} ${lvl.toFixed(2)} แล้ว${buy ? 'ดีดกลับเหนือ' : 'ถูกตีกลับใต้'}ระดับ (Sweep + ${buy ? 'Reclaim' : 'Reject'})`; break; }
    if (pierced && sweep < 13) { sweep = 13; sweepLevel = lvl; sweepNote = `แตะ${w.under} ${lvl.toFixed(2)} — รอปิดกลับ${w.over}ระดับเพื่อยืนยัน`; }
  }
  add('sweep', 'Liquidity Sweep', 20, sweep, sweepNote);

  // 2) QM / Demand-Supply Zone (+20)
  let dz = 0, dzNote = `ยังไม่พบ QM / ${w.zone} Zone`;
  if (qm) {
    dz = qm.confirmed ? 20 : 10;
    dzNote = qm.confirmed
      ? `QM ฝั่ง${w.side}ครบ — ไหล่ ${qm.leftShoulder.toFixed(2)} / หัว ${qm.head.toFixed(2)} · ทะลุ ${qm.broken.toFixed(2)} แล้ว`
      : `QM ฝั่ง${w.side}กำลังก่อตัว — ยังไม่ทะลุ ${qm.broken.toFixed(2)}`;
  } else if (srZone && price >= srZone.lo - atr * 0.5 && price <= srZone.hi + atr * 0.5) {
    dz = 14; dzNote = `ราคาอยู่ใน ${w.zone} Zone ${srZone.lo.toFixed(2)}–${srZone.hi.toFixed(2)} (ทดสอบ ${srZone.touches} ครั้ง)`;
  } else if (srZone) {
    dz = 7; dzNote = `มี ${w.zone} Zone ${srZone.lo.toFixed(2)}–${srZone.hi.toFixed(2)} แต่ราคายังไม่ถึง`;
  }
  // POC confluence — the price where the most volume changed hands is where the
  // bank did its business; a zone/entry sitting on it is stronger.
  if (vprofile && dz > 0 && Math.abs(price - vprofile.poc) <= atr * 0.7) {
    dz = Math.min(20, dz + 3);
    dzNote += ` · ตรงกับ POC ${vprofile.poc.toFixed(2)} (${vprofile.source === 'volume' ? 'วอลุ่มหนาสุด' : 'ราคาถูกยอมรับมากสุด'})`;
  }
  add('demand', `QM / ${w.zone} Zone`, 20, dz, dzNote);

  // 3) Market Structure Shift (+20)
  let mss = 0; const mssBits = [];
  if (bar.bos === dir) { mss += 12; mssBits.push(`BOS ${w.mss}ที่ ${bar.level != null ? bar.level.toFixed(2) : '-'}`); }
  if (structTF.trend === dir || structTF.bos === dir || structTF.choch === dir) { mss += 8; mssBits.push(`โครงสร้าง TF ถัดไปเป็น${w.mss} (${w.struct})`); }
  add('mss', 'Market Structure Shift', 20, mss, mssBits.length ? mssBits.join(' · ') : `โครงสร้างยังไม่เปลี่ยนเป็น${w.mss}`);

  // 4) Momentum & Displacement (+15): displacement candle + volume + MACD + RSI
  const last3 = entryCandles.slice(-4, -1);
  let disp = 0; const dispBits = [];
  const strong = last3.find(c => {
    const range = c.high - c.low;
    const body = buy ? c.close - c.open : c.open - c.close;
    return range > 0 && body >= range * 0.55 && range >= atr * 1.3;
  });
  if (strong) { disp += 6; dispBits.push(`แท่ง${w.bar} Displacement > 1.3×ATR`); }
  else {
    const mid = last3.find(c => (c.high - c.low) >= atr && (buy ? c.close > c.open : c.close < c.open));
    if (mid) { disp += 3; dispBits.push(`แท่ง${w.mss}แรงพอควร`); }
  }
  const vols = entryCandles.slice(-21, -1).map(c => c.volume).filter(v => v != null && v > 0);
  const lastVol = entryCandles[n - 2] ? entryCandles[n - 2].volume : null;
  if (vols.length >= 10 && lastVol != null && lastVol > 0) {
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
    if (lastVol >= avg * 1.5) { disp += 3; dispBits.push('วอลุ่มพุ่ง > 1.5× ค่าเฉลี่ย'); }
    else if (lastVol >= avg * 1.1) { disp += 1; dispBits.push('วอลุ่มสูงกว่าค่าเฉลี่ย'); }
  } else if (strong) { disp += 2; dispBits.push('(ไม่มีวอลุ่ม — ใช้ขนาดแท่ง)'); }
  // MACD (+4) — at a dip/rally entry we want momentum *turning* our way, not
  // necessarily already positive.
  if (macd && isFinite(macd.histogram)) {
    const turning = buy ? macd.histogram > macd.histogramPrev : macd.histogram < macd.histogramPrev;
    const favor = buy ? macd.histogram > 0 : macd.histogram < 0;
    if ((buy && macd.crossUp) || (!buy && macd.crossDown)) { disp += 4; dispBits.push(`MACD ตัด${buy ? 'ขึ้น' : 'ลง'} (cross)`); }
    else if (turning && favor) { disp += 4; dispBits.push(`MACD histogram ${buy ? 'บวกและกว้างขึ้น' : 'ลบและกว้างขึ้น'}`); }
    else if (turning) { disp += 3; dispBits.push(`MACD histogram กำลัง${buy ? 'ดีดขึ้น' : 'อ่อนลง'} (โมเมนตัมเริ่มพลิก)`); }
    else if (favor) { disp += 2; dispBits.push(`MACD ${buy ? 'ยังบวก' : 'ยังลบ'} แต่แผ่ว`); }
  }
  // RSI (+3) — momentum leaning the trade way; a dip buy just needs RSI turning
  // up from a healthy area, not already above 50.
  if (rsi != null) {
    const fav = buy ? (rsi >= 50 || (rsi >= 42 && rsiRising === true)) : (rsi <= 50 || (rsi <= 58 && rsiRising === false));
    const strongFav = buy ? (rsi > 52 && rsiRising !== false) : (rsi < 48 && rsiRising !== true);
    if (strongFav) { disp += 3; dispBits.push(`RSI ${rsi.toFixed(0)} ${buy ? 'ดีดขึ้นเหนือ 50' : 'อ่อนลงใต้ 50'}`); }
    else if (fav) { disp += 2; dispBits.push(`RSI ${rsi.toFixed(0)} ${buy ? 'กำลังหันขึ้น' : 'กำลังหันลง'}`); }
  }
  disp = Math.min(15, disp);
  add('disp', 'Momentum & Displacement', 15, disp, dispBits.length ? dispBits.join(' · ') : 'โมเมนตัม (แท่ง/วอลุ่ม/MACD/RSI) ยังไม่ยืนยัน');

  // 5) Pullback / Retest (+10): retest of the broken level, or a pullback to EMA21/50 in an aligned tape
  let pb = 0, pbNote = 'ยังไม่เห็นการ Retest โซน / ย่อเข้า EMA';
  if (bar.bos === dir && bar.retest) { pb = 10; pbNote = `ราคา${buy ? 'ย่อ' : 'เด้ง'}กลับมาทดสอบ ${bar.level.toFixed(2)} แล้วยืนได้ (Retest ผ่าน)`; }
  else if (bar.bos === dir && bar.level != null && Math.abs(price - bar.level) <= atr * 0.9) { pb = 6; pbNote = `ราคากำลังกลับมาที่ ${bar.level.toFixed(2)} — รอสัญญาณยืน`; }
  else if (ms.dir === dir && [ema21, ema50].some(m => m != null && Math.abs(price - m) <= atr * 0.45)) {
    const at21 = ema21 != null && Math.abs(price - ema21) <= atr * 0.45;
    pb = 6; pbNote = `ราคาย่อเข้า EMA${at21 ? '21' : '50'} ในเทรนด์ที่ MA เรียงตัว — จุด pullback แบบ dynamic`;
  }
  add('pullback', 'Pullback / Retest', 10, pb, pbNote);

  const score = comps.reduce((s, c) => s + c.earned, 0);
  const rsiOk = rsi != null && (buy ? (rsi > 50 && rsiRising !== false) : (rsi < 50 && rsiRising !== true));
  // >=64 is where the walk-forward backtest holds a >=70% hit rate on the
  // 0.5R first target (5000-bar sweep, XAU 1h & 4h).
  const tier = score >= 64 ? 'STRONG_ZONE' : score >= 42 ? 'FORMING' : 'WAIT';

  // Liquidity targets in the trade direction — where price is likely drawn (= TP)
  const swExtreme = buy
    ? (structEntry.lastHigh ? structEntry.lastHigh.price : null)
    : (structEntry.lastLow ? structEntry.lastLow.price : null);
  const legOrigin = sweepLevel != null ? sweepLevel
    : buy ? (structEntry.lastLow ? structEntry.lastLow.price : null)
          : (structEntry.lastHigh ? structEntry.lastHigh.price : null);
  const trendMS = trendCandles && trendCandles.length ? I.marketStructure(trendCandles, 2) : null;
  const trendTarget = trendMS ? (buy ? trendMS.lastHigh : trendMS.lastLow) : null;
  const targets = [];
  const pushT = (name, v) => { if (v != null && isFinite(v) && (buy ? v > price : v < price)) targets.push({ name, price: Math.round(v * 100) / 100 }); };
  pushT(buy ? 'Previous Day High' : 'Previous Day Low', priorDay ? (buy ? priorDay.high : priorDay.low) : null);
  pushT(buy ? 'Swing / Equal High' : 'Swing / Equal Low', swExtreme);
  if (legOrigin != null && swExtreme != null && Math.abs(swExtreme - legOrigin) > 0) {
    const range = swExtreme - legOrigin;
    pushT('Fib Ext 1.272', swExtreme + range * 0.272);
    pushT('Fib Ext 1.618', swExtreme + range * 0.618);
  }
  pushT(buy ? 'Weekly / Daily Supply' : 'Weekly / Daily Demand', trendTarget ? trendTarget.price : null);
  targets.sort((a, b) => (buy ? a.price - b.price : b.price - a.price));

  // Precise entry: the nearest confluent level in the trade direction, "armed"
  // only when MA stack, MACD and RSI all lean the trade way.
  const entryCands = [
    ['โซน Demand/Supply', srZone ? srZone.mid : null],
    ['POC', vprofile ? vprofile.poc : null],
    ['EMA21', ema21],
    ['EMA50', ema50],
    ['ระดับ BOS / Retest', bar.bos === dir ? bar.level : null],
    ['QM ไหล่ซ้าย', qm ? qm.entry : null],
  ].filter(([, v]) => v != null && isFinite(v) && (buy ? v <= price + atr * 0.6 : v >= price - atr * 0.6));
  entryCands.sort((a, b) => Math.abs(price - a[1]) - Math.abs(price - b[1]));
  const entryRef = entryCands[0] || null;
  const entryPx = entryRef ? entryRef[1] : null;
  const confluence = entryPx != null
    ? entryCands.filter(([, v]) => Math.abs(v - entryPx) <= atr * 0.5).map(([k]) => k)
    : [];
  const macdLeans = !!(macd && isFinite(macd.histogram) &&
    (buy ? macd.histogram >= macd.histogramPrev : macd.histogram <= macd.histogramPrev));
  const rsiLeans = rsi == null || (buy ? rsi > 47 : rsi < 53);
  const armed = tier !== 'WAIT' && ms.dir === dir && macdLeans && rsiLeans && entryPx != null;
  const entryPlan = {
    price: entryPx != null ? Math.round(entryPx * 100) / 100 : null,
    basis: entryRef ? entryRef[0] : null,
    confluence,
    armed,
    trigger: buy
      ? 'รอแท่ง bullish rejection/engulfing ปิดเหนือโซน + MACD histogram เพิ่มขึ้น + RSI ยืนเหนือ 50'
      : 'รอแท่ง bearish rejection/engulfing ปิดใต้โซน + MACD histogram ลดลง + RSI หลุด 50',
  };

  // ---- ENTRY SIGNAL — a real trigger, not just "score is high" -------------
  // Fires on the close of a confirmed rejection bar AT a level, in an
  // established (non-chop) regime and in session, with momentum turning our
  // way. This is what the backtest enters on.
  const nb = entryCandles.length;
  const cur = entryCandles[nb - 1];
  const prev = entryCandles[nb - 2] || null;
  const rejBar = buy
    ? (I.isBullishRejection(prev, cur) ? cur : null)
    : (I.isBearishRejection(prev, cur) ? cur : null);
  const esReasons = [], esBlockers = [];

  // Backtest-tuned (XAU 4h, 5000-bar walk-forward): score>=50 + ADX>=18 is the
  // frontier that keeps PF ~2.4 while giving the most trades.
  if (score < 50) esBlockers.push('setup context ยังไม่พอ (score < 50)');
  if (sessionOK === false) esBlockers.push('นอกเวลาเทรด (London+NY)');
  const adxOk = !!(adx && adx.adx >= 18);
  const maAligned = ms.dir === dir && ms.aligned >= 3;
  if (!adxOk || ms.aligned < 1) esBlockers.push(`ตลาดยังไม่มีเทรนด์ชัด (ADX ${adx ? adx.adx.toFixed(0) : '?'} / MA ${ms.aligned}/4)`);
  else esReasons.push(`ADX ${adx.adx.toFixed(0)}${maAligned ? ' + MA เรียงตัว' : ''}`);
  // counter-trend guard: only take the trade the higher-TF trend agrees with
  if (trend.dir && trend.dir !== dir) esBlockers.push('สวนเทรนด์กรอบใหญ่');
  // SELL is a trap on gold's structural uptrend — only take it once price has
  // actually lost the EMA200.
  if (!buy && ema200 != null && price > ema200) esBlockers.push('ราคายังอยู่เหนือ EMA200 (SELL เข้มกว่า)');

  const atLevels = [
    ['โซน', srZone ? srZone.mid : null, srZone ? srZone.lo : null, srZone ? srZone.hi : null],
    ['POC', vprofile ? vprofile.poc : null, null, null],
    ['EMA21', ema21, null, null],
    ['EMA50', ema50, null, null],
    ['ระดับ BOS', bar.bos === dir ? bar.level : null, null, null],
  ].filter(([, v]) => v != null && Math.abs(price - v) <= atr * 0.5);
  if (!atLevels.length) esBlockers.push('ราคายังไม่อยู่ที่ระดับสำคัญ');
  else esReasons.push('ราคาอยู่ที่ ' + atLevels.map(l => l[0]).join(' + '));

  if (!rejBar) esBlockers.push(`ยังไม่มีแท่ง ${buy ? 'bullish' : 'bearish'} rejection ปิดยืนยัน`);
  else esReasons.push(`แท่ง ${buy ? 'bullish' : 'bearish'} rejection ปิดยืนยัน`);

  const macdTurning = !!(macd && isFinite(macd.histogram) &&
    (buy ? macd.histogram >= macd.histogramPrev : macd.histogram <= macd.histogramPrev));
  if (!macdTurning) esBlockers.push('MACD histogram ยังไม่หันทางเทรด');
  const rsiChase = rsi != null && (buy ? rsi > 72 : rsi < 28);
  if (rsiChase) esBlockers.push(`RSI ${rsi.toFixed(0)} — ไล่ราคาเกินไป`);

  const fire = esBlockers.length === 0 && !!rejBar;
  const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
  const zEdge = atLevels.find(l => l[2] != null);
  const swing = buy ? (structEntry.lastLow ? structEntry.lastLow.price : null)
                    : (structEntry.lastHigh ? structEntry.lastHigh.price : null);
  let entrySignal;
  if (!fire) {
    entrySignal = { fire: false, side, blockers: esBlockers, have: esReasons };
  } else {
    const entry = price;
    // SL beyond the STRUCTURE (zone edge or the swing that formed it), not just
    // the rejection wick — a wick-tight stop is what gets noise-stopped.
    const structEdge = buy
      ? Math.min(rejBar.low, zEdge ? zEdge[2] : Infinity, swing != null ? swing : Infinity)
      : Math.max(rejBar.high, zEdge ? zEdge[3] : -Infinity, swing != null ? swing : -Infinity);
    const sl = buy ? structEdge - atr * 0.4 : structEdge + atr * 0.4;
    const risk = Math.abs(entry - sl);
    // TP1 = a structure target if one sits at 1.2–2.5R, otherwise a fixed 1.4R.
    const opp = targets.map(t => t.price)
      .filter(v => (buy ? (v > entry + risk * 1.2 && v < entry + risk * 3) : (v < entry - risk * 1.2 && v > entry - risk * 3)))
      .sort((x, y) => (buy ? x - y : y - x));
    const tp1 = opp[0] != null ? opp[0] : (buy ? entry + risk * 1.4 : entry - risk * 1.4);
    const tp2 = buy ? entry + risk * 2.5 : entry - risk * 2.5;
    const tp3 = buy ? entry + risk * 4.5 : entry - risk * 4.5;
    entrySignal = {
      fire: true, side, have: esReasons,
      entry: r2(entry), sl: r2(sl), tp1: r2(tp1), tp2: r2(tp2), tp3: r2(tp3),
      risk: r2(risk), rr1: risk > 0 ? Math.round((Math.abs(tp1 - entry) / risk) * 100) / 100 : null,
      zoneLo: r2(zEdge ? zEdge[2] : null), zoneHi: r2(zEdge ? zEdge[3] : null),
      swingRef: r2(swing), rejLow: r2(rejBar.low), rejHigh: r2(rejBar.high),
      trigger: `แท่ง rejection ฝั่ง${buy ? 'ซื้อ' : 'ขาย'} ที่ ${atLevels[0][0]} · ${adxOk ? 'ADX ' + adx.adx.toFixed(0) : 'MA เรียงตัว'} · MACD หันทาง`,
    };
  }

  return {
    state: buy ? 'ACCUMULATION' : 'DISTRIBUTION',
    side,
    score, maxScore: 100, tier,
    ready: tier === 'STRONG_ZONE',       // the SETUP is in place
    armed: !!entrySignal.fire,           // the TRIGGER fired — enter now
    components: comps,
    sweepLevel,
    entryPlan,
    entrySignal,
    adx: adx ? { adx: Math.round(adx.adx * 10) / 10, plusDI: Math.round(adx.plusDI), minusDI: Math.round(adx.minusDI) } : null,
    sessionOK: sessionOK !== false,
    // Runner scheme once entrySignal fires: bank part at TP1 (structure, ~1.3R),
    // move stop to breakeven, let TP2/TP3 ride.
    plan: { beAfter: 'TP1', primaryTP: 'TP1' },
    maStack: ms,
    macd: macd ? { histogram: Math.round(macd.histogram * 1000) / 1000, rising: macd.rising, crossUp: macd.crossUp, crossDown: macd.crossDown } : null,
    poc: vprofile ? vprofile.poc : null,
    valueArea: vprofile ? { vah: vprofile.vah, val: vprofile.val, source: vprofile.source } : null,
    rsi: rsi != null ? Math.round(rsi * 10) / 10 : null,
    rsiRising, rsiOk,
    targets: targets.slice(0, 6),
    checklist: [
      { name: `MA 9/21/50/200 เรียงตัว${w.trendW}`, got: ms.dir === dir && ms.aligned >= 3 },
      { name: `ราคาทำ Sweep ${buy ? 'Low' : 'High'} กวาดสภาพคล่อง`, got: sweep >= 20 },
      { name: `อยู่ใน ${w.zone} Zone / QM`, got: dz >= 12 },
      { name: `เกิด Market Structure Shift (MSS/BOS) ${w.mss}`, got: mss >= 12 },
      { name: `แท่ง${w.bar} Displacement + Volume + MACD ยืนยันโมเมนตัม`, got: disp >= 9 },
      { name: 'Retest โซน / ย่อเข้า EMA แล้วไม่หลุด', got: pb >= 6 },
      { name: buy ? 'RSI > 50 และดีดขึ้น / ไม่มี Divergence ขาลง' : 'RSI < 50 และอ่อนลง / ไม่มี Divergence ขาขึ้น', got: !!rsiOk },
    ],
  };
}

/** Hour (0–23, UTC) of a "YYYY-MM-DD HH:MM:SS" timestamp; null if unparseable. */
function hourUTC(t) {
  const m = /(\d{2}):(\d{2}):/.exec(String(t));
  return m ? Number(m[1]) : null;
}

function inSession(entryTime, cfg) {
  if (!cfg.session || !cfg.session.enabled) return true;
  const h = hourUTC(entryTime);
  if (h == null) return true;
  return h >= cfg.session.startUTC && h < cfg.session.endUTC;
}

function breakAndRetestFor(candles) {
  const b = I.breakAndRetest(candles, 2);
  return b || { bos: null, level: null, barsSinceBreak: null, retest: false };
}

function buildResult(x) {
  const { interval, stack, price, atr, direction, score, checklist, cfg, entryTime } = x;

  // BUY needs 8/9, SELL needs 9/9 (backtest: shorts underperform on lower TFs).
  const strongBar = direction === 'SELL' ? cfg.strongScoreShort : cfg.strongScore;
  const sessionOK = inSession(entryTime, cfg);
  const rawTier = score >= strongBar ? 'STRONG' : score >= cfg.watchScore ? 'WATCH' : 'NO_TRADE';
  const tier = (rawTier === 'STRONG' && !sessionOK) ? 'WATCH' : rawTier;
  const tradable = tier === 'STRONG';
  const developing = tier === 'WATCH';
  const confidence = Math.round((score / 9) * 100);
  const sessionHour = hourUTC(entryTime);

  let waitReason = null;
  if (!direction) {
    waitReason = `เทรนด์ ${stack.trend} ยังไม่ชัดเจน — ระบบเข้าเฉพาะเมื่อ H4 เป็นเทรนด์ชัด`;
  } else if (rawTier === 'STRONG' && !sessionOK) {
    waitReason = `Setup ${score}/9 ครบแล้ว แต่อยู่นอกเวลาเทรด (London+NY ${cfg.session.startUTC}:00–${cfg.session.endUTC}:00 UTC · ตอนนี้ ${sessionHour != null ? sessionHour + ':00' : '?'} UTC) — Asian session ทองไซด์เวย์ ระบบงดเข้า`;
  } else if (tier === 'WATCH') {
    waitReason = `Setup ${score}/9 (Watch) — ยังไม่ครบ ${strongBar}/9${direction === 'SELL' ? ' (ฝั่ง SELL ต้องครบ 9/9)' : ''} รอ ${missingBits(checklist)}`;
  } else if (tier === 'NO_TRADE') {
    waitReason = `Setup ${score}/9 — เงื่อนไขยังไม่พอ (${missingBits(checklist)})`;
  }

  const levels = buildLevels({ direction, tradable, price, atr, x, cfg });

  // The four core reads, surfaced as concrete values regardless of score so the
  // dashboard can always show Breakout / Pullback / Action Zone / QM.
  const a1 = isFinite(atr) && atr > 0 ? atr : null;
  const isBuy = direction === 'BUY';
  const playbook = {
    breakout: {
      level: x.bar.level != null ? x.bar.level : null,
      dir: x.bar.bos || null,
      barsSince: x.bar.barsSinceBreak,
      confirmed: !!x.bos,
    },
    pullback: {
      active: !!x.retest,
      toLevel: x.bar.level != null ? x.bar.level : null,
      distance: (x.bar.level != null && isFinite(price)) ? Math.round((price - x.bar.level) * 100) / 100 : null,
    },
    actionZone: x.srZone
      ? {
          lo: x.srZone.lo, hi: x.srZone.hi, mid: x.srZone.mid,
          touches: x.srZone.touches, htf: !!x.isHtfLevel,
          inside: a1 ? (price >= x.srZone.lo - a1 * 0.35 && price <= x.srZone.hi + a1 * 0.35) : null,
        }
      : (x.srLevel != null ? { lo: x.srLevel, hi: x.srLevel, mid: x.srLevel, touches: 1, htf: false, inside: false } : null),
    qm: x.qm
      ? {
          pattern: isBuy ? 'BULLISH_QM' : 'BEARISH_QM',
          leftShoulder: x.qm.leftShoulder, head: x.qm.head, broken: x.qm.broken,
          entry: x.qm.entry, stop: x.qm.stop, confirmed: !!x.qmMatch,
        }
      : null,
  };

  const reasons = checklist.map(c => {
    const icon = c.partial ? '🟡' : c.got ? '✅' : '⬜';
    return `${icon} ${c.name} (+${c.earned}/${c.points}) — ${c.note}`;
  });
  if (direction && cfg.session && cfg.session.enabled) {
    reasons.push(`${sessionOK ? '✅' : '⬜'} Session — ${sessionOK ? 'อยู่ในเวลาเทรด London+NY' : 'นอกเวลาเทรด (' + (sessionHour != null ? sessionHour + ':00' : '?') + ' UTC)'}`);
  }

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
      strongBar,
      setupId,
      waitReason,
      reasons,
      checklist,
      session: cfg.session && cfg.session.enabled
        ? { ok: sessionOK, hourUTC: sessionHour, windowUTC: [cfg.session.startUTC, cfg.session.endUTC] }
        : { ok: true, hourUTC: sessionHour, windowUTC: null },
    },
    levels,
    playbook,
    institutional: x.institutional || {
      state: 'NO_TREND', side: null,
      score: 0, maxScore: 100, tier: 'WAIT', ready: false,
      components: [], targets: [], checklist: [], sweepLevel: null, entryPlan: null,
      entrySignal: { fire: false, side: null, blockers: ['เทรนด์ H4 ยังไม่ชัด'], have: [] },
      adx: null, sessionOK: true, plan: { beAfter: 'TP1', primaryTP: 'TP1' },
      maStack: x.maStack || null,
      macd: x.macd ? { histogram: Math.round(x.macd.histogram * 1000) / 1000, rising: x.macd.rising, crossUp: x.macd.crossUp, crossDown: x.macd.crossDown } : null,
      poc: x.vprofile ? x.vprofile.poc : null,
      valueArea: x.vprofile ? { vah: x.vprofile.vah, val: x.vprofile.val, source: x.vprofile.source } : null,
      rsi: x.rsi != null ? Math.round(x.rsi * 10) / 10 : null, rsiRising: null, rsiOk: false,
      note: 'เทรนด์ H4 ยังไม่ชัดเจน — ยังไม่มีโซนสะสม/กระจาย',
    },
    indicators: {
      ema9: x.ema9 != null ? x.ema9 : null,
      ema21: x.ema21 != null ? x.ema21 : null,
      ema50: x.ema50Entry,
      ema50Entry: x.ema50Entry,
      ema200: x.ema200 != null ? x.ema200 : null,
      maStack: x.maStack || null,
      macd: x.macd ? { histogram: Math.round(x.macd.histogram * 1000) / 1000, signal: x.macd.signal, macd: x.macd.macd, rising: x.macd.rising, crossUp: x.macd.crossUp, crossDown: x.macd.crossDown } : null,
      poc: x.vprofile ? x.vprofile.poc : null,
      volumeProfile: x.vprofile || null,
      atr,
      trendTF: { tf: stack.trend, direction: x.trend.dir, ema50: x.trend.ema, label: x.trendDirWord },
      structureTF: { tf: stack.structure, direction: x.structTF.trend, label: x.structWord },
      srLevel: x.srLevel != null ? x.srLevel : null,
      srZone: x.srZone ? { mid: x.srZone.mid, touches: x.srZone.touches, htf: !!x.isHtfLevel } : null,
      priorDay: x.priorDay ? { high: x.priorDay.high, low: x.priorDay.low, close: x.priorDay.close } : null,
      atSR: !!x.atSR,
      bos: x.bar.bos, bosLevel: x.bar.level, retest: !!x.retest,
      rejection: !!x.rej,
      qm: playbook.qm,
      rsi: x.rsi != null ? x.rsi : null,
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
