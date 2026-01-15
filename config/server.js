// filepath: config/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";
import { initializeProviders, isProviderAvailable, streamCompletion, calculateCost, reloadProviders } from "./providers/index.js";
import { routeMessage, previewRoute } from "./providers/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');

const CONFIG_PATH = path.join(DATA_DIR, 'models.json');
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
const conversationsPath = path.join(DATA_DIR, 'conversations.json');
const statsPath = path.join(DATA_DIR, 'stats.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let providerStatus = initializeProviders();

// --- HELPER FUNCTIONS ---

async function readJson(filePath, defaultValue) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (err) { return defaultValue; }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createId() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10); }

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

/**
 * Packs messages for optimal caching.
 * Static Prefix (Files) -> Instructions -> Pruned History -> New Message
 */
function prepareMessagesForModel(messages, options) {
  const { instructions, fileContext } = options;
  const packed = [];

  // 1. Repository Context (The stable prefix for caching)
  if (fileContext) {
    packed.push({ role: "system", content: `REPOSITORY_CONTEXT:\n${fileContext}` });
  }

  // 2. System Instructions
  packed.push({ role: "system", content: instructions });

  // 3. Pruned Conversation History (Last 12 messages only)
  // This prevents the "infinite growth" of token costs.
  const historyWindow = messages.slice(-12);
  packed.push(...historyWindow);

  return packed;
}

// --- GITHUB API HELPERS ---

async function getApiKeyWithFallback(provider) {
  const envKey = process.env[provider === 'github' ? 'GITHUB_TOKEN' : `${provider.toUpperCase()}_API_KEY`];
  if (envKey) return { key: envKey, source: "env" };
  const secrets = await readJson(SECRETS_PATH, { apiKeys: {} });
  return { key: secrets.apiKeys?.[provider], source: "config" };
}

async function getFileFromGitHub(repoFullName, filePath) {
  const token = (await getApiKeyWithFallback("github")).key;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  const [owner, repo] = repoFullName.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub Error: ${res.status}`);
  const json = await res.json();
  return Buffer.from(json.content, "base64").toString("utf8");
}

// --- STATS LOGGING ---

async function updateStats(modelKey, input, output, cost) {
  const stats = await readJson(statsPath, { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0, byModel: {} });
  stats.totalCost += cost;
  stats.totalInputTokens += input;
  stats.totalOutputTokens += output;
  stats.requestCount += 1;
  if (!stats.byModel[modelKey]) stats.byModel[modelKey] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  stats.byModel[modelKey].requests += 1;
  stats.byModel[modelKey].inputTokens += input;
  stats.byModel[modelKey].outputTokens += output;
  stats.byModel[modelKey].cost += cost;
  await writeJson(statsPath, stats);
}

// --- CHAT ENDPOINT ---

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride, mode } = req.body;
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const config = await readJson(CONFIG_PATH, await readJson(path.join(ROOT_DIR, 'config/config/models.json'), {}));
    const conversations = await readJson(conversationsPath, []);
    let conversationIdx = conversations.findIndex(c => c.id === conversationId);
    let conversation = conversationIdx !== -1 ? conversations[conversationIdx] : { id: createId(), messages: [], createdAt: new Date().toISOString() };

    // 1. Determine Model & Routing
    let { modelKey, model: modelConfig } = routeMessage(message, config, loadedFiles.length > 0);
    if (modelOverride && config.models[modelOverride]) {
      modelKey = modelOverride;
      modelConfig = config.models[modelOverride];
    }

    // 2. Fetch Context Files
    const fileContents = {};
    for (const f of loadedFiles) {
      try { fileContents[f] = await getFileFromGitHub(repoFullName, f); }
      catch (e) { console.warn(`Skip file ${f}: ${e.message}`); }
    }

    // 3. Build Optimized Prompt
    const fileContext = Object.entries(fileContents)
      .map(([path, content]) => `--- FILE: ${path} ---\n${content}`)
      .join('\n\n');

    const instructions = `You are an AI Coding Assistant. Reference the REPOSITORY_CONTEXT provided.
Mode: ${mode || 'building'}. 
Current Time: ${new Date().toISOString()}.
Format code changes as patches or clear blocks.`;

    const packedMessages = prepareMessagesForModel(conversation.messages, {
      instructions,
      fileContext,
    });

    // Add current user message
    packedMessages.push({ role: "user", content: message });

    console.log(`[CHAT] ${modelConfig.displayName} | Est. Context: ${estimateTokens(fileContext + instructions)} tokens`);

    res.write(`data: ${JSON.stringify({ type: "start", conversationId: conversation.id, model: modelConfig.displayName })}\n\n`);

    let fullResponse = "";
    let metadata = {};

    // 4. Stream from AI
    // We pass null for the 2nd param (systemPrompt) because we baked it into packedMessages for caching.
    for await (const chunk of streamCompletion(modelConfig, null, packedMessages, modelConfig.maxOutputTokens)) {
      if (chunk.type === "text") {
        fullResponse += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
      } else if (chunk.type === "done") {
        metadata = chunk;
      }
    }

    // 5. Update History & Stats
    conversation.messages.push({ role: "user", content: message });
    conversation.messages.push({ role: "assistant", content: fullResponse, model: modelConfig.displayName });
    if (conversationIdx === -1) conversations.push(conversation);
    await writeJson(conversationsPath, conversations);

    const cost = calculateCost(modelConfig, metadata.inputTokens || 0, metadata.outputTokens || 0);
    await updateStats(modelKey, metadata.inputTokens || 0, metadata.outputTokens || 0, cost);

    res.write(`data: ${JSON.stringify({ type: "done", cost, ...metadata })}\n\n`);
    res.end();

  } catch (err) {
    console.error("Chat Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// --- REMAINING ROUTES (ADMIN/PROJECTS) ---
// (Simplified for this version, keep your existing admin/stats routes here)

app.get("/api/stats", async (req, res) => {
  res.json(await readJson(statsPath, {}));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Optimizer Server running on http://localhost:${PORT}`);
});
