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
  getProviderStatus
} from "./providers/index.js";
import { routeMessage, previewRoute } from "./providers/router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// ------------------------------
// Paths / storage
// ------------------------------
const CONFIG_PATH = path.join(__dirname, "config", "models.json");
const SECRETS_PATH = path.join(__dirname, "config", "secrets.json");
const DATA_DIR = path.join(__dirname, "data");
const conversationsPath = path.join(DATA_DIR, "conversations.json");
const projectsPath = path.join(DATA_DIR, "projects.json");
const statsPath = path.join(DATA_DIR, "stats.json");

// ------------------------------
// Provider init
// ------------------------------
let providerStatus = initializeProviders();

// ------------------------------
// Helpers: JSON read/write
// ------------------------------
async function readJson(p, fallback) {
  try {
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

// ------------------------------
// Config + secrets
// ------------------------------
async function loadConfig() {
  return readJson(CONFIG_PATH, {
    models: {
      fast: { provider: "google", model: "gemini-1.5-flash", maxOutputTokens: 1024 },
      full: { provider: "openai", model: "gpt-4o", maxOutputTokens: 2048 },
      fallback: { provider: "anthropic", model: "claude-3-5-sonnet", maxOutputTokens: 2048 }
    },
    routing: {},
    providers: {},
    templates: {},
    modelOptions: {}
  });
}

async function saveConfig(cfg) {
  await writeJson(CONFIG_PATH, cfg);
}

async function loadSecrets() {
  return readJson(SECRETS_PATH, {
    adminPassword: "",
    keys: { openai: "", anthropic: "", google: "", github: "" }
  });
}

async function saveSecrets(secrets) {
  await writeJson(SECRETS_PATH, secrets);
}

// ------------------------------
// Admin auth (simple sessions)
// ------------------------------
const adminSessions = new Map(); // token -> { expiresAt }
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12; // 12h

function createSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function getSession(req) {
  const token = req.headers["x-admin-session"];
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

async function requireAuth(req, res, next) {
  const secrets = await loadSecrets();
  // If no admin password has been set, allow access (unlocked).
  if (!secrets.adminPassword) return next();

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized", needsAuth: true });
  return next();
}

function maskKey(key) {
  if (!key) return "";
  const s = String(key);
  if (s.length <= 8) return "••••••••";
  return "••••••••••••" + s.slice(-4);
}

function resolveKeys(secrets) {
  return {
    openai: process.env.OPENAI_API_KEY || secrets?.keys?.openai || "",
    anthropic: process.env.ANTHROPIC_API_KEY || secrets?.keys?.anthropic || "",
    google: process.env.GOOGLE_API_KEY || secrets?.keys?.google || "",
    github: process.env.GITHUB_TOKEN || secrets?.keys?.github || ""
  };
}

// ------------------------------
// GitHub helpers
// ------------------------------
async function githubRequest(url, method = "GET", token, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "AI-Coding-Helper",
    Accept: "application/vnd.github+json"
  };

  const options = { method, headers };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GitHub API error ${resp.status}: ${text || resp.statusText}`);
  }
  // Some endpoints return 204
  if (resp.status === 204) return null;
  return resp.json();
}

async function listUserRepos(token) {
  // fetch up to 100 repos (paginated could be added later)
  const url = "https://api.github.com/user/repos?per_page=100&sort=updated";
  return githubRequest(url, "GET", token);
}

async function listRepoFiles(repoFullName, token) {
  // uses git trees API from default branch
  const repo = await githubRequest(`https://api.github.com/repos/${repoFullName}`, "GET", token);
  const branch = repo.default_branch || "main";
  const ref = await githubRequest(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`, "GET", token);
  const sha = ref.object?.sha;
  if (!sha) return [];
  const tree = await githubRequest(`https://api.github.com/repos/${repoFullName}/git/trees/${sha}?recursive=1`, "GET", token);
  const files = (tree.tree || [])
    .filter((x) => x.type === "blob")
    .map((x) => x.path)
    .filter(Boolean);
  return files;
}

async function getFileSha(repoFullName, filePath, token) {
  try {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;
    const data = await githubRequest(url, "GET", token);
    return data?.sha || null;
  } catch (e) {
    // If 404, treat as new file. Our githubRequest throws with message containing status.
    if (String(e.message || "").includes(" 404:")) return null;
    if (String(e.message || "").includes(" 404 ")) return null;
    return null;
  }
}

async function upsertFile(repoFullName, filePath, contentText, message, token) {
  const sha = await getFileSha(repoFullName, filePath, token);
  const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;
  const body = {
    message: message || `Update ${filePath}`,
    content: Buffer.from(String(contentText), "utf8").toString("base64")
  };
  if (sha) body.sha = sha;
  return githubRequest(url, "PUT", token, body);
}

// ------------------------------
// Middleware + static
// ------------------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ------------------------------
// Admin API (matches public/admin.html)
// ------------------------------
app.get("/api/admin/auth-status", async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const isAuthenticated = !secrets.adminPassword ? true : !!getSession(req);
    res.json({ needsPassword: !secrets.adminPassword, isAuthenticated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat: some older builds used /api/admin/status
app.get("/api/admin/status", async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const isAuthenticated = !secrets.adminPassword ? true : !!getSession(req);
    res.json({ needsPassword: !secrets.adminPassword, isAuthenticated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { password } = req.body || {};
    const secrets = await loadSecrets();

    // If no password set, allow login (setup flow uses /api/admin/setup-password)
    if (!secrets.adminPassword) {
      const token = createSessionToken();
      adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION_MS });
      return res.json({ ok: true, token, noPassword: true });
    }

    if (!password || password !== secrets.adminPassword) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }

    const token = createSessionToken();
    adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION_MS });
    return res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat: older UI posted to /admin/login
app.post("/admin/login", (req, res) => app._router.handle(req, res, () => {}));

app.post("/api/admin/logout", requireAuth, async (req, res) => {
  const token = req.headers["x-admin-session"];
  if (token) adminSessions.delete(token);
  res.json({ ok: true });
});

app.post("/api/admin/setup-password", async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const secrets = await loadSecrets();
    if (secrets.adminPassword) {
      // already set
      return res.status(400).json({ error: "Password already set" });
    }
    secrets.adminPassword = String(password);
    await saveSecrets(secrets);

    const token = createSessionToken();
    adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION_MS });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    const secrets = await loadSecrets();
    if (secrets.adminPassword && String(currentPassword || "") !== String(secrets.adminPassword)) {
      return res.status(401).json({ error: "Current password incorrect" });
    }
    secrets.adminPassword = String(newPassword);
    await saveSecrets(secrets);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API keys (matches admin.html expectation: { keys: {...} })
app.get("/api/admin/api-keys", requireAuth, async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const resolved = resolveKeys(secrets);

    res.json({
      keys: {
        openai: { hasValue: !!resolved.openai, masked: maskKey(resolved.openai), source: process.env.OPENAI_API_KEY ? "env" : "stored" },
        anthropic: { hasValue: !!resolved.anthropic, masked: maskKey(resolved.anthropic), source: process.env.ANTHROPIC_API_KEY ? "env" : "stored" },
        google: { hasValue: !!resolved.google, masked: maskKey(resolved.google), source: process.env.GOOGLE_API_KEY ? "env" : "stored" },
        github: { hasValue: !!resolved.github, masked: maskKey(resolved.github), source: process.env.GITHUB_TOKEN ? "env" : "stored" }
      },
      adminPassword: !!(await loadSecrets()).adminPassword
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat endpoints used by older code
app.get("/api/config/keys", requireAuth, async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const resolved = resolveKeys(secrets);
    res.json({
      openai: { hasValue: !!resolved.openai, masked: maskKey(resolved.openai) },
      anthropic: { hasValue: !!resolved.anthropic, masked: maskKey(resolved.anthropic) },
      google: { hasValue: !!resolved.google, masked: maskKey(resolved.google) },
      github: { hasValue: !!resolved.github, masked: maskKey(resolved.github) }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/config/keys", requireAuth, async (req, res) => {
  try {
    const { provider, key } = req.body || {};
    if (!provider) return res.status(400).json({ error: "provider required" });

    const secrets = await loadSecrets();
    secrets.keys = secrets.keys || {};
    secrets.keys[provider] = key || "";
    await saveSecrets(secrets);

    providerStatus = await reloadProviders({
      openaiApiKey: process.env.OPENAI_API_KEY || secrets.keys.openai || "",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || secrets.keys.anthropic || "",
      googleApiKey: process.env.GOOGLE_API_KEY || secrets.keys.google || ""
    });

    res.json({ ok: true, providerStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// Config API (matches UI: /api/config)
// ------------------------------
app.get("/api/config", async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Existing admin model config endpoints (keep, but align)
app.get("/api/config/models", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(cfg.models || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/config/models", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    cfg.models = req.body?.models || cfg.models;
    await saveConfig(cfg);
    res.json({ ok: true, models: cfg.models });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// Model options API (matches admin.html)
// Does NOT auto-switch models; only maintains selectable lists.
// ------------------------------
app.get("/api/model-options", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(cfg.modelOptions || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Minimal sync: adds a few known models to the list and timestamps.
// You can extend this later to call providers' "list models" APIs.
app.post("/api/model-options/sync", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    const now = new Date().toISOString();
    const existing = cfg.modelOptions || {};

    const merged = {
      openai: {
        lastSyncedAt: now,
        models: dedupeModels([...(existing.openai?.models || []), 
          { id: "gpt-5.2", label: "GPT-5.2" },
          { id: "gpt-5.2-mini", label: "GPT-5.2 Mini" },
          { id: "gpt-4o", label: "GPT-4o" }
        ])
      },
      anthropic: {
        lastSyncedAt: now,
        models: dedupeModels([...(existing.anthropic?.models || []),
          { id: "claude-sonnet-4.5", label: "Sonnet 4.5" },
          { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }
        ])
      },
      google: {
        lastSyncedAt: now,
        models: dedupeModels([...(existing.google?.models || []),
          { id: "gemini-3-flash", label: "Gemini 3 Flash" },
          { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" }
        ])
      }
    };

    cfg.modelOptions = merged;
    await saveConfig(cfg);

    res.json({ ok: true, modelOptions: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function dedupeModels(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr || []) {
    if (!m || !m.id) continue;
    const id = String(m.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label || id });
  }
  return out;
}

// ------------------------------
// Stats + conversations
// ------------------------------
app.get("/api/stats", async (req, res) => {
  const stats = await readJson(statsPath, { totalCost: 0, requests: 0 });
  res.json(stats);
});

app.post("/api/stats/reset", requireAuth, async (req, res) => {
  await writeJson(statsPath, { totalCost: 0, requests: 0 });
  res.json({ ok: true });
});

app.get("/api/conversations", async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  res.json(conversations);
});

// ------------------------------
// Projects (GitHub) API (matches UI)
// ------------------------------
app.get("/api/projects", async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const token = process.env.GITHUB_TOKEN || secrets?.keys?.github;
    if (!token) return res.status(400).json({ error: "Missing GitHub token. Set GITHUB_TOKEN or configure in Admin." });

    const repos = await listUserRepos(token);
    const projects = (repos || []).map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner?.login,
      private: !!r.private,
      updatedAt: r.updated_at
    }));

    // cache to data/projects.json for convenience (optional)
    await writeJson(projectsPath, projects);

    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UI expects /api/projects/:owner/:repo/files
app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const token = process.env.GITHUB_TOKEN || secrets?.keys?.github;
    if (!token) return res.status(400).json({ error: "Missing GitHub token. Set GITHUB_TOKEN or configure in Admin." });

    const repoFullName = `${req.params.owner}/${req.params.repo}`;
    const files = await listRepoFiles(repoFullName, token);
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat: older server used /api/repos/:owner/:repo/files
app.get("/api/repos/:owner/:repo/files", async (req, res) => {
  req.url = `/api/projects/${req.params.owner}/${req.params.repo}/files`;
  return app._router.handle(req, res, () => {});
});

// Apply change (commit file) used by UI
app.post("/api/apply-change", async (req, res) => {
  try {
    const { repoFullName, filePath, newContent, commitMessage } = req.body || {};
    if (!repoFullName || !filePath || newContent === undefined) {
      return res.status(400).json({ error: "repoFullName, filePath, newContent required" });
    }

    const secrets = await loadSecrets();
    const token = process.env.GITHUB_TOKEN || secrets?.keys?.github;
    if (!token) return res.status(400).json({ error: "Missing GitHub token. Set GITHUB_TOKEN or configure in Admin." });

    const result = await upsertFile(repoFullName, filePath, newContent, commitMessage, token);
    res.json({
      ok: true,
      path: result?.content?.path || filePath,
      commitSha: result?.commit?.sha || null,
      commitUrl: result?.commit?.html_url || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// Chat API (SSE-like streaming over fetch body)
// ------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const {
      message,
      project,
      filePaths = [],
      loadedFiles = [],
      conversationId,
      mode, // UI passes modelOverride into "mode" currently
      chatMode
    } = req.body || {};

    if (!message) return res.status(400).json({ error: "message required" });

    // Prepare SSE-ish response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const cfg = await loadConfig();
    const secrets = await loadSecrets();

    // Track conversations
    const conversations = await readJson(conversationsPath, []);
    let conv = null;
    if (conversationId) conv = conversations.find((c) => c.id === conversationId);

    if (!conv) {
      conv = { id: crypto.randomBytes(10).toString("hex"), createdAt: new Date().toISOString(), messages: [], project: project || "" };
      conversations.unshift(conv);
    }

    // Determine route (fast/full/fallback) using router logic if present
    const route = routeMessage({ message, mode: mode || "", chatMode: chatMode || "" }, cfg);
    // route expected: { level: 'fast'|'full'|'fallback', reason, provider, model }
    const level = route?.level || (mode === "fast" ? "fast" : "full");
    const modelConfig = cfg.models?.[level] || cfg.models?.full;

    // Provider availability checks
    const provider = modelConfig.provider;
    const modelName = modelConfig.model;

    // Emit start
    res.write(`data: ${JSON.stringify({ type: "start", conversationId: conv.id, model: `${provider}:${modelName}` })}\n\n`);

    // Append user message
    conv.messages.push({ role: "user", content: message, at: new Date().toISOString() });

    // Stream completion
    let fullText = "";
    let usedProviderModel = `${provider}:${modelName}`;
    let computedCost = 0;

    const providerOk = isProviderAvailable(providerStatus, provider);
    if (!providerOk) {
      res.write(`data: ${JSON.stringify({ type: "error", error: `Provider ${provider} not configured` })}\n\n`);
      res.end();
      return;
    }

    for await (const chunk of streamCompletion(
      modelConfig,
      { ...resolveKeys(secrets) },
      conv.messages,
      modelConfig.maxOutputTokens || 2048
    )) {
      if (chunk?.type === "text") {
        fullText += chunk.text || "";
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text || "" })}\n\n`);
      } else if (chunk?.type === "meta") {
        // optional metadata from providers
        if (chunk.model) usedProviderModel = chunk.model;
        if (chunk.usage) {
          computedCost = calculateCost(modelConfig, chunk.usage) || computedCost;
        }
      }
    }

    // Save assistant message
    conv.messages.push({ role: "assistant", content: fullText, at: new Date().toISOString(), model: usedProviderModel, level });

    // Stats
    const stats = await readJson(statsPath, { totalCost: 0, requests: 0 });
    stats.requests = (stats.requests || 0) + 1;
    stats.totalCost = (stats.totalCost || 0) + (computedCost || 0);
    await writeJson(statsPath, stats);

    // Persist conversations
    await writeJson(conversationsPath, conversations.slice(0, 50));

    res.write(`data: ${JSON.stringify({ type: "done", model: usedProviderModel, cost: computedCost || 0 })}\n\n`);
    res.end();
  } catch (e) {
    try {
      // if already streaming, emit error event
      // otherwise just 500
      res.write?.(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
      res.end?.();
    } catch (_) {}
  }
});

// Preview route helper (used by UI)
app.post("/api/preview-route", async (req, res) => {
  try {
    const cfg = await loadConfig();
    const result = previewRoute(req.body || {}, cfg);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check (Railway)
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Provider status:", getProviderStatus(providerStatus));
});
