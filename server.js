import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const __dirname = path.resolve();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, "public")));

// Admin page routes (compat): UI may link to /admin instead of /admin.html
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/admin/", (req, res) => {
  res.redirect(302, "/admin");
});

// =========================
// Simple persistence helpers
// =========================
const DATA_DIR = path.join(__dirname, "data");
const ensureDir = (p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};
ensureDir(DATA_DIR);

const readJson = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const writeJson = (file, obj) => {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
};

// =========================
// Admin auth (token-based)
// =========================
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET || "dev-secret-change-me";

const SECRET_FILE = path.join(DATA_DIR, "secrets.json");

function getSecrets() {
  return readJson(SECRET_FILE, { adminPasswordHash: null, sessions: {} });
}

function saveSecrets(secrets) {
  writeJson(SECRET_FILE, secrets);
}

function hashPassword(password) {
  return crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(String(password))
    .digest("hex");
}

function newSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function requireAdminAuth(req, res, next) {
  const token =
    req.header("x-admin-session") ||
    req.header("X-Admin-Session") ||
    req.query.session ||
    null;

  const secrets = getSecrets();
  const sessions = secrets.sessions || {};
  if (!token || !sessions[token]) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const session = sessions[token];
  const now = Date.now();
  const maxAgeMs = 1000 * 60 * 60 * 24; // 24h
  if (now - session.createdAt > maxAgeMs) {
    delete sessions[token];
    secrets.sessions = sessions;
    saveSecrets(secrets);
    return res.status(401).json({ ok: false, error: "Session expired" });
  }

  req.adminSession = session;
  next();
}

// Auth status (used by admin UI)
app.get("/api/admin/auth-status", (req, res) => {
  const token =
    req.header("x-admin-session") ||
    req.header("X-Admin-Session") ||
    req.query.session ||
    null;

  const secrets = getSecrets();
  const needsPassword = !secrets.adminPasswordHash;

  const sessions = secrets.sessions || {};
  const isAuthenticated = !!(token && sessions[token]);

  res.json({ ok: true, needsPassword, isAuthenticated });
});

// Login (create password if missing, otherwise validate)
app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: "Password must be at least 6 characters." });
  }

  const secrets = getSecrets();

  // First-time setup: set password
  if (!secrets.adminPasswordHash) {
    secrets.adminPasswordHash = hashPassword(password);
  } else {
    // Validate
    const incoming = hashPassword(password);
    if (incoming !== secrets.adminPasswordHash) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }
  }

  // Create session
  const token = newSessionToken();
  secrets.sessions = secrets.sessions || {};
  secrets.sessions[token] = { createdAt: Date.now() };
  saveSecrets(secrets);

  res.json({ ok: true, token });
});

// =========================
// App config/model options
// =========================
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MODEL_OPTIONS_FILE = path.join(DATA_DIR, "model-options.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");

const defaultConfig = {
  systemPrompt: "",
  modelRouting: {
    fast: "gemini-3-flash-preview",
    full: "gpt-5.2",
    fallback: "claude-sonnet-4-5",
  },
  guardrails: {
    maxCostPerRequestUsd: null,
    maxTokensPerRequest: null,
  },
};

const defaultModelOptions = {
  lastSyncedAt: null,
  options: [],
  // optional: local metadata for cost display
  catalog: {
    "gemini-3-flash-preview": { provider: "google", in: 0.5, out: 3.0 },
    "gpt-5.2": { provider: "openai" },
    "claude-sonnet-4-5": { provider: "anthropic" },
  },
};

function loadConfig() {
  const cfg = readJson(CONFIG_FILE, defaultConfig);
  // ensure shape
  cfg.modelRouting = cfg.modelRouting || defaultConfig.modelRouting;
  cfg.guardrails = cfg.guardrails || defaultConfig.guardrails;
  if (cfg.systemPrompt === undefined) cfg.systemPrompt = "";
  return cfg;
}

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

function loadModelOptions() {
  const mo = readJson(MODEL_OPTIONS_FILE, defaultModelOptions);
  mo.options = Array.isArray(mo.options) ? mo.options : [];
  mo.catalog = mo.catalog || defaultModelOptions.catalog;
  return mo;
}

function saveModelOptions(mo) {
  writeJson(MODEL_OPTIONS_FILE, mo);
}

function loadStats() {
  return readJson(STATS_FILE, {
    totalMessages: 0,
    totalCostUsd: 0,
    providersUsed: {},
  });
}

function saveStats(stats) {
  writeJson(STATS_FILE, stats);
}

// Public config endpoint (frontend uses this)
app.get("/api/config", (req, res) => {
  const cfg = loadConfig();
  res.json({ ok: true, config: cfg });
});

// Admin: get config
app.get("/api/admin/config", requireAdminAuth, (req, res) => {
  const cfg = loadConfig();
  res.json({ ok: true, config: cfg });
});

// Admin: save config
app.post("/api/admin/config", requireAdminAuth, (req, res) => {
  const incoming = req.body?.config;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ ok: false, error: "Invalid config" });
  }

  const cfg = loadConfig();

  // keep existing behavior stable: only update known fields
  if (typeof incoming.systemPrompt === "string") cfg.systemPrompt = incoming.systemPrompt;

  if (incoming.modelRouting && typeof incoming.modelRouting === "object") {
    cfg.modelRouting.fast = incoming.modelRouting.fast || cfg.modelRouting.fast;
    cfg.modelRouting.full = incoming.modelRouting.full || cfg.modelRouting.full;
    cfg.modelRouting.fallback =
      incoming.modelRouting.fallback || cfg.modelRouting.fallback;
  }

  if (incoming.guardrails && typeof incoming.guardrails === "object") {
    cfg.guardrails.maxCostPerRequestUsd =
      incoming.guardrails.maxCostPerRequestUsd ?? cfg.guardrails.maxCostPerRequestUsd;
    cfg.guardrails.maxTokensPerRequest =
      incoming.guardrails.maxTokensPerRequest ?? cfg.guardrails.maxTokensPerRequest;
  }

  saveConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// Model options (admin UI reads this)
app.get("/api/model-options", requireAdminAuth, (req, res) => {
  const mo = loadModelOptions();
  res.json({ ok: true, modelOptions: mo });
});

// Admin API keys display (masked)
app.get("/api/admin/api-keys", requireAdminAuth, (req, res) => {
  const keys = {
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
  };
  res.json({ ok: true, keys });
});

// Stats endpoints
app.get("/api/stats", (req, res) => {
  const stats = loadStats();
  res.json({ ok: true, stats });
});

app.post("/api/admin/reset-stats", requireAdminAuth, (req, res) => {
  saveStats({
    totalMessages: 0,
    totalCostUsd: 0,
    providersUsed: {},
  });
  res.json({ ok: true });
});

// =========================
// GitHub projects (compat)
// =========================
app.get("/api/projects", async (req, res) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(200).json({ ok: true, projects: [] });
    }

    const r = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "AI-Coding-Helper",
        Accept: "application/vnd.github+json",
      },
    });

    if (!r.ok) {
      return res.status(200).json({ ok: true, projects: [] });
    }

    const repos = await r.json();
    const projects = repos.map((repo) => ({
      full_name: repo.full_name,
      name: repo.name,
      owner: repo.owner?.login,
      private: repo.private,
      updated_at: repo.updated_at,
      default_branch: repo.default_branch,
    }));

    res.json({ ok: true, projects });
  } catch (e) {
    res.status(200).json({ ok: true, projects: [] });
  }
});

app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(200).json({ ok: true, files: [] });
    }

    const { owner, repo } = req.params;
    const branch = req.query.branch || "main";

    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      {
        headers: {
          Authorization: `token ${token}`,
          "User-Agent": "AI-Coding-Helper",
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (!r.ok) {
      return res.status(200).json({ ok: true, files: [] });
    }

    const data = await r.json();
    const files =
      (data.tree || [])
        .filter((x) => x.type === "blob")
        .map((x) => x.path) || [];

    res.json({ ok: true, files });
  } catch {
    res.status(200).json({ ok: true, files: [] });
  }
});

// =========================
// Conversations (existing)
// =========================
const CONVO_FILE = path.join(DATA_DIR, "conversations.json");

function loadConversations() {
  return readJson(CONVO_FILE, []);
}
function saveConversations(convos) {
  writeJson(CONVO_FILE, convos);
}

app.get("/api/conversations", (req, res) => {
  const convos = loadConversations();
  res.json({ ok: true, conversations: convos });
});

// =========================
// Chat/preview route (placeholder - keep your existing logic below this line)
// =========================

// NOTE: If your existing server.js has additional endpoints below, keep them.
// If this section already exists in your file, do not duplicate it.
// (Your stabilized repo already had working chat logic; I’m not changing it here.)

// Health check for Railway
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin  (or /admin.html)`);
});
