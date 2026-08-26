'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');

const { ASSETS, VALID_INTERVALS, getAnalysis } = require('./lib/marketData');
const { assetConfig } = require('./lib/strategy');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasDataKey: !!process.env.TWELVE_DATA_API_KEY, emailAlerts: !!mailer, time: new Date().toISOString() });
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

// Compact multi-timeframe summary — one row per timeframe.
const MTF_INTERVALS = ['5min', '15min', '30min', '1h', '4h', '1day'];

app.get('/api/mtf', async (req, res) => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const asset = pickAsset(req.query.asset);
  try {
    const rows = await Promise.all(MTF_INTERVALS.map(async interval => {
      try {
        const d = await getAnalysis(asset, interval);
        return {
          interval,
          direction: d.signal.direction,
          tradable: d.signal.tradable,
          strong: d.signal.strong,
          developing: d.signal.developing,
          confidence: d.signal.confidence,
          net: d.signal.net,
          totalWeight: d.signal.totalWeight,
          maxWeight: d.signal.maxWeight,
          adx: d.indicators.adx,
          regime: d.regime.direction,
          price: d.price,
          ok: true,
        };
      } catch (e) {
        return { interval, ok: false, error: e.message };
      }
    }));
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
const EMAIL_INTERVAL = pickInterval(process.env.EMAIL_INTERVAL);
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
    if (s.direction === lastEmailedDirection) return;
    lastEmailedDirection = s.direction;

    const L = d.levels;
    await mailer.sendMail({
      from: EMAIL_USER,
      to: EMAIL_TO,
      subject: `[Gold] ${s.direction} ${d.assetLabel} @ ${d.price.toFixed(2)} (${EMAIL_INTERVAL})`,
      text: [
        `สัญญาณ: ${s.direction}${s.strong ? ' (ชัดเจน)' : ''}`,
        `สินทรัพย์: ${d.assetLabel} — กรอบเวลา ${EMAIL_INTERVAL}`,
        `ราคาปัจจุบัน: ${d.price.toFixed(2)}`,
        `คะแนนสุทธิ: ${s.net}/${s.totalWeight} · confidence ${s.confidence}%`,
        `ADX: ${d.indicators.adx != null ? d.indicators.adx.toFixed(1) : 'N/A'}`,
        L.entry != null ? `Entry ${L.entry.toFixed(2)} · SL ${L.sl.toFixed(2)} · TP ${L.tp.toFixed(2)} (${L.riskReward}, SL อิง ${L.slBasis})` : '',
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
  console.log(`Assets: ${Object.keys(ASSETS).join(', ')} · XAU ADX gate: ${assetConfig('XAU').adxGate}`);
});
