module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model, temperature = 0.7, max_tokens = 4096 } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages array required.' });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'DeepSeek not configured.' });

  try {
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages,
        max_tokens,
        temperature,
        stream: true,
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('DeepSeek error:', upstream.status, errText.slice(0, 300));
      return res.status(upstream.status).json({ error: `DeepSeek API error (${upstream.status})` });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('DeepSeek proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy error.' });
    else { res.end(); }
  }
};
