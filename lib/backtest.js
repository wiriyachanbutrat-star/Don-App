'use strict';

const { analyze } = require('./strategy');

// ---------------------------------------------------------------------------
// Walk-forward backtest of the exact live strategy over a long candle series.
//
// No look-ahead: at bar i the signal is computed from candles[0..i] only
// (windowed to the last WINDOW bars, which is all analyze() needs), and the
// higher-timeframe series is truncated to bars that had already closed by
// candles[i].time. Entry is the close of the signal bar; the SL/TP are the
// ones the live system would have shown. Exit is decided by scanning forward
// bar-by-bar. One position at a time — no pyramiding.
//
// Result is expressed in **R** (multiples of the initial risk) so it is
// independent of lot size: +1R = hit TP at RR 1:1, a 1:1.5 setup that wins
// pays +1.5R, a loss is -1R.
// ---------------------------------------------------------------------------

const WINDOW = 320;          // bars fed to analyze() — matches live OUTPUT_SIZE
const MAX_HOLD_BARS = 48;    // time-stop: close at market if neither SL/TP hit

function runBacktest({ assetKey = 'XAU', interval = '1h', candles, htfCandles }) {
  const n = candles.length;
  if (n < WINDOW + 50) {
    return { error: `ข้อมูลย้อนหลังน้อยเกินไป (${n} แท่ง ต้องการอย่างน้อย ${WINDOW + 50})` };
  }

  // Pre-sort htf candles; advance a forward-only pointer as bar.time grows
  // (non-decreasing even when i jumps past a trade) so truncation is O(1)
  // amortised instead of an O(htf) filter every bar.
  const htfSorted = htfCandles.slice().sort((a, b) => (a.time < b.time ? -1 : 1));
  let hIdx = 0;

  const trades = [];
  let i = WINDOW;
  while (i < n - 1) {
    const bar = candles[i];
    while (hIdx < htfSorted.length && htfSorted[hIdx].time <= bar.time) hIdx++;
    if (hIdx < 60) { i++; continue; }
    const window = candles.slice(i - WINDOW + 1, i + 1);
    // analyze()'s regime read only needs the recent HTF tail; 220 keeps EMA50
    // well past its settle window while staying cheap.
    const htfWindow = htfSorted.slice(Math.max(0, hIdx - 220), hIdx);

    let res;
    try {
      res = analyze({ assetKey, interval, candles: window, htfCandles: htfWindow });
    } catch (e) {
      i++; continue;
    }
    const s = res.signal;
    const L = res.levels;
    if (!s.tradable || !s.direction || L.entry == null || !isFinite(L.sl) || !isFinite(L.tp)) {
      i++; continue;
    }

    const isBuy = s.direction === 'BUY';
    const entry = bar.close;
    const risk = Math.abs(entry - L.sl);
    if (!(risk > 0)) { i++; continue; }
    // Re-derive TP off the actual entry (bar.close), keeping the system's RR.
    const rr = L.tpDistance / L.slDistance;
    const tp = isBuy ? entry + risk * rr : entry - risk * rr;
    const sl = L.sl;

    // Scan forward for the outcome.
    let outcome = null, exitIdx = null, rMultiple = null;
    const lastScan = Math.min(n - 1, i + MAX_HOLD_BARS);
    for (let j = i + 1; j <= lastScan; j++) {
      const c = candles[j];
      const slHit = isBuy ? c.low <= sl : c.high >= sl;
      const tpHit = isBuy ? c.high >= tp : c.low <= tp;
      if (slHit && tpHit) {
        // Both in one bar, no tick data — assume the closer-to-open level first.
        outcome = Math.abs(c.open - sl) <= Math.abs(c.open - tp) ? 'loss' : 'win';
      } else if (slHit) outcome = 'loss';
      else if (tpHit) outcome = 'win';
      if (outcome) { exitIdx = j; break; }
    }
    if (!outcome) {
      // Time stop — mark to market at the last scanned close.
      exitIdx = lastScan;
      const mtm = candles[lastScan].close;
      rMultiple = (isBuy ? (mtm - entry) : (entry - mtm)) / risk;
      outcome = rMultiple >= 0 ? 'scratch+' : 'scratch-';
    } else {
      rMultiple = outcome === 'win' ? rr : -1;
    }

    trades.push({
      time: bar.time,
      direction: s.direction,
      entry, sl, tp,
      adx: res.indicators.adx,
      confidence: s.confidence,
      net: s.net,
      strong: s.strong,
      outcome,
      rMultiple,
      barsHeld: exitIdx - i,
    });

    // Resume after the trade closed — one position at a time.
    i = exitIdx + 1;
  }

  return summarise(trades, candles, interval);
}

function summarise(trades, candles, interval) {
  const closed = trades.filter(t => t.outcome === 'win' || t.outcome === 'loss');
  const wins = closed.filter(t => t.outcome === 'win');
  const losses = closed.filter(t => t.outcome === 'loss');
  const scratches = trades.filter(t => t.outcome.startsWith('scratch'));

  const sumR = trades.reduce((a, t) => a + t.rMultiple, 0);
  const grossWin = trades.filter(t => t.rMultiple > 0).reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = -trades.filter(t => t.rMultiple < 0).reduce((a, t) => a + t.rMultiple, 0);

  // Equity curve in R, for max drawdown.
  let eq = 0, peak = 0, maxDD = 0, consec = 0, maxConsec = 0;
  const equity = [];
  for (const t of trades) {
    eq += t.rMultiple;
    equity.push(Math.round(eq * 100) / 100);
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
    if (t.rMultiple < 0) { consec++; if (consec > maxConsec) maxConsec = consec; }
    else consec = 0;
  }

  const winRate = closed.length ? wins.length / closed.length : null;
  const expectancyR = trades.length ? sumR / trades.length : null;

  // ADX buckets — is the gate in the right place?
  const bucketDefs = [
    { label: '25–30', lo: 25, hi: 30 },
    { label: '30–35', lo: 30, hi: 35 },
    { label: '35–40', lo: 35, hi: 40 },
    { label: '40+', lo: 40, hi: Infinity },
  ];
  const adxBuckets = bucketDefs.map(b => {
    const inB = closed.filter(t => isFinite(t.adx) && t.adx >= b.lo && t.adx < b.hi);
    const w = inB.filter(t => t.outcome === 'win').length;
    return { range: b.label, trades: inB.length, winRate: inB.length ? w / inB.length : null,
      expectancyR: inB.length ? inB.reduce((a, t) => a + t.rMultiple, 0) / inB.length : null };
  }).filter(b => b.trades > 0);

  const byDir = ['BUY', 'SELL'].map(d => {
    const g = closed.filter(t => t.direction === d);
    const w = g.filter(t => t.outcome === 'win').length;
    return { direction: d, trades: g.length, winRate: g.length ? w / g.length : null,
      expectancyR: g.length ? g.reduce((a, t) => a + t.rMultiple, 0) / g.length : null };
  });

  const first = candles[WINDOW] ? candles[WINDOW].time : null;
  const last = candles[candles.length - 1] ? candles[candles.length - 1].time : null;

  return {
    interval,
    period: { from: first, to: last, bars: candles.length },
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    winRate,
    expectancyR: expectancyR == null ? null : Math.round(expectancyR * 1000) / 1000,
    totalR: Math.round(sumR * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    maxDrawdownR: Math.round(maxDD * 100) / 100,
    maxConsecutiveLosses: maxConsec,
    avgBarsHeld: trades.length ? Math.round(trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length) : null,
    adxBuckets,
    byDirection: byDir,
    equityCurveR: equity,
    recentTrades: trades.slice(-15).map(t => ({
      time: t.time, direction: t.direction, outcome: t.outcome,
      rMultiple: Math.round(t.rMultiple * 100) / 100, adx: t.adx == null ? null : Math.round(t.adx * 10) / 10,
    })),
    verdict: buildVerdict({ winRate, expectancyR, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, totalTrades: trades.length, adxBuckets }),
    tuning: buildTuning({ byDirection: byDir, adxBuckets }),
  };
}

function buildVerdict({ winRate, expectancyR, profitFactor, totalTrades, adxBuckets }) {
  const notes = [];
  if (totalTrades < 20) {
    notes.push(`มีเทรดแค่ ${totalTrades} ครั้งในช่วงที่ทดสอบ — น้อยเกินจะสรุปได้ ต้องดึงข้อมูลย้อนหลังมากขึ้นหรือรอสะสม`);
  }
  if (expectancyR != null) {
    if (expectancyR > 0.15) notes.push(`คาดหวังกำไร ${expectancyR.toFixed(2)}R ต่อไม้ — กลยุทธ์มี edge เป็นบวกในช่วงนี้`);
    else if (expectancyR > 0) notes.push(`คาดหวัง ${expectancyR.toFixed(2)}R ต่อไม้ — บวกแบบบาง ๆ อ่อนไหวต่อค่าคอมมิชชั่น/สเปรด`);
    else notes.push(`คาดหวัง ${expectancyR.toFixed(2)}R ต่อไม้ — ติดลบ กลยุทธ์นี้ขาดทุนสุทธิในช่วงที่ทดสอบ ควรเข้มงวด gate เพิ่ม`);
  }
  if (profitFactor != null) notes.push(`Profit factor ${profitFactor.toFixed(2)} (กำไรรวม ÷ ขาดทุนรวม ${profitFactor >= 1.3 ? '— ดี' : profitFactor >= 1 ? '— พอไหว' : '— แย่'})`);

  return notes;
}

// Compare BUY vs SELL performance and the ADX buckets — separate from the
// headline verdict because these point at concrete config changes.
function buildTuning({ byDirection, adxBuckets }) {
  const t = [];
  const buy = byDirection.find(d => d.direction === 'BUY');
  const sell = byDirection.find(d => d.direction === 'SELL');
  if (buy && sell && buy.trades >= 8 && sell.trades >= 8 && buy.expectancyR != null && sell.expectancyR != null) {
    const gap = buy.expectancyR - sell.expectancyR;
    if (Math.abs(gap) > 0.35) {
      const good = gap > 0 ? 'BUY' : 'SELL';
      const bad = gap > 0 ? 'SELL' : 'BUY';
      const badExp = gap > 0 ? sell.expectancyR : buy.expectancyR;
      t.push(`ฝั่ง ${good} ทำเงินได้ แต่ฝั่ง ${bad} คาดหวัง ${badExp.toFixed(2)}R (ขาดทุน) — ในช่วงนี้กลยุทธ์เวิร์กข้างเดียว พิจารณาปิดฝั่ง ${bad} หรือเข้มงวดเงื่อนไขฝั่งนั้นเป็นพิเศษ`);
    }
  }
  if (adxBuckets.length >= 2) {
    const sorted = adxBuckets.filter(b => b.trades >= 5 && b.expectancyR != null);
    if (sorted.length >= 2) {
      const best = sorted.reduce((a, b) => (b.expectancyR > a.expectancyR ? b : a));
      const worst = sorted.reduce((a, b) => (b.expectancyR < a.expectancyR ? b : a));
      if (best.range === '25–30' && best.expectancyR - worst.expectancyR > 0.4) {
        t.push(`ADX ช่วง 25–30 กลับทำได้ดีสุด (${best.expectancyR.toFixed(2)}R) ช่วงสูงกว่าแย่กว่า — การ "ยก ADX gate ให้สูงขึ้น" จะทำให้แย่ลง ไม่ใช่ดีขึ้น`);
      } else if (worst.range === '25–30' && best.expectancyR - worst.expectancyR > 0.3) {
        t.push(`ADX ช่วง 25–30 แย่สุด (${worst.expectancyR.toFixed(2)}R) — พิจารณายก adxGate เป็น ${best.range.split('–')[0]}`);
      }
    }
  }
  return t;
}

module.exports = { runBacktest, WINDOW, MAX_HOLD_BARS };
