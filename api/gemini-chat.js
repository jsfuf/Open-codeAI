module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model, temperature = 2.0, maxOutputTokens = 8192 } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini not configured.' });

  const modelId = model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const systemMsg = messages.find(m => m.role === 'system');
  const geminiMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

  const payload = {
    contents: geminiMessages,
    generationConfig: { temperature, topP: 0.95, maxOutputTokens },
  };

  if (systemMsg && systemMsg.content && systemMsg.content.length > 10) {
    payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  try {
    const rawRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!rawRes.ok) {
      const errText = await rawRes.text();
      console.error('Gemini error:', rawRes.status, errText.slice(0, 300));
      return res.status(rawRes.status).json({ error: `Gemini error (${rawRes.status})` });
    }

    const data = await rawRes.json();
    let fullText = '';
    for (const c of (data.candidates || [])) {
      for (const p of (c.content?.parts || [])) {
        if (p.text) fullText += p.text;
      }
    }
    if (!fullText) fullText = 'No response received.';

    // Stream back as SSE
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const chunkSize = 20;
    let idx = 0;
    const sendChunk = () => {
      if (idx < fullText.length) {
        const chunk = fullText.slice(idx, idx + chunkSize);
        idx += chunkSize;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        setTimeout(sendChunk, 10);
      } else {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };
    sendChunk();
  } catch (err) {
    console.error('Gemini proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy error.' });
    else res.end();
  }
};
