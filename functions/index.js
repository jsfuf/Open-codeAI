const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();

// Cache config so we don't read RTDB on every request
let configCache = null;
let configCacheTime = 0;
const CACHE_TTL = 300000; // 5 minutes

async function getConfig() {
  const now = Date.now();
  if (configCache && (now - configCacheTime) < CACHE_TTL) {
    return configCache;
  }
  try {
    const snap = await admin.database().ref("Opencode AI/config").once("value");
    const data = snap.val();
    if (data) {
      configCache = data;
      configCacheTime = now;
      console.log("[Config] Loaded from Realtime Database");
      return data;
    }
  } catch (e) {
    console.warn("[Config] RTDB read failed, falling back to env:", e.message);
  }
  // Fallback to env vars (for local dev)
  console.log("[Config] Using environment variables");
  return {
    nvidiaApiKey: process.env.NVIDIA_API_KEY || "",
    invokeUrl: process.env.NVIDIA_INVOKE_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
    modelName: process.env.MODEL_NAME || "minimaxai/minimax-m3"
  };
}

// Error classification helper
function classifyError(statusCode, body) {
  const lower = (body || "").toLowerCase();

  if (statusCode === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { type: "rate_limit", message: "The model is currently busy. Please wait a moment." };
  }
  if (statusCode === 504 || statusCode === 503 || lower.includes("timeout") || lower.includes("timed out")) {
    return { type: "timeout", message: "The AI service is temporarily unavailable. Please try again." };
  }
  if (statusCode === 401 || statusCode === 403 || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return { type: "auth", message: "API authentication failed. Please contact the administrator." };
  }
  if (statusCode === 400 || lower.includes("invalid") || lower.includes("bad request")) {
    return { type: "invalid", message: "Invalid request. Please check your message and try again." };
  }
  if (statusCode >= 500) {
    return { type: "server", message: "The AI service is temporarily unavailable. Please try again." };
  }
  return { type: "unknown", message: "An unexpected error occurred. Please try again." };
}

/**
 * Streaming chat endpoint using HTTPS function
 * Proxies requests to NVIDIA API with streaming support
 */
exports.chatStream = onRequest(
  {
    cors: true,
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req, res) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();

    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const { messages, temperature = 1.0, top_p = 0.95 } = req.body || {};

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Messages array is required." });
      }

      const config = await getConfig();
      const apiKey = config.nvidiaApiKey;
      const invokeUrl = config.invokeUrl || "https://integrate.api.nvidia.com/v1/chat/completions";
      const model = config.modelName || "minimaxai/minimax-m3";

      if (!apiKey) {
        console.error(`[${requestId}] NVIDIA_API_KEY not configured`);
        return res.status(500).json({ error: "AI service configuration error." });
      }

      console.log(`[${requestId}] Starting streaming request to ${model}`);

      // Prepend system prompt from Realtime Database
      const dbSystemMsg = config.systemPrompt
        ? { role: "system", content: config.systemPrompt }
        : null;
      const allMessages = dbSystemMsg
        ? [dbSystemMsg, ...messages]
        : messages;

      const payload = {
        model,
        messages: allMessages,
        max_tokens: 8192,
        temperature,
        top_p,
        stream: true,
      };

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const response = await fetch(invokeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
        timeout: 60000,
      });

      if (!response.ok) {
        const errText = await response.text();
        const classified = classifyError(response.status, errText);
        console.error(`[${requestId}] API error ${response.status}: ${errText.slice(0, 500)}`);
        res.write(`data: ${JSON.stringify({ error: classified.message, errorType: classified.type })}\n\n`);
        return res.end();
      }

      // Pipe the streaming response
      let chunkCount = 0;
      response.body.on("data", (chunk) => {
        chunkCount++;
        res.write(chunk);
      });

      response.body.on("end", () => {
        const elapsed = Date.now() - startTime;
        console.log(`[${requestId}] Stream complete. Chunks: ${chunkCount}, Time: ${elapsed}ms`);
        res.end();
      });

      response.body.on("error", (err) => {
        console.error(`[${requestId}] Stream error:`, err.message);
        res.write(`data: ${JSON.stringify({ error: "Stream interrupted. Please try again.", errorType: "stream_error" })}\n\n`);
        res.end();
      });
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(`[${requestId}] Server error after ${elapsed}ms:`, error);

      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error." });
      } else {
        res.write(`data: ${JSON.stringify({ error: "The AI service is temporarily unavailable.", errorType: "server_error" })}\n\n`);
        res.end();
      }
    }
  }
);
