// filepath: config/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";
import { 
  initializeProviders, 
  isProviderAvailable, 
  streamCompletion, 
  calculateCost, 
  reloadProviders 
} from "./providers/index.js";
import { routeMessage } from "./providers/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'models.json');
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
const conversationsPath = path.join(DATA_DIR, 'conversations.json');
const projectsPath = path.join(DATA_DIR, 'projects.json');

// Safety Limits
const MAX_FILE_SIZE = 100 * 1024; // 100KB per file max
const MAX_FILES = 15; // Max files to send to AI at once

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize
let providerStatus = initializeProviders();

/* --- Helpers --- */

async function readJson(filePath, defaultValue) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return defaultValue; }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadConfig() {
  const defaults = await readJson(path.join(__dirname, 'config', 'models.json'), {});
  const runtime = await readJson(CONFIG_PATH, {});
  return { ...defaults, ...runtime };
}

/**
 * Optimizes message order for OpenAI Prompt Caching.
 * Stable Prefix = System Prompt + Sorted File Contents.
 */
function prepareMessagesForModel(messages, options = {}) {
  const { systemPrompt, fileContents = {} } = options;
  const prepared = [];
  
  // 1. Static System Instructions (Most stable)
  prepared.push({ 
    role: 'system', 
    content: systemPrompt || "You are an expert AI coding assistant." 
  });

  // 2. Stable File Context (Sorted alphabetically)
  const sortedPaths = Object.keys(fileContents).sort();
  if (sortedPaths.length > 0) {
    let repoContext = "ACTIVE REPOSITORY FILES:\n";
    for (const filePath of sortedPaths) {
      const content = fileContents[filePath];
      // Skip files that are too large
      if (content.length > MAX_FILE_SIZE) {
        repoContext += `--- FILE: ${filePath} ---\n[File omitted: exceeds size limit]\n`;
      } else {
        repoContext += `--- FILE: ${filePath} ---\n${content}\n`;
      }
    }
    prepared.push({ role: 'system', content: repoContext });
  }

  // 3. Dynamic Conversation (The "tail" that changes)
  prepared.push(...messages);

  return prepared;
}

async function getHistorySummary(messages, config) {
  if (messages.length < 8) return null;
  const fastModel = config.models.fast;
  const textToSummarize = messages.slice(0, -4).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `Summarize the technical state of this chat concisely. Decisions made, current tasks, and code context. Be brief.`;
  
  let summary = "";
  try {
    for await (const chunk of streamCompletion(fastModel, "Summarize concisely.", [{role: "user", content: prompt + "\n\n" + textToSummarize}], 512)) {
      if (chunk.type === "text") summary += chunk.text;
    }
    return summary.trim();
  } catch (e) {
    return null;
  }
}

/**
 * simulated GitHub fetch - Replace with your actual GitHub client logic
 */
async function getFileContent(repo, path) {
    // This is where your actual octokit or fetch logic goes.
    // For now, it's a placeholder to prevent the 404.
    return `// Content for ${path} from ${repo}\n(Actual content fetching logic needs implementation)`;
}

/* --- Endpoints --- */

app.get("/api/config", async (req, res) => {
    res.json(await loadConfig());
});

app.get("/api/projects", async (req, res) => {
  res.json(await readJson(projectsPath, []));
});

// Fix for the 404 error when UI tries to list files
app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  const { owner, repo } = req.params;
  const repoFullName = `${owner}/${repo}`;
  // In a real app, you'd fetch the tree from GitHub here.
  // Returning a placeholder list so the UI works.
  res.json({ repo: repoFullName, files: ["package.json", "index.js", "src/App.js"] });
});

app.get("/api/conversations", async (req, res) => {
  res.json(await readJson(conversationsPath, []));
});

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride } = req.body;
  
  // 1. SET SSE HEADERS IMMEDIATELY
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const config = await loadConfig();
    const conversations = await readJson(conversationsPath, []);
    let convo = conversations.find(c => c.id === conversationId);

    if (!convo) {
      convo = { id: Date.now().toString(36), messages: [], createdAt: new Date().toISOString() };
      conversations.push(convo);
    }

    // 2. SMART ROUTING
    const route = routeMessage(message, config, (loadedFiles && loadedFiles.length > 0));
    const modelKey = (modelOverride && modelOverride !== 'auto') ? modelOverride : route.modelKey;
    const modelConfig = config.models[modelKey];

    // 3. SEND START EVENT IMMEDIATELY (Fixes UI Indicator)
    res.write(`data: ${JSON.stringify({ type: "start", conversationId: convo.id, model: modelConfig.displayName })}\n\n`);

    // 4. FETCH FILES (With Safety Limits)
    const fileContents = {};
    const filesToFetch = loadedFiles.slice(0, MAX_FILES);
    for (const f of filesToFetch) {
       fileContents[f] = await getFileContent(repoFullName, f); 
    }

    // 5. HISTORY COMPACTION (Check token budget)
    const summaryThreshold = modelConfig.summarizationThreshold || 30000;
    const currentEstChars = JSON.stringify(convo.messages).length;
    
    if (currentEstChars > summaryThreshold * 3) { // 1 token ~ 3-4 chars
      const summary = await getHistorySummary(convo.messages, config);
      if (summary) {
        convo.messages = [
          { role: "system", content: "Conversation Summary: " + summary },
          ...convo.messages.slice(-4) // Keep only the most recent context
        ];
      }
    }

    convo.messages.push({ role: "user", content: message, timestamp: new Date().toISOString() });

    // 6. PREPARE PACKED PROMPT
    const finalMessages = prepareMessagesForModel(convo.messages, {
      systemPrompt: config.systemPrompt,
      fileContents
    });

    let fullResponse = "";
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

    // 7. STREAM COMPLETION
    // Pass null as systemPrompt because we manually packed it into finalMessages
    for await (const chunk of streamCompletion(modelConfig, null, finalMessages, modelConfig.maxOutputTokens)) {
      if (chunk.type === "text") {
        fullResponse += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
      } else if (chunk.type === "done") {
        usage = chunk;
      }
    }

    // 8. SAVE CONVERSATION
    convo.messages.push({ 
      role: "assistant", 
      content: fullResponse, 
      timestamp: new Date().toISOString(), 
      model: modelConfig.displayName 
    });
    convo.updatedAt = new Date().toISOString();
    convo.title = convo.title || message.substring(0, 40) + "...";
    
    await writeJson(conversationsPath, conversations);

    // 9. FINAL USAGE DATA
    const cost = calculateCost(modelConfig, usage.inputTokens, usage.outputTokens);
    res.write(`data: ${JSON.stringify({ 
      type: "done", 
      cost, 
      inputTokens: usage.inputTokens, 
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens
    })}\n\n`);
    res.end();

  } catch (err) {
    console.error("Chat Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`📂 Data directory: ${DATA_DIR}`);
});
