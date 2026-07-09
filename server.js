require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'gold.html'));
});

app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์' });
  }

  const { base64, mediaType, prompt } = req.body || {};
  if (!base64 || !mediaType || !prompt) {
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ครบ' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mediaType, data: base64 } }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.3,
            response_mime_type: 'application/json'
          }
        })
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

    // Normalize to the same shape gold.html already parses (Anthropic-style content blocks)
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Gold AI analyzer running at http://localhost:${PORT}`);
});
