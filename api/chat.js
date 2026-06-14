const https = require('https');

// ─── Config: reads from Vercel env vars (can also read from RTDB) ─
// Your NVIDIA key is stored in Firebase RTDB under "Opencode AI/config"
// To use RTDB instead of env vars, set FIREBASE_SERVICE_ACCOUNT (base64)
// in Vercel dashboard and this function will read from RTDB automatically.

let configCache = null;
let configCacheTime = 0;
const CACHE_TTL = 300000; // 5 min

async function getConfig() {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CACHE_TTL) return configCache;

  // Try RTDB via Admin SDK (lightweight JWT approach, no extra deps)
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa) {
    try {
      const account = JSON.parse(Buffer.from(sa, 'base64').toString());
      const { client_email, private_key, project_id } = account;

      // Create JWT assertion for OAuth2 token exchange
      const jwtNow = Math.floor(now / 1000);
      const header = { alg: 'RS256', typ: 'JWT' };
      const claim = {
        iss: client_email,
        scope: 'https://www.googleapis.com/auth/firebase.database',
        aud: 'https://oauth2.googleapis.com/token',
        exp: jwtNow + 3600,
        iat: jwtNow
      };
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const signInput = `${b64(header)}.${b64(claim)}`;
      const { createSign } = require('crypto');
      const sig = createSign('RSA-SHA256').update(signInput).sign(private_key, 'base64url');
      const jwt = `${signInput}.${sig}`;

      // Exchange for access token
      const token = await new Promise((resolve, reject) => {
        const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`;
        const req = https.request({
          hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d).access_token); } catch { reject(); } }); });
        req.on('error', reject); req.write(body); req.end();
      });

      // Read config from RTDB
      configCache = await new Promise((resolve, reject) => {
        const p = `/Opencode%20AI/config.json?access_token=${encodeURIComponent(token)}`;
        https.get({ hostname: `${project_id}-default-rtdb.firebaseio.com`, path: p }, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(); } });
        }).on('error', reject);
      });

      if (configCache?.nvidiaApiKey) {
        configCacheTime = now;
        console.log('[api/chat] Config loaded from Realtime Database');
        return configCache;
      }
    } catch (e) {
      console.warn('[api/chat] RTDB config failed:', e.message);
    }
  }

  // Fallback: Vercel environment variables
  configCache = {
    nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
    invokeUrl: process.env.NVIDIA_INVOKE_URL || 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelName: process.env.MODEL_NAME || 'minimaxai/minimax-m3'
  };
  configCacheTime = now;
  return configCache;
}

function classifyError(statusCode, body) {
  const lower = (body || '').toLowerCase();
  if (statusCode === 429 || lower.includes('rate limit')) return { type: 'rate_limit', message: 'The model is currently busy. Please wait a moment.' };
  if (statusCode === 504 || statusCode === 503 || lower.includes('timeout')) return { type: 'timeout', message: 'The AI service is temporarily unavailable. Please try again.' };
  if (statusCode === 401 || statusCode === 403) return { type: 'auth', message: 'API authentication failed.' };
  if (statusCode >= 500) return { type: 'server', message: 'The AI service is temporarily unavailable. Please try again.' };
  return { type: 'unknown', message: 'An unexpected error occurred. Please try again.' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

  // Read body — Vercel may or may not auto-parse it
  let parsed;
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    parsed = req.body;
  } else {
    const raw = typeof req.body === 'string' ? req.body : '';
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  }
  const { messages, temperature = 1.0, top_p = 0.95 } = parsed;
  if (!messages || !Array.isArray(messages)) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Messages array is required.' })); return; }

  const config = await getConfig();
  const apiKey = config.nvidiaApiKey;
  const invokeUrl = config.invokeUrl || 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = config.modelName || 'minimaxai/minimax-m3';

  if (!apiKey) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'AI service configuration error.' })); return; }

  // Prepend system prompt from Realtime Database (so AI reads from DB first)
  const dbSystemMsg = config.systemPrompt
    ? { role: 'system', content: config.systemPrompt }
    : null;
  const allMessages = dbSystemMsg
    ? [dbSystemMsg, ...messages]
    : messages;

  try {
    const upstreamRes = await fetch(invokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({ model, messages: allMessages, max_tokens: 2048, temperature, top_p, stream: true }),
      signal: AbortSignal.timeout(90000)
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    if (upstreamRes.status !== 200) {
      const errBody = await upstreamRes.text();
      const cls = classifyError(upstreamRes.status, errBody);
      res.write(`data: ${JSON.stringify({ error: cls.message, errorType: cls.type })}\n\n`);
      res.end(); return;
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
  } catch (err) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const cls = classifyError(0, err.message);
    res.write(`data: ${JSON.stringify({ error: cls.message, errorType: cls.type })}\n\n`);
    res.end();
  }
};

module.exports.config = { maxDuration: 60, regions: ['iad1'] };
