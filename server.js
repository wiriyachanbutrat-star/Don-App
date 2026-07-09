require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const SYMBOL = 'XAU/USD';

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

app.get('/api/market-data', async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const interval = ['1min', '5min', '15min', '1h', '4h', '1day'].includes(req.query.interval)
    ? req.query.interval
    : '1h';

  try {
    const series = await fetchTwelveData('time_series', { symbol: SYMBOL, interval, outputsize: 100 });

    // Twelve Data returns newest-first; put oldest-first for trend reading.
    const candles = series.values.slice().reverse().map(c => ({
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

    res.json({
      symbol: SYMBOL,
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
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'ดึงราคาทองจริงไม่สำเร็จ: ' + err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์' });
  }

  const { marketData } = req.body || {};
  if (!marketData) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลราคาทองส่งมาให้วิเคราะห์' });
  }

  const prompt = buildPrompt(marketData);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            response_mime_type: 'application/json',
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'เรียก Gemini API ไม่สำเร็จ' });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'ไม่ได้รับข้อความตอบกลับจาก AI' });
    }

    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์: ' + err.message });
  }
});

function buildPrompt(m) {
  return `คุณคือนักวิเคราะห์เทคนิคทองคำ (XAUUSD) ข้อมูลด้านล่างนี้คือค่าจริงที่คำนวณจากราคาตลาดจริง (ไม่ใช่การประมาณจากภาพ) ให้ใช้ตัวเลขเหล่านี้เป็นหลักฐานหลักในการให้เหตุผล ห้ามสร้างตัวเลขราคาหรืออินดิเคเตอร์ขึ้นใหม่เอง:

ราคาปัจจุบัน: ${m.currentPrice}
กรอบเวลา: ${m.interval}
แนวต้าน (high สูงสุดใน 30 แท่งล่าสุด): ${m.resistance}
แนวรับ (low ต่ำสุดใน 30 แท่งล่าสุด): ${m.support}
แท่งเทียนขึ้น/ลง ใน 15 แท่งล่าสุด: ขึ้น ${m.candleCounts.up} แท่ง / ลง ${m.candleCounts.down} แท่ง
RSI (14): ${m.rsi.toFixed(2)}
MACD: macd=${m.macd.macd.toFixed(4)}, signal=${m.macd.signal.toFixed(4)}, histogram=${m.macd.histogram.toFixed(4)}
EMA20: ${m.ema20.toFixed(2)}
EMA50: ${m.ema50.toFixed(2)}

หน้าที่ของคุณ:
- สรุปแนวโน้ม (trend) และ pattern จากข้อมูลข้างต้นเท่านั้น
- กำหนด entry ใกล้ราคาปัจจุบัน, tp และ sl โดยอ้างอิงแนวรับ-แนวต้านที่ให้มาจริง (ห้ามให้ tp/sl ขัดกับทิศทางคำแนะนำ)
- risk_reward ต้องคำนวณจาก |tp-entry| ต่อ |entry-sl| ให้ตรงกับตัวเลข entry/tp/sl ที่คุณให้จริง

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
  "volume": "ลักษณะ momentum จากแท่งเทียนขึ้น/ลง",
  "entry": ราคาตัวเลข,
  "tp": ราคาตัวเลข,
  "sl": ราคาตัวเลข,
  "risk_reward": "อัตราส่วน เช่น 1 : 2.5",
  "reasons": ["เหตุผลข้อ 1 ภาษาไทย อ้างอิงตัวเลขจริงข้างต้น", "เหตุผลข้อ 2", "..."]
}`;
}

app.listen(PORT, () => {
  console.log(`Gold AI analyzer running at http://localhost:${PORT}`);
});
