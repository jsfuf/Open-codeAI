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
    const { messages, temperature = 1.0, top_p = 0.95 } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    const apiKey     = process.env.NVIDIA_API_KEY;
    const invokeUrl  = process.env.NVIDIA_INVOKE_URL;
    const model      = process.env.MODEL_NAME || 'minimaxai/minimax-m3';

    if (!apiKey) {
      console.error(`[${requestId}] NVIDIA_API_KEY missing on server.`);
      return res.status(500).json({ error: 'AI service configuration error.' });
    }

    if (!invokeUrl) {
      console.error(`[${requestId}] NVIDIA_INVOKE_URL missing on server.`);
      return res.status(500).json({ error: 'AI service endpoint not configured.' });
    }

    const payload = {
      model,
      messages,
      max_tokens: 8192,
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
    const timeoutMs = 60000; // 60 second timeout
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
