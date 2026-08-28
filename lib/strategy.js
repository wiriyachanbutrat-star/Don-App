'use strict';

const I = require('./indicators');

// ---------------------------------------------------------------------------
// One coherent intraday trend-pullback strategy. No AI, no kitchen sink.
//
// The idea, in order of importance:
//   1. Regime   — the higher timeframe must agree with the trade direction.
//   2. Trend    — EMA20 > EMA50 > EMA200 (or the mirror) on the trading TF.
//   3. Momentum — MACD histogram + RSI must lean the same way.
//   4. Location — price has pulled back toward value (EMA20/50), not chased
//                 into an extreme.
//   5. Gates    — ADX confirms a real trend; a fresh CHoCH against us vetoes;
//                 counter-EMA200 trades need a bigger edge.
//
// Everything is a signed vote with a weight. The net vote decides direction
// and confidence; the gates decide whether it is actually tradable.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // ADX 25 = Wilder's "trending" line. Below it, gold intraday just chops and
  // a trend-following confluence system bleeds — raised from 20 after live
  // losses in exactly that 20–25 band.
  adxGate: 25,
  rr: 1.5,
  atrSlMult: { min: 1.0, max: 3.0, fallback: 1.5 },
  swingBufferAtr: 0.25,
  // fraction of total weight the |net vote| must reach to be "strong"
  strongFraction: 0.34,
  strongFractionCounter200: 0.5,
};

const ASSET_CONFIG = {
  XAU: { ...DEFAULTS },
  BTC: { ...DEFAULTS, adxGate: 22 },
};

const HTF_MAP = {
  '1min': '15min',
  '5min': '30min',
  '15min': '1h',
  '30min': '4h',
  '1h': '4h',
  '4h': '1day',
  '1day': '1week',
};

// Intraday timeframes get a faster EMA pair so the trend read is responsive;
// everything else keeps the classic 20/50 swing pair. EMA200 is always 200.
const FAST_SLOW = {
  '1min': [9, 21], '5min': [9, 21], '15min': [9, 21], '30min': [9, 21], '1h': [9, 21],
};

function higherInterval(interval) {
  return HTF_MAP[interval] || '4h';
}

function assetConfig(assetKey) {
  return ASSET_CONFIG[assetKey] || ASSET_CONFIG.XAU;
}

/**
 * Higher-timeframe regime. Deliberately strict: it drives the biggest single
 * vote in the model, so it must not read "UP" off a lagging EMA while the HTF
 * itself has actually been falling. Requires all three to agree:
 *   1. price on the right side of EMA50
 *   2. EMA50 sloping that way
 *   3. the HTF's own last ~8 closes have net-moved that way
 */
function computeRegime(htfCandles) {
  const closes = htfCandles.map(c => c.close);
  const n = closes.length;
  const ema50 = I.emaSeries(closes, 50);
  const ema50Now = I.last(ema50);
  const price = I.last(closes);
  if (ema50Now == null || price == null || n < 12) {
    return { direction: 'NEUTRAL', ema50: ema50Now, slope: 0, recentMove: 0, label: 'ข้อมูล HTF ไม่พอ' };
  }
  const norm = I.slope(ema50, 10) / ema50Now;      // EMA50 slope, fraction/bar
  const recentMove = (price - closes[n - 9]) / price; // last 8 HTF bars, fraction
  let direction = 'NEUTRAL';
  if (price > ema50Now && norm > 0.0003 && recentMove > -0.0015) direction = 'UP';
  else if (price < ema50Now && norm < -0.0003 && recentMove < 0.0015) direction = 'DOWN';
  const label = direction === 'UP' ? 'ขาขึ้น' : direction === 'DOWN' ? 'ขาลง' : 'ไม่ชัดเจน (sideways)';
  return { direction, ema50: ema50Now, slope: norm, recentMove, label };
}

/**
 * The core signal. `candles` and `htfCandles` are chronological arrays of
 * { time, open, high, low, close }. Returns a full analysis payload.
 */
function analyze({ assetKey = 'XAU', interval = '1h', candles, htfCandles }) {
  const cfg = assetConfig(assetKey);
  const closes = candles.map(c => c.close);
  const n = candles.length;
  const price = closes[n - 1];

  const [fastP, slowP] = FAST_SLOW[interval] || [20, 50];
  const emaFast = I.last(I.emaSeries(closes, fastP));
  const emaSlow = I.last(I.emaSeries(closes, slowP));
  const ema200 = n >= 200 ? I.last(I.emaSeries(closes, 200)) : null;

  const rsiArr = I.rsiSeries(closes, 14);
  const rsi = I.last(rsiArr);
  const rsiPrev = rsiArr.length >= 2 ? rsiArr[rsiArr.length - 2] : null;

  const atrArr = I.atrSeries(candles, 14);
  const atr = I.last(atrArr);

  const adx = I.adxLatest(candles, 14); // { adx, plusDI, minusDI } | null
  const macdRes = I.macd(closes);
  const structure = I.marketStructure(candles, 2);
  const bb = I.bollinger(closes, 20, 2);

  const lookbackSR = Math.min(30, n);
  const srWindow = candles.slice(-lookbackSR);
  const resistance = Math.max(...srWindow.map(c => c.high));
  const support = Math.min(...srWindow.map(c => c.low));

  const regime = computeRegime(htfCandles);

  // ---- "What is the chart actually doing" — measured, not inferred ----
  // Two windows, both in ATR units so they're comparable across assets:
  //   short  ~6 bars  — the immediate candles
  //   medium ~20 bars — the visible swing on screen
  // These become hard gates below: the system will not issue a direction that
  // fights a committed move on either window. This is the single rule that
  // keeps the signal from "going the opposite way to the chart".
  const a1 = atr != null && atr > 0 ? atr : null;
  const shortBars = 6, medBars = 20;
  const shortMoveAtr = (a1 && n > shortBars) ? (price - closes[n - 1 - shortBars]) / a1 : 0;
  const medMoveAtr = (a1 && n > medBars) ? (price - closes[n - 1 - medBars]) / a1 : 0;
  const shortDir = shortMoveAtr >= 1.0 ? 'BUY' : shortMoveAtr <= -1.0 ? 'SELL' : null;
  const medDir = medMoveAtr >= 1.5 ? 'BUY' : medMoveAtr <= -1.5 ? 'SELL' : null;

  // ---- Weighted votes -----------------------------------------------------
  const votes = [];
  const vote = (dir, weight, label) => votes.push({ dir, weight, label });

  // 1. Higher-timeframe regime (weight 3)
  if (regime.direction === 'UP') vote(1, 3, `HTF (${higherInterval(interval)}) ขาขึ้น — เทรนด์ใหญ่หนุนฝั่งซื้อ`);
  else if (regime.direction === 'DOWN') vote(-1, 3, `HTF (${higherInterval(interval)}) ขาลง — เทรนด์ใหญ่หนุนฝั่งขาย`);
  else vote(0, 0, `HTF (${higherInterval(interval)}) ไม่ชัดเจน — ไม่ให้คะแนนทิศทาง`);

  // 2. EMA cascade on the trading timeframe (weight 3)
  if (emaFast != null && emaSlow != null) {
    const bullCascade = ema200 != null ? (emaFast > emaSlow && emaSlow > ema200 && price > ema200) : emaFast > emaSlow;
    const bearCascade = ema200 != null ? (emaFast < emaSlow && emaSlow < ema200 && price < ema200) : emaFast < emaSlow;
    if (bullCascade) vote(1, 3, `EMA${fastP}>EMA${slowP}${ema200 != null ? '>EMA200 และราคาเหนือ EMA200' : ''} — เทรนด์ขาขึ้น`);
    else if (bearCascade) vote(-1, 3, `EMA${fastP}<EMA${slowP}${ema200 != null ? '<EMA200 และราคาใต้ EMA200' : ''} — เทรนด์ขาลง`);
    else vote(0, 0, 'EMA ไม่เรียงตัวเป็นเทรนด์เดียว — ไม่ให้คะแนน');
  }

  // 3. Market structure (weight 2). A fresh CHoCH flips this vote against the
  //    prevailing trend — it is an early-reversal tell, so it should not keep
  //    voting for the old direction just because the swing labels still read
  //    HH/HL.
  if (structure.choch === 'UP') vote(1, 2, 'โครงสร้างตลาด CHoCH ขาขึ้น (หักโครงสร้างเดิมที่เป็นขาลง)');
  else if (structure.choch === 'DOWN') vote(-1, 2, 'โครงสร้างตลาด CHoCH ขาลง (หักโครงสร้างเดิมที่เป็นขาขึ้น)');
  else if (structure.trend === 'UP' || structure.bos === 'UP') vote(1, 2, `โครงสร้างตลาด ${structure.bos === 'UP' ? 'BOS ขาขึ้น (ทะลุ swing high)' : 'HH/HL ขาขึ้น'}`);
  else if (structure.trend === 'DOWN' || structure.bos === 'DOWN') vote(-1, 2, `โครงสร้างตลาด ${structure.bos === 'DOWN' ? 'BOS ขาลง (หลุด swing low)' : 'LH/LL ขาลง'}`);
  else vote(0, 0, 'โครงสร้างตลาด sideways — ไม่ให้คะแนน');

  // 4. MACD histogram (weight 1)
  if (macdRes) {
    if (macdRes.histogram > 0 && macdRes.rising) vote(1, 1, 'MACD histogram บวกและกำลังเพิ่ม — โมเมนตัมขาขึ้น');
    else if (macdRes.histogram < 0 && !macdRes.rising) vote(-1, 1, 'MACD histogram ลบและกำลังลด — โมเมนตัมขาลง');
    else vote(0, 0, 'MACD histogram ก้ำกึ่ง — ไม่ให้คะแนน');
  }

  // 5. RSI regime (weight 1)
  if (rsi != null) {
    if (rsi >= 55) vote(1, 1, `RSI ${rsi.toFixed(1)} — โมเมนตัมฝั่งซื้อ`);
    else if (rsi <= 45) vote(-1, 1, `RSI ${rsi.toFixed(1)} — โมเมนตัมฝั่งขาย`);
    else vote(0, 0, `RSI ${rsi.toFixed(1)} อยู่โซนกลาง (45–55) — ไม่ให้คะแนน`);
  }

  // 6. ADX directional bias (weight 1) — only when the trend is real
  if (adx && adx.adx >= cfg.adxGate) {
    if (adx.plusDI > adx.minusDI) vote(1, 1, `+DI(${adx.plusDI.toFixed(0)}) > -DI(${adx.minusDI.toFixed(0)}) ที่ ADX ${adx.adx.toFixed(0)} — แรงซื้อนำ`);
    else vote(-1, 1, `-DI(${adx.minusDI.toFixed(0)}) > +DI(${adx.plusDI.toFixed(0)}) ที่ ADX ${adx.adx.toFixed(0)} — แรงขายนำ`);
  }

  // 7. Pullback-to-value location bonus (weight 1) — rewards entering on a dip
  //    within the trend. Only counts while the trading-timeframe STRUCTURE is
  //    still intact in the trend direction: once price prints LH/LL (or a
  //    CHoCH / opposite BOS) the "dip" has become a reversal, and calling it a
  //    buy-the-dip is exactly what makes the signal fight the visible chart.
  // 7. Pullback-to-value (weight 1) — a dip toward EMA value, but only when
  //    EVERYTHING slower agrees it's still a trend and the newest candles are
  //    not actively going the other way. A "pullback BUY" printed next to a
  //    SELL momentum vote is an internal contradiction — don't cast it.
  let pullback = null;
  if (emaFast != null && emaSlow != null && a1) {
    const bandLow = Math.min(emaFast, emaSlow) - a1 * 0.5;
    const bandHigh = Math.max(emaFast, emaSlow) + a1 * 0.5;
    const inBand = price >= bandLow && price <= bandHigh;
    const structOkForBuy = structure.trend !== 'DOWN' && structure.choch !== 'DOWN' && structure.bos !== 'DOWN';
    const structOkForSell = structure.trend !== 'UP' && structure.choch !== 'UP' && structure.bos !== 'UP';
    if (inBand && regime.direction === 'UP' && structOkForBuy && shortDir !== 'SELL' && medDir !== 'SELL') { pullback = 'BUY'; vote(1, 1, 'ราคาย่อเข้าโซน EMA ตามเทรนด์ (โครงสร้าง+โมเมนตัมยังไม่สวน)'); }
    else if (inBand && regime.direction === 'DOWN' && structOkForSell && shortDir !== 'BUY' && medDir !== 'BUY') { pullback = 'SELL'; vote(-1, 1, 'ราคาเด้งเข้าโซน EMA ตามเทรนด์ (โครงสร้าง+โมเมนตัมยังไม่สวน)'); }
    else if (inBand) vote(0, 0, 'ราคาอยู่ในโซน EMA แต่ทิศทางช้า/เร็วยังไม่สอดคล้อง — ไม่นับเป็นจุดเข้าตามเทรนด์');
  }

  // 8. Short-term price move (weight 2) — the last 6 candles, in ATR units.
  //    The one vote that tracks what price is doing right now, not a lagging
  //    average.
  const momentum = shortDir;
  if (shortDir === 'BUY') vote(1, 2, `ราคา ${shortBars} แท่งล่าสุด +${shortMoveAtr.toFixed(1)}×ATR — โมเมนตัมสั้นเป็นขาขึ้น`);
  else if (shortDir === 'SELL') vote(-1, 2, `ราคา ${shortBars} แท่งล่าสุด ${shortMoveAtr.toFixed(1)}×ATR — โมเมนตัมสั้นเป็นขาลง`);
  else vote(0, 0, `ราคา ${shortBars} แท่งล่าสุด ${shortMoveAtr >= 0 ? '+' : ''}${shortMoveAtr.toFixed(1)}×ATR — โมเมนตัมสั้นก้ำกึ่ง`);

  // 9. Medium-term price move (weight 2) — the ~20-bar swing visible on screen.
  if (medDir === 'BUY') vote(1, 2, `ราคา ${medBars} แท่งล่าสุด +${medMoveAtr.toFixed(1)}×ATR — กราฟระยะกลางเป็นขาขึ้น`);
  else if (medDir === 'SELL') vote(-1, 2, `ราคา ${medBars} แท่งล่าสุด ${medMoveAtr.toFixed(1)}×ATR — กราฟระยะกลางเป็นขาลง`);
  else vote(0, 0, `ราคา ${medBars} แท่งล่าสุด ${medMoveAtr >= 0 ? '+' : ''}${medMoveAtr.toFixed(1)}×ATR — กราฟระยะกลาง sideways`);

  // ---- Tally ------------------------------------------------------------
  // Confidence and the "strong" bar are measured against the FIXED maximum
  // weight any setup could score (below), not the weight that happened to
  // vote this bar — otherwise a bar where only 4 points had an opinion could
  // show 100% and clear the strong bar on a fraction of the real evidence.
  const MAX_WEIGHT = 16; // regime 3 + cascade 3 + structure 2 + short-mom 2 + med-mom 2 + macd 1 + rsi 1 + adx 1 + pullback 1
  const presentWeight = votes.reduce((s, v) => s + v.weight, 0);
  const net = votes.reduce((s, v) => s + v.dir * v.weight, 0);
  const direction = net > 0 ? 'BUY' : net < 0 ? 'SELL' : null;
  const confidence = Math.min(100, Math.round((Math.abs(net) / MAX_WEIGHT) * 100));

  const ema200Dir = ema200 != null ? (price > ema200 ? 'BUY' : 'SELL') : null;
  const against200 = ema200Dir != null && direction != null && direction !== ema200Dir;
  const strongFrac = against200 ? cfg.strongFractionCounter200 : cfg.strongFraction;
  const strongThreshold = Math.max(1, Math.ceil(MAX_WEIGHT * strongFrac));
  const strong = Math.abs(net) >= strongThreshold;
  const totalWeight = presentWeight;

  // ---- Gates ----------------------------------------------------------
  const reasons = votes.filter(v => v.weight > 0).map(v => `${v.dir > 0 ? '▲' : v.dir < 0 ? '▼' : '•'} ${v.label}`);
  let tradable = true;
  let waitReason = null;

  if (!direction) {
    tradable = false;
    waitReason = 'สัญญาณซื้อ/ขายหักล้างกันพอดี — ยังไม่มีทิศทางชัดเจน';
  } else if (!adx || adx.adx < cfg.adxGate) {
    tradable = false;
    waitReason = `ADX ${adx ? adx.adx.toFixed(1) : 'N/A'} < ${cfg.adxGate} — ตลาดยังไม่มีเทรนด์แข็งแรงพอ (ไซด์เวย์)`;
  } else if (regime.direction !== 'NEUTRAL' && ((direction === 'BUY' && regime.direction === 'DOWN') || (direction === 'SELL' && regime.direction === 'UP'))) {
    tradable = false;
    waitReason = `ทิศทาง ${direction} สวนกับเทรนด์ HTF (${regime.label}) — ระบบไม่เทรดสวนกรอบใหญ่`;
  } else if ((direction === 'BUY' && structure.choch === 'DOWN') || (direction === 'SELL' && structure.choch === 'UP')) {
    tradable = false;
    waitReason = `เพิ่งเกิด CHoCH สวนทาง ${direction} — รอโครงสร้างตลาดนิ่งก่อน`;
  } else if ((direction === 'BUY' && structure.trend === 'DOWN') || (direction === 'SELL' && structure.trend === 'UP')) {
    tradable = false;
    waitReason = `ทิศทาง ${direction} สวนกับโครงสร้าง ${structure.trend === 'DOWN' ? 'LH/LL (ขาลง)' : 'HH/HL (ขาขึ้น)'} ของกรอบเวลานี้ — ไม่เข้าซื้อตอนตลาดยังทำ${structure.trend === 'DOWN' ? 'จุดต่ำใหม่' : 'จุดสูงใหม่'} รอโครงสร้างกลับก่อน`;
  } else if (shortDir && direction !== shortDir) {
    tradable = false;
    waitReason = `ทิศทาง ${direction} สวนกับราคา ${shortBars} แท่งล่าสุด (${shortMoveAtr >= 0 ? '+' : ''}${shortMoveAtr.toFixed(1)}×ATR) — ระบบไม่เข้าสวนสิ่งที่แท่งเทียนกำลังทำ`;
  } else if (medDir && direction !== medDir) {
    tradable = false;
    waitReason = `ทิศทาง ${direction} สวนกับการเคลื่อนของราคา ${medBars} แท่งล่าสุด (${medMoveAtr >= 0 ? '+' : ''}${medMoveAtr.toFixed(1)}×ATR) — ระบบไม่เข้าสวนทิศทางที่กราฟกำลังไป`;
  } else if (!strong) {
    tradable = false;
    waitReason = `สัญญาณยังไม่แข็งแรงพอ (${Math.abs(net)}/${MAX_WEIGHT}, ต้องการ ${strongThreshold}${against200 ? ' เพราะสวน EMA200' : ''})`;
  } else if (regime.direction === 'NEUTRAL') {
    tradable = false;
    waitReason = 'เทรนด์ HTF ยังไม่ชัดเจน — รอกรอบใหญ่เลือกทาง';
  }

  // "developing" never applies to a direction that fights the chart or the
  // higher timeframe — those are hard no's, not "almost there".
  const fightsChart = (shortDir && direction !== shortDir)
    || (medDir && direction !== medDir)
    || (direction === 'BUY' && (regime.direction === 'DOWN' || structure.trend === 'DOWN'))
    || (direction === 'SELL' && (regime.direction === 'UP' || structure.trend === 'UP'));
  const developing = !tradable && direction != null && adx != null && !fightsChart
    && adx.adx >= cfg.adxGate - 4 && Math.abs(net) >= strongThreshold - 2;

  // ---- Trade levels -------------------------------------------------
  const levels = buildLevels({ direction, tradable, price, atr, structure, support, resistance, cfg });

  return {
    assetKey,
    interval,
    higherInterval: higherInterval(interval),
    price,
    generatedAt: new Date().toISOString(),
    candleTime: candles[n - 1].time,
    signal: {
      direction,
      tradable,
      strong,
      developing,
      net,
      totalWeight,
      maxWeight: MAX_WEIGHT,
      strongThreshold,
      confidence,
      against200,
      waitReason,
      reasons,
    },
    levels,
    indicators: {
      emaFast, emaSlow, ema200, fastPeriod: fastP, slowPeriod: slowP,
      rsi, rsiPrev,
      atr,
      adx: adx ? adx.adx : null,
      plusDI: adx ? adx.plusDI : null,
      minusDI: adx ? adx.minusDI : null,
      macd: macdRes,
      bollinger: bb,
      support, resistance,
      pullback,
      momentum,
      shortMoveAtr: Math.round(shortMoveAtr * 100) / 100,
      medMoveAtr: Math.round(medMoveAtr * 100) / 100,
      shortDir, medDir,
    },
    structure,
    regime,
  };
}

function buildLevels({ direction, tradable, price, atr, structure, support, resistance, cfg }) {
  if (!direction || !isFinite(price)) {
    return { entry: null, sl: null, tp: null, slDistance: null, tpDistance: null, riskReward: null, slBasis: null };
  }
  const isBuy = direction === 'BUY';
  const a = isFinite(atr) && atr > 0 ? atr : null;
  const buffer = a ? a * cfg.swingBufferAtr : 0;

  // Anchor SL beyond the most relevant structure level in the trade direction.
  let slAnchor = null, slBasis = null;
  if (isBuy) {
    const swingLow = structure.lastLow ? structure.lastLow.price : null;
    if (swingLow != null && swingLow < price) { slAnchor = swingLow - buffer; slBasis = 'Swing Low'; }
    else if (support < price) { slAnchor = support - buffer; slBasis = 'Support (30 แท่ง)'; }
  } else {
    const swingHigh = structure.lastHigh ? structure.lastHigh.price : null;
    if (swingHigh != null && swingHigh > price) { slAnchor = swingHigh + buffer; slBasis = 'Swing High'; }
    else if (resistance > price) { slAnchor = resistance + buffer; slBasis = 'Resistance (30 แท่ง)'; }
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

  // Clamp to a sane multiple of ATR so a nearby swing doesn't give a
  // hair-thin stop and a far one doesn't blow the risk budget.
  if (a) {
    const minD = a * cfg.atrSlMult.min;
    const maxD = a * cfg.atrSlMult.max;
    if (slDistance < minD) { slDistance = minD; slBasis += ` (ขยายเป็น ATR × ${cfg.atrSlMult.min})`; }
    else if (slDistance > maxD) { slDistance = maxD; slBasis += ` (จำกัดที่ ATR × ${cfg.atrSlMult.max})`; }
  }

  const tpDistance = slDistance * cfg.rr;
  const sl = isBuy ? price - slDistance : price + slDistance;
  const tp = isBuy ? price + tpDistance : price - tpDistance;

  return {
    entry: price,
    sl,
    tp,
    slDistance,
    tpDistance,
    riskReward: `1 : ${cfg.rr}`,
    slBasis,
  };
}

module.exports = { analyze, computeRegime, higherInterval, assetConfig, ASSET_CONFIG, HTF_MAP, FAST_SLOW };
