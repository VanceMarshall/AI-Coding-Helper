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

const projectsPath = path.join(DATA_DIR, "projects.json");

// NEW: pinned projects defaults (bundled) + GitHub projects cache
const pinnedProjectsPath = path.join(ROOT_DIR, "pinnedProjects.json");
const projectsCachePath = path.join(DATA_DIR, "projectsCache.json");
const PROJECTS_TTL_MS = 1000 * 60 * 10; // 10 minutes

// NEW: cache for repo file lists (paths only)
const repoFileCachePath = path.join(DATA_DIR, "repoFileCache.json");
const REPO_FILES_TTL_MS = 1000 * 60 * 30; // 30 minutes


// Chat safety + cost controls
const MAX_FILES_PER_CHAT = parseInt(process.env.MAX_FILES_PER_CHAT || '8', 10);
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || String(60 * 1024), 10); // 60KB per file
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || '24', 10); // hard cap on messages sent to the model
const SUMMARY_TAIL_MESSAGES = parseInt(process.env.SUMMARY_TAIL_MESSAGES || '6', 10); // keep last N after summarizing

// In-memory cache for GitHub file blobs (reduces GitHub API calls, not token usage)
const fileContentMemCache = new Map();

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
  const defaults = await readJson(path.join(__dirname, "config", "models.json"), {});
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

async function githubFetchAllPages(urlBase) {
  const out = [];
  let page = 1;
  while (true) {
    const u = new URL(urlBase);
    if (!u.searchParams.get("per_page")) u.searchParams.set("per_page", "100");
    u.searchParams.set("page", String(page));

    const data = await githubFetchJson(u.toString());
    if (!Array.isArray(data)) break;

    out.push(...data);
    if (data.length < 100) break;

    page += 1;
    if (page > 50) break; // safety
  }
  return out;
}



function encodeGitHubPath(p) {
  return String(p)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function isSafeRepoPath(p) {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  if (p.includes("\u0000")) return false;

  const parts = p.split("/");
  // Disallow empty segments and path traversal.
  if (parts.some((seg) => !seg || seg === "..")) return false;
  return true;
}

async function githubRequest(url, { method = "GET", body } = {}) {
  const { key: token } = await getApiKeyWithFallback("github");
  if (!token) throw new Error("GitHub token missing. Set GITHUB_TOKEN in Railway variables.");

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return fetch(url, init);
}

async function githubJsonAllow404(url) {
  const resp = await githubRequest(url);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`GitHub ${resp.status}: ${txt || url}`);
  }
  return resp.json();
}

async function getRepoDefaultBranch(repoFullName) {
  const cache = await readRepoFileCache();
  const cached = cache[repoFullName];
  if (cached && cached.branch) return cached.branch;
  const repoJson = await githubFetchJson(`https://api.github.com/repos/${repoFullName}`);
  return repoJson.default_branch || "main";
}

async function getFileContentFromGitHub(repoFullName, filePath, ref) {
  if (!repoFullName) throw new Error("repoFullName is required");
  if (!isSafeRepoPath(filePath)) throw new Error("Invalid file path");

  const key = `${repoFullName}@${ref || "default"}:${filePath}`;
  const cached = fileContentMemCache.get(key);
  if (cached) return cached;

  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeGitHubPath(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const json = await githubFetchJson(url);

  if (Array.isArray(json)) {
    const result = { skipped: true, reason: "Path is a directory" };
    fileContentMemCache.set(key, result);
    return result;
  }

  let buf = null;
  if (json && json.encoding === "base64" && typeof json.content === "string") {
    buf = Buffer.from(String(json.content).replace(/\n/g, ""), "base64");
  } else if (json && json.sha) {
    const blob = await githubFetchJson(`https://api.github.com/repos/${repoFullName}/git/blobs/${json.sha}`);
    if (blob && typeof blob.content === "string") {
      buf = Buffer.from(String(blob.content).replace(/\n/g, ""), "base64");
    }
  }

  if (!buf) {
    const result = { skipped: true, reason: "No file content returned by GitHub API" };
    fileContentMemCache.set(key, result);
    return result;
  }

  if (buf.length > MAX_FILE_BYTES) {
    const result = { skipped: true, reason: `File too large (${buf.length} bytes > ${MAX_FILE_BYTES})` };
    fileContentMemCache.set(key, result);
    return result;
  }

  const text = buf.toString("utf8");
  if (text.includes("\u0000")) {
    const result = { skipped: true, reason: "Binary file" };
    fileContentMemCache.set(key, result);
    return result;
  }

  const result = { skipped: false, content: text };
  fileContentMemCache.set(key, result);
  return result;
}


function mergePinnedProjects(pinnedNames, projects) {
  const byFullName = new Map();
  for (const p of projects || []) {
    if (p && p.fullName) byFullName.set(p.fullName, p);
  }

  const out = [];
  const seen = new Set();

  for (const name of pinnedNames || []) {
    if (!name || typeof name !== "string") continue;
    const fullName = name.trim();
    if (!fullName || seen.has(fullName)) continue;
    seen.add(fullName);
    out.push(byFullName.get(fullName) || { fullName });
  }

  for (const p of projects || []) {
    if (!p || !p.fullName) continue;
    if (seen.has(p.fullName)) continue;
    seen.add(p.fullName);
    out.push(p);
  }

  return out;
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

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function resolveModelKey(modelOverride, routedModelKey, config) {
  const override = (modelOverride || '').toString().trim().toLowerCase();
  if (!override || override === 'auto') return routedModelKey;
  if (override === 'fast' || override === 'full') return override;
  if (config?.models && config.models[override]) return override;
  return routedModelKey;
}

function compactMessagesForModel(messages, maxMessages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= maxMessages) return messages;
  const out = [];
  // Preserve the leading conversation summary system message, if present.
  if (messages[0]?.role === 'system' && typeof messages[0].content === 'string' && messages[0].content.startsWith('Conversation Summary:')) {
    out.push(messages[0]);
  }
  const remainingSlots = Math.max(0, maxMessages - out.length);
  if (remainingSlots === 0) return out;
  out.push(...messages.slice(-remainingSlots));
  return out;
}

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

// Frontend expects this endpoint to exist and return JSON.
// If it's missing, the browser receives HTML (often index.html) and JSON parsing fails
// with: "Unexpected token '<'".
app.get("/api/config", async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(cfg);
  } catch (e) {
    console.error("GET /api/config error:", e);
    res.status(500).json({ error: "Failed to load config" });
  }
});

app.get("/api/projects", async (req, res) => {
  try {
    const refresh = String(req.query.refresh || "").toLowerCase() === "true";

    // Pinned projects: from runtime DATA_DIR/projects.json (optional) and bundled pinnedProjects.json
    const runtimePinned = await readJson(projectsPath, []);
    const bundledPinned = await readJson(pinnedProjectsPath, { pinned: [] });

    const pinnedNames = [];
    const addPinned = (v) => {
      if (!v) return;
      if (typeof v === "string") pinnedNames.push(v);
      else if (typeof v === "object" && typeof v.fullName === "string") pinnedNames.push(v.fullName);
    };

    if (Array.isArray(bundledPinned?.pinned)) bundledPinned.pinned.forEach(addPinned);
    if (Array.isArray(runtimePinned)) runtimePinned.forEach(addPinned);

    // Cache (to avoid rate limits)
    const cached = await readJson(projectsCachePath, null);
    const isFresh =
      cached &&
      cached.fetchedAt &&
      Date.now() - new Date(cached.fetchedAt).getTime() < PROJECTS_TTL_MS &&
      Array.isArray(cached.projects);

    if (!refresh && isFresh) {
      return res.json(mergePinnedProjects(pinnedNames, cached.projects));
    }

    // If no token, fall back to pinned only
    const { key: token } = await getApiKeyWithFallback("github");
    if (!token) {
      return res.json(mergePinnedProjects(pinnedNames, []));
    }

    // Fetch ALL repos user has access to (pagination)
    const repos = await githubFetchAllPages(
      "https://api.github.com/user/repos?sort=updated&direction=desc&affiliation=owner,collaborator,organization_member"
    );

    const projects = [];
    const seen = new Set();
    for (const r of repos) {
      const fullName = r?.full_name;
      if (!fullName || seen.has(fullName)) continue;
      seen.add(fullName);
      projects.push({
        fullName,
        private: !!r.private,
        defaultBranch: r.default_branch,
        description: r.description || "",
        updatedAt: r.updated_at || "",
      });
    }

    await writeJson(projectsCachePath, {
      fetchedAt: new Date().toISOString(),
      projects,
    });

    return res.json(mergePinnedProjects(pinnedNames, projects));
  } catch (e) {
    console.error("GET /api/projects error:", e);
    // Safe fallback: return runtime pinned list only
    return res.json(await readJson(projectsPath, []));
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
    const conversations = await readJson(conversationsPath, []);
    const convo = conversations.find((c) => c.id === req.params.id);

    if (!convo) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const title = (req.body?.title || "").toString().trim();
    convo.title = title.slice(0, 120);
    convo.updatedAt = new Date().toISOString();

    await writeJson(conversationsPath, conversations);
    res.json(convo);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update conversation" });
  }
});

app.post("/api/pr/create", async (req, res) => {
  try {
    const { repoFullName, conversationId, filePath, content, title, body, draft } =
      req.body || {};

    if (!repoFullName || typeof repoFullName !== "string") {
      return res.status(400).json({ error: "repoFullName is required" });
    }
    if (!filePath || typeof filePath !== "string" || !isSafeRepoPath(filePath)) {
      return res.status(400).json({ error: "A valid filePath is required" });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content is required" });
    }

    // Get repo info
    const repo = await githubFetchJson(`https://api.github.com/repos/${repoFullName}`);
    const base = repo.default_branch || "main";

    // Create a branch from base
    const baseRef = await githubFetchJson(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(base)}`
    );

    const safeId = (conversationId || "chat")
      .toString()
      .replace(/[^a-zA-Z0-9\-_]/g, "")
      .slice(0, 24);
    const branch = `ai/${safeId}-${Date.now().toString(36)}`;

    const refResp = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/git/refs`,
      { method: "POST", body: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha } }
    );
    if (!refResp.ok) {
      const txt = await refResp.text().catch(() => "");
      return res
        .status(refResp.status)
        .json({ error: `Failed to create branch: ${txt || refResp.status}` });
    }

    // Update the file on the new branch via the contents API
    const existing = await githubJsonAllow404(
      `https://api.github.com/repos/${repoFullName}/contents/${encodeGitHubPath(filePath)}?ref=${encodeURIComponent(base)}`
    );

    const putBody = {
      message: `AI update: ${filePath}`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
    };
    if (existing?.sha) putBody.sha = existing.sha;

    const putResp = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/contents/${encodeGitHubPath(filePath)}`,
      { method: "PUT", body: putBody }
    );
    if (!putResp.ok) {
      const txt = await putResp.text().catch(() => "");
      return res
        .status(putResp.status)
        .json({ error: `Failed to commit file: ${txt || putResp.status}` });
    }

    // Create a (draft) PR
    const prTitle = (title || `AI update: ${filePath}`).toString().slice(0, 140);
    const prBody = (body || "").toString();

    const prResp = await githubRequest(
      `https://api.github.com/repos/${repoFullName}/pulls`,
      {
        method: "POST",
        body: {
          title: prTitle,
          head: branch,
          base,
          body: prBody,
          draft: draft !== false,
        },
      }
    );

    if (!prResp.ok) {
      const txt = await prResp.text().catch(() => "");
      return res
        .status(prResp.status)
        .json({ error: `Failed to create PR: ${txt || prResp.status}` });
    }

    const pr = await prResp.json();
    res.json({ url: pr.html_url, branch, base });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to create PR" });
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


    // Smart Routing
    const route = routeMessage(message, config, Array.isArray(loadedFiles) && loadedFiles.length > 0);
    const modelKey = resolveModelKey(modelOverride, route.modelKey, config);
    const modelConfig = config.models[modelKey];

    if (!modelConfig) {
      throw new Error(`Unknown model key: ${modelKey}`);
    }

    // Persist repo selection on the conversation (helps follow-up chats)
    if (repoFullName) convo.repoFullName = repoFullName;

    // Give new conversations a default title from the first user message
    if (!convo.title && typeof message === "string") {
      const t = message.trim().replace(/\s+/g, " ").slice(0, 60);
      convo.title = t || "New Chat";
    }

    // Load selected file contents from GitHub (explicit selection only)
    const fileContents = {};
    const skippedFiles = [];
    const safeLoadedFiles = Array.isArray(loadedFiles)
      ? loadedFiles.filter((f) => typeof f === "string" && f.trim())
      : [];

    const limitedFiles = safeLoadedFiles.slice(0, MAX_FILES_PER_CHAT);

    if (limitedFiles.length > 0 && repoFullName) {
      const ref = await getRepoDefaultBranch(repoFullName);

      for (const f of limitedFiles) {
        try {
          const r = await getFileContentFromGitHub(repoFullName, f, ref);
          if (r.skipped) skippedFiles.push({ path: f, reason: r.reason || "Skipped" });
          else fileContents[f] = r.content;
        } catch (e) {
          skippedFiles.push({ path: f, reason: e.message || "Failed to read file" });
        }
      }
    } else if (limitedFiles.length > 0 && !repoFullName) {
      for (const f of limitedFiles) {
        skippedFiles.push({ path: f, reason: "No repo selected" });
      }
    }

    // Compaction: summarize older messages when big, then enforce a hard cap
    const summaryThreshold = Number.isFinite(modelConfig.summarizationThreshold)
      ? modelConfig.summarizationThreshold
      : 40000;

    const currentEstTokens = estimateTokens(JSON.stringify(convo.messages));

    if (currentEstTokens > summaryThreshold && convo.messages.length > SUMMARY_TAIL_MESSAGES * 2) {
      const summary = await getHistorySummary(convo.messages, config);
      if (summary) {
        const tail = convo.messages.slice(-SUMMARY_TAIL_MESSAGES * 2);
        convo.messages = [{ role: "system", content: "Conversation Summary: " + summary }, ...tail];
      }
    }

    // Always cap the number of messages we keep to control token usage.
    if (convo.messages.length > MAX_HISTORY_MESSAGES) {
      const hasSummary =
        convo.messages[0]?.role === "system" &&
        typeof convo.messages[0]?.content === "string" &&
        convo.messages[0].content.startsWith("Conversation Summary:");

      const keep = MAX_HISTORY_MESSAGES - (hasSummary ? 1 : 0);
      const tail = convo.messages.slice(-keep);
      convo.messages = hasSummary ? [convo.messages[0], ...tail] : tail;
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
