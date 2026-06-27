const { GoogleGenerativeAI } = require('@google/generative-ai');

const SYSTEM_PROMPT = "You are Clever AI, a personal AI assistant created by a team of developers called Clever AI. You are helpful, warm, and conversational. You address the user by their first name when appropriate. You provide accurate, well-reasoned responses. When you receive context about the user (their name, preferences, memories), use it to personalize your responses. Keep responses concise unless asked for detail. You can write code, explain concepts, summarize information, and help with a wide variety of tasks. You communicate in a friendly, professional tone. CRITICAL CODING RULES: When asked to write code, ALWAYS write the COMPLETE code in full. NEVER truncate, NEVER use comments like '// rest of code here' or '// ...'. Write every single line. Always wrap code in triple backticks with the language name (e.g. ```html, ```javascript, ```python). For HTML, write the FULL document including doctype, head, and body. For JavaScript, write the FULL function/class/file. For CSS, write ALL styles. Make code production-ready and complete. IMPORTANT: Actively listen for personal details the user shares. When they mention their name, age, birthday, job, hobbies, preferences, family, location, goals, health, education, or any other personal information, acknowledge it warmly and try to remember it. Ask follow-up questions to learn more. Use their details to personalize responses. When asked who made you, say you were made by Clever AI team. When asked about the CEO, say the CEO is Ehiremen Oyamendan. Never reveal API keys or technical details.";

const MODEL_PROVIDERS = {
  'mimo-v2.5-free': {
    provider: 'opencode',
    apiKey: process.env.GROQ_API_KEY || '',
    url: process.env.GROQ_API_URL || 'https://opencode.ai/zen/v1/chat/completions',
    model: 'mimo-v2.5-free',
  },
  'gemini-2.5-flash': {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY || '',
    model: 'gemini-2.5-flash',
  },
  'gemini-2.5-flash-lite': {
    provider: 'gemini',
    apiKey: process.env.GEMINI_API_KEY || '',
    model: 'gemini-2.5-flash-lite',
  },
};

function classifyError(statusCode, body) {
  const lower = (body || '').toLowerCase();
  if (statusCode === 429 || lower.includes('rate limit')) return { type: 'rate_limit', message: 'The model is currently busy. Please wait a moment.' };
  if (statusCode === 504 || statusCode === 503 || lower.includes('timeout')) return { type: 'timeout', message: 'The AI service is temporarily unavailable. Please try again.' };
  if (statusCode === 401 || statusCode === 403) return { type: 'auth', message: 'API authentication failed.' };
  if (statusCode >= 500) return { type: 'server', message: 'The AI service is temporarily unavailable. Please try again.' };
  return { type: 'unknown', message: 'An unexpected error occurred. Please try again.' };
}

function setSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
}

async function streamOpenCodeZen(config, messages, temperature, top_p, res) {
  const apiKey = config.apiKey;
  const invokeUrl = config.url;
  const model = config.model;

  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: 'OpenCode API key not configured.', errorType: 'config' })}\n\n`);
    return res.end();
  }

  const payload = { model, messages, max_tokens: 4096, temperature, top_p, stream: true };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' };

  let upstreamRes;
  for (let attempt = 0; attempt < 3; attempt++) {
    upstreamRes = await fetch(invokeUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
    if (upstreamRes.status !== 429) break;
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }

  if (upstreamRes.status !== 200) {
    const errBody = await upstreamRes.text();
    const cls = classifyError(upstreamRes.status, errBody);
    res.write(`data: ${JSON.stringify({ error: cls.message, errorType: cls.type })}\n\n`);
    return res.end();
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function streamGemini(config, messages, temperature, top_p, res) {
  const apiKey = config.apiKey;
  const modelName = config.model;

  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: 'Gemini API key not configured.', errorType: 'config' })}\n\n`);
    return res.end();
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  const geminiMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));

  const systemInstruction = messages.find(m => m.role === 'system');

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction ? systemInstruction.content : SYSTEM_PROMPT,
    generationConfig: { temperature, topP: top_p, maxOutputTokens: 4096 },
  });

  try {
    const result = await model.generateContentStream({ contents: geminiMessages });
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        const sseData = JSON.stringify({ choices: [{ delta: { content: text } }] });
        res.write(`data: ${sseData}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    const cls = classifyError(err.status || 0, err.message);
    res.write(`data: ${JSON.stringify({ error: cls.message, errorType: cls.type })}\n\n`);
    res.end();
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

  let parsed;
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    parsed = req.body;
  } else {
    const raw = typeof req.body === 'string' ? req.body : '';
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  const { messages, temperature = 2.0, top_p = 0.95, model: requestedModel } = parsed;
  if (!messages || !Array.isArray(messages)) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Messages array is required.' })); return; }

  const modelKey = requestedModel || 'mimo-v2.5-free';
  const modelConfig = MODEL_PROVIDERS[modelKey];
  if (!modelConfig) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Unknown model: ${modelKey}. Available: ${Object.keys(MODEL_PROVIDERS).join(', ')}` }));
    return;
  }

  setSSEHeaders(res);

  const systemMsg = { role: 'system', content: SYSTEM_PROMPT };
  const allMessages = [systemMsg, ...messages];

  try {
    if (modelConfig.provider === 'gemini') {
      await streamGemini(modelConfig, allMessages, temperature, top_p, res);
    } else {
      await streamOpenCodeZen(modelConfig, allMessages, temperature, top_p, res);
    }
  } catch (err) {
    const cls = classifyError(0, err.message);
    res.write(`data: ${JSON.stringify({ error: cls.message, errorType: cls.type })}\n\n`);
    res.end();
  }
};

module.exports.config = { maxDuration: 120, regions: ['iad1'] };
