'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');

const { ASSETS, VALID_INTERVALS, getAnalysis, getLongSeries } = require('./lib/marketData');
const { assetConfig, higherInterval, trendInterval } = require('./lib/strategy');
const { getCommentary, MODEL: AI_MODEL } = require('./lib/aiCommentary');
const { runBacktest } = require('./lib/backtest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasDataKey: !!process.env.TWELVE_DATA_API_KEY,
    hasAiKey: !!process.env.ANTHROPIC_API_KEY,
    aiModel: process.env.ANTHROPIC_API_KEY ? AI_MODEL : null,
    emailAlerts: !!mailer,
    time: new Date().toISOString(),
  });
});

function pickInterval(q) {
  return VALID_INTERVALS.includes(q) ? q : '1h';
}
function pickAsset(q) {
  return ASSETS[q] ? q : 'XAU';
}

// Full analysis for one asset + timeframe.
app.get('/api/signal', async (req, res) => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  try {
    const data = await getAnalysis(pickAsset(req.query.asset), pickInterval(req.query.interval));
    res.json(data);
  } catch (err) {
    console.error('/api/signal', err.message);
    res.status(502).json({ error: 'ดึงข้อมูลราคาไม่สำเร็จ: ' + err.message });
  }
});

// Optional AI commentary on the current deterministic signal. Does not change
// the verdict or levels — explanation only. Button-triggered on the client
// (each call has a real Claude API cost); cached per asset+interval+candle.
app.get('/api/commentary', async (req, res) => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'ยังไม่ได้เปิดใช้ AI — ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์ก่อน' });
  }
  try {
    const analysis = await getAnalysis(pickAsset(req.query.asset), pickInterval(req.query.interval));
    const commentary = await getCommentary(analysis);
    res.json({
      asset: analysis.assetKey,
      interval: analysis.interval,
      direction: analysis.signal.direction,
      tradable: analysis.signal.tradable,
      ...commentary,
    });
  } catch (err) {
    console.error('/api/commentary', err.message);
    res.status(502).json({ error: 'ขอคำวิเคราะห์จาก AI ไม่สำเร็จ: ' + err.message });
  }
});

// Walk-forward backtest of the live strategy over months of real candles.
// One Twelve Data call per (interval), cached an hour. Result cached 30 min
// since the computation is heavy.
const backtestCache = new Map();
const BACKTEST_TTL_MS = 30 * 60 * 1000;

app.get('/api/backtest', async (req, res) => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const asset = pickAsset(req.query.asset);
  const interval = pickInterval(req.query.interval);
  const bars = Math.max(800, Math.min(5000, Number(req.query.bars) || 3000));
  const cacheKey = `${asset}:${interval}:${bars}`;
  const hit = backtestCache.get(cacheKey);
  if (hit && Date.now() - hit.time < BACKTEST_TTL_MS) {
    return res.json({ ...hit.data, cached: true });
  }
  try {
    const [candles, structureCandles, trendCandles] = await Promise.all([
      getLongSeries(asset, interval, bars),
      getLongSeries(asset, higherInterval(interval), bars),
      getLongSeries(asset, trendInterval(interval), bars),
    ]);
    const t0 = Date.now();
    const result = runBacktest({ assetKey: asset, interval, candles, structureCandles, trendCandles });
    result.asset = asset;
    result.computeMs = Date.now() - t0;
    if (!result.error) backtestCache.set(cacheKey, { time: Date.now(), data: result });
    res.json({ ...result, cached: false });
  } catch (err) {
    console.error('/api/backtest', err.message);
    res.status(502).json({ error: 'ทดสอบย้อนหลังไม่สำเร็จ: ' + err.message });
  }
});

// Compact multi-timeframe summary — one row per timeframe. Kept to four
// timeframes and fetched SEQUENTIALLY (not Promise.all) so a cold load
// trickles requests instead of firing a burst that trips Twelve Data's
// 8-credits-per-minute limit. Most calls hit the 5-minute cache anyway.
const MTF_INTERVALS = ['15min', '1h', '4h', '1day'];

app.get('/api/mtf', async (req, res) => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const asset = pickAsset(req.query.asset);
  try {
    const rows = [];
    for (const interval of MTF_INTERVALS) {
      try {
        const d = await getAnalysis(asset, interval);
        rows.push({
          interval,
          direction: d.signal.direction,
          tradable: d.signal.tradable,
          strong: d.signal.strong,
          developing: d.signal.developing,
          tier: d.signal.tier,
          confidence: d.signal.confidence,
          score: d.signal.score,
          maxScore: d.signal.maxScore,
          net: d.signal.net,
          maxWeight: d.signal.maxWeight,
          trend: d.indicators.trendTF ? d.indicators.trendTF.direction : null,
          structure: d.indicators.structureTF ? d.indicators.structureTF.direction : null,
          regime: d.regime.direction,
          price: d.price,
          ok: true,
        });
      } catch (e) {
        rows.push({ interval, ok: false, error: e.message });
      }
    }
    res.json({ asset, rows });
  } catch (err) {
    console.error('/api/mtf', err.message);
    res.status(502).json({ error: 'ดึงข้อมูล multi-timeframe ไม่สำเร็จ: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Email alerts — polls one asset/interval server-side and mails only on a
// *change* into (or of direction within) a tradable BUY/SELL. Never repeats
// the same signal, never mails on WAIT. All optional: no env vars → disabled.
// ---------------------------------------------------------------------------
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_TO = process.env.EMAIL_TO || EMAIL_USER;
const EMAIL_ASSET = pickAsset(process.env.EMAIL_ASSET);
// Default 4h, not 1h: the 3000-bar backtest shows 4h has real positive
// expectancy (~+0.23R/trade, PF 1.48) while 1h is roughly break-even.
const EMAIL_INTERVAL = VALID_INTERVALS.includes(process.env.EMAIL_INTERVAL) ? process.env.EMAIL_INTERVAL : '4h';
const EMAIL_CHECK_MS = 15 * 60 * 1000;

const mailer = (EMAIL_USER && EMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD } })
  : null;

let lastEmailedDirection = null;

async function checkAndSendSignalEmail() {
  if (!mailer) return;
  try {
    const d = await getAnalysis(EMAIL_ASSET, EMAIL_INTERVAL);
    const s = d.signal;
    if (!s.tradable || !s.direction) { lastEmailedDirection = null; return; }
    // Dedupe on the setup (direction + S/R zone), not just direction, so the
    // same setup in the same place isn't re-alerted after a WAIT blip.
    const key = s.setupId || s.direction;
    if (key === lastEmailedDirection) return;
    lastEmailedDirection = key;

    const L = d.levels;
    await mailer.sendMail({
      from: EMAIL_USER,
      to: EMAIL_TO,
      subject: `[Gold] ${s.direction} ${d.assetLabel} @ ${d.price.toFixed(2)} — Setup ${s.score}/9 (${EMAIL_INTERVAL})`,
      text: [
        `สัญญาณ: ${s.direction} — Setup ${s.score}/9 (${s.tier})`,
        `สินทรัพย์: ${d.assetLabel} — Entry ${EMAIL_INTERVAL} / Structure ${d.stack.structure} / Trend ${d.stack.trend}`,
        `ราคาปัจจุบัน: ${d.price.toFixed(2)}`,
        `เทรนด์ ${d.stack.trend}: ${d.indicators.trendTF.label} · โครงสร้าง ${d.stack.structure}: ${d.indicators.structureTF.label}`,
        L.entry != null ? `Entry ${L.entry.toFixed(2)} · SL ${L.sl.toFixed(2)} · TP ${L.tp.toFixed(2)} (${L.riskReward}, SL ${L.slBasis})` : '',
        '',
        'เหตุผล:',
        ...s.reasons.map(r => '- ' + r),
        '',
        'อีเมลอัตโนมัติ — ไม่ใช่คำแนะนำการลงทุน ตรวจสอบก่อนเทรดจริงเสมอ',
      ].filter(Boolean).join('\n'),
    });
    console.log(`[email] sent ${s.direction} alert for ${EMAIL_ASSET}/${EMAIL_INTERVAL}`);
  } catch (err) {
    console.error('[email] check failed:', err.message);
  }
}

if (mailer) {
  setInterval(checkAndSendSignalEmail, EMAIL_CHECK_MS);
  checkAndSendSignalEmail();
  console.log(`[email] alerts on for ${EMAIL_ASSET}/${EMAIL_INTERVAL} → ${EMAIL_TO}`);
} else {
  console.log('[email] alerts disabled — set EMAIL_USER and EMAIL_APP_PASSWORD to enable.');
}

app.listen(PORT, () => {
  console.log(`Gold trading system running at http://localhost:${PORT}`);
  console.log(`Assets: ${Object.keys(ASSETS).join(', ')} · XAUUSD Smart Entry (H4/H1/M15 price action, score ${assetConfig('XAU').strongScore}/9)`);
});
