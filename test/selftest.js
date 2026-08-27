'use strict';

// Deterministic sanity checks for the indicator + strategy math.
// Run: node test/selftest.js

const I = require('../lib/indicators');
const S = require('../lib/strategy');

let pass = 0, fail = 0;
const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- EMA ----------------------------------------------------------------
{
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const e = I.emaSeries(v, 3);
  check('ema: null before seed', e[0] === null && e[1] === null);
  check('ema: SMA seed at period-1', approx(e[2], 2)); // (1+2+3)/3
  // next: 4*0.5 + 2*0.5 = 3
  check('ema: recursive step', approx(e[3], 3));
  check('ema: too-short returns all null', I.emaSeries([1, 2], 5).every(x => x === null));
}

// ---- SMA --------------------------------------------------------------
{
  const s = I.smaSeries([2, 4, 6, 8, 10], 2);
  check('sma: seed', approx(s[1], 3));
  check('sma: rolling', approx(s[4], 9));
}

// ---- RSI (Wilder) --------------------------------------------------
{
  // Classic Wilder textbook series (from "New Concepts in Technical Trading
  // Systems"), first RSI value should be ~70.53.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  ];
  const r = I.rsiSeries(closes, 14);
  check('rsi: null before period', r[13] === null);
  check('rsi: first value ~70.53', approx(r[14], 70.53, 0.5), `got ${r[14]}`);
  check('rsi: all-up series → 100', I.rsiSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14).pop() === 100);
  check('rsi: flat series → 50', I.rsiSeries(new Array(20).fill(5), 14).pop() === 50);
}

// ---- ATR ---------------------------------------------------------
{
  // Build candles with a constant true range of 2 → ATR must converge to 2.
  const candles = [];
  let base = 100;
  for (let i = 0; i < 40; i++) {
    candles.push({ time: String(i), open: base, high: base + 1, low: base - 1, close: base });
    // next candle's close == this close so TR = high-low = 2 each bar
  }
  const a = I.atrSeries(candles, 14);
  check('atr: null before seed', a[14 - 1] === null);
  check('atr: seed index set', a[14] != null);
  check('atr: constant TR → ATR≈2', approx(I.last(a), 2, 1e-9), `got ${I.last(a)}`);
}

// ---- ADX ------------------------------------------------------------
{
  // Pure uptrend: each bar strictly higher → +DI should dominate, ADX high.
  const up = [];
  let p = 100;
  for (let i = 0; i < 60; i++) { up.push({ time: String(i), open: p, high: p + 2, low: p + 0.5, close: p + 1.5 }); p += 1.5; }
  const adxUp = I.adxLatest(up, 14);
  check('adx: returns object on trend', adxUp && isFinite(adxUp.adx));
  check('adx: +DI > -DI in uptrend', adxUp.plusDI > adxUp.minusDI, `${adxUp.plusDI} vs ${adxUp.minusDI}`);
  check('adx: strong trend → ADX high', adxUp.adx > 40, `got ${adxUp.adx}`);
  check('adx: null when too short', I.adxLatest(up.slice(0, 10), 14) === null);

  // Choppy: alternating → ADX low.
  const chop = [];
  for (let i = 0; i < 80; i++) {
    const hi = i % 2 === 0 ? 101 : 100.5;
    const lo = i % 2 === 0 ? 99.5 : 99;
    chop.push({ time: String(i), open: 100, high: hi, low: lo, close: i % 2 === 0 ? 100.6 : 99.6 });
  }
  const adxChop = I.adxLatest(chop, 14);
  check('adx: choppy market → ADX low', adxChop.adx < 30, `got ${adxChop.adx}`);
}

// ---- MACD -------------------------------------------------------
{
  const closes = [];
  for (let i = 0; i < 80; i++) closes.push(100 + Math.sin(i / 5) * 5 + i * 0.1);
  const m = I.macd(closes);
  check('macd: returns object', m && isFinite(m.macd) && isFinite(m.signal));
  check('macd: histogram = macd - signal', approx(m.histogram, m.macd - m.signal, 1e-9));
  check('macd: null when too short', I.macd([1, 2, 3]) === null);
}

// ---- swings / structure -----------------------------------------
{
  const c = [];
  // deliberate zigzag: up to 110, down to 95, up to 120
  const path = [100, 103, 107, 110, 108, 104, 99, 95, 98, 104, 111, 117, 120, 118, 121];
  path.forEach((v, i) => c.push({ time: String(i), open: v, high: v + 0.5, low: v - 0.5, close: v }));
  const sw = I.swings(c, 2);
  check('swings: found highs', sw.highs.length >= 1);
  check('swings: found lows', sw.lows.length >= 1);
  check('swings: last wing candles excluded', sw.highs.every(h => h.idx <= c.length - 1 - 2));

  const st = I.marketStructure(c, 2);
  check('structure: returns a trend label', ['UP', 'DOWN', 'RANGE'].includes(st.trend));
}

// ---- bollinger ------------------------------------------------
{
  const flat = new Array(30).fill(50);
  const b = I.bollinger(flat, 20, 2);
  check('bollinger: zero variance → bands collapse', approx(b.upper, 50) && approx(b.lower, 50));
}

// ---- strategy end-to-end -------------------------------------
{
  // Strong synthetic uptrend on both TFs → expect BUY, tradable.
  const mk = (nBars, startP, stepP) => {
    const arr = [];
    let p = startP;
    for (let i = 0; i < nBars; i++) {
      const noise = Math.sin(i / 3) * stepP * 0.3;
      const close = p + noise;
      arr.push({ time: `2024-01-01 ${String(i % 24).padStart(2, '0')}:00:00`, open: p, high: Math.max(p, close) + stepP * 0.2, low: Math.min(p, close) - stepP * 0.2, close });
      p += stepP;
    }
    return arr;
  };
  const candles = mk(320, 2000, 0.8);
  const htf = mk(320, 1900, 1.6);
  const r = S.analyze({ assetKey: 'XAU', interval: '1h', candles, htfCandles: htf });
  check('strategy: uptrend → BUY direction', r.signal.direction === 'BUY', JSON.stringify(r.signal));
  check('strategy: uptrend → tradable', r.signal.tradable === true, r.signal.waitReason || '');
  check('strategy: BUY levels ordered (sl < entry < tp)', r.levels.sl < r.levels.entry && r.levels.entry < r.levels.tp, JSON.stringify(r.levels));
  check('strategy: RR honoured', approx(r.levels.tpDistance / r.levels.slDistance, 1.5, 1e-6));
  check('strategy: confidence 0..100', r.signal.confidence >= 0 && r.signal.confidence <= 100);
  check('strategy: reasons present', Array.isArray(r.signal.reasons) && r.signal.reasons.length > 0);

  // Downtrend mirror
  const dcandles = mk(320, 2000, -0.8);
  const dhtf = mk(320, 2100, -1.6);
  const dr = S.analyze({ assetKey: 'XAU', interval: '1h', candles: dcandles, htfCandles: dhtf });
  check('strategy: downtrend → SELL', dr.signal.direction === 'SELL', JSON.stringify(dr.signal));
  check('strategy: SELL levels ordered (tp < entry < sl)', dr.levels.tp < dr.levels.entry && dr.levels.entry < dr.levels.sl, JSON.stringify(dr.levels));

  // Choppy / flat → expect WAIT (not tradable)
  const fcandles = mk(320, 2000, 0).map((c, i) => ({ ...c, high: c.close + 3, low: c.close - 3, close: c.close + (i % 2 ? 1 : -1) }));
  const fr = S.analyze({ assetKey: 'XAU', interval: '1h', candles: fcandles, htfCandles: fcandles });
  check('strategy: flat market → not tradable', fr.signal.tradable === false, JSON.stringify(fr.signal));

  // Counter-trend: main up but HTF down → must not be tradable BUY
  const ct = S.analyze({ assetKey: 'XAU', interval: '1h', candles, htfCandles: dhtf });
  check('strategy: main-up vs HTF-down → vetoed', !(ct.signal.tradable && ct.signal.direction === 'BUY'), JSON.stringify(ct.signal));

  // Buy-the-dip guard: long uptrend history (regime + cascade bullish) but the
  // last ~15 bars sell off hard, printing LH/LL → must NOT be a tradable BUY.
  const base = mk(300, 2000, 0.8);
  const selloff = [];
  let p = base[base.length - 1].close;
  for (let i = 0; i < 20; i++) {
    const close = p - 3.5;
    selloff.push({ time: `2024-02-01 ${String(i % 24).padStart(2, '0')}:00:00`, open: p, high: p + 1, low: close - 1, close });
    p = close;
  }
  const dipCandles = base.concat(selloff);
  const dip = S.analyze({ assetKey: 'XAU', interval: '1h', candles: dipCandles, htfCandles: mk(320, 1900, 1.6) });
  check('strategy: sharp selloff in an uptrend → BUY not tradable', !(dip.signal.tradable && dip.signal.direction === 'BUY'), JSON.stringify(dip.signal));
  check('strategy: selloff → momentum vote is SELL', dip.indicators.momentum === 'SELL', String(dip.indicators.momentum));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
