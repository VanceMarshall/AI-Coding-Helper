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

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize
let providerStatus = initializeProviders();

async function readJson(filePath, defaultValue) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return defaultValue; }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadConfig() {
  const defaults = await readJson(path.join(__dirname, 'config', 'models.json'), {});
  const runtime = await readJson(CONFIG_PATH, {});
  return { ...defaults, ...runtime };
}

// Ensure stable ordering for OpenAI Prompt Caching
function prepareMessagesForModel(messages, options = {}) {
  const { systemPrompt, fileContents = {} } = options;
  const prepared = [];
  
  // 1. Static System Instructions (Always first)
  prepared.push({ 
    role: 'system', 
    content: systemPrompt || "You are an expert AI coding assistant." 
  });

  // 2. Stable File Context
  // We SORT the keys alphabetically so the prompt prefix is identical turn-over-turn.
  const sortedPaths = Object.keys(fileContents).sort();
  if (sortedPaths.length > 0) {
    let repoContext = "ACTIVE REPOSITORY FILES:\n";
    for (const filePath of sortedPaths) {
      repoContext += `--- FILE: ${filePath} ---\n${fileContents[filePath]}\n`;
    }
    // This block becomes a "Cache Hit" for OpenAI if the files haven't changed.
    prepared.push({ role: 'system', content: repoContext });
  }

  // 3. Dynamic Conversation (The "tail" that changes every turn)
  prepared.push(...messages);

  return prepared;
}

// Summarize long histories using the cheaper Fast model
async function getHistorySummary(messages, config) {
  if (messages.length < 10) return null;
  const fastModel = config.models.fast;
  const textToSummarize = messages.slice(0, -6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `Summarize the following technical conversation concisely. Focus on current state and decisions made:\n\n${textToSummarize}`;
  
  let summary = "";
  try {
    for await (const chunk of streamCompletion(fastModel, "Summarize concisely.", [{role: "user", content: prompt}], 512)) {
      if (chunk.type === "text") summary += chunk.text;
    }
    return summary;
  } catch (e) {
    return null;
  }
}

// --- Endpoints ---

app.get("/api/projects", async (req, res) => {
  res.json(await readJson(path.join(DATA_DIR, 'projects.json'), []));
});

app.get("/api/conversations", async (req, res) => {
  res.json(await readJson(conversationsPath, []));
});

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride } = req.body;
  
  try {
    const config = await loadConfig();
    const conversations = await readJson(conversationsPath, []);
    let convo = conversations.find(c => c.id === conversationId);

    if (!convo) {
      convo = { id: Date.now().toString(36), messages: [], createdAt: new Date().toISOString() };
      conversations.push(convo);
    }

    // Smart Routing
    const route = routeMessage(message, config, loadedFiles.length > 0);
    const modelKey = modelOverride || route.modelKey;
    const modelConfig = config.models[modelKey];

    // Fetch Files (Simulated here - ensure your GitHub logic is called)
    const fileContents = {};
    for (const f of loadedFiles) {
       // fileContents[f] = await getFileContent(repoFullName, f); 
    }

    // Compaction: If history is too long, summarize it
    const summaryThreshold = modelConfig.summarizationThreshold || 40000;
    const currentEstTokens = JSON.stringify(convo.messages).length / 4;
    
    if (currentEstTokens > summaryThreshold) {
      const summary = await getHistorySummary(convo.messages, config);
      if (summary) {
        convo.messages = [
          { role: "system", content: "Conversation Summary: " + summary },
          ...convo.messages.slice(-6)
        ];
      }
    }

    convo.messages.push({ role: "user", content: message, timestamp: new Date().toISOString() });

    const finalMessages = prepareMessagesForModel(convo.messages, {
      systemPrompt: config.systemPrompt,
      fileContents
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: "start", conversationId: convo.id, model: modelConfig.displayName })}\n\n`);

    let fullResponse = "";
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of streamCompletion(modelConfig, "", finalMessages, modelConfig.maxOutputTokens)) {
      if (chunk.type === "text") {
        fullResponse += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
      } else if (chunk.type === "done") {
        usage = chunk;
      }
    }

    convo.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), model: modelConfig.displayName });
    convo.updatedAt = new Date().toISOString();
    await writeJson(conversationsPath, conversations);

    const cost = calculateCost(modelConfig, usage.inputTokens, usage.outputTokens);
    res.write(`data: ${JSON.stringify({ type: "done", cost, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })}\n\n`);
    res.end();

  } catch (err) {
    console.error("Chat Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// Standard static routes and listen
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📂 Data directory: ${DATA_DIR}`);
});
