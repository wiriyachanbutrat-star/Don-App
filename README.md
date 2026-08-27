# Gold Trading System

ระบบสัญญาณเทรด **XAU/USD** (และ BTC/USD) เชิงปริมาณล้วน — คำนวณจากราคาจริงทั้งหมด
ไม่มี AI ไม่มี veto ซ้อนกันหลายชั้น ตรรกะเดียวอ่านตามได้ตรง ๆ

## กลยุทธ์ (Intraday trend-pullback)

เรียงตามน้ำหนักความสำคัญ:

1. **Regime** — เทรนด์กรอบเวลาใหญ่ (HTF) ต้องไปทางเดียวกับไม้ที่จะเข้า (ราคา vs EMA50 + ความชัน)
2. **Trend** — EMA20 > EMA50 > EMA200 (หรือกลับด้าน) บนกรอบเวลาที่เทรด
3. **Momentum** — MACD histogram + RSI + การเคลื่อนตัว 6 แท่งล่าสุด (เทียบ ATR) ต้องเอียงทางเดียวกัน
4. **Location** — ราคาย่อกลับเข้าโซน EMA *และโครงสร้างยังไม่หัก* (ไม่ไล่ราคา, ไม่รับมีดตก)
5. **Gates** — ADX ≥ 20 · CHoCH สวนทาง = งด · **ทิศทางสวนโครงสร้าง LH/LL หรือ HH/HL ของ TF นั้น = งด** ·
   ทิศทางสวนโมเมนตัม 6 แท่งล่าสุด = งด · เทรดสวน EMA200 ต้องใช้คะแนนสูงกว่า

ทุกปัจจัยเป็นโหวตมีทิศทาง+น้ำหนัก คะแนนสุทธิ (net / ±14) ตัดสินทิศทาง+ความมั่นใจ
gate ตัดสินว่า "เข้าเทรดได้จริงไหม" — ออกแบบให้ไม่ขัดกับสิ่งที่เห็นบนกราฟระยะสั้น

**จุดเข้า/ออก:** Entry = ราคาปัจจุบัน · SL วางพ้น Swing Low/High (หรือแนวรับ-ต้าน 30 แท่ง)
แล้วบีบให้อยู่ในช่วง 1–3 เท่า ATR · TP = ระยะ SL × 1.5

**AI (ตัวเลือก):** ถ้าตั้ง `ANTHROPIC_API_KEY` จะมีปุ่ม "ขอคำวิเคราะห์เชิงลึกจาก AI"
บน dashboard — Claude อธิบายสัญญาณเป็นภาษาไทย (บริบท, ความเสี่ยง, จุดที่สัญญาณเสีย)
**ไม่เปลี่ยนคำตัดสิน BUY/SELL/WAIT หรือตัวเลขใด ๆ** เป็นคำอธิบายอย่างเดียว กดครั้งละ 1 call

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
| `lib/aiCommentary.js` | ตัวเลือก: เรียก Claude อธิบายสัญญาณเป็นภาษาไทย (commentary เท่านั้น ไม่ override) |
| `server.js` | Express: `/api/signal`, `/api/mtf`, `/api/commentary`, `/api/health` + อีเมลแจ้งเตือน |
| `dashboard.html` | หน้าเว็บหน้าเดียว (สัญญาณ, ladder, MTF, กราฟ TradingView, สถิติในเครื่อง) |
| `test/selftest.js` | ชุดทดสอบสูตร (เทียบค่ามาตรฐาน Wilder ฯลฯ) |

## API

- `GET /api/signal?asset=XAU&interval=1h` — วิเคราะห์เต็มของกรอบเวลาเดียว
- `GET /api/mtf?asset=XAU` — สรุปหลายกรอบเวลา (5m–1d)
- `GET /api/commentary?asset=XAU&interval=1h` — คำอธิบายจาก AI (ต้องมี `ANTHROPIC_API_KEY`)
- `GET /api/health`

ไม่ใช่คำแนะนำการลงทุน
