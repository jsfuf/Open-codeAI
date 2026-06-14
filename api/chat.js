const https = require('https');

// Error classification
function classifyError(statusCode, body) {
  const lower = (body || '').toLowerCase();
  if (statusCode === 429 || lower.includes('rate limit')) {
    return { type: 'rate_limit', message: 'The model is currently busy. Please wait a moment.' };
  }
  if (statusCode === 504 || statusCode === 503 || lower.includes('timeout')) {
    return { type: 'timeout', message: 'The AI service is temporarily unavailable. Please try again.' };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { type: 'auth', message: 'API authentication failed.' };
  }
  if (statusCode >= 500) {
    return { type: 'server', message: 'The AI service is temporarily unavailable. Please try again.' };
  }
  return { type: 'unknown', message: 'An unexpected error occurred. Please try again.' };
}

// Vercel serverless function config
module.exports.config = {
  maxDuration: 120,
  regions: ['iad1'],
};

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const { messages, temperature = 1.0, top_p = 0.95 } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Messages array is required.' }));
    return;
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  const invokeUrl = process.env.NVIDIA_INVOKE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = 'minimaxai/minimax-m3';

  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'AI service configuration error.' }));
    return;
  }

  // Streaming SSE response for real-time token-by-token output
  const bodyPayload = JSON.stringify({
    model,
    messages,
    max_tokens: 8192,
    temperature,
    top_p,
    stream: true
  });

  return new Promise((resolve) => {
    const url = new URL(invokeUrl);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(bodyPayload)
      }
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        let errBody = '';
        upstreamRes.on('data', chunk => errBody += chunk);
        upstreamRes.on('end', () => {
          const classified = classifyError(upstreamRes.statusCode, errBody);
          console.error(`API error ${upstreamRes.statusCode}: ${errBody.slice(0, 500)}`);
          res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
          res.end();
          resolve();
        });
        return;
      }

      upstreamRes.on('data', chunk => {
        res.write(chunk);
      });

      upstreamRes.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
        resolve();
      });

      upstreamRes.on('error', (err) => {
        console.error('Upstream error:', err.message);
        res.write(`data: ${JSON.stringify({ error: 'The AI service encountered an issue. Please try again.', errorType: 'upstream_error' })}\n\n`);
        res.end();
        resolve();
      });
    });

    upstreamReq.on('error', (err) => {
      console.error('Request error:', err.message);
      const classified = classifyError(0, err.message);
      res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
      res.end();
      resolve();
    });

    upstreamReq.setTimeout(60000, () => {
      upstreamReq.destroy();
      res.write(`data: ${JSON.stringify({ error: 'The AI service is taking too long. Please try again.', errorType: 'timeout' })}\n\n`);
      res.end();
      resolve();
    });

    upstreamReq.write(bodyPayload);
    upstreamReq.end();
  });
};
