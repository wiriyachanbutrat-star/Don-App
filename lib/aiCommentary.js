'use strict';

// ---------------------------------------------------------------------------
// Optional AI layer — COMMENTARY ONLY. Claude is handed the finished
// deterministic analysis and asked to explain it in Thai: context, the main
// risk, what would invalidate the setup, what to watch next. It never changes
// the BUY/SELL/WAIT verdict or any price level — the formula stays
// authoritative. Button-triggered on the dashboard (each call costs money),
// cached per asset+interval+candle so repeat clicks within a bar are free.
// ---------------------------------------------------------------------------

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function fmt(v, d = 2) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d); }

function buildPrompt(a) {
  const s = a.signal, L = a.levels, i = a.indicators;
  const verdict = s.tradable && s.direction
    ? `${s.direction}${s.strong ? ' (สัญญาณแข็งแรง)' : ''}`
    : `WAIT — ${s.waitReason || 'ยังไม่เข้าเกณฑ์'}`;
  const levelLine = L.entry != null && s.tradable
    ? `Entry ${fmt(L.entry)} / SL ${fmt(L.sl)} / TP ${fmt(L.tp)} (${L.riskReward}, SL อิง ${L.slBasis})`
    : 'ยังไม่มีจุดเข้า';

  return `คุณคือผู้ช่วยอธิบายสัญญาณเทรด ${a.assetLabel} กรอบเวลา ${a.interval}

ด้านล่างคือผลวิเคราะห์ที่ระบบคำนวณเสร็จแล้วจากสูตรล้วน (deterministic) — ถือเป็น "ข้อเท็จจริงที่ตายตัว" ห้ามเปลี่ยนคำตัดสินหรือตัวเลขใด ๆ หน้าที่คุณคืออธิบายให้เทรดเดอร์เข้าใจบริบทเท่านั้น

ราคาปัจจุบัน: ${fmt(a.price)}
คำตัดสินระบบ: ${verdict}
คะแนนสุทธิ: ${s.net}/±${s.maxWeight} (confidence ${s.confidence}%)
จุดเข้า/ออก: ${levelLine}
เทรนด์กรอบใหญ่ (${a.higherInterval}): ${a.regime.label}
โครงสร้างตลาด: ${a.structure.trend}${a.structure.bos ? ' · BOS ' + a.structure.bos : ''}${a.structure.choch ? ' · CHoCH ' + a.structure.choch : ''}
EMA${i.fastPeriod}/${i.slowPeriod}: ${fmt(i.emaFast)} / ${fmt(i.slowPeriod ? i.emaSlow : null)}  ·  EMA200: ${fmt(i.ema200)}
RSI: ${fmt(i.rsi, 1)}  ·  ADX: ${fmt(i.adx, 1)} (+DI ${fmt(i.plusDI, 0)} / -DI ${fmt(i.minusDI, 0)})  ·  ATR: ${fmt(i.atr)}
MACD histogram: ${i.macd ? fmt(i.macd.histogram, 3) + (i.macd.rising ? ' (กำลังเพิ่ม)' : ' (กำลังลด)') : '—'}
แนวรับ/แนวต้าน 30 แท่ง: ${fmt(i.support)} / ${fmt(i.resistance)}
เหตุผลจากระบบ:
${s.reasons.map(r => '  - ' + r).join('\n')}

เขียนคำอธิบายภาษาไทย 3–5 ย่อหน้าสั้น ๆ ครอบคลุม:
1. สรุปภาพรวมว่าทำไมระบบจึงให้คำตัดสินนี้ (โยงกับตัวเลขจริงข้างบน)
2. ความเสี่ยง/จุดอ่อนหลักของสถานการณ์นี้ (เช่น สัญญาณขัดแย้งกันตรงไหน, ใกล้ข่าว, ผันผวนสูง)
3. อะไรจะทำให้สัญญาณนี้ "เสีย" (invalidation) — ระดับราคาหรือเงื่อนไขที่ควรถอย
4. ถ้าเป็น WAIT ให้บอกว่ารออะไร ถ้าเข้าได้ให้บอกการบริหารความเสี่ยงสั้น ๆ

ห้ามแนะนำทิศทางอื่นนอกเหนือจากคำตัดสินระบบ ห้ามเสนอตัวเลข entry/SL/TP ใหม่ ตอบเป็นข้อความล้วนเป็นย่อหน้า ห้ามใช้ ** __ # หรือ markdown จัดรูปแบบ ขึ้นย่อหน้าใหม่ด้วยบรรทัดว่างเท่านั้น`;
}

async function getCommentary(analysis) {
  const key = [
    analysis.assetKey, analysis.interval, analysis.candleTime,
    analysis.signal.direction, analysis.signal.tradable, analysis.signal.net,
  ].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return { ...hit.data, cached: true };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY บนเซิร์ฟเวอร์');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1800,
      messages: [{ role: 'user', content: buildPrompt(analysis) }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `เรียก Claude API ไม่สำเร็จ (${res.status})`);

  const text = (Array.isArray(data.content) ? data.content : [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('ไม่ได้รับข้อความตอบกลับจาก AI');

  const out = { commentary: text, model: MODEL, generatedAt: new Date().toISOString() };
  cache.set(key, { time: Date.now(), data: out });
  return { ...out, cached: false };
}

module.exports = { getCommentary, MODEL };
