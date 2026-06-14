// ─── Seed script: Upload config to Realtime Database ─────────────
// 1. Download your Firebase service account key:
//    Firebase Console → Project Settings → Service Accounts → Generate new private key
//    Save it as "service-account.json" in this project root (DO NOT commit to git!)
//
// 2. Run: node scripts/seed-config.js
//
// 3. Delete service-account.json when done (it's a sensitive file)

const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const admin = require("firebase-admin");

// Load service account (you must download this from Firebase Console)
let serviceAccount;
try {
  serviceAccount = require(path.join(__dirname, "..", "service-account.json"));
} catch (e) {
  console.error("ERROR: Download your service account key first:");
  console.error("  Firebase Console → Project Settings → Service Accounts");
  console.error("  → 'Generate new private key' → save as service-account.json");
  console.error("  in the project root folder.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ai-chat-21dfc-default-rtdb.firebaseio.com"
});

const config = {
  nvidiaApiKey: process.env.NVIDIA_API_KEY || "",
  invokeUrl: process.env.NVIDIA_INVOKE_URL || "https://integrate.api.nvidia.com/v1/chat/completions",
  modelName: process.env.MODEL_NAME || "minimaxai/minimax-m3",
  systemPrompt: "You are a personal AI assistant. You are helpful, warm, and conversational. You address the user by their first name when appropriate. You provide accurate, well-reasoned responses. When you receive context about the user (their name, preferences, memories), use it to personalize your responses. Keep responses concise unless asked for detail. You can write code, explain concepts, summarize information, and help with a wide variety of tasks. You communicate in a friendly, professional tone. Always format code blocks using triple backticks with the language name."
};

async function main() {
  await admin.database().ref("Opencode AI/config").set(config);
  console.log("✓ Config uploaded to Realtime Database:");
  console.log('  Path: "Opencode AI/config"');
  console.log("  API Key: " + (config.nvidiaApiKey ? config.nvidiaApiKey.slice(0, 12) + "..." : "NOT SET"));
  console.log("  Invoke URL: " + config.invokeUrl);
  console.log("  Model: " + config.modelName);
  console.log("  System Prompt: " + config.systemPrompt.slice(0, 60) + "...");
  console.log("You can now delete service-account.json");
  process.exit(0);
}

main().catch(err => {
  console.error("Failed:", err.message);
  process.exit(1);
});
