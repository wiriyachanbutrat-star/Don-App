require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GROQ_API_KEY;
const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GROQ_API_KEY บนเซิร์ฟเวอร์' });
  }

  const { base64, mediaType, prompt } = req.body || {};
  if (!base64 || !mediaType || !prompt) {
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ครบ' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || 'เรียก Groq API ไม่สำเร็จ' });
    }

    const text = data?.choices?.[0]?.message?.content;
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
