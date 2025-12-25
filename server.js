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
  } catch {
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
    // routing “levels”
    models: {
      fast: { provider: "google", model: "gemini-1.5-flash", maxOutputTokens: 1024 },
      full: { provider: "openai", model: "gpt-4o", maxOutputTokens: 2048 },
      fallback: { provider: "anthropic", model: "claude-3-5-sonnet", maxOutputTokens: 2048 }
    },

    // optional request routing rules used by providers/router.js
    routing: {},

    // system prompt + spend caps
    systemPrompt: "",
    guardrails: { maxCost: null, maxTokens: null },

    // model options store (provider lists + timestamps)
    modelOptions: {
      openai: { lastSyncedAt: null, models: [] },
      anthropic: { lastSyncedAt: null, models: [] },
      google: { lastSyncedAt: null, models: [] }
    }
  });
}

async function saveConfig(cfg) {
  await writeJson(CONFIG_PATH, cfg);
}

async function loadSecrets() {
  // Backward compatible: older versions used adminPassword (plaintext).
  return readJson(SECRETS_PATH, {
    adminPassword: "", // legacy plaintext
    adminPasswordHash: "", // new
    adminPasswordSalt: "", // new
    keys: { openai: "", anthropic: "", google: "", github: "" }
  });
}

async function saveSecrets(secrets) {
  await writeJson(SECRETS_PATH, secrets);
}

// ------------------------------
// Admin auth (stateless signed session token)
// ------------------------------
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12; // 12h

function base64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function sessionSecret() {
  // Prefer env; otherwise derive from a stable file-based secret.
  // This keeps tokens valid across container restarts (and across replicas),
  // as long as secrets.json persists (Railway volume) OR ADMIN_SESSION_SECRET env var is set.
  return process.env.ADMIN_SESSION_SECRET || "fallback_session_secret_change_me";
}

function signPayload(payloadObj) {
  const payload = base64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let obj = null;
  try {
    obj = JSON.parse(base64urlDecode(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (!obj?.exp || typeof obj.exp !== "number") return null;
  if (Date.now() > obj.exp) return null;

  return obj;
}

function getSession(req) {
  const token = req.get("x-admin-session") || req.get("X-Admin-Session");
  if (!token) return null;
  return verifyToken(token);
}

function createSessionToken() {
  return signPayload({
    exp: Date.now() + SESSION_DURATION_MS,
    nonce: crypto.randomBytes(12).toString("hex")
  });
}

// Password hashing (scrypt)
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
async function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return Buffer.from(derived).toString("hex");
}

async function hasAdminPasswordSet() {
  const secrets = await loadSecrets();
  return !!(secrets.adminPasswordHash || secrets.adminPassword);
}

async function verifyAdminPassword(plain) {
  const secrets = await loadSecrets();

  // If new hash exists, verify against it
  if (secrets.adminPasswordHash && secrets.adminPasswordSalt) {
    const computed = await hashPassword(plain, secrets.adminPasswordSalt);
    const a = Buffer.from(computed, "hex");
    const b = Buffer.from(secrets.adminPasswordHash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // Legacy plaintext fallback
  if (secrets.adminPassword) {
    return String(plain) === String(secrets.adminPassword);
  }

  return false;
}

async function migrateLegacyPasswordIfNeeded(plain) {
  const secrets = await loadSecrets();
  if (secrets.adminPassword && !secrets.adminPasswordHash) {
    // only migrate if legacy password matches the provided one
    if (String(plain) !== String(secrets.adminPassword)) return;
    const salt = makeSalt();
    const hash = await hashPassword(plain, salt);
    secrets.adminPasswordHash = hash;
    secrets.adminPasswordSalt = salt;
    secrets.adminPassword = ""; // remove legacy
    await saveSecrets(secrets);
  }
}

async function requireAuth(req, res, next) {
  const passwordSet = await hasAdminPasswordSet();
  if (!passwordSet) return next(); // unlocked if no password set

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
  if (resp.status === 204) return null;
  return resp.json();
}

async function listUserRepos(token) {
  const url = "https://api.github.com/user/repos?per_page=100&sort=updated";
  return githubRequest(url, "GET", token);
}

async function listRepoFiles(repoFullName, token) {
  const repo = await githubRequest(`https://api.github.com/repos/${repoFullName}`, "GET", token);
  const branch = repo.default_branch || "main";
  const ref = await githubRequest(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`, "GET", token);
  const sha = ref.object?.sha;
  if (!sha) return [];
  const tree = await githubRequest(`https://api.github.com/repos/${repoFullName}/git/trees/${sha}?recursive=1`, "GET", token);
  return (tree.tree || [])
    .filter((x) => x.type === "blob")
    .map((x) => x.path)
    .filter(Boolean);
}

async function getFileSha(repoFullName, filePath, token) {
  try {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`;
    const data = await githubRequest(url, "GET", token);
    return data?.sha || null;
  } catch (e) {
    if (String(e.message || "").includes(" 404")) return null;
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
    const passwordSet = await hasAdminPasswordSet();
    const isAuthenticated = !passwordSet ? true : !!getSession(req);
    res.json({ needsPassword: !passwordSet, isAuthenticated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat
app.get("/api/admin/status", async (req, res) => {
  try {
    const passwordSet = await hasAdminPasswordSet();
    const isAuthenticated = !passwordSet ? true : !!getSession(req);
    res.json({ needsPassword: !passwordSet, isAuthenticated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/setup-password", async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const secrets = await loadSecrets();
    const passwordSet = await hasAdminPasswordSet();
    if (passwordSet) return res.status(400).json({ error: "Password already set" });

    const salt = makeSalt();
    const hash = await hashPassword(password, salt);
    secrets.adminPasswordHash = hash;
    secrets.adminPasswordSalt = salt;
    secrets.adminPassword = ""; // legacy cleared
    await saveSecrets(secrets);

    const token = createSessionToken();
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { password } = req.body || {};
    const passwordSet = await hasAdminPasswordSet();

    // If no password set, allow login (still return token)
    if (!passwordSet) {
      const token = createSessionToken();
      return res.json({ ok: true, token, noPassword: true });
    }

    if (!password) return res.status(401).json({ ok: false, error: "Invalid password" });

    const ok = await verifyAdminPassword(password);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid password" });

    // If legacy password existed, migrate it to hashed form
    await migrateLegacyPasswordIfNeeded(password);

    const token = createSessionToken();
    return res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/logout", async (req, res) => {
  // Stateless tokens cannot be revoked server-side without a denylist.
  // Frontend should clear localStorage; we return ok for UX.
  const token = req.headers["x-admin-session"] || req.headers["X-Admin-Session"] || null;
  res.json({ ok: true, token });
});

app.post("/api/admin/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const ok = await verifyAdminPassword(currentPassword || "");
    if (!(await hasAdminPasswordSet()) || !ok) {
      return res.status(401).json({ error: "Current password incorrect" });
    }

    const secrets = await loadSecrets();
    const salt = makeSalt();
    const hash = await hashPassword(newPassword, salt);
    secrets.adminPasswordHash = hash;
    secrets.adminPasswordSalt = salt;
    secrets.adminPassword = "";
    await saveSecrets(secrets);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin API keys (admin.html expects { keys: {...} })
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
      adminPassword: await hasAdminPasswordSet()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backward compat key endpoints (keep)
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

// Admin save system prompt + guardrails (these were missing)
app.post("/api/admin/system-prompt", requireAuth, async (req, res) => {
  try {
    const { systemPrompt } = req.body || {};
    const cfg = await loadConfig();
    cfg.systemPrompt = String(systemPrompt ?? "");
    await saveConfig(cfg);
    res.json({ ok: true, systemPrompt: cfg.systemPrompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/guardrails", requireAuth, async (req, res) => {
  try {
    const { maxCost, maxTokens } = req.body || {};
    const cfg = await loadConfig();
    cfg.guardrails = cfg.guardrails || { maxCost: null, maxTokens: null };
    cfg.guardrails.maxCost = maxCost === null ? null : (maxCost === undefined ? cfg.guardrails.maxCost : Number(maxCost));
    cfg.guardrails.maxTokens = maxTokens === null ? null : (maxTokens === undefined ? cfg.guardrails.maxTokens : Number(maxTokens));
    await saveConfig(cfg);
    res.json({ ok: true, guardrails: cfg.guardrails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Existing admin model config endpoints (keep)
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
// Model options API (aligned to admin.html)
// Returns: { options: ["provider:model"], selected: {fast,full,fallback} }
// ------------------------------
function modelKeyFromCfg(m) {
  if (!m?.provider || !m?.model) return "";
  return `${m.provider}:${m.model}`;
}

function flattenModelOptions(modelOptions) {
  const out = [];
  const push = (provider, models) => {
    for (const m of models || []) {
      const id = m?.id ? String(m.id) : null;
      if (!id) continue;
      out.push(`${provider}:${id}`);
    }
  };

  push("openai", modelOptions?.openai?.models);
  push("anthropic", modelOptions?.anthropic?.models);
  push("google", modelOptions?.google?.models);

  // de-dupe
  return Array.from(new Set(out)).sort();
}

app.get("/api/model-options", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();

    const options = flattenModelOptions(cfg.modelOptions || {});
    const selected = {
      fast: modelKeyFromCfg(cfg.models?.fast),
      full: modelKeyFromCfg(cfg.models?.full),
      fallback: modelKeyFromCfg(cfg.models?.fallback)
    };

    res.json({
      options,
      selected,
      lastSyncedAt: cfg.modelOptions?.openai?.lastSyncedAt || cfg.modelOptions?.anthropic?.lastSyncedAt || cfg.modelOptions?.google?.lastSyncedAt || null
    });
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

app.post("/api/model-options/sync", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    const now = new Date().toISOString();
    const existing = cfg.modelOptions || {};

    cfg.modelOptions = {
      openai: {
        lastSyncedAt: now,
        models: dedupeModels([
          ...(existing.openai?.models || []),
          { id: "gpt-5.2", label: "GPT-5.2" },
          { id: "gpt-5.2-mini", label: "GPT-5.2 Mini" },
          { id: "gpt-4o", label: "GPT-4o" }
        ])
      },
      anthropic: {
        lastSyncedAt: now,
        models: dedupeModels([
          ...(existing.anthropic?.models || []),
          { id: "claude-sonnet-4.5", label: "Sonnet 4.5" },
          { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }
        ])
      },
      google: {
        lastSyncedAt: now,
        models: dedupeModels([
          ...(existing.google?.models || []),
          { id: "gemini-3-flash", label: "Gemini 3 Flash" },
          { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" }
        ])
      }
    };

    await saveConfig(cfg);

    const options = flattenModelOptions(cfg.modelOptions);
    const selected = {
      fast: modelKeyFromCfg(cfg.models?.fast),
      full: modelKeyFromCfg(cfg.models?.full),
      fallback: modelKeyFromCfg(cfg.models?.fallback)
    };

    res.json({ ok: true, options, selected, lastSyncedAt: now });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// Model routing endpoints (fast/full/fallback selection)
// ------------------------------
app.get("/api/admin/model-routing", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json({
      fast: modelKeyFromCfg(cfg.models?.fast),
      full: modelKeyFromCfg(cfg.models?.full),
      fallback: modelKeyFromCfg(cfg.models?.fallback)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/model-routing", requireAuth, async (req, res) => {
  try {
    const { fast, full, fallback } = req.body || {};
    const cfg = await loadConfig();

    const parseModel = (str) => {
      if (!str) return null;
      const [provider, model] = String(str).split(":");
      return provider && model ? { provider, model } : null;
    };

    cfg.models = cfg.models || {};

    if (fast) {
      const parsed = parseModel(fast);
      if (parsed) cfg.models.fast = { ...parsed, maxOutputTokens: cfg.models.fast?.maxOutputTokens || 1024 };
    }
    if (full) {
      const parsed = parseModel(full);
      if (parsed) cfg.models.full = { ...parsed, maxOutputTokens: cfg.models.full?.maxOutputTokens || 2048 };
    }
    if (fallback) {
      const parsed = parseModel(fallback);
      if (parsed) cfg.models.fallback = { ...parsed, maxOutputTokens: cfg.models.fallback?.maxOutputTokens || 2048 };
    }

    await saveConfig(cfg);

    res.json({
      ok: true,
      models: cfg.models,
      selected: {
        fast: modelKeyFromCfg(cfg.models.fast),
        full: modelKeyFromCfg(cfg.models.full),
        fallback: modelKeyFromCfg(cfg.models.fallback)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------
// Stats + conversations
// ------------------------------
function countProviders(status) {
  try {
    const s = getProviderStatus(status);
    // s is typically an object keyed by provider
    return Object.keys(s || {}).length;
  } catch {
    return 0;
  }
}

async function computeTotalMessages() {
  const conversations = await readJson(conversationsPath, []);
  let total = 0;
  for (const c of conversations || []) total += (c?.messages?.length || 0);
  return total;
}

app.get("/api/stats", async (req, res) => {
  const stats = await readJson(statsPath, { totalCost: 0, requests: 0 });
  const cfg = await loadConfig();
  const options = flattenModelOptions(cfg.modelOptions || {});

  res.json({
    totalCost: stats.totalCost || 0,
    requests: stats.requests || 0,

    // fields admin.html expects:
    totalMessages: await computeTotalMessages(),
    providers: countProviders(providerStatus),
    modelsKnown: options.length
  });
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

    await writeJson(projectsPath, projects);
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// Backward compat
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
    const { message, project, conversationId, mode, chatMode } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const cfg = await loadConfig();
    const secrets = await loadSecrets();

    const conversations = await readJson(conversationsPath, []);
    let conv = null;
    if (conversationId) conv = conversations.find((c) => c.id === conversationId);

    if (!conv) {
      conv = { id: crypto.randomBytes(10).toString("hex"), createdAt: new Date().toISOString(), messages: [], project: project || "" };
      conversations.unshift(conv);
    }

    const route = routeMessage({ message, mode: mode || "", chatMode: chatMode || "" }, cfg);
    const level = route?.level || (mode === "fast" ? "fast" : "full");
    const modelConfig = cfg.models?.[level] || cfg.models?.full;

    const provider = modelConfig.provider;
    const modelName = modelConfig.model;

    res.write(`data: ${JSON.stringify({ type: "start", conversationId: conv.id, model: `${provider}:${modelName}` })}\n\n`);

    conv.messages.push({ role: "user", content: message, at: new Date().toISOString() });

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
        if (chunk.model) usedProviderModel = chunk.model;
        if (chunk.usage) computedCost = calculateCost(modelConfig, chunk.usage) || computedCost;
      }
    }

    conv.messages.push({ role: "assistant", content: fullText, at: new Date().toISOString(), model: usedProviderModel, level });

    const stats = await readJson(statsPath, { totalCost: 0, requests: 0 });
    stats.requests = (stats.requests || 0) + 1;
    stats.totalCost = (stats.totalCost || 0) + (computedCost || 0);
    await writeJson(statsPath, stats);

    await writeJson(conversationsPath, conversations.slice(0, 50));

    res.write(`data: ${JSON.stringify({ type: "done", model: usedProviderModel, cost: computedCost || 0 })}\n\n`);
    res.end();
  } catch (e) {
    try {
      res.write?.(`data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
      res.end?.();
    } catch {}
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
