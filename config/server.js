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
  reloadProviders,
} from "./providers/index.js";
import { routeMessage, previewRoute } from "./providers/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const CONFIG_PATH = path.join(DATA_DIR, "models.json");
const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");
const conversationsPath = path.join(DATA_DIR, "conversations.json");

// Bundled defaults (read-only at runtime)
const DEFAULTS_PATH = path.join(__dirname, "config", "models.json");

const projectsPath = path.join(DATA_DIR, "projects.json");

// NEW: cache for repo file lists (paths only)
const repoFileCachePath = path.join(DATA_DIR, "repoFileCache.json");
const REPO_FILES_TTL_MS = 1000 * 60 * 30; // 30 minutes

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Initialize
let providerStatus = initializeProviders();

/* ----------------------- basic json helpers ----------------------- */

async function readJson(filePath, defaultValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return defaultValue;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadConfig() {
  const defaults = await readJson(DEFAULTS_PATH, {});
  const runtime = await readJson(CONFIG_PATH, {});
  return { ...defaults, ...runtime };
}

/* ----------------------- github helpers ----------------------- */

async function loadSecrets() {
  return await readJson(SECRETS_PATH, { apiKeys: {} });
}

async function getApiKeyWithFallback(provider) {
  // env first
  const envKeyName =
    provider === "github" ? "GITHUB_TOKEN" : `${provider.toUpperCase()}_API_KEY`;
  const envKey = process.env[envKeyName];
  if (envKey) return { key: envKey, source: "env" };

  // secrets.json next
  const secrets = await loadSecrets();
  const key = secrets?.apiKeys?.[provider];
  return { key, source: "secrets" };
}

async function githubFetchJson(url) {
  const { key: token } = await getApiKeyWithFallback("github");
  if (!token) throw new Error("GITHUB_TOKEN not configured");

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`GitHub ${resp.status}: ${txt || url}`);
  }
  return await resp.json();
}

async function githubRequestJson(url, { method = "GET", body } = {}) {
  const { key: token } = await getApiKeyWithFallback("github");
  if (!token) throw new Error("GITHUB_TOKEN not configured");

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const txt = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${txt || url}`);
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

function sanitizeRepoPath(filePath) {
  const raw = String(filePath || "").trim().replace(/^\//, "");
  if (!raw) throw new Error("filePath is required");
  // prevent path traversal / weirdness
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "." || p.includes("\\"))) {
    throw new Error("Invalid filePath");
  }
  return raw;
}

function stripFilePathHeader(codeText) {
  const lines = String(codeText || "").split(/\r?\n/);
  let i = 0;
  while (i < Math.min(lines.length, 6) && lines[i].trim() === "") i++;
  if (
    i < lines.length &&
    /filepath:\s*/i.test(lines[i]) &&
    /^\s*(?:\/\/|#|;|--|\/\*|\*|<!--)/.test(lines[i])
  ) {
    lines.splice(i, 1);
    if (i < lines.length && lines[i].trim() === "") lines.splice(i, 1);
  }
  return lines.join("\n");
}

// NOTE: this endpoint returns PATHS ONLY (never contents), so it doesn't affect token burn.
async function fetchRepoFileListFromGitHub(repoFullName) {
  const repoJson = await githubFetchJson(`https://api.github.com/repos/${repoFullName}`);
  const branch = repoJson.default_branch;

  const treeJson = await githubFetchJson(
    `https://api.github.com/repos/${repoFullName}/git/trees/${branch}?recursive=1`
  );

  const files = (treeJson.tree || [])
    .filter((n) => n.type === "blob" && typeof n.path === "string")
    .map((n) => n.path);

  return { branch, files };
}

async function readRepoFileCache() {
  return await readJson(repoFileCachePath, {});
}

async function writeRepoFileCache(cache) {
  await writeJson(repoFileCachePath, cache);
}

/* ----------------------- prompt packing ----------------------- */

// Ensure stable ordering for OpenAI Prompt Caching
function prepareMessagesForModel(messages, options = {}) {
  const { systemPrompt, fileContents = {} } = options;

  const prepared = [];

  // IMPORTANT for caching: put the biggest stable block first.
  // We sort keys so the prefix stays identical turn-over-turn.
  const sortedPaths = Object.keys(fileContents).sort();
  if (sortedPaths.length > 0) {
    let repoContext = "ACTIVE REPOSITORY FILES:\n";
    for (const filePath of sortedPaths) {
      repoContext += `--- FILE: ${filePath} ---\n${fileContents[filePath]}\n`;
    }
    prepared.push({ role: "system", content: repoContext });
  }

  // Stable instructions next
  prepared.push({
    role: "system",
    content: systemPrompt || "You are an expert AI coding assistant.",
  });

  // Then the chat tail
  prepared.push(...messages);

  return prepared;
}

// Summarize long histories using the cheaper Fast model
async function getHistorySummary(messages, config) {
  if (messages.length < 10) return null;
  const fastModel = config.models.fast;
  if (!fastModel) return null;

  const textToSummarize = messages
    .slice(0, -6)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prompt = `Summarize the following technical conversation concisely.
Focus on current state, decisions, and any constraints. Keep it short.

${textToSummarize}`;

  let summary = "";
  try {
    for await (const chunk of streamCompletion(
      fastModel,
      "Summarize concisely.",
      [{ role: "user", content: prompt }],
      512
    )) {
      if (chunk.type === "text") summary += chunk.text;
    }
    return summary.trim() || null;
  } catch {
    return null;
  }
}

/* ----------------------- endpoints ----------------------- */

app.get("/api/projects", async (req, res) => {
  res.json(await readJson(projectsPath, []));
});

// Required by the frontend (and admin UI): returns the active runtime config
// plus a small _meta block with paths for debugging.
app.get("/api/config", async (req, res) => {
  try {
    const config = await loadConfig();

    // Provider availability is derived from initialized clients/env.
    // Do NOT include any secret values in this response.
    const providers = {
      openai: isProviderAvailable("openai"),
      anthropic: isProviderAvailable("anthropic"),
      google: isProviderAvailable("google"),
      // GitHub is considered available if a token exists (env or secrets).
      github: !!(await getApiKeyWithFallback("github")).key,
    };

    res.json({
      ...config,
      providers,
      _meta: {
        configPath: CONFIG_PATH,
        defaultConfigPath: DEFAULTS_PATH,
      },
    });
  } catch (e) {
    console.error("GET /api/config error:", e);
    res.status(500).json({ error: e.message || "Failed to load config" });
  }
});

// NEW: endpoint required by frontend
app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repoFullName = `${owner}/${repo}`;
    const refresh = String(req.query.refresh || "").toLowerCase() === "true";

    const cache = await readRepoFileCache();
    const cached = cache[repoFullName];

    const isFresh =
      cached &&
      cached.fetchedAt &&
      Date.now() - new Date(cached.fetchedAt).getTime() < REPO_FILES_TTL_MS &&
      Array.isArray(cached.files);

    if (!refresh && isFresh) {
      return res.json({
        repo: repoFullName,
        branch: cached.branch,
        files: cached.files,
        cached: true,
        fetchedAt: cached.fetchedAt,
      });
    }

    const { branch, files } = await fetchRepoFileListFromGitHub(repoFullName);

    cache[repoFullName] = {
      branch,
      files,
      fetchedAt: new Date().toISOString(),
    };
    await writeRepoFileCache(cache);

    res.json({
      repo: repoFullName,
      branch,
      files,
      cached: false,
      fetchedAt: cache[repoFullName].fetchedAt,
    });
  } catch (e) {
    console.error("GET /api/projects/:owner/:repo/files error:", e);
    res.status(500).json({ error: e.message || "Failed to load repo files" });
  }
});

app.get("/api/conversations", async (req, res) => {
  res.json(await readJson(conversationsPath, []));
});

app.patch("/api/conversations/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const conversations = await readJson(conversationsPath, []);
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return res.status(404).json({ error: "Not found" });

    convo.title = title.trim().slice(0, 120);
    convo.updatedAt = new Date().toISOString();
    await writeJson(conversationsPath, conversations);
    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/conversations/:id error:", e);
    res.status(500).json({ error: e.message || "Rename failed" });
  }
});

// Create a DRAFT PR from a single full-file code block. Never commits to the default branch.
app.post("/api/pr/create", async (req, res) => {
  try {
    const { repoFullName, conversationId, filePath, content, title } = req.body || {};
    if (!repoFullName || typeof repoFullName !== "string") {
      return res.status(400).json({ error: "repoFullName is required" });
    }
    const cleanPath = sanitizeRepoPath(filePath);
    const cleanContent = stripFilePathHeader(content);

    const repo = await githubFetchJson(`https://api.github.com/repos/${repoFullName}`);
    const baseBranch = repo.default_branch;
    if (!baseBranch) throw new Error("Could not determine default_branch");

    const baseRef = await githubFetchJson(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${baseBranch}`
    );
    const baseSha = baseRef?.object?.sha;
    if (!baseSha) throw new Error("Could not read base branch ref sha");

    const safeConvo = String(conversationId || "new")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 32);
    const branch = `ai/${safeConvo}-${Date.now().toString(36)}`;

    // Create branch
    await githubRequestJson(`https://api.github.com/repos/${repoFullName}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });

    // Build a single commit with Git Data API (blob -> tree -> commit -> ref)
    const baseCommit = await githubFetchJson(
      `https://api.github.com/repos/${repoFullName}/git/commits/${baseSha}`
    );
    const baseTreeSha = baseCommit?.tree?.sha;
    if (!baseTreeSha) throw new Error("Could not read base tree sha");

    const blob = await githubRequestJson(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      { method: "POST", body: { content: cleanContent, encoding: "utf-8" } }
    );
    if (!blob?.sha) throw new Error("Failed to create blob");

    const newTree = await githubRequestJson(
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      {
        method: "POST",
        body: {
          base_tree: baseTreeSha,
          tree: [{ path: cleanPath, mode: "100644", type: "blob", sha: blob.sha }],
        },
      }
    );
    if (!newTree?.sha) throw new Error("Failed to create tree");

    const commitMessage = (typeof title === "string" && title.trim())
      ? title.trim().slice(0, 120)
      : `AI patch: ${cleanPath}`;

    const commit = await githubRequestJson(
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      { method: "POST", body: { message: commitMessage, tree: newTree.sha, parents: [baseSha] } }
    );
    if (!commit?.sha) throw new Error("Failed to create commit");

    await githubRequestJson(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`,
      { method: "PATCH", body: { sha: commit.sha, force: false } }
    );

    const pr = await githubRequestJson(`https://api.github.com/repos/${repoFullName}/pulls`, {
      method: "POST",
      body: {
        title: commitMessage,
        head: branch,
        base: baseBranch,
        body: "Created by AI Code Helper",
        draft: true,
      },
    });
    if (!pr?.html_url) throw new Error("Failed to create PR");

    res.json({ prUrl: pr.html_url, branch, base: baseBranch, prNumber: pr.number });
  } catch (e) {
    console.error("POST /api/pr/create error:", e);
    res.status(500).json({ error: e.message || "Create PR failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride } =
    req.body;

  // SSE headers should be set before streaming output
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const config = await loadConfig();
    const conversations = await readJson(conversationsPath, []);
    let convo = conversations.find((c) => c.id === conversationId);

    if (!convo) {
      convo = {
        id: Date.now().toString(36),
        messages: [],
        createdAt: new Date().toISOString(),
      };
      conversations.push(convo);
    }

	    // Persist lightweight metadata for nicer UX
	    if (repoFullName && typeof repoFullName === "string") convo.repoFullName = repoFullName;
	    if (!convo.title && typeof message === "string" && convo.messages.length === 0) {
	      const t = message.trim();
	      if (t) convo.title = t.slice(0, 60);
	    }
	    convo.updatedAt = new Date().toISOString();

    // Smart Routing
    const route = routeMessage(message, config, loadedFiles.length > 0);
    const modelKey = modelOverride || route.modelKey;
    const modelConfig = config.models[modelKey];

    // IMPORTANT: fileContents must only include explicitly selected files.
    // Your repo file LIST is separate and should never be injected into prompts.
    const fileContents = {};
    for (const f of loadedFiles) {
      // TODO: restore your GitHub file content logic here (explicit selection only)
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
          ...convo.messages.slice(-6),
        ];
      }
    }

    convo.messages.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });

    const finalMessages = prepareMessagesForModel(convo.messages, {
      systemPrompt: config.systemPrompt,
      fileContents,
    });

    res.write(
      `data: ${JSON.stringify({
        type: "start",
        conversationId: convo.id,
        model: modelConfig.displayName,
      })}\n\n`
    );

    let fullResponse = "";
    let usage = { inputTokens: 0, outputTokens: 0 };

    // IMPORTANT: pass null here so providers don't add another system message.
    // We already packed system messages into finalMessages.
    for await (const chunk of streamCompletion(
      modelConfig,
      null,
      finalMessages,
      modelConfig.maxOutputTokens
    )) {
      if (chunk.type === "text") {
        fullResponse += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
      } else if (chunk.type === "done") {
        usage = chunk;
      }
    }

    convo.messages.push({
      role: "assistant",
      content: fullResponse,
      timestamp: new Date().toISOString(),
      model: modelConfig.displayName,
    });
    convo.updatedAt = new Date().toISOString();
    await writeJson(conversationsPath, conversations);

    const cost = calculateCost(modelConfig, usage.inputTokens, usage.outputTokens);
    res.write(
      `data: ${JSON.stringify({
        type: "done",
        cost,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })}\n\n`
    );
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
