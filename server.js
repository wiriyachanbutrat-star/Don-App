require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

const ASSETS = {
  XAU: { symbol: 'XAU/USD', label: 'ทองคำ (XAUUSD)' },
  BTC: { symbol: 'BTC/USD', label: 'บิตคอยน์ (BTCUSD)' },
};

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

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function bollingerBands(closes, period = 20, mult = 2) {
  const middle = sma(closes, period);
  const idx = closes.length - 1;
  const mid = middle[idx];
  const slice = closes.slice(idx - period + 1, idx + 1);
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - mid, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { middle: mid, upper: mid + mult * stdDev, lower: mid - mult * stdDev, stdDev };
}

function atr(candles, period = 14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  const relevant = trs.slice(-period);
  return relevant.reduce((a, b) => a + b, 0) / relevant.length;
}

function stochasticOscillator(candles, period = 14, smoothK = 3) {
  const kValues = [];
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const highest = Math.max(...window.map(c => c.high));
    const lowest = Math.min(...window.map(c => c.low));
    const close = candles[i].close;
    const k = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    kValues.push(k);
  }
  const kSmoothed = sma(kValues, smoothK);
  const validK = kSmoothed.filter(v => v != null);
  const dValues = sma(validK, smoothK);
  const k = validK[validK.length - 1];
  const d = dValues[dValues.length - 1];
  return { k, d };
}

function computeSignalScore(m) {
  const reasons = [];

  // EMA20/50, MACD histogram and higher-timeframe trend are all trend-following
  // and tend to move together, so counting each separately inflates the score
  // during ordinary trending markets (exactly when trend indicators lag a reversal
  // the most). Collapse them into a single trend vote instead.
  let trendVotes = 0;
  if (m.ema20 > m.ema50) { trendVotes += 1; reasons.push('EMA20>EMA50 (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('EMA20<EMA50 (trend vote sell)'); }

  if (m.macd.histogram > 0) { trendVotes += 1; reasons.push('MACD histogram>0 (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('MACD histogram<0 (trend vote sell)'); }

  if (m.higherTimeframe.trend.includes('Uptrend')) { trendVotes += 1; reasons.push('Higher timeframe uptrend (trend vote buy)'); }
  else { trendVotes -= 1; reasons.push('Higher timeframe downtrend (trend vote sell)'); }

  // EMA200 is the standard long-term trend filter; only vote when we have
  // enough history (200 candles) to compute it.
  if (m.ema200 != null) {
    if (m.currentPrice > m.ema200) { trendVotes += 1; reasons.push('Price>EMA200 (trend vote buy)'); }
    else { trendVotes -= 1; reasons.push('Price<EMA200 (trend vote sell)'); }
  }

  let score = 0;
  if (trendVotes >= 2) { score += 1; reasons.push('=> Trend confluence BUY (+1)'); }
  else if (trendVotes <= -2) { score -= 1; reasons.push('=> Trend confluence SELL (+1)'); }
  else { reasons.push('=> Trend confluence mixed (0)'); }

  if (m.rsi >= 55) { score += 1; reasons.push('RSI>=55 (+1 buy)'); }
  else if (m.rsi <= 45) { score -= 1; reasons.push('RSI<=45 (+1 sell)'); }
  else { reasons.push('RSI neutral (0)'); }

  if (m.stochastic.k > m.stochastic.d && m.stochastic.k < 80) { score += 1; reasons.push('Stoch %K>%D not overbought (+1 buy)'); }
  else if (m.stochastic.k < m.stochastic.d && m.stochastic.k > 20) { score -= 1; reasons.push('Stoch %K<%D not oversold (+1 sell)'); }
  else { reasons.push('Stochastic neutral (0)'); }

  const candleDiff = m.candleCounts.up - m.candleCounts.down;
  if (candleDiff >= 3) { score += 1; reasons.push('More up candles recently (+1 buy)'); }
  else if (candleDiff <= -3) { score -= 1; reasons.push('More down candles recently (+1 sell)'); }
  else { reasons.push('Candle count neutral (0)'); }

  const direction = score > 0 ? 'BUY' : score < 0 ? 'SELL' : null;
  const strong = Math.abs(score) >= 3;
  return { score, direction, strong, reasons, maxScore: 4 };
}

function volatilityStats(candles, period = 20) {
  const recent = candles.slice(-period);
  const ranges = recent.map(c => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const bodyRatios = recent.map(c => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : 0;
  });
  const avgBodyRatio = bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length;
  return { avgRange, avgBodyRatio };
}

app.get('/api/market-data', async (req, res) => {
  if (!TWELVE_DATA_API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า TWELVE_DATA_API_KEY บนเซิร์ฟเวอร์' });
  }
  const interval = ['1min', '5min', '15min', '1h', '4h', '1day'].includes(req.query.interval)
    ? req.query.interval
    : '1h';
  const assetKey = ASSETS[req.query.asset] ? req.query.asset : 'XAU';
  const asset = ASSETS[assetKey];

  const higherIntervalMap = { '1min': '15min', '5min': '1h', '15min': '4h', '1h': '4h', '4h': '1day', '1day': '1week' };
  const higherInterval = higherIntervalMap[interval] || '4h';

  try {
    const [series, higherSeries] = await Promise.all([
      fetchTwelveData('time_series', { symbol: asset.symbol, interval, outputsize: 210 }),
      fetchTwelveData('time_series', { symbol: asset.symbol, interval: higherInterval, outputsize: 150 }),
    ]);

    // Twelve Data returns newest-first; put oldest-first for trend reading.
    const candles = series.values.slice().reverse().map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
    const higherCandles = higherSeries.values.slice().reverse().map(c => ({
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
    const ema200Series = closes.length >= 200 ? ema(closes, 200) : null;

    const higherCloses = higherCandles.map(c => c.close);
    const higherEma20Series = ema(higherCloses, 20);
    const higherEma50Series = ema(higherCloses, 50);
    const higherEma20 = higherEma20Series[higherEma20Series.length - 1];
    const higherEma50 = higherEma50Series[higherEma50Series.length - 1];
    const higherTrend = higherEma20 > higherEma50 ? 'ขาขึ้น (Uptrend)' : 'ขาลง (Downtrend)';

    res.json({
      symbol: asset.symbol,
      assetKey,
      assetLabel: asset.label,
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
      ema200: ema200Series ? ema200Series[ema200Series.length - 1] : null,
      bollinger: bollingerBands(closes),
      atr: atr(candles),
      stochastic: stochasticOscillator(candles),
      volatility: volatilityStats(candles),
      higherTimeframe: {
        interval: higherInterval,
        trend: higherTrend,
        ema20: higherEma20,
        ema50: higherEma50,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'ดึงราคาจริงไม่สำเร็จ: ' + err.message });
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

  const signal = computeSignalScore(marketData);
  const assetLabel = marketData.assetLabel || ASSETS[marketData.assetKey]?.label || ASSETS.XAU.label;
  const prompt = buildPrompt(marketData, signal, assetLabel);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            response_mime_type: 'application/json',
          },
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'เรียก Gemini API ไม่สำเร็จ' });
    }

    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'ไม่ได้รับข้อความตอบกลับจาก AI' });
    }

    // Server-side veto: if the deterministic indicator score strongly disagrees
    // with the AI's call, the AI's answer is contradicting the actual data —
    // flip the recommendation and cap confidence instead of trusting free text blindly.
    try {
      const parsed = JSON.parse(text);
      const aiIsBuy = String(parsed.recommendation).toUpperCase().indexOf('BUY') !== -1;
      const aiDirection = aiIsBuy ? 'BUY' : 'SELL';
      if (signal.strong && signal.direction && signal.direction !== aiDirection) {
        parsed.recommendation = signal.direction;
        const flippedIsBuy = signal.direction === 'BUY';
        // Scale the overridden probability/confidence with how many indicators
        // actually agree (score 3 of 4 vs. all 4) instead of a flat 65/35 for
        // every override regardless of signal strength.
        const magnitude = Math.abs(signal.score); // 3 or 4 given strong threshold
        const skew = 60 + (magnitude - 3) * 10; // 3 -> 60, 4 -> 70
        parsed.buy_probability = flippedIsBuy ? skew : 100 - skew;
        parsed.sell_probability = flippedIsBuy ? 100 - skew : skew;
        parsed.confidence_percent = Math.min(Number(parsed.confidence_percent) || skew, skew);
        parsed.confidence_score = Math.round((parsed.confidence_percent / 10) * 10) / 10;

        // The AI's tp/sl were structured for its original (now-overridden) direction
        // (tp beyond entry in the old direction, sl on the opposite side). Flipping
        // recommendation without flipping the trade levels leaves tp/sl backwards for
        // the new direction — swapping them mirrors the same entry/risk distances onto
        // the corrected side instead of shipping a structurally broken trade.
        const entry = Number(parsed.entry);
        const oldTp = Number(parsed.tp);
        const oldSl = Number(parsed.sl);
        if (isFinite(entry) && isFinite(oldTp) && isFinite(oldSl)) {
          parsed.tp = oldSl;
          parsed.sl = oldTp;
          const reward = Math.abs(parsed.tp - entry);
          const risk = Math.abs(entry - parsed.sl);
          parsed.risk_reward = risk > 0 ? `1 : ${(reward / risk).toFixed(2)}` : parsed.risk_reward;
        }

        parsed.reasons = [
          `ระบบตรวจพบว่าคำตอบของ AI ขัดแย้งกับสัญญาณอินดิเคเตอร์เชิงปริมาณ (score=${signal.score}) จึงปรับคำแนะนำเป็น ${signal.direction} ตามข้อมูลจริง`,
          ...(Array.isArray(parsed.reasons) ? parsed.reasons : []),
        ];
        text = JSON.stringify(parsed);
      }
    } catch (parseErr) {
      console.error('veto check failed to parse AI response', parseErr);
    }

    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์: ' + err.message });
  }
});

function buildPrompt(m, signal, assetLabel) {
  return `คุณคือนักวิเคราะห์เทคนิค ${assetLabel} ข้อมูลด้านล่างนี้คือค่าจริงที่คำนวณจากราคาตลาดจริง (ไม่ใช่การประมาณจากภาพ) ให้ใช้ตัวเลขเหล่านี้เป็นหลักฐานหลักในการให้เหตุผล ห้ามสร้างตัวเลขราคาหรืออินดิเคเตอร์ขึ้นใหม่เอง:

สัญญาณเชิงปริมาณเบื้องต้น (คำนวณจากอินดิเคเตอร์ล้วนๆ ไม่ใช่ความเห็น AI): score=${signal.score} จาก -${signal.maxScore} ถึง +${signal.maxScore} (บวก=เอนไปทาง BUY, ลบ=เอนไปทาง SELL, เทรนด์จาก EMA/MACD/กรอบเวลาใหญ่นับรวมเป็น 1 คะแนนเดียวเพราะสัมพันธ์กันสูง) → ${signal.direction ? `เอนไปทาง ${signal.direction}` : 'ก้ำกึ่ง'}${signal.strong ? ' (สัญญาณชัดเจนมาก ควรให้คำแนะนำสอดคล้องกับทิศทางนี้เป็นหลัก)' : ''}
รายละเอียด: ${signal.reasons.join(', ')}

ราคาปัจจุบัน: ${m.currentPrice}
กรอบเวลา: ${m.interval}
แนวต้าน (high สูงสุดใน 30 แท่งล่าสุด): ${m.resistance}
แนวรับ (low ต่ำสุดใน 30 แท่งล่าสุด): ${m.support}
แท่งเทียนขึ้น/ลง ใน 15 แท่งล่าสุด: ขึ้น ${m.candleCounts.up} แท่ง / ลง ${m.candleCounts.down} แท่ง
RSI (14): ${m.rsi.toFixed(2)}
MACD: macd=${m.macd.macd.toFixed(4)}, signal=${m.macd.signal.toFixed(4)}, histogram=${m.macd.histogram.toFixed(4)}
EMA20: ${m.ema20.toFixed(2)}
EMA50: ${m.ema50.toFixed(2)}
${m.ema200 != null ? `EMA200: ${m.ema200.toFixed(2)}\n` : ''}Bollinger Bands (20,2): upper=${m.bollinger.upper.toFixed(2)}, middle=${m.bollinger.middle.toFixed(2)}, lower=${m.bollinger.lower.toFixed(2)}
ATR (14): ${m.atr.toFixed(2)} (วัดความผันผวนเฉลี่ยต่อแท่ง)
Stochastic Oscillator: %K=${m.stochastic.k.toFixed(2)}, %D=${m.stochastic.d.toFixed(2)}
ความผันผวน 20 แท่งล่าสุด: ช่วงราคาเฉลี่ย/แท่ง=${m.volatility.avgRange.toFixed(2)}, สัดส่วนตัวแท่งเทียนเฉลี่ย=${(m.volatility.avgBodyRatio*100).toFixed(1)}%
แนวโน้มกรอบเวลาใหญ่กว่า (${m.higherTimeframe.interval}): ${m.higherTimeframe.trend} (EMA20=${m.higherTimeframe.ema20.toFixed(2)}, EMA50=${m.higherTimeframe.ema50.toFixed(2)})

หน้าที่ของคุณ:
- สรุปแนวโน้ม (trend) และ pattern จากข้อมูลข้างต้นเท่านั้น โดยพิจารณาแนวโน้มกรอบเวลาใหญ่กว่าประกอบด้วยเสมอ (ถ้าแนวโน้มเล็กสวนทางกับแนวโน้มใหญ่ ถือเป็นสัญญาณขัดแย้งที่ต้องลด confidence)
- ใช้ Bollinger Bands ประเมินว่าราคาอยู่ใกล้ขอบบน/ล่าง/กลาง (โซน overbought/oversold หรือ breakout)
- ใช้ ATR และความผันผวนเฉลี่ยประกอบการประเมินความเสี่ยง และช่วยกำหนดระยะ tp/sl ให้สมเหตุสมผลกับความผันผวนจริง (อย่าตั้ง sl แคบกว่า ATR มากเกินไป)
- ใช้ Stochastic Oscillator (%K, %D) ยืนยันโซน overbought (>80) / oversold (<20) และสัญญาณ crossover
- กำหนด entry ใกล้ราคาปัจจุบัน, tp และ sl โดยอ้างอิงแนวรับ-แนวต้านและ ATR ที่ให้มาจริง (ห้ามให้ tp/sl ขัดกับทิศทางคำแนะนำ)
- risk_reward ต้องคำนวณจาก |tp-entry| ต่อ |entry-sl| ให้ตรงกับตัวเลข entry/tp/sl ที่คุณให้จริง
- เขียน detailed_analysis เป็นย่อหน้าภาษาไทยอย่างละเอียด (อย่างน้อย 4-6 ประโยค) อธิบายภาพรวมทั้งหมด: โครงสร้างแนวโน้มหลัก/รอง, ตำแหน่งราคาเทียบ Bollinger Bands, โมเมนตัมจาก RSI/MACD/Stochastic, ความผันผวนจาก ATR, และเหตุผลเชิงลึกว่าทำไมจึงให้คำแนะนำ BUY/SELL นี้พร้อมความเสี่ยงที่ควรระวัง

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
  "ema200_relation": "${m.ema200 != null ? 'ตำแหน่งราคาเทียบ EMA200 เช่น ราคาอยู่เหนือ EMA200 (ขาขึ้นระยะยาว)' : 'ไม่มีข้อมูลเพียงพอ'}",
  "volume": "ลักษณะ momentum จากแท่งเทียนขึ้น/ลง",
  "bollinger": "ตำแหน่งราคาเทียบ Bollinger Bands เช่น ราคาใกล้ขอบบน (overbought zone)",
  "stochastic": "สถานะ Stochastic เช่น %K ตัดขึ้นเหนือ %D ในโซน oversold",
  "higher_timeframe": "สรุปแนวโน้มกรอบเวลาใหญ่กว่าและว่าสอดคล้องหรือขัดแย้งกับกรอบเวลาปัจจุบัน",
  "entry": ราคาตัวเลข,
  "tp": ราคาตัวเลข,
  "sl": ราคาตัวเลข,
  "risk_reward": "อัตราส่วน เช่น 1 : 2.5",
  "reasons": ["เหตุผลข้อ 1 ภาษาไทย อ้างอิงตัวเลขจริงข้างต้น", "เหตุผลข้อ 2", "..."],
  "detailed_analysis": "ย่อหน้าวิเคราะห์เชิงลึกภาษาไทย อย่างน้อย 4-6 ประโยค ตามที่อธิบายไว้ข้างต้น"
}`;
}

app.listen(PORT, () => {
  console.log(`Gold AI analyzer running at http://localhost:${PORT}`);
});
