# Gold Trading System — XAUUSD Smart Entry

ระบบสัญญาณเทรด **XAU/USD** (และ BTC/USD) แบบ top-down price action — คำนวณจากราคาจริง
ไม่มี AI ในเส้นทางตัดสินใจ อินดิเคเตอร์เดียวคือ **EMA50** ที่เหลือเป็น price action ล้วน

## กลยุทธ์

| ชั้น | กรอบเวลา | หน้าที่ |
|---|---|---|
| **Trend** | H4 | EMA50 + ความชัน → **กำหนดทิศทางอย่างเดียว** (ราคาเหนือ/ใต้ EMA50 + slope) |
| **Structure** | H1 | ต้องเป็น HH/HL (BUY) หรือ LH/LL (SELL) |
| **Entry** | M15 | ราคาอยู่ที่แนว Swing S/R + Break of Structure + Retest + Rejection candle |

**Score /9** — เข้าเทรดเฉพาะ **8–9/9**

| เงื่อนไข | คะแนน |
|---|---|
| H4 Trend ตรงกัน | +2 |
| H1 Structure ตรงกัน | +2 |
| ราคาอยู่ที่แนว S/R สำคัญ | +2 |
| Break of Structure (BOS) | +1 |
| Retest ระดับที่ทะลุ | +1 |
| Rejection candle (hammer/engulfing) | +1 |

`8–9` STRONG (เข้าได้) · `6–7` WATCH · `0–5` NO_TRADE

**Entry/SL/TP:** Entry = ราคาปัจจุบัน · SL พ้นแนว Swing + บัฟเฟอร์ 0.3×ATR (บีบ 1–3×ATR) ·
TP = RR 1:1.6 หรือ swing ตรงข้าม (ไม่เกิน 3R)

กรอบเวลาที่เลือกได้บน dashboard = **Entry TF** (M15/M30/H1/H4) — Structure & Trend TF เลื่อนตามอัตโนมัติ
เช่น เลือก M15 → Structure=H1, Trend=H4 (ตรงตาม spec)

## Backtest — `/api/backtest` + ปุ่มบน dashboard

walk-forward, ไม่มี look-ahead (แต่ละแท่งเห็นเฉพาะข้อมูลก่อนหน้า, 2 กรอบ TF บนตัดตามเวลาปิดจริง),
จำลองผลถึง SL/TP + time-stop 48 แท่ง, คิดเป็นหน่วย **R**

ผลทดสอบทอง 2026 (5000 แท่ง):

| Entry TF | เทรด | Win | Expectancy | Profit Factor | รวม |
|---|---|---|---|---|---|
| **H4** | 81 | 53% | **+0.37R** | **1.82** | **+30R** ✅ |
| M30 | 51 | 44% | +0.12R | 1.22 | +6R |
| M15 (spec) | 44 | 40% | +0.02R | 1.04 | เสมอตัว |
| H1 | 54 | 33% | −0.12R | 0.81 | −6R ❌ |

→ **spec H4/H1/M15 = เสมอตัวในช่วงนี้** · engine เดียวกันบน H4 (entry) ทำได้ดีสุด ·
SELL แย่กว่า BUY เกือบทุก TF (shorting ทองขาขึ้น)

*ตัวอย่างเดียว 1 ช่วงตลาด — เป็นแนวโน้ม ไม่ใช่คำรับประกัน · price-action mechanised แบบนี้หยาบกว่าตาคน*

## Pine Script

`XAUUSD-SmartEntry.pine` — indicator v5 สำหรับ TradingView (ใส่บนชาร์ต M15/M30/H1 XAUUSD):
EMA50, dashboard H4/H1/M15, score /9, label BUY/SELL + เส้น Entry/SL/TP + RR, ไม่ซ้ำในโซนเดิม, alertcondition

## AI (ตัวเลือก)

ถ้าตั้ง `ANTHROPIC_API_KEY` → ปุ่ม "ขอคำวิเคราะห์เชิงลึกจาก AI" บน dashboard — Claude อธิบาย setup
เป็นภาษาไทย **ไม่เปลี่ยนคำตัดสินหรือตัวเลข** commentary อย่างเดียว

## รันในเครื่อง

```
npm install
cp .env.example .env      # ใส่ TWELVE_DATA_API_KEY
npm start                 # http://localhost:3000
npm test
```

## โครงสร้าง

| ไฟล์ | หน้าที่ |
|---|---|
| `lib/indicators.js` | EMA/RSI/ATR/ADX/MACD/Bollinger + swings/marketStructure/rejection/breakAndRetest |
| `lib/strategy.js` | XAUUSD Smart Entry: top-down 3 TF, checklist /9, gate, Entry/SL/TP |
| `lib/marketData.js` | ดึง 3 กรอบเวลาจาก Twelve Data + แคช + dedupe |
| `lib/backtest.js` | walk-forward backtest คืนสถิติหน่วย R |
| `lib/aiCommentary.js` | (ตัวเลือก) Claude อธิบาย setup — commentary เท่านั้น |
| `server.js` | Express: `/api/signal` `/api/mtf` `/api/backtest` `/api/commentary` `/api/health` + email |
| `dashboard.html` | หน้าเว็บหน้าเดียว |
| `XAUUSD-SmartEntry.pine` | เวอร์ชัน TradingView |
| `test/selftest.js` | ชุดทดสอบ |

## API

- `GET /api/signal?asset=XAU&interval=15min` — setup เต็มของ Entry TF เดียว
- `GET /api/mtf?asset=XAU` — สรุป Entry TF 15m/1h/4h/1d
- `GET /api/backtest?asset=XAU&interval=4h&bars=5000` — ทดสอบย้อนหลัง (แคช 30 นาที)
- `GET /api/commentary?asset=XAU&interval=15min` — คำอธิบาย AI (ต้องมี `ANTHROPIC_API_KEY`)
- `GET /api/health`

ไม่ใช่คำแนะนำการลงทุน
