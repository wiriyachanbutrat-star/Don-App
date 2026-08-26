# Gold Trading System

ระบบสัญญาณเทรด **XAU/USD** (และ BTC/USD) เชิงปริมาณล้วน — คำนวณจากราคาจริงทั้งหมด
ไม่มี AI ไม่มี veto ซ้อนกันหลายชั้น ตรรกะเดียวอ่านตามได้ตรง ๆ

## กลยุทธ์ (Intraday trend-pullback)

เรียงตามน้ำหนักความสำคัญ:

1. **Regime** — เทรนด์กรอบเวลาใหญ่ (HTF) ต้องไปทางเดียวกับไม้ที่จะเข้า (ราคา vs EMA50 + ความชัน)
2. **Trend** — EMA20 > EMA50 > EMA200 (หรือกลับด้าน) บนกรอบเวลาที่เทรด
3. **Momentum** — MACD histogram + RSI ต้องเอียงทางเดียวกัน
4. **Location** — ราคาย่อกลับเข้าโซน EMA (ไม่ไล่ราคา)
5. **Gates** — ADX ≥ 20 (เทรนด์จริง) · CHoCH สวนทาง = งด · เทรดสวน EMA200 ต้องใช้คะแนนสูงกว่า

ทุกปัจจัยเป็นโหวตมีทิศทาง+น้ำหนัก คะแนนสุทธิ (net / ±12) ตัดสินทิศทาง+ความมั่นใจ
gate ตัดสินว่า "เข้าเทรดได้จริงไหม"

**จุดเข้า/ออก:** Entry = ราคาปัจจุบัน · SL วางพ้น Swing Low/High (หรือแนวรับ-ต้าน 30 แท่ง)
แล้วบีบให้อยู่ในช่วง 1–3 เท่า ATR · TP = ระยะ SL × 1.5

## รันในเครื่อง

```
npm install
cp .env.example .env      # ใส่ TWELVE_DATA_API_KEY
npm start                 # http://localhost:3000
npm test                  # ตรวจสูตรอินดิเคเตอร์ + กลยุทธ์
```

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `lib/indicators.js` | สูตรอินดิเคเตอร์ล้วน (EMA/RSI/ATR/ADX/MACD/Bollinger/swing/structure) — deterministic, คืน null เมื่อข้อมูลไม่พอ |
| `lib/strategy.js` | เครื่องมือสัญญาณ: โหวตถ่วงน้ำหนัก → ทิศทาง + gate + จุดเข้า/ออก |
| `lib/marketData.js` | ดึงราคาจาก Twelve Data + แคช 2 ชั้น + dedupe |
| `server.js` | Express: `/api/signal`, `/api/mtf`, `/api/health` + อีเมลแจ้งเตือน |
| `dashboard.html` | หน้าเว็บหน้าเดียว (สัญญาณ, ladder, MTF, กราฟ TradingView, สถิติในเครื่อง) |
| `test/selftest.js` | ชุดทดสอบสูตร (เทียบค่ามาตรฐาน Wilder ฯลฯ) |

## API

- `GET /api/signal?asset=XAU&interval=1h` — วิเคราะห์เต็มของกรอบเวลาเดียว
- `GET /api/mtf?asset=XAU` — สรุปหลายกรอบเวลา (5m–1d)
- `GET /api/health`

ไม่ใช่คำแนะนำการลงทุน
