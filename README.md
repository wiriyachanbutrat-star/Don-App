# Gold Trading System — XAUUSD Smart Entry

ระบบสัญญาณเทรด **XAU/USD** (และ BTC/USD) แบบ top-down price action — คำนวณจากราคาจริง
ไม่มี AI ในเส้นทางตัดสินใจ อินดิเคเตอร์เดียวคือ **EMA50** ที่เหลือเป็น price action ล้วน

## กลยุทธ์

| ชั้น | กรอบเวลา | หน้าที่ |
|---|---|---|
| **Trend** | H4 | EMA50 + ความชัน → **กำหนดทิศทางอย่างเดียว** (ราคาเหนือ/ใต้ EMA50 + slope) |
| **Structure** | H1 | ต้องเป็น HH/HL (BUY) หรือ LH/LL (SELL) |
| **Entry** | M15 | Breakout (BOS) → Pullback (retest) → Action Zone (S/R) → QM → Rejection candle |

**Score /9**

| เงื่อนไข | คะแนน |
|---|---|
| H4 Trend ตรงกัน (บริบท) | +2 |
| H1 Structure ตรงกัน (บริบท) | +1 |
| **ACTION ZONE** — ราคาอยู่ที่แนว S/R | **+2** ถ้าเป็นโซนที่โดนทดสอบ ≥2 ครั้ง / ระดับ HTF (วานนี้ H-L-C) / เลขกลม · **+1** ถ้าเป็น swing เดี่ยว |
| **BREAKOUT** — Break of Structure (BOS) | +1 |
| **PULLBACK** — ย่อกลับมาทดสอบระดับที่ทะลุ | +1 |
| **QM (Quasimodo)** — รูปแบบ over/under ตามทิศทาง + ทะลุแล้ว | +1 |
| Rejection candle (ปิดในโซน 1/3 ที่ถูกทาง) | +1 |

**Filter เข้าเทรด:**
- **BUY ต้อง 8/9 · SELL ต้อง 9/9** (backtest: ฝั่ง SELL ทำผลงานแย่กว่าเกือบทุก TF)
- **ต้องอยู่ในเวลา London+NY (07–21 UTC)** เท่านั้น — Asian session ทองไซด์เวย์
- `8–9` (ผ่าน filter) = STRONG เข้าได้ · `6–7` = WATCH · ต่ำกว่า = NO_TRADE

**Entry/SL/TP:** Entry = ราคาปัจจุบัน · SL พ้นแนว + บัฟเฟอร์ 0.3×ATR (บีบ 1–3×ATR) ·
TP = RR 1:1.6 หรือ swing ตรงข้าม (ไม่เกิน 3R)

กรอบเวลาที่เลือกได้บน dashboard = **Entry TF** (M15/M30/H1/H4) — Structure & Trend TF เลื่อนตามอัตโนมัติ
เช่น เลือก M15 → Structure=H1, Trend=H4 (ตรงตาม spec)

## Backtest — `/api/backtest` + ปุ่มบน dashboard

walk-forward, ไม่มี look-ahead (แต่ละแท่งเห็นเฉพาะข้อมูลก่อนหน้า, 2 กรอบ TF บนตัดตามเวลาปิดจริง),
จำลองผลถึง SL/TP + time-stop 48 แท่ง, คิดเป็นหน่วย **R**

ผลทดสอบทอง (5000 แท่ง, ~ก.ค.–ก.ย. 2026) — **หลังใส่ session filter + S/R zones + BUY-bias + rejection ที่เข้มขึ้น**:

| Entry TF | เทรด | Win | Expectancy | Profit Factor | รวม | Max DD |
|---|---|---|---|---|---|---|
| **H4** | 129 | 49% | +0.29R | 1.58 | **+37R** ✅ | 6.4R |
| **M15 (spec)** | 31 | 50% | **+0.29R** | **1.60** | +8.9R | **3.3R** |
| M30 | 37 | 47% | +0.21R | 1.41 | +7.9R | 5.2R |
| H1 | 37 | 26% | −0.22R | 0.67 | −8.3R ❌ | 11.3R |

**M15 spec: จากเสมอตัว (+0.02R) → +0.29R/ไม้, PF 1.6, drawdown ครึ่งเดียว** — ปรับปรุงชัดวัดได้
H1 ยังเป็น TF ที่แย่สุด (หลีกเลี่ยง) · session filter ยกคุณภาพต่อไม้ทุก TF

*ตัวอย่างเดียว 1 ช่วงตลาด (~2 เดือน) — เป็นแนวโน้ม ไม่ใช่คำรับประกัน*

## Pine Script

`XAUUSD-SmartEntry.pine` — indicator v5 สำหรับ TradingView (ใส่บนชาร์ต M15/M30/H1 XAUUSD):
EMA50, dashboard H4/H1/M15 + session + score, prior-day H-L-C + round numbers เป็น S/R,
SELL ต้อง 9/9, session filter, label BUY/SELL + เส้น Entry/SL/TP + RR, ไม่ซ้ำในโซนเดิม, alertcondition

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
