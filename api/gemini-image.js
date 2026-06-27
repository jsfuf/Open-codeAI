module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini not configured.' });

  const modelId = model || 'gemini-2.5-flash-image';
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
    generationConfig: { temperature: 2.0, responseModalities: ['TEXT', 'IMAGE'] },
  };

  if (systemMsg && systemMsg.content) {
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
      console.error('Gemini image error:', rawRes.status, errText.slice(0, 300));
      return res.status(rawRes.status).json({ error: `Gemini error (${rawRes.status})` });
    }

    const data = await rawRes.json();
    res.json(data);
  } catch (err) {
    console.error('Gemini image proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy error.' });
  }
};
