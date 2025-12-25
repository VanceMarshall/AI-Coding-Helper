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

let providerStatus = initializeProviders();

const CONFIG_PATH = path.join(__dirname, "config", "models.json");
const SECRETS_PATH = path.join(__dirname, "config", "secrets.json");
const DATA_DIR = path.join(__dirname, "data");
const conversationsPath = path.join(DATA_DIR, "conversations.json");
const projectsPath = path.join(DATA_DIR, "projects.json");
const statsPath = path.join(DATA_DIR, "stats.json");

const adminSessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000;

// Key files to auto-load for different project types
const AUTO_LOAD_FILES = {
  always: ["README.md", "readme.md", "README.MD"],
  node: ["package.json", "tsconfig.json", ".env.example", "next.config.js", "vite.config.js"],
  python: ["requirements.txt", "pyproject.toml", "Pipfile", ".env.example"],
  react: ["package.json", "vite.config.js", "tsconfig.json"],
  next: ["package.json", "next.config.js", "tsconfig.json"],
  general: [".gitignore", "docker-compose.yml", "Dockerfile", ".env.example"]
};

const IMPORTANT_DIRS = [
  "src",
  "app",
  "pages",
  "components",
  "lib",
  "utils",
  "api",
  "routes",
  "models",
  "services",
  "providers",
  "public",
  "config"
];

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

async function writeJson(filePath, data) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function loadConfig() {
  const text = await fs.readFile(CONFIG_PATH, "utf8");
  return JSON.parse(text);
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

async function loadSecrets() {
  try {
    const text = await fs.readFile(SECRETS_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    // Default structure if secrets.json doesn't exist yet
    return {
      adminPassword: "",
      keys: {
        openai: "",
        anthropic: "",
        google: "",
        github: ""
      }
    };
  }
}

async function saveSecrets(secrets) {
  await fs.writeFile(SECRETS_PATH, JSON.stringify(secrets, null, 2), "utf8");
}

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
  if (!secrets.adminPassword) return next(); // unlocked if no password set

  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized", needsAuth: true });
  next();
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return "••••••••••••" + key.slice(-4);
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
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

async function getGitHubToken() {
  const secrets = await loadSecrets();
  return process.env.GITHUB_TOKEN || secrets?.keys?.github || "";
}

async function listRepos() {
  const token = await getGitHubToken();
  if (!token) throw new Error("Missing GitHub token. Set GITHUB_TOKEN env var or store in Admin Keys.");

  const repos = await githubRequest("https://api.github.com/user/repos?per_page=100&sort=updated", "GET", token);

  return repos.map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private
  }));
}

async function listRepoFiles(fullName) {
  const token = await getGitHubToken();
  if (!token) throw new Error("Missing GitHub token. Set GITHUB_TOKEN env var or store in Admin Keys.");

  // Use Git Trees API to list all files recursively
  const [owner, repo] = fullName.split("/");
  const repoInfo = await githubRequest(`https://api.github.com/repos/${owner}/${repo}`, "GET", token);
  const branch = repoInfo.default_branch;

  const tree = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    "GET",
    token
  );

  const files = (tree.tree || [])
    .filter((item) => item.type === "blob")
    .map((item) => item.path);

  return files;
}

function detectStack(files) {
  const set = new Set(files);
  const has = (n) => set.has(n) || [...set].some((p) => p.endsWith("/" + n));

  if (has("next.config.js")) return "Next.js";
  if (has("vite.config.js")) return "Vite";
  if (has("package.json") && [...set].some((p) => p.endsWith(".tsx") || p.endsWith(".jsx"))) return "React";
  if (has("requirements.txt") || has("pyproject.toml")) return "Python";
  if ([...set].some((p) => p.endsWith(".go"))) return "Go";
  if ([...set].some((p) => p.endsWith(".rs"))) return "Rust";
  return "Unknown";
}

function selectFilesToAutoLoad(files, stack) {
  const set = new Set(files);
  const selected = new Set();

  // Always
  for (const f of AUTO_LOAD_FILES.always) {
    if (set.has(f)) selected.add(f);
  }

  // Stack-specific
  if (stack === "Next.js") {
    for (const f of AUTO_LOAD_FILES.next) if (set.has(f)) selected.add(f);
  } else if (stack === "React") {
    for (const f of AUTO_LOAD_FILES.react) if (set.has(f)) selected.add(f);
  } else if (stack === "Vite") {
    for (const f of AUTO_LOAD_FILES.react) if (set.has(f)) selected.add(f);
  } else if (stack === "Python") {
    for (const f of AUTO_LOAD_FILES.python) if (set.has(f)) selected.add(f);
  } else {
    for (const f of AUTO_LOAD_FILES.general) if (set.has(f)) selected.add(f);
  }

  // Important dirs: pick top-level summary files if present
  for (const dir of IMPORTANT_DIRS) {
    const candidates = files.filter((p) => p.startsWith(dir + "/")).slice(0, 10);
    candidates.forEach((c) => selected.add(c));
  }

  return [...selected].slice(0, 25);
}

// ------------------------------
// Admin routes
// ------------------------------

// Serve admin UI at /admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/admin/login", async (req, res) => {
  const { password } = req.body || {};
  const secrets = await loadSecrets();

  if (!secrets.adminPassword) {
    // no password set yet
    const token = createSessionToken();
    adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION });
    return res.json({ ok: true, token, noPassword: true });
  }

  if (!password || password !== secrets.adminPassword) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  const token = createSessionToken();
  adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION });
  return res.json({ ok: true, token });
});

// API-flavored aliases (admin.html calls /api/admin/*)
app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body || {};
  const secrets = await loadSecrets();

  if (!secrets.adminPassword) {
    const token = createSessionToken();
    adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION });
    return res.json({ ok: true, sessionToken: token, noPassword: true });
  }

  if (!password || password !== secrets.adminPassword) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  const token = createSessionToken();
  adminSessions.set(token, { expiresAt: Date.now() + SESSION_DURATION });
  return res.json({ ok: true, sessionToken: token });
});

app.get("/api/admin/status", async (req, res) => {
  const secrets = await loadSecrets();
  res.json({ hasPassword: !!secrets.adminPassword });
});

app.post("/api/admin/password", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: "Password too short" });

  const secrets = await loadSecrets();
  secrets.adminPassword = password;
  await saveSecrets(secrets);
  res.json({ ok: true });
});

app.get("/api/config/keys", requireAuth, async (req, res) => {
  const secrets = await loadSecrets();
  const resolved = {
    openai: process.env.OPENAI_API_KEY || secrets?.keys?.openai || "",
    anthropic: process.env.ANTHROPIC_API_KEY || secrets?.keys?.anthropic || "",
    google: process.env.GOOGLE_API_KEY || secrets?.keys?.google || "",
    github: process.env.GITHUB_TOKEN || secrets?.keys?.github || ""
  };

  res.json({
    openai: { hasValue: !!resolved.openai, masked: maskKey(resolved.openai), source: process.env.OPENAI_API_KEY ? "env" : "stored" },
    anthropic: { hasValue: !!resolved.anthropic, masked: maskKey(resolved.anthropic), source: process.env.ANTHROPIC_API_KEY ? "env" : "stored" },
    google: { hasValue: !!resolved.google, masked: maskKey(resolved.google), source: process.env.GOOGLE_API_KEY ? "env" : "stored" },
    github: { hasValue: !!resolved.github, masked: maskKey(resolved.github), source: process.env.GITHUB_TOKEN ? "env" : "stored" },
    adminPassword: !!(await loadSecrets()).adminPassword
  });
});

app.post("/api/config/keys", requireAuth, async (req, res) => {
  const { provider, key } = req.body || {};
  if (!provider) return res.status(400).json({ error: "provider required" });

  const secrets = await loadSecrets();
  secrets.keys = secrets.keys || {};
  secrets.keys[provider] = key || "";
  await saveSecrets(secrets);

  // reload provider clients
  providerStatus = reloadProviders({
    openai: process.env.OPENAI_API_KEY || secrets.keys.openai,
    anthropic: process.env.ANTHROPIC_API_KEY || secrets.keys.anthropic,
    google: process.env.GOOGLE_API_KEY || secrets.keys.google
  });

  res.json({ ok: true });
});

// ------------------------------
// Repo APIs
// ------------------------------

app.get("/api/repos", async (req, res) => {
  try {
    const repos = await listRepos();
    res.json(repos);
  } catch (err) {
    console.error("Repos error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Alias for UI "Projects" dropdown (expects the same data as /api/repos)
app.get("/api/projects", async (req, res) => {
  try {
    const repos = await listRepos();
    res.json(repos);
  } catch (err) {
    console.error("Projects (repos) error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/repos/:owner/:repo/files", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const files = await listRepoFiles(`${owner}/${repo}`);
    const stack = detectStack(files);
    const autoLoad = selectFilesToAutoLoad(files, stack);
    res.json({ files, stack, autoLoad });
  } catch (err) {
    console.error("Files error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// Config APIs
// ------------------------------

app.get("/api/config/models", requireAuth, async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/config/models", requireAuth, async (req, res) => {
  try {
    await saveConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/provider-status", async (req, res) => {
  res.json(getProviderStatus());
});

// ------------------------------
// Conversations
// ------------------------------

app.get("/api/conversations", async (req, res) => {
  const conversations = await readJson(conversationsPath, []);
  res.json(conversations);
});

app.post("/api/conversations", async (req, res) => {
  const { title } = req.body || {};
  const conversations = await readJson(conversationsPath, []);
  const id = crypto.randomBytes(8).toString("hex");

  const conv = {
    id,
    title: title || "New Conversation",
    createdAt: new Date().toISOString(),
    messages: []
  };

  conversations.unshift(conv);
  await writeJson(conversationsPath, conversations);
  res.json(conv);
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  const { role, content, meta } = req.body || {};
  if (!role || !content) return res.status(400).json({ error: "role and content required" });

  const conversations = await readJson(conversationsPath, []);
  const conv = conversations.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });

  conv.messages.push({
    role,
    content,
    meta: meta || {},
    createdAt: new Date().toISOString()
  });

  await writeJson(conversationsPath, conversations);
  res.json({ ok: true });
});

// ------------------------------
// Stats
// ------------------------------

app.get("/api/stats", requireAuth, async (req, res) => {
  const stats = await readJson(statsPath, { totalMessages: 0, totalCost: 0, byProvider: {} });
  res.json(stats);
});

// ------------------------------
// Health
// ------------------------------

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ------------------------------
// Chat
// ------------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const { message, conversationId, mode = "auto", attachedFiles = [] } = req.body || {};
    if (!message) return res.status(400).json({ error: "Message is required" });

    const config = await loadConfig();

    // Decide route
    const routing = mode === "fast" || mode === "full"
      ? {
          modelKey: mode,
          model: config.models[mode],
          reason: `User forced ${mode}`
        }
      : routeMessage(message, config, attachedFiles?.length > 0);

    const systemPrompt = config.systemPrompt || "";
    const modelConfig = routing.model;

    // Provider availability guard
    if (!isProviderAvailable(modelConfig.provider)) {
      return res.status(500).json({ error: `Provider ${modelConfig.provider} is not configured.` });
    }

    // Build messages
    const messages = [{ role: "user", content: message }];

    // Stream response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullText = "";
    let usage = null;

    for await (const chunk of streamCompletion(modelConfig, systemPrompt, messages, modelConfig.maxTokens || 2048)) {
      if (chunk.type === "text") {
        fullText += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "delta", text: chunk.text })}\n\n`);
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
        res.write(`data: ${JSON.stringify({ type: "usage", usage })}\n\n`);
      }
    }

    // Save conversation
    if (conversationId) {
      const conversations = await readJson(conversationsPath, []);
      const conv = conversations.find((c) => c.id === conversationId);
      if (conv) {
        conv.messages.push({ role: "user", content: message, createdAt: new Date().toISOString() });
        conv.messages.push({
          role: "assistant",
          content: fullText,
          meta: { provider: modelConfig.provider, model: modelConfig.model, route: routing },
          createdAt: new Date().toISOString()
        });
        await writeJson(conversationsPath, conversations);
      }
    }

    // Save stats
    const stats = await readJson(statsPath, { totalMessages: 0, totalCost: 0, byProvider: {} });
    stats.totalMessages += 1;
    if (usage) {
      const cost = calculateCost(modelConfig, usage);
      stats.totalCost += cost;
      stats.byProvider[modelConfig.provider] = (stats.byProvider[modelConfig.provider] || 0) + cost;
    }
    await writeJson(statsPath, stats);

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Preview routing
app.post("/api/preview-route", async (req, res) => {
  try {
    const { message, attachedFiles = [] } = req.body || {};
    const config = await loadConfig();
    const preview = previewRoute(message || "", config, attachedFiles?.length > 0);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// Startup
// ------------------------------

await ensureDataDir();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
