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
  const I = a.institutional || {};
  const ms = I.maStack || i.maStack || {};
  const ep = I.entryPlan || {};
  const modeWord = I.state === 'ACCUMULATION' ? 'เจ้ามือกำลังสะสม (Accumulation → เข้าซื้อ)'
    : I.state === 'DISTRIBUTION' ? 'เจ้ามือกำลังกระจายของ (Distribution → เข้าขาย)'
    : 'ยังไม่มีโซนสะสม/กระจายชัดเจน';
  const tierWord = I.tier === 'STRONG_ZONE' ? 'STRONG ZONE (เข้าได้)' : I.tier === 'FORMING' ? 'กำลังก่อตัว' : 'รอ';
  const R = L.slDistance;
  const planLine = L.entry != null
    ? `Entry อ้างอิง ${fmt(L.entry)} · SL ${fmt(L.sl)} (ระยะ ${fmt(R)}) · TP1 ${fmt(I.side === 'SELL' ? L.entry - R * 3 : L.entry + R * 3)} (3R) · TP2 ${fmt(I.side === 'SELL' ? L.entry - R * 5 : L.entry + R * 5)} (5R)`
    : 'ยังไม่มีจุดเข้า';
  const macd = i.macd || I.macd;

  return `คุณคือนักวิเคราะห์เทคนิค ${a.assetLabel} กรอบเวลา ${a.interval} เชี่ยวชาญแนวคิด Smart Money (การสะสม/กระจายของเจ้ามือ) และ Multi-MA + Momentum

ด้านล่างคือผลวิเคราะห์ที่ระบบคำนวณเสร็จแล้วจากสูตรล้วน (deterministic) — ถือเป็น "ข้อเท็จจริงที่ตายตัว" ห้ามเปลี่ยนทิศทางหรือตัวเลขใด ๆ หน้าที่คุณคือ "อ่านเกม" ให้เทรดเดอร์เข้าใจและชี้จังหวะเข้าที่แม่นที่สุดภายใต้กรอบนี้

ราคาปัจจุบัน: ${fmt(a.price)}
โหมดเจ้ามือ: ${modeWord}
Institutional Score: ${I.score ?? '—'}/100 (${tierWord})${I.ready ? ' — พร้อมเข้า' : ''}
องค์ประกอบคะแนน:
${(I.components || []).map(c => `  - ${c.name}: ${c.earned}/${c.max} — ${c.note}`).join('\n')}

เส้นค่าเฉลี่ย (Entry TF): EMA9 ${fmt(i.ema9)} · EMA21 ${fmt(i.ema21)} · EMA50 ${fmt(i.ema50)} · EMA200 ${fmt(i.ema200)}
การเรียงตัว MA: ${ms.label || '—'} (${ms.dir || '—'}, ${ms.aligned ?? '?'}/4)
RSI(14): ${fmt(i.rsi, 1)} ${I.rsiRising === true ? '(ดีดขึ้น)' : I.rsiRising === false ? '(อ่อนลง)' : ''}
MACD histogram: ${macd ? fmt(macd.histogram, 3) + (macd.rising ? ' (กำลังเพิ่ม)' : ' (กำลังลด)') + (macd.crossUp ? ' · ตัดขึ้น' : macd.crossDown ? ' · ตัดลง' : '') : '—'}
ATR(14): ${fmt(i.atr)}
เทรนด์กรอบใหญ่ (${a.higherInterval}): ${a.regime.label} · โครงสร้าง entry TF: ${a.structure.trend}${a.structure.bos ? ' · BOS ' + a.structure.bos : ''}${a.structure.choch ? ' · CHoCH ' + a.structure.choch : ''}
Liquidity / Sweep: ${I.sweepLevel != null ? fmt(I.sweepLevel) : '—'} · Demand/Supply zone: ${i.srZone ? fmt(i.srZone.mid) : '—'}
Volume Profile: POC ${I.poc != null ? fmt(I.poc) : '—'}${I.valueArea ? ` · Value Area ${fmt(I.valueArea.val)}–${fmt(I.valueArea.vah)} (${I.valueArea.source === 'volume' ? 'จากวอลุ่ม' : 'จากเวลา/การยอมรับราคา'})` : ''}
แผนเทรดระบบ: ${planLine}
จุดเข้าแม่นที่ระบบเสนอ: ${ep.price != null ? fmt(ep.price) + ' (อิง ' + ep.basis + (ep.confluence && ep.confluence.length > 1 ? ', confluence: ' + ep.confluence.join(' + ') : '') + ')' : '—'} · armed: ${ep.armed ? 'ใช่' : 'ยังไม่'}
ทริกเกอร์: ${ep.trigger || '—'}
เป้าหมาย Liquidity: ${(I.targets || []).map(t => t.name + ' ' + fmt(t.price)).join(' · ') || '—'}

เขียนภาษาไทย 4–6 ย่อหน้าสั้น ๆ:
1. อ่านเกมเจ้ามือ: จาก 6 องค์ประกอบ + การเรียงตัว MA + RSI + MACD ตอนนี้เป็นการสะสมหรือกระจาย และไปถึงไหนแล้ว
2. จุดเข้าที่แม่นที่สุด (ตามทิศทางระบบเท่านั้น): ควรเข้าที่บริเวณไหน รอทริกเกอร์อะไรให้ครบ (แท่งยืนยัน + MACD + RSI + MA) — อธิบายให้เห็นภาพ ห้ามเสนอตัวเลข entry/SL/TP ใหม่นอกเหนือจากที่ระบบให้
3. ถ้ายัง "ไม่ armed" หรือ score ไม่ถึง 72 บอกชัดว่าขาดอะไร ต้องเห็นอะไรเพิ่ม
4. Invalidation: ระดับราคา/เงื่อนไขที่ถ้าเกิดแล้วให้ยกเลิกไอเดียนี้ทันที
5. การบริหารความเสี่ยงสั้น ๆ (ขนาดไม้, ย้าย SL, ปิดบางส่วน)

ห้ามแนะนำทิศทางตรงข้ามกับระบบ ห้ามเสนอเลข entry/SL/TP ใหม่ ตอบเป็นย่อหน้าข้อความล้วน ห้ามใช้ ** __ # หรือ markdown ขึ้นย่อหน้าใหม่ด้วยบรรทัดว่าง`;
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
