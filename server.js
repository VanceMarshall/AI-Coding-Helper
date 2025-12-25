import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import { router as providerRouter } from "./config/providers/router.js";
import { loadModelsConfig, saveModelsConfig, mergeModelOptions } from "./config/providers/index.js";

// ------------------------------
// Paths + App Setup
// ------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");
const conversationsPath = path.join(DATA_DIR, "conversations.json");
const ideasPath = path.join(DATA_DIR, "ideasStore.json");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------
// Helpers
// ------------------------------

function createId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, defaultValue) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return "••••••••••••" + key.slice(-4);
}

// ------------------------------
// Secrets + Admin Auth
// ------------------------------

const adminSessions = new Map();

async function loadSecrets() {
  await ensureDataDir();
  return await readJson(SECRETS_PATH, {
    adminPassword: "",
    keys: {
      openai: "",
      anthropic: "",
      google: "",
      github: ""
    }
  });
}

async function saveSecrets(secrets) {
  await writeJson(SECRETS_PATH, secrets);
}

async function getApiKeyWithFallback(providerName) {
  const secrets = await loadSecrets();

  const envMap = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    github: process.env.GITHUB_TOKEN
  };

  const env = envMap[providerName] || "";
  const stored = secrets?.keys?.[providerName] || "";

  return {
    key: env || stored || "",
    source: env ? "env" : stored ? "stored" : "missing"
  };
}

async function requireAdminAuth(req, res, next) {
  const secrets = await loadSecrets();
  if (!secrets.adminPassword) return next();

  const sessionToken = req.headers["x-admin-session"];
  if (!sessionToken) return res.status(401).json({ error: "Authentication required", needsAuth: true });

  const session = adminSessions.get(sessionToken);
  if (!session || session.expires < Date.now()) {
    adminSessions.delete(sessionToken);
    return res.status(401).json({ error: "Session expired", needsAuth: true });
  }

  next();
}

// ------------------------------
// Providers wiring
// ------------------------------

providerRouter.setKeyResolver(async (provider) => {
  const { key } = await getApiKeyWithFallback(provider);
  return key;
});

providerRouter.setModelsConfigLoader(async () => {
  await ensureDataDir();
  return await loadModelsConfig(path.join(__dirname, "config", "models.json"));
});

providerRouter.setModelsConfigSaver(async (config) => {
  await ensureDataDir();
  return await saveModelsConfig(path.join(__dirname, "config", "models.json"), config);
});

// ------------------------------
// Utilities
// ------------------------------

function extractCodeBlocks(text) {
  const codeBlocks = [];
  if (!text) return codeBlocks;

  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    codeBlocks.push({
      language: match[1] || "",
      code: match[2] || "",
      id: createId()
    });
  }
  return codeBlocks;
}

// ------------------------------
// Middleware + Static
// ------------------------------

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Serve admin panel at /admin (so /admin works, not just /admin.html)
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/admin/", (req, res) => res.redirect(302, "/admin"));

// ------------------------------
// GitHub Repos (UI "Projects" dropdown)
// Frontend expects array items with { fullName, ... }.
// ------------------------------

async function fetchGitHubJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "AI-Coding-Helper",
      Accept: "application/vnd.github+json"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${txt || res.statusText}`);
  }

  return res.json();
}

async function listRepos() {
  const { key: token } = await getApiKeyWithFallback("github");
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set (set env var in Railway or set in Admin Keys)");
  }

  // Pull up to 100 repos sorted by updated.
  const repos = await fetchGitHubJson(
    "https://api.github.com/user/repos?per_page=100&sort=updated",
    token
  );

  return repos.map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private
  }));
}

// Alias used by your UI
app.get("/api/projects", async (req, res) => {
  try {
    const repos = await listRepos();
    res.json(repos);
  } catch (err) {
    console.error("Projects (repos) error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Backward-compatible endpoint
app.get("/api/repos", async (req, res) => {
  try {
    const repos = await listRepos();
    res.json(repos);
  } catch (err) {
    console.error("Repos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// Admin + Config APIs (used by /public/admin.html)
// ------------------------------

app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body || {};
  const secrets = await loadSecrets();

  if (!secrets.adminPassword) {
    const token = crypto.randomBytes(24).toString("hex");
    adminSessions.set(token, { expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    return res.json({ ok: true, sessionToken: token, noPassword: true });
  }

  if (!password || password !== secrets.adminPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  adminSessions.set(token, { expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return res.json({ ok: true, sessionToken: token });
});

app.get("/api/admin/status", async (req, res) => {
  const secrets = await loadSecrets();
  return res.json({ hasPassword: !!secrets.adminPassword });
});

app.post("/api/admin/password", requireAdminAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: "Password too short" });
  const secrets = await loadSecrets();
  secrets.adminPassword = password;
  await saveSecrets(secrets);
  return res.json({ ok: true });
});

app.get("/api/stats", requireAdminAuth, async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  const ideas = await readJson(ideasPath, []);

  const totalConversations = conversations.length;
  const totalMessages = conversations.reduce((sum, c) => sum + (c.messages?.length || 0), 0);

  const providerCounts = {};
  for (const c of conversations) {
    for (const m of c.messages || []) {
      const p = m?.meta?.provider;
      if (!p) continue;
      providerCounts[p] = (providerCounts[p] || 0) + 1;
    }
  }

  return res.json({
    totalConversations,
    totalMessages,
    totalIdeas: ideas.length,
    providerCounts
  });
});

app.get("/api/config/models", requireAdminAuth, async (req, res) => {
  const configPath = path.join(__dirname, "config", "models.json");
  const config = await loadModelsConfig(configPath);
  return res.json(config);
});

app.post("/api/config/models", requireAdminAuth, async (req, res) => {
  const configPath = path.join(__dirname, "config", "models.json");
  const nextConfig = req.body || {};
  await saveModelsConfig(configPath, nextConfig);
  return res.json({ ok: true });
});

app.get("/api/config/keys", requireAdminAuth, async (req, res) => {
  const secrets = await loadSecrets();
  const out = {};
  for (const k of ["openai", "anthropic", "google", "github"]) {
    const { key, source } = await getApiKeyWithFallback(k);
    out[k] = { source, masked: maskKey(key), hasValue: !!key };
  }
  out.adminPassword = !!secrets.adminPassword;
  return res.json(out);
});

app.post("/api/config/keys", requireAdminAuth, async (req, res) => {
  const { provider, key } = req.body || {};
  if (!provider) return res.status(400).json({ error: "provider required" });
  const secrets = await loadSecrets();
  secrets.keys = secrets.keys || {};
  secrets.keys[provider] = key || "";
  await saveSecrets(secrets);
  return res.json({ ok: true });
});

// Model options endpoints
app.get("/api/model-options", requireAdminAuth, async (req, res) => {
  const configPath = path.join(__dirname, "config", "models.json");
  const config = await loadModelsConfig(configPath);
  return res.json({
    lastSyncAt: config.lastSyncAt || null,
    modelOptions: config.modelOptions || {}
  });
});

app.post("/api/model-options/sync", requireAdminAuth, async (req, res) => {
  const configPath = path.join(__dirname, "config", "models.json");
  const config = await loadModelsConfig(configPath);

  const result = await providerRouter.syncModelOptions(config);
  const merged = mergeModelOptions(config, result);

  merged.lastSyncAt = new Date().toISOString();
  await saveModelsConfig(configPath, merged);

  return res.json({ ok: true, added: result.added || {}, lastSyncAt: merged.lastSyncAt });
});

// ------------------------------
// Core App APIs (Chat + Conversations)
// ------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/conversations", async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  return res.json(conversations);
});

app.post("/api/conversations", async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  const id = createId();
  const newConversation = {
    id,
    title: req.body?.title || "New conversation",
    createdAt: new Date().toISOString(),
    messages: []
  };
  conversations.unshift(newConversation);
  await writeJson(conversationsPath, conversations);
  return res.status(201).json(newConversation);
});

app.get("/api/conversations/:id", async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  const convo = conversations.find((c) => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: "Not found" });
  return res.json(convo);
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const { role, content, meta } = req.body || {};
  if (!role || !content) return res.status(400).json({ error: "role and content required" });

  const conversations = await readJson(conversationsPath, []);
  const convo = conversations.find((c) => c.id === req.params.id);
  if (!convo) return res.status(404).json({ error: "Not found" });

  convo.messages = convo.messages || [];
  convo.messages.push({
    id: createId(),
    role,
    content,
    createdAt: new Date().toISOString(),
    meta: meta || {}
  });

  await writeJson(conversationsPath, conversations);
  return res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const { message, mode = "fast", conversationId, context } = req.body || {};
  if (!message) return res.status(400).json({ error: "message required" });

  // Mode selection remains button-driven + your existing heuristics (inside providerRouter).
  try {
    const result = await providerRouter.run({ message, mode, context });
    const codeBlocks = extractCodeBlocks(result.text || "");

    if (conversationId) {
      const conversations = await readJson(conversationsPath, []);
      const convo = conversations.find((c) => c.id === conversationId);
      if (convo) {
        convo.messages = convo.messages || [];
        convo.messages.push({
          id: createId(),
          role: "user",
          content: message,
          createdAt: new Date().toISOString()
        });
        convo.messages.push({
          id: createId(),
          role: "assistant",
          content: result.text || "",
          createdAt: new Date().toISOString(),
          meta: result.meta || {}
        });
        await writeJson(conversationsPath, conversations);
      }
    }

    return res.json({
      text: result.text || "",
      meta: result.meta || {},
      codeBlocks
    });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(502).json({ error: err.message || "Upstream provider error" });
  }
});

// ------------------------------
// Startup
// ------------------------------

await ensureDataDir();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
