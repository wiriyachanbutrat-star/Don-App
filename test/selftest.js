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

// ---- price-action primitives --------------------------------
{
  const hammer = { open: 100, high: 100.3, low: 97, close: 100.1 };
  check('rejection: bullish hammer detected', I.isBullishRejection(null, hammer));
  const star = { open: 100, high: 103, low: 99.8, close: 100 };
  check('rejection: bearish shooting star detected', I.isBearishRejection(null, star));
  const doji = { open: 100, high: 101, low: 99, close: 100 };
  check('rejection: doji is neither', !I.isBullishRejection(null, doji) && !I.isBearishRejection(null, doji));
}

// ---- strategy end-to-end (XAUUSD Smart Entry) ---------------
{
  const mk = (nBars, startP, stepP, noiseAmp = 0.3) => {
    const arr = [];
    let p = startP;
    for (let i = 0; i < nBars; i++) {
      const close = p + Math.sin(i / 3) * Math.abs(stepP || 1) * noiseAmp;
      arr.push({ time: `2024-01-01 ${String(i % 24).padStart(2, '0')}:00:00`, open: p,
        high: Math.max(p, close) + Math.abs(stepP || 1) * 0.2, low: Math.min(p, close) - Math.abs(stepP || 1) * 0.2, close });
      p += stepP;
    }
    return arr;
  };
  const call = (interval, e, s, t) => S.analyze({ assetKey: 'XAU', interval, entryCandles: e, structureCandles: s, trendCandles: t });

  // Clean uptrend on all three TFs.
  const up = call('15min', mk(320, 2000, 0.8), mk(320, 1950, 1.2), mk(320, 1900, 1.6));
  check('strategy: uptrend → BUY direction', up.signal.direction === 'BUY', JSON.stringify(up.signal.checklist));
  check('strategy: score in 0..9', up.signal.score >= 0 && up.signal.score <= 9);
  check('strategy: H4 trend row scored +2', up.signal.checklist[0].got === true);
  check('strategy: has levels when direction set', up.levels.entry != null && isFinite(up.levels.sl) && isFinite(up.levels.tp));
  if (up.levels.sl != null) check('strategy: BUY sl < entry < tp', up.levels.sl < up.levels.entry && up.levels.entry < up.levels.tp, JSON.stringify(up.levels));

  // Clean downtrend.
  const dn = call('15min', mk(320, 2000, -0.8), mk(320, 2050, -1.2), mk(320, 2100, -1.6));
  check('strategy: downtrend → SELL direction', dn.signal.direction === 'SELL', JSON.stringify(dn.signal.checklist));
  if (dn.levels.sl != null) check('strategy: SELL tp < entry < sl', dn.levels.tp < dn.levels.entry && dn.levels.entry < dn.levels.sl, JSON.stringify(dn.levels));

  // Flat trend TF → no direction, no trade.
  const flat = mk(320, 2000, 0);
  const fr = call('15min', flat, flat, flat);
  check('strategy: flat trend TF → no direction', fr.signal.direction === null);
  check('strategy: flat → not tradable', fr.signal.tradable === false);
  check('strategy: flat → tier NO_TRADE', fr.signal.tier === 'NO_TRADE');

  // Trend TF up but structure TF down → H1 Structure row must NOT score,
  // so the setup can't reach STRONG on trend alone.
  const conflict = call('15min', mk(320, 2000, 0.8), mk(320, 2100, -1.2), mk(320, 1900, 1.6));
  const h1row = conflict.signal.checklist.find(c => c.name === 'H1 Structure');
  check('strategy: conflicting H1 structure → row not scored', h1row && h1row.got === false, JSON.stringify(h1row));

  // maxScore / shape sanity for downstream consumers.
  check('strategy: signal shape', up.signal.maxScore === 9 && up.signal.checklist.length === 7 && Array.isArray(up.signal.reasons) && up.signal.reasons.length >= 7);
  check('strategy: checklist names', ['H4 Trend','H1 Structure','Action Zone','Breakout','Pullback','QM Pattern','Price Action'].every((nm,ix)=>up.signal.checklist[ix].name===nm), JSON.stringify(up.signal.checklist.map(c=>c.name)));
  check('strategy: playbook block present', up.playbook && 'breakout' in up.playbook && 'pullback' in up.playbook && 'actionZone' in up.playbook && 'qm' in up.playbook);
  check('strategy: institutional block (BUY) present', up.institutional && up.institutional.state === 'ACCUMULATION' && up.institutional.maxScore === 100 && Array.isArray(up.institutional.components) && up.institutional.components.length === 6 && Array.isArray(up.institutional.checklist) && up.institutional.checklist.length === 6, JSON.stringify(up.institutional && up.institutional.tier));
  check('strategy: institutional score 0..100', up.institutional.score >= 0 && up.institutional.score <= 100);
  check('strategy: institutional non-BUY → not accumulation', dn.institutional && dn.institutional.state === 'DISTRIBUTION' && dn.institutional.ready === false);
  check('strategy: institutional flat → NO_TREND', fr.institutional && fr.institutional.state === 'NO_TREND');
  check('strategy: session field present', up.signal.session && typeof up.signal.session.ok === 'boolean');

  // Session gate: same clean uptrend but the last bar lands at 03:00 UTC
  // (Asian) → a full setup must be held to WATCH, not STRONG.
  const asianCandles = mk(320, 2000, 0.8).map((c, i) => ({ ...c, time: '2024-01-01 03:00:00' }));
  const asia = S.analyze({ assetKey: 'XAU', interval: '15min', entryCandles: asianCandles, structureCandles: mk(320, 1950, 1.2), trendCandles: mk(320, 1900, 1.6) });
  check('strategy: out-of-session → not tradable', asia.signal.tradable === false, asia.signal.waitReason || '');

  // Prior-day levels helper
  const twoDays = [];
  for (let d = 1; d <= 2; d++) for (let h = 0; h < 24; h++)
    twoDays.push({ time: `2024-01-0${d} ${String(h).padStart(2, '0')}:00:00`, open: 100 + d, high: 105 + d, low: 95 + d, close: 100 + d + h * 0.1 });
  const pd = I.priorDayLevels(twoDays);
  check('priorDayLevels: prev day high/low', pd && pd.high === 106 && pd.low === 96, JSON.stringify(pd));

  // srZones: repeated pivots at ~the same price merge into one high-touch zone
  const zc = [];
  const zpath = [100, 103, 106, 103, 100, 103, 106.1, 103, 100.1, 103, 106, 103, 100, 103];
  zpath.forEach((v, i) => zc.push({ time: String(i), open: v, high: v + 0.3, low: v - 0.3, close: v }));
  const zones = I.srZones(zc, 2, 1.0);
  check('srZones: clusters repeated levels', zones.some(z => z.touches >= 2), JSON.stringify(zones));

  // quasimodo: LS low → high → lower low (head) → break the high → return
  const qc = [];
  const qpath = [105, 103, 100, 102, 106, 110, 108, 103, 98, 95, 99, 104, 109, 113, 112, 111];
  qpath.forEach((v, i) => qc.push({ time: String(i), open: v, high: v + 0.4, low: v - 0.4, close: v }));
  const qm = I.quasimodo(qc, 2);
  check('quasimodo: bullish QM detected', qm.bull && qm.bull.head < qm.bull.leftShoulder, JSON.stringify(qm));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
