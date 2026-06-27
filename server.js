require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Use keep-alive agents for connection reuse
const httpAgent  = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Error Classification ────────────────────────────────────────
function classifyError(statusCode, body) {
  const lower = (body || '').toLowerCase();

  if (statusCode === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { type: 'rate_limit', message: 'The model is currently busy. Please wait a moment.' };
  }
  if (statusCode === 504 || statusCode === 503 || lower.includes('timeout') || lower.includes('timed out')) {
    return { type: 'timeout', message: 'The AI service is temporarily unavailable. Please try again.' };
  }
  if (statusCode === 401 || statusCode === 403 || lower.includes('unauthorized') || lower.includes('forbidden')) {
    return { type: 'auth', message: 'API authentication failed. Please contact the administrator.' };
  }
  if (statusCode === 400 || lower.includes('invalid') || lower.includes('bad request')) {
    return { type: 'invalid', message: 'Invalid request. Please check your message and try again.' };
  }
  if (statusCode >= 500) {
    return { type: 'server', message: 'The AI service is temporarily unavailable. Please try again.' };
  }
  return { type: 'unknown', message: 'An unexpected error occurred. Please try again.' };
}

function classifyNetworkError(err) {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
    return { type: 'network', message: 'Connection lost. Please check your internet connection.' };
  }
  if (msg.includes('etimedout') || msg.includes('timeout') || msg.includes('aborted')) {
    return { type: 'timeout', message: 'The AI service is taking too long. Please try again.' };
  }
  return { type: 'network', message: 'Connection lost. Retrying request.' };
}

// ─── Chat Proxy — Streaming with Robust Error Handling ───────────
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { messages, temperature = 2.0, top_p = 0.95 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    const apiKey     = process.env.GROQ_API_KEY;
    const invokeUrl  = process.env.GROQ_API_URL;
    const model      = process.env.MODEL_NAME || 'gpt-5-mini';

    if (!apiKey) {
      console.error(`[${requestId}] GROQ_API_KEY missing on server.`);
      return res.status(500).json({ error: 'AI service configuration error.' });
    }

    if (!invokeUrl) {
      console.error(`[${requestId}] GROQ_API_URL missing on server.`);
      return res.status(500).json({ error: 'AI service endpoint not configured.' });
    }

    const payload = {
      model,
      messages,
      max_tokens: 4096,
      temperature,
      top_p,
      stream: true
    };

    console.log(`[${requestId}] Starting request to ${model} at ${new Date().toISOString()}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Create abort controller for timeout handling
    const controller = new AbortController();
    const timeoutMs = 120000; // 120 second timeout
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let upstream;
    try {
      upstream = await fetch(invokeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      const classified = classifyNetworkError(fetchErr);
      console.error(`[${requestId}] Network error:`, fetchErr.message);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      return res.end();
    }

    clearTimeout(timeoutId);

    // Handle non-OK responses
    if (!upstream.ok) {
      const errText = await upstream.text();
      const classified = classifyError(upstream.status, errText);
      console.error(`[${requestId}] API error ${upstream.status}: ${errText.slice(0, 500)}`);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      return res.end();
    }

    if (!upstream.body) {
      console.error(`[${requestId}] No body in upstream response.`);
      res.write(`data: ${JSON.stringify({ error: 'The AI service returned an empty response.', errorType: 'empty' })}\n\n`);
      return res.end();
    }

    // Track streaming health
    let chunkCount = 0;
    let firstChunkTime = null;
    let errorDetected = false;

    const handleUpstreamError = (errorMsg) => {
      if (errorDetected) return;
      errorDetected = true;

      // Check for endpoint feedback alerts or other error patterns in stream
      const lower = errorMsg.toLowerCase();
      if (lower.includes('feedback') || lower.includes('alert') || lower.includes('endpoint')) {
        console.warn(`[${requestId}] Endpoint feedback detected: ${errorMsg.slice(0, 200)}`);
        res.write(`data: ${JSON.stringify({ error: 'The AI service is temporarily unavailable. Please try again.', errorType: 'endpoint_feedback' })}\n\n`);
      } else if (lower.includes('rate limit') || lower.includes('429')) {
        res.write(`data: ${JSON.stringify({ error: 'The model is currently busy. Please wait a moment.', errorType: 'rate_limit' })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: 'The AI service encountered an issue. Please try again.', errorType: 'stream_error' })}\n\n`);
      }
      res.end();
    };

    // Pipe upstream SSE → client SSE
    const pipe = async () => {
      if (upstream.body.on) {
        // Node Readable stream
        upstream.body.on('data', chunk => {
          chunkCount++;
          if (!firstChunkTime) firstChunkTime = Date.now();

          const chunkStr = chunk.toString();
          // Check for error patterns in SSE data
          if (chunkStr.includes('"error"') && !chunkStr.includes('"choices"')) {
            try {
              const lines = chunkStr.split('\n').filter(l => l.startsWith('data:'));
              for (const line of lines) {
                const data = JSON.parse(line.slice(5).trim());
                if (data.error) {
                  handleUpstreamError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
                  return;
                }
              }
            } catch (_) {
              // Not JSON, pass through normally
            }
          }
          res.write(chunk);
        });
        upstream.body.on('end', () => {
          const elapsed = Date.now() - startTime;
          console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
          res.end();
        });
        upstream.body.on('error', err => {
          console.error(`[${requestId}] Upstream stream error:`, err.message);
          handleUpstreamError(err.message);
        });
      } else if (typeof upstream.body.getReader === 'function') {
        // Web ReadableStream (Node 18+ built-in fetch)
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkCount++;
            if (!firstChunkTime) firstChunkTime = Date.now();

            const chunkStr = new TextDecoder().decode(value);
            // Check for error patterns in SSE data
            if (chunkStr.includes('"error"') && !chunkStr.includes('"choices"')) {
              try {
                const lines = chunkStr.split('\n').filter(l => l.trim().startsWith('data:'));
                for (const line of lines) {
                  const data = JSON.parse(line.slice(5).trim());
                  if (data.error) {
                    handleUpstreamError(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
                    return;
                  }
                }
              } catch (_) {
                // Not JSON, pass through normally
              }
            }
            res.write(value);
          }
          const elapsed = Date.now() - startTime;
          console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
        } catch (readErr) {
          console.error(`[${requestId}] Reader error:`, readErr.message);
          handleUpstreamError(readErr.message);
        } finally {
          reader.releaseLock();
          res.end();
        }
      } else if (upstream.body[Symbol.asyncIterator]) {
        for await (const chunk of upstream.body) {
          chunkCount++;
          if (!firstChunkTime) firstChunkTime = Date.now();
          res.write(chunk);
        }
        const elapsed = Date.now() - startTime;
        console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
        res.end();
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Unsupported response format from AI service.', errorType: 'format' })}\n\n`);
        res.end();
      }
    };

    await pipe();

  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[${requestId}] Server error after ${elapsed}ms:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      const classified = classifyNetworkError(err);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      res.end();
    }
  }
});

// ─── DeepSeek AI Proxy — Streaming ─────────────────────────────
app.post('/api/deepseek-chat', async (req, res) => {
  const startTime = Date.now();
  const requestId = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { messages, model, temperature = 0.7, max_tokens = 4096 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array are required.' });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.error(`[${requestId}] DEEPSEEK_API_KEY missing on server.`);
      return res.status(500).json({ error: 'DeepSeek AI service not configured.' });
    }

    const modelId = model || 'deepseek-chat';
    const url = 'https://api.deepseek.com/chat/completions';

    const payload = {
      model: modelId,
      messages,
      max_tokens,
      temperature,
      stream: true,
    };

    console.log(`[${requestId}] DeepSeek AI request: ${modelId}`);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      const classified = classifyNetworkError(fetchErr);
      console.error(`[${requestId}] Network error:`, fetchErr.message);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      return res.end();
    }

    clearTimeout(timeoutId);

    if (!upstream.ok) {
      const errText = await upstream.text();
      const classified = classifyError(upstream.status, errText);
      console.error(`[${requestId}] DeepSeek API error ${upstream.status}: ${errText.slice(0, 500)}`);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      return res.end();
    }

    if (!upstream.body) {
      console.error(`[${requestId}] No body in upstream response.`);
      res.write(`data: ${JSON.stringify({ error: 'DeepSeek AI returned an empty response.', errorType: 'empty' })}\n\n`);
      return res.end();
    }

    let chunkCount = 0;
    let firstChunkTime = null;

    const pipe = async () => {
      if (typeof upstream.body.getReader === 'function') {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkCount++;
            if (!firstChunkTime) firstChunkTime = Date.now();
            res.write(value);
          }
          const elapsed = Date.now() - startTime;
          console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
        } catch (readErr) {
          console.error(`[${requestId}] Reader error:`, readErr.message);
          res.write(`data: ${JSON.stringify({ error: 'Stream interrupted.', errorType: 'stream_error' })}\n\n`);
        } finally {
          reader.releaseLock();
          res.end();
        }
      } else if (upstream.body.on) {
        upstream.body.on('data', chunk => {
          chunkCount++;
          if (!firstChunkTime) firstChunkTime = Date.now();
          res.write(chunk);
        });
        upstream.body.on('end', () => {
          const elapsed = Date.now() - startTime;
          console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
          res.end();
        });
        upstream.body.on('error', err => {
          console.error(`[${requestId}] Upstream stream error:`, err.message);
          res.write(`data: ${JSON.stringify({ error: 'Stream interrupted.', errorType: 'stream_error' })}\n\n`);
          res.end();
        });
      } else {
        res.write(`data: ${JSON.stringify({ error: 'Unsupported response format.', errorType: 'format' })}\n\n`);
        res.end();
      }
    };

    await pipe();
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[${requestId}] Server error after ${elapsed}ms:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      const classified = classifyNetworkError(err);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      res.end();
    }
  }
});

// ─── Gemini AI Proxy — Streaming ──────────────────────────────
app.post('/api/gemini-chat', async (req, res) => {
  const startTime = Date.now();
  const requestId = `gm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { messages, model, temperature = 2.0, maxOutputTokens = 8192 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(`[${requestId}] GEMINI_API_KEY missing.`);
      return res.status(500).json({ error: 'Gemini service not configured.' });
    }

    const modelId = model || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    // Convert messages to Gemini format
    const systemMsg = messages.find(m => m.role === 'system');
    const geminiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));

    const payload = {
      contents: geminiMessages,
      generationConfig: {
        temperature,
        topP: 0.95,
        maxOutputTokens,
      },
    };

    if (systemMsg && systemMsg.content && systemMsg.content.length > 10) {
      payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    console.log(`[${requestId}] Gemini request: ${modelId}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let rawRes;
    try {
      rawRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      const classified = classifyNetworkError(fetchErr);
      console.error(`[${requestId}] Network error:`, fetchErr.message);
      return res.status(500).json({ error: classified.message });
    }

    clearTimeout(timeoutId);

    if (!rawRes.ok) {
      const errText = await rawRes.text();
      console.error(`[${requestId}] Gemini API error ${rawRes.status}: ${errText.slice(0, 500)}`);
      const classified = classifyError(rawRes.status, errText);
      return res.status(rawRes.status).json({ error: classified.message });
    }

    const data = await rawRes.json();
    let fullText = '';
    for (const candidate of (data.candidates || [])) {
      for (const part of (candidate.content?.parts || [])) {
        if (part.text) fullText += part.text;
      }
    }

    if (!fullText) fullText = 'No response received. Please try again.';

    // Stream it back as SSE for compatibility with the frontend
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const chunkSize = 20;
    let idx = 0;
    const sendChunk = () => {
      if (idx < fullText.length) {
        const chunk = fullText.slice(idx, idx + chunkSize);
        idx += chunkSize;
        const sseData = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
        res.write(`data: ${sseData}\n\n`);
        setTimeout(sendChunk, 10);
      } else {
        res.write('data: [DONE]\n\n');
        const elapsed = Date.now() - startTime;
        console.log(`[${requestId}] Gemini response complete. Length: ${fullText.length}, Time: ${elapsed}ms`);
        res.end();
      }
    };
    sendChunk();
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[${requestId}] Server error after ${elapsed}ms:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error.' });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Server error.', errorType: 'server' })}\n\n`);
      res.end();
    }
  }
});

// ─── Gemini Image Generation Proxy ────────────────────────────
app.post('/api/gemini-image', async (req, res) => {
  const startTime = Date.now();
  const requestId = `gi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { messages, model } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error(`[${requestId}] GEMINI_API_KEY missing.`);
      return res.status(500).json({ error: 'Gemini service not configured.' });
    }

    const modelId = model || 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const geminiMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      }));

    const systemMsg = messages.find(m => m.role === 'system');

    const payload = {
      contents: geminiMessages,
      generationConfig: {
        temperature: 2.0,
        responseModalities: ['TEXT', 'IMAGE'],
      },
    };

    if (systemMsg && systemMsg.content) {
      payload.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    console.log(`[${requestId}] Gemini image request: ${modelId}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    let rawRes;
    try {
      rawRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      console.error(`[${requestId}] Network error:`, fetchErr.message);
      return res.status(500).json({ error: 'Network error.' });
    }

    clearTimeout(timeoutId);

    if (!rawRes.ok) {
      const errText = await rawRes.text();
      console.error(`[${requestId}] Gemini image API error ${rawRes.status}: ${errText.slice(0, 500)}`);
      return res.status(rawRes.status).json({ error: `Gemini API error (${rawRes.status})` });
    }

    const data = await rawRes.json();
    const elapsed = Date.now() - startTime;
    console.log(`[${requestId}] Gemini image response complete. Time: ${elapsed}ms`);
    res.json(data);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[${requestId}] Server error after ${elapsed}ms:`, err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─── Static Routes ───────────────────────────────────────────────
app.get('/auth.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'auth.html'))
);

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () =>
  console.log(`✅  Server running → http://localhost:${PORT}`)
);
