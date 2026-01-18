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

  // Deep-merge known nested sections so partial runtime overrides don't wipe defaults.
  const merged = { ...defaults, ...runtime };
  const defaultModels = defaults.models || {};
  const runtimeModels = runtime.models || {};
  const modelKeys = new Set([...Object.keys(defaultModels), ...Object.keys(runtimeModels)]);
  const mergedModels = {};
  for (const k of modelKeys) {
    mergedModels[k] = { ...(defaultModels[k] || {}), ...(runtimeModels[k] || {}) };
  }
  merged.models = mergedModels;
  merged.routing = { ...(defaults.routing || {}), ...(runtime.routing || {}) };
  merged.routing.thresholds = {
    ...((defaults.routing || {}).thresholds || {}),
    ...((runtime.routing || {}).thresholds || {}),
  };

  return merged;
}

function resolveModelKey(modelOverride, routedModelKey, config) {
  const models = config?.models || {};
  const override = String(modelOverride || "").toLowerCase().trim();

  // Frontend sends mode values: auto | fast | full.
  // Only accept overrides that correspond to a configured model key.
  if (override && override !== "auto" && models[override]) return override;

  // Use router result when available.
  if (routedModelKey && models[routedModelKey]) return routedModelKey;

  // Last-resort fallbacks.
  if (models.full) return "full";
  if (models.fast) return "fast";
  if (models.fallback) return "fallback";

  const first = Object.keys(models)[0];
  return first || null;
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



async function githubRequestJson(url, options = {}) {
  const { key: token } = await getApiKeyWithFallback("github");
  if (!token) throw new Error("GITHUB_TOKEN not configured");

  const method = (options.method || "GET").toUpperCase();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  let body = options.body;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const resp = await fetch(url, { method, headers, body });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const msg = txt ? txt.slice(0, 800) : url;
    const err = new Error(`GitHub ${resp.status}: ${msg}`);
    err.status = resp.status;
    throw err;
  }

  // Some GitHub endpoints can return 204 No Content.
  if (resp.status == 204) return null;
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



function sanitizeRepoPath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new Error("filePath is required");
  }

  let s = inputPath.trim();
  // allow simple prefixes like "filepath: ..."
  s = s.replace(/^\s*filepath\s*:\s*/i, "");
  s = s.replace(/^\s*file\s*:\s*/i, "");

  // normalize Windows separators and remove leading ./ or /
  s = s.replace(/\\/g, "/");
  while (s.startsWith("/")) s = s.slice(1);
  while (s.startsWith("./")) s = s.slice(2);

  const parts = s.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("filePath is required");
  if (parts.some((p) => p === "." || p === "..")) {
    throw new Error("Invalid filePath (path traversal)");
  }

  const clean = parts.join("/");
  if (clean.length > 400) throw new Error("filePath too long");
  if (clean === ".git" || clean.startsWith(".git/") || clean.includes("/.git/")) {
    throw new Error("Invalid filePath (.git not allowed)");
  }

  return clean;
}

function stripFilePathHeader(content) {
  if (typeof content !== "string") return "";

  // Normalize newlines, then drop a first-line filepath header if present.
  const lines = content.replace(/\r?\n/g, "\n").split("\n");
  if (lines.length === 0) return "";

  const first = lines[0] || "";
  const headerRe = /^\s*(?:\/\/|#|;|--)?\s*filepath\s*:/i;
  if (headerRe.test(first)) {
    lines.shift();
    if (lines[0] === "") lines.shift();
  }

  return lines.join("\n");
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

// --- GitHub file content (explicit selection only) ---
// Safety: we only fetch the contents of files the user explicitly selected in the UI.
// We never send the whole repo tree to the model.
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 250000); // ~250 KB
const MAX_FILES_PER_CHAT = Number(process.env.MAX_FILES_PER_CHAT || 20);

function encodeGitHubPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

async function githubFetchRawText(url) {
  const { key: token } = await getApiKeyWithFallback('github');
  if (!token) throw new Error('GITHUB_TOKEN not configured');

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
    },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status}: ${txt || url}`);
  }

  // NOTE: GitHub returns raw bytes; we treat it as UTF-8 text.
  return await resp.text();
}

async function getRepoDefaultBranch(repoFullName) {
  try {
    const cache = await readRepoFileCache();
    const cached = cache?.[repoFullName];
    if (cached?.branch) return cached.branch;
  } catch {}

  const repoJson = await githubFetchJson(`https://api.github.com/repos/${repoFullName}`);
  return repoJson?.default_branch || 'main';
}

async function getFileContentFromGitHub(repoFullName, filePath) {
  if (!repoFullName) throw new Error('No repo selected');
  const cleanPath = sanitizeRepoPath(filePath);

  const branch = await getRepoDefaultBranch(repoFullName);
  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeGitHubPath(cleanPath)}?ref=${encodeURIComponent(branch)}`;

  const content = await githubFetchRawText(url);

  // Guard against binary files
  if (content && content.indexOf('\u0000') !== -1) {
    throw new Error(`File appears to be binary: ${cleanPath}`);
  }

  const bytes = Buffer.byteLength(content || '', 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`File too large (${bytes} bytes). Max is ${MAX_FILE_BYTES} bytes.`);
  }

  return content;
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

// Fetch the CONTENTS of a single repo file (for UI preview / "open file" flows).
// This is still explicit-selection only; we never enumerate or inject the full repo.
app.get("/api/projects/:owner/:repo/file", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const repoFullName = `${owner}/${repo}`;
    const filePath = String(req.query.path || '').trim();
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    const cleanPath = sanitizeRepoPath(filePath);
    const content = await getFileContentFromGitHub(repoFullName, cleanPath);
    res.json({ repo: repoFullName, path: cleanPath, content });
  } catch (e) {
    console.error('GET /api/projects/:owner/:repo/file error:', e);
    res.status(500).json({ error: e.message || 'Failed to load file' });
  }
});


app.get("/api/conversations", async (req, res) => {
  res.json(await readJson(conversationsPath, []));
});

app.patch("/api/conversations/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { title } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const conversations = await readJson(conversationsPath, []);
    const convo = conversations.find((c) => c.id === id);
    if (!convo) return res.status(404).json({ error: "Conversation not found" });

    convo.title = title.trim().slice(0, 80);
    convo.updatedAt = new Date().toISOString();
    await writeJson(conversationsPath, conversations);
    res.json({ ok: true });
  } catch (e) {
    console.error("PATCH /api/conversations/:id error:", e);
    res.status(500).json({ error: "Failed to rename conversation" });
  }
});



// Create a DRAFT PR from a single full-file code block. Never commits to the default branch.
app.post("/api/pr/create", async (req, res) => {
  try {
    const { repoFullName, conversationId, filePath, content, title } = req.body || {};

    if (!repoFullName || typeof repoFullName !== "string") {
      return res.status(400).json({ error: "repoFullName is required" });
    }
    if (!filePath || typeof filePath !== "string") {
      return res.status(400).json({ error: "filePath is required" });
    }

    const cleanPath = sanitizeRepoPath(filePath);
    const cleanContent = stripFilePathHeader(typeof content === "string" ? content : "");

    if (!cleanContent.trim()) {
      return res.status(400).json({ error: "content is required" });
    }
    if (cleanContent.length > 1_500_000) {
      return res.status(400).json({ error: "content too large" });
    }

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

    // Create a branch name and retry if collision
    let branch = `ai/${safeConvo}-${Date.now().toString(36)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await githubRequestJson(`https://api.github.com/repos/${repoFullName}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${branch}`, sha: baseSha },
        });
        break;
      } catch (e) {
        if (attempt === 2 || e?.status !== 422) throw e;
        branch = `ai/${safeConvo}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }

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
        title: (typeof message === 'string' && message.trim() ? message.trim().slice(0, 60) : 'Chat'),
        repoFullName: repoFullName || '',
        messages: [],
        createdAt: new Date().toISOString(),
      };
      conversations.push(convo);
    }

    if (repoFullName) convo.repoFullName = repoFullName;

    // Smart Routing
    const route = routeMessage(message, config, loadedFiles.length > 0);
    const modelKey = resolveModelKey(modelOverride, route.modelKey, config);
    const modelConfig = modelKey ? (config.models || {})[modelKey] : null;
    if (!modelConfig) {
      throw new Error(
        `No model configured for key '${modelKey || "(none)"}'. Check DATA_DIR/models.json or config/config/models.json.`
      );
    }

    // IMPORTANT: fileContents must only include explicitly selected files.
    // Your repo file LIST is separate and should never be injected into prompts.
    const fileContents = {};
    const selectedFiles = Array.isArray(loadedFiles)
      ? loadedFiles.filter((x) => typeof x === "string" && x.trim())
      : [];

    // Deterministic order + safety caps
    const unique = [];
    const seen = new Set();
    for (const f of selectedFiles) {
      const k = f.trim();
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(k);
    }
    unique.sort();

    const limited = unique.slice(0, MAX_FILES_PER_CHAT);
    for (const f of limited) {
      try {
        fileContents[f] = await getFileContentFromGitHub(repoFullName, f);
      } catch (e) {
        // We skip unreadable/too-large files rather than failing the whole chat.
        // (The user can select fewer files or smaller files.)
        console.warn(`Skipping file '${f}':`, e?.message || e);
      }
    }

    // Compaction: If history is too long, summarize it
    const summaryThreshold = modelConfig?.summarizationThreshold ?? config.models?.full?.summarizationThreshold ?? 40000;
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
        model: modelConfig?.displayName || modelKey || "(unknown)",
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
      model: modelConfig?.displayName || modelKey || "(unknown)",
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
