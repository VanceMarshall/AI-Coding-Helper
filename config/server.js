// filepath: config/server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

import { initializeProviders, streamCompletion, calculateCost } from "./providers/index.js";
import { routeMessage } from "./providers/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Railway persistent volume is mounted at /app per your deployment summary.
// Your repo lives under /app/config for code, and we persist runtime data under /app/data.
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");

// Runtime JSON state
const CONFIG_PATH = path.join(DATA_DIR, "models.json");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");
const PROJECTS_PATH = path.join(DATA_DIR, "projects.json");

// Safety limits to prevent runaway context costs
const MAX_FILES = Number(process.env.MAX_FILES || 15);
const MAX_FILE_CHARS = Number(process.env.MAX_FILE_CHARS || 120_000); // ~120k chars/file cap in prompt

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Initialize providers from env
initializeProviders();

/* -------------------- Utilities -------------------- */

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadConfig() {
  // Defaults baked into repo
  const defaultConfigPath = path.join(__dirname, "config", "models.json");
  const defaults = await readJson(defaultConfigPath, {});
  // Runtime overrides on the persistent volume
  const runtime = await readJson(CONFIG_PATH, {});
  // Shallow merge is fine for this config structure
  return { ...defaults, ...runtime };
}

/**
 * Prompt caching strategy:
 * - Put the MOST STABLE prefix first: system instructions + repo/file context (sorted)
 * - Append dynamic conversation last
 *
 * NOTE: We pack system messages ourselves, so provider streaming should receive `systemPrompt = null`.
 */
function prepareMessagesForModel(conversationMessages, options = {}) {
  const { systemPrompt, fileContents = {} } = options;

  const prepared = [];

  // 1) Stable system instructions
  prepared.push({
    role: "system",
    content: systemPrompt || "You are an expert AI coding assistant.",
  });

  // 2) Stable repo context, sorted by file path
  const paths = Object.keys(fileContents).sort();
  if (paths.length) {
    let repoBlock = "ACTIVE REPOSITORY FILES (authoritative context):\n";
    for (const p of paths) {
      let content = fileContents[p] ?? "";
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS) + "\n\n[TRUNCATED: file exceeded max chars]\n";
      }
      repoBlock += `\n--- FILE: ${p} ---\n${content}\n`;
    }
    prepared.push({ role: "system", content: repoBlock });
  }

  // 3) Dynamic conversation tail
  prepared.push(...(conversationMessages || []));

  return prepared;
}

async function maybeSummarizeConversation(convo, config) {
  // Simple guard: only summarize when we have lots of messages
  const msgs = convo.messages || [];
  if (msgs.length < 12) return;

  // Estimate size (rough). You can tune threshold in models.json via summarizationThreshold.
  const modelForSummary = config.models?.fast || config.models?.full;
  if (!modelForSummary) return;

  const threshold =
    modelForSummary.summarizationThreshold != null
      ? Number(modelForSummary.summarizationThreshold)
      : 30_000; // tokens-ish target

  const estChars = JSON.stringify(msgs).length;
  // ~1 token ~= 3-4 chars for english-ish; use *3 as a conservative conversion
  if (estChars < threshold * 3) return;

  const head = msgs.slice(0, -6);
  const tail = msgs.slice(-6);

  const summaryPrompt =
    "Summarize the conversation so far for continuity in a coding assistant. " +
    "Include: key decisions, current repo state assumptions, requirements, what remains to do. " +
    "Be concise and factual.\n\n" +
    head.map((m) => `${m.role}: ${m.content}`).join("\n");

  let summary = "";
  try {
    for await (const chunk of streamCompletion(
      modelForSummary,
      "You summarize conversations for downstream LLM context.",
      [{ role: "user", content: summaryPrompt }],
      600
    )) {
      if (chunk.type === "text") summary += chunk.text;
    }
    summary = summary.trim();
  } catch {
    summary = "";
  }

  if (!summary) return;

  convo.messages = [
    { role: "system", content: `Conversation Summary:\n${summary}` },
    ...tail,
  ];
}

/**
 * TODO: Replace these placeholders with your real GitHub integration.
 * Your UI expects:
 * - GET /api/projects/:owner/:repo/files -> { files: [...] }
 * - When user attaches files, server should fetch those contents.
 *
 * If you already have a GitHub client module in your repo, tell me the path and
 * I will wire it in without placeholders.
 */
async function listRepoFilesPlaceholder(_repoFullName) {
  return ["README.md", "package.json", "config/server.js", "config/public/index.html"];
}

async function getFileContentPlaceholder(repoFullName, filePath) {
  return `// Placeholder content\n// repo: ${repoFullName}\n// file: ${filePath}\n\n(Implement GitHub file fetch here.)\n`;
}

/* -------------------- API -------------------- */

app.get("/api/config", async (_req, res) => {
  res.json(await loadConfig());
});

app.get("/api/projects", async (_req, res) => {
  const projects = await readJson(PROJECTS_PATH, []);
  res.json(projects);
});

app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  const { owner, repo } = req.params;
  const repoFullName = `${owner}/${repo}`;

  // Replace with real listing logic if available.
  const files = await listRepoFilesPlaceholder(repoFullName);
  res.json({ repo: repoFullName, files });
});

app.get("/api/conversations", async (_req, res) => {
  res.json(await readJson(CONVERSATIONS_PATH, []));
});

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride } = req.body || {};

  // SSE headers immediately (fixes "model indicator not updating")
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    if (!message || typeof message !== "string") {
      send({ type: "error", error: "Missing message" });
      return res.end();
    }

    const config = await loadConfig();
    const conversations = await readJson(CONVERSATIONS_PATH, []);

    let convo = conversations.find((c) => c.id === conversationId);
    if (!convo) {
      convo = {
        id: Date.now().toString(36),
        title: "",
        messages: [],
        repoFullName: repoFullName || "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      conversations.push(convo);
    }

    if (repoFullName) convo.repoFullName = repoFullName;

    // Route the message (auto/fast/full)
    const route = routeMessage(message, config, (loadedFiles && loadedFiles.length > 0) || false);
    const modelKey = modelOverride && modelOverride !== "auto" ? modelOverride : route.modelKey;

    const modelConfig = config.models?.[modelKey];
    if (!modelConfig) {
      send({ type: "error", error: `Unknown model key: ${modelKey}` });
      return res.end();
    }

    // Start event immediately so UI shows model
    send({ type: "start", conversationId: convo.id, model: modelConfig.displayName || modelConfig.model });

    // Attach file contents (with limits)
    const fileContents = {};
    const filesToFetch = Array.isArray(loadedFiles) ? loadedFiles.slice(0, MAX_FILES) : [];

    for (const fp of filesToFetch) {
      try {
        fileContents[fp] = await getFileContentPlaceholder(repoFullName, fp);
      } catch (e) {
        fileContents[fp] = `[Error loading ${fp}: ${e.message}]`;
      }
    }

    // Optional history compaction to reduce costs
    await maybeSummarizeConversation(convo, config);

    // Append user message
    convo.messages.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });

    // Pack final prompt with stable prefix for caching
    const finalMessages = prepareMessagesForModel(convo.messages, {
      systemPrompt: config.systemPrompt,
      fileContents,
    });

    let assistantText = "";
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, finishReason: "stop" };

    // IMPORTANT: pass systemPrompt = null because finalMessages already include system messages.
    for await (const chunk of streamCompletion(modelConfig, null, finalMessages, modelConfig.maxOutputTokens)) {
      if (chunk.type === "text") {
        assistantText += chunk.text;
        send({ type: "text", text: chunk.text });
      } else if (chunk.type === "done") {
        usage = chunk;
      }
    }

    convo.messages.push({
      role: "assistant",
      content: assistantText,
      timestamp: new Date().toISOString(),
      model: modelConfig.displayName || modelConfig.model,
    });

    convo.updatedAt = new Date().toISOString();
    if (!convo.title) convo.title = message.slice(0, 48) + (message.length > 48 ? "…" : "");

    await writeJson(CONVERSATIONS_PATH, conversations);

    const cost = calculateCost(modelConfig, usage.inputTokens || 0, usage.outputTokens || 0);

    send({
      type: "done",
      cost,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      finishReason: usage.finishReason || "stop",
    });

    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    send({ type: "error", error: err?.message || String(err) });
    res.end();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`ROOT_DIR: ${ROOT_DIR}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
});
