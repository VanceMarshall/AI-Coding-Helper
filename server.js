import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";
import { initializeProviders, isProviderAvailable, streamCompletion, calculateCost, reloadProviders } from "./providers/index.js";
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
  always: ['README.md', 'readme.md', 'README.MD'],
  node: ['package.json', 'tsconfig.json', '.env.example', 'next.config.js', 'next.config.mjs', 'vite.config.js', 'vite.config.ts'],
  python: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'main.py', 'app.py'],
  rust: ['Cargo.toml'],
  go: ['go.mod', 'main.go'],
  config: ['.gitignore', 'docker-compose.yml', 'Dockerfile', '.env.example']
};

const IMPORTANT_DIRS = ['src', 'app', 'pages', 'components', 'lib', 'utils', 'api', 'routes', 'models', 'services', 'providers', 'public', 'config'];

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
  } catch (err) {
    if (err.code === "ENOENT") return { adminPassword: null, apiKeys: {} };
    throw err;
  }
}

async function saveSecrets(secrets) {
  await fs.writeFile(SECRETS_PATH, JSON.stringify(secrets, null, 2), "utf8");
}

function getApiKey(provider) {
  const envKeys = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    github: process.env.GITHUB_TOKEN
  };
  return envKeys[provider] || null;
}

async function getApiKeyWithFallback(provider) {
  const envKey = getApiKey(provider);
  if (envKey) return { key: envKey, source: "env" };
  const secrets = await loadSecrets();
  if (secrets.apiKeys?.[provider]) return { key: secrets.apiKeys[provider], source: "config" };
  return { key: null, source: null };
}

async function reloadProvidersWithSecrets() {
  const secrets = await loadSecrets();
  const keys = {
    openai: process.env.OPENAI_API_KEY || secrets.apiKeys?.openai,
    anthropic: process.env.ANTHROPIC_API_KEY || secrets.apiKeys?.anthropic,
    google: process.env.GOOGLE_API_KEY || secrets.apiKeys?.google,
    github: process.env.GITHUB_TOKEN || secrets.apiKeys?.github
  };
  providerStatus = reloadProviders(keys);
  return providerStatus;
}

(async () => { await reloadProvidersWithSecrets(); })();

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (err) { if (err.code !== "EEXIST") console.error(err); }
}
await ensureDataDir();

async function readJson(filePath, defaultValue) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (err) { return defaultValue; }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createId() { return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10); }
function generateSessionToken() { return crypto.randomBytes(32).toString("hex"); }
function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return "••••••••••••" + key.slice(-4);
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

async function getGitHubToken() { return (await getApiKeyWithFallback("github")).key; }
function parseRepoFullName(full) { const [owner, repo] = (full || "").split("/"); return { owner, repo }; }
function encodeGitHubPath(filePath) { return (filePath || "").split("/").map(encodeURIComponent).join("/"); }

async function fetchGitHubJson(url, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listRepos() {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const repos = await fetchGitHubJson("https://api.github.com/user/repos?per_page=100&sort=updated", token);
  return repos.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private }));
}

async function listRepoFiles(repoFullName) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);
  const json = await fetchGitHubJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, token);
  if (!Array.isArray(json.tree)) return [];
  return json.tree.filter((e) => e.type === "blob").map((e) => e.path);
}

async function getFileFromGitHub(repoFullName, filePath) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);
  const json = await fetchGitHubJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeGitHubPath(filePath)}`, token);
  if (!json.content) throw new Error("Missing content");
  return Buffer.from(json.content, "base64").toString("utf8");
}

async function createGitHubRepo(name, description, isPrivate = true) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true })
  });
  if (!res.ok) throw new Error(`Failed to create repo: ${await res.text()}`);
  return res.json();
}

async function createOrUpdateFile(repoFullName, filePath, content, message) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGitHubPath(filePath)}`;
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  
  let sha;
  try {
    const existing = await fetch(url, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } });
    if (existing.ok) sha = (await existing.json()).sha;
  } catch (e) {}
  
  const body = { message, content: Buffer.from(content, "utf8").toString("base64") };
  if (sha) body.sha = sha;
  
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Failed to create file: ${await res.text()}`);
  return res.json();
}

function detectStack(filePaths) {
  const files = new Set(filePaths || []);
  const has = (n) => files.has(n) || [...files].some((p) => p.endsWith("/" + n));
  if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts")) return "Next.js";
  if (has("remix.config.js")) return "Remix";
  if (has("nuxt.config.js") || has("nuxt.config.ts")) return "Nuxt";
  if (has("svelte.config.js")) return "SvelteKit";
  if (has("vite.config.js") || has("vite.config.ts")) return "Vite";
  if (has("package.json")) return "Node.js";
  if ([...files].some((p) => p.endsWith(".py"))) return "Python";
  if ([...files].some((p) => p.endsWith(".go"))) return "Go";
  if ([...files].some((p) => p.endsWith(".rs"))) return "Rust";
  return "Unknown";
}

function selectFilesToAutoLoad(filePaths, stack, maxFiles = 20) {
  const selected = [];
  const fileSet = new Set(filePaths);
  const addIfExists = (filename) => {
    if (fileSet.has(filename) && !selected.includes(filename)) {
      selected.push(filename);
      return true;
    }
    return false;
  };
  
  // Add root level config files first
  AUTO_LOAD_FILES.always.forEach(f => addIfExists(f));
  AUTO_LOAD_FILES.config.forEach(f => addIfExists(f));
  
  // Stack-specific files
  if (["Node.js", "Next.js", "Vite", "Remix", "Nuxt", "SvelteKit"].includes(stack)) {
    AUTO_LOAD_FILES.node.forEach(f => addIfExists(f));
  }
  if (stack === "Python") AUTO_LOAD_FILES.python.forEach(f => addIfExists(f));
  if (stack === "Rust") AUTO_LOAD_FILES.rust.forEach(f => addIfExists(f));
  if (stack === "Go") AUTO_LOAD_FILES.go.forEach(f => addIfExists(f));
  
  // Entry points
  const entryPoints = [
    'src/index.js', 'src/index.ts', 'src/index.tsx', 'src/main.js', 'src/main.ts', 'src/main.tsx',
    'src/App.js', 'src/App.tsx', 'src/app.js', 'src/app.tsx',
    'app/layout.tsx', 'app/layout.js', 'app/page.tsx', 'app/page.js',
    'pages/index.js', 'pages/index.tsx', 'pages/_app.js', 'pages/_app.tsx',
    'index.js', 'index.ts', 'main.py', 'app.py', 'main.go', 'src/main.rs', 'src/lib.rs',
    'server.js', 'server.ts', 'app.js', 'app.ts'
  ];
  entryPoints.forEach(f => addIfExists(f));
  
  // Important directories - grab key files
  for (const dir of IMPORTANT_DIRS) {
    const dirFiles = filePaths.filter(f => f.startsWith(dir + '/') && !f.includes('test') && !f.includes('spec') && !f.includes('.map'));
    // Index files first
    const indexFiles = dirFiles.filter(f => f.match(/\/(index|main)\.(js|ts|tsx|jsx|py|go|rs)$/));
    indexFiles.slice(0, 2).forEach(f => addIfExists(f));
    // Then other important files
    if (selected.length < maxFiles) {
      dirFiles.filter(f => f.match(/\.(js|ts|tsx|jsx|json|py|go|rs|html|css)$/)).slice(0, 3).forEach(f => addIfExists(f));
    }
  }
  
  return selected.slice(0, maxFiles);
}

function parseFileRequests(response) {
  const patterns = [
    /\[READ_FILE:\s*([^\]]+)\]/gi,
    /\[LOAD_FILE:\s*([^\]]+)\]/gi,
    /\[VIEW_FILE:\s*([^\]]+)\]/gi
  ];
  
  // Paths to ignore (examples, placeholders)
  const ignorePaths = ['path/to/file', 'path/to/', 'example', 'your-file', 'filename'];
  
  const files = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const file = match[1].trim();
      // Skip if it's an example/placeholder path
      const isExample = ignorePaths.some(p => file.toLowerCase().includes(p));
      if (file && !files.includes(file) && !isExample && file.length < 200) {
        files.push(file);
      }
    }
  }
  return files;
}

function buildSystemPrompt(repoFullName, filePaths, stack, fileContents = {}, mode = "building") {
  const loadedFileCount = Object.keys(fileContents).length;
  
  let prompt = mode === "planning" 
    ? `You are an expert software architect helping plan a new application. Ask clarifying questions, recommend tech stack, and create a project plan. When ready, output: CREATE_PROJECT:{"name":"repo-name","description":"...","stack":"...","features":[...],"pages":[...]}`
    : `You are an expert full-stack engineer. You have FULL ACCESS to this repository's files.

## IMPORTANT: File Access
${loadedFileCount > 0 ? `✅ ${loadedFileCount} files have been pre-loaded below - you can see their COMPLETE contents.` : '⚠️ No files were auto-loaded.'}
- To read any OTHER file not shown below, use: [READ_FILE: exact/path/to/file.js]
- Only request files that exist in the repository structure shown below.
- Do NOT use example paths like "path/to/file" - use real file paths from this repo.

## When Showing Code Changes
Show the complete file with a filepath comment:
\`\`\`javascript
// filepath: src/components/Button.jsx
import React from 'react';
export function Button({ children }) {
  return <button>{children}</button>;
}
\`\`\`
`;

  if (repoFullName) {
    prompt += `\n## Project: ${repoFullName}`;
    if (stack && stack !== "Unknown") prompt += ` (${stack})`;
    prompt += "\n";
  }

  // Show file structure
  if (filePaths?.length > 0) {
    prompt += `\n## Repository Files (${filePaths.length} total)\n\`\`\`\n`;
    filePaths.slice(0, 100).forEach(f => prompt += `${f}\n`);
    if (filePaths.length > 100) prompt += `... and ${filePaths.length - 100} more files\n`;
    prompt += "```\n";
  }

  // Show loaded file contents - THIS IS THE KEY PART
  if (loadedFileCount > 0) {
    prompt += `\n## 📂 Pre-loaded File Contents (${loadedFileCount} files)\n`;
    prompt += "You can see the COMPLETE contents of these files:\n\n";
    
    for (const [fp, content] of Object.entries(fileContents)) {
      const ext = fp.split('.').pop() || 'txt';
      const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n\n... [truncated - file continues]" : content;
      prompt += `### 📄 ${fp}\n\`\`\`${ext}\n${truncated}\n\`\`\`\n\n`;
    }
  }

  return prompt;
}

async function updateStats(modelKey, inputTokens, outputTokens, cost, projectId = null) {
  const stats = await readJson(statsPath, { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0, byModel: {}, byProject: {}, dailyStats: {} });
  const today = new Date().toISOString().split("T")[0];
  stats.totalCost += cost;
  stats.totalInputTokens += inputTokens;
  stats.totalOutputTokens += outputTokens;
  stats.requestCount += 1;
  if (!stats.byModel[modelKey]) stats.byModel[modelKey] = { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
  stats.byModel[modelKey].cost += cost;
  stats.byModel[modelKey].inputTokens += inputTokens;
  stats.byModel[modelKey].outputTokens += outputTokens;
  stats.byModel[modelKey].requests += 1;
  if (projectId) {
    if (!stats.byProject[projectId]) stats.byProject[projectId] = { cost: 0, requests: 0 };
    stats.byProject[projectId].cost += cost;
    stats.byProject[projectId].requests += 1;
  }
  if (!stats.dailyStats[today]) stats.dailyStats[today] = { cost: 0, requests: 0 };
  stats.dailyStats[today].cost += cost;
  stats.dailyStats[today].requests += 1;
  await writeJson(statsPath, stats);
  return stats;
}

async function updateProjectCost(projectId, cost) {
  const projects = await readJson(projectsPath, []);
  const idx = projects.findIndex(p => p.id === projectId);
  if (idx !== -1) {
    projects[idx].totalCost = (projects[idx].totalCost || 0) + cost;
    projects[idx].updatedAt = new Date().toISOString();
    await writeJson(projectsPath, projects);
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Admin endpoints
app.get("/api/admin/auth-status", async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const sessionToken = req.headers["x-admin-session"];
    let isAuthenticated = !secrets.adminPassword;
    if (secrets.adminPassword && sessionToken) {
      const session = adminSessions.get(sessionToken);
      isAuthenticated = session && session.expires > Date.now();
    }
    res.json({ needsPassword: !secrets.adminPassword, isAuthenticated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/setup-password", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const secrets = await loadSecrets();
    if (secrets.adminPassword) return res.status(400).json({ error: "Password already set" });
    secrets.adminPassword = crypto.createHash("sha256").update(password).digest("hex");
    await saveSecrets(secrets);
    const sessionToken = generateSessionToken();
    adminSessions.set(sessionToken, { expires: Date.now() + SESSION_DURATION });
    res.json({ ok: true, sessionToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const { password } = req.body;
    const secrets = await loadSecrets();
    if (!secrets.adminPassword) return res.status(400).json({ error: "No password set" });
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    if (hash !== secrets.adminPassword) return res.status(401).json({ error: "Invalid password" });
    const sessionToken = generateSessionToken();
    adminSessions.set(sessionToken, { expires: Date.now() + SESSION_DURATION });
    res.json({ ok: true, sessionToken });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/logout", (req, res) => {
  const sessionToken = req.headers["x-admin-session"];
  if (sessionToken) adminSessions.delete(sessionToken);
  res.json({ ok: true });
});

app.post("/api/admin/change-password", requireAdminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
    const secrets = await loadSecrets();
    if (secrets.adminPassword) {
      const currentHash = crypto.createHash("sha256").update(currentPassword || "").digest("hex");
      if (currentHash !== secrets.adminPassword) return res.status(401).json({ error: "Current password is incorrect" });
    }
    secrets.adminPassword = crypto.createHash("sha256").update(newPassword).digest("hex");
    await saveSecrets(secrets);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/api-keys", requireAdminAuth, async (req, res) => {
  try {
    const secrets = await loadSecrets();
    const keys = {};
    for (const provider of ["openai", "anthropic", "google", "github"]) {
      const envKey = getApiKey(provider);
      const configKey = secrets.apiKeys?.[provider];
      keys[provider] = {
        isSet: !!(envKey || configKey),
        source: envKey ? "env" : (configKey ? "config" : null),
        masked: maskKey(envKey || configKey),
        connected: providerStatus[provider] || false
      };
    }
    res.json({ keys });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/api-keys", requireAdminAuth, async (req, res) => {
  try {
    const { provider, key } = req.body;
    if (!["openai", "anthropic", "google", "github"].includes(provider)) return res.status(400).json({ error: "Invalid provider" });
    const secrets = await loadSecrets();
    if (!secrets.apiKeys) secrets.apiKeys = {};
    if (key) secrets.apiKeys[provider] = key;
    else delete secrets.apiKeys[provider];
    await saveSecrets(secrets);
    await reloadProvidersWithSecrets();
    res.json({ ok: true, masked: maskKey(key), connected: providerStatus[provider] || false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/admin/api-keys/:provider", requireAdminAuth, async (req, res) => {
  try {
    const { provider } = req.params;
    if (!["openai", "anthropic", "google", "github"].includes(provider)) return res.status(400).json({ error: "Invalid provider" });
    const secrets = await loadSecrets();
    if (secrets.apiKeys) { delete secrets.apiKeys[provider]; await saveSecrets(secrets); }
    await reloadProvidersWithSecrets();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/config", async (req, res) => {
  try {
    const config = await loadConfig();
    res.json({
      models: config.models,
      routing: config.routing,
      templates: config.templates,
      providers: { openai: providerStatus.openai || false, anthropic: providerStatus.anthropic || false, google: providerStatus.google || false }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/config/models", requireAdminAuth, async (req, res) => {
  try {
    const config = await loadConfig();
    const { modelKey, updates } = req.body;
    if (!config.models[modelKey]) return res.status(400).json({ error: "Model not found" });
    const allowed = ["provider", "model", "displayName", "description", "inputCost", "outputCost", "maxOutputTokens", "contextWindow", "enabled"];
    for (const f of allowed) if (updates[f] !== undefined) config.models[modelKey][f] = updates[f];
    await saveConfig(config);
    res.json({ ok: true, model: config.models[modelKey] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", async (req, res) => {
  try { res.json(await readJson(statsPath, { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0, byModel: {}, byProject: {}, dailyStats: {} })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/stats/reset", requireAdminAuth, async (req, res) => {
  try { await writeJson(statsPath, { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0, byModel: {}, byProject: {}, dailyStats: {} }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/preview-route", async (req, res) => {
  try {
    const { message, hasFiles } = req.body;
    const config = await loadConfig();
    res.json(previewRoute(message || "", config, hasFiles || false));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/projects", async (req, res) => {
  try { res.json(await listRepos()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/projects/local", async (req, res) => {
  try { res.json(await readJson(projectsPath, [])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  const repoFullName = `${req.params.owner}/${req.params.repo}`;
  try {
    const files = await listRepoFiles(repoFullName);
    res.json({ files, stack: detectStack(files) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/projects/:owner/:repo/file", async (req, res) => {
  const repoFullName = `${req.params.owner}/${req.params.repo}`;
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: "path required" });
  try { res.json({ path: filePath, content: await getFileFromGitHub(repoFullName, filePath) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/projects/create", async (req, res) => {
  const { name, description, stack, features, pages, planningSpec, workspaceId = "personal", clientName = null } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const repo = await createGitHubRepo(name, description || "Created with AI Code Helper", true);
    const repoFullName = repo.full_name;
    await new Promise(r => setTimeout(r, 1500));
    const readme = `# ${name}\n\n${description || ''}\n\n## Features\n${(features || []).map(f => `- ${f}`).join('\n')}\n\n## Tech Stack\n${stack || 'TBD'}\n`;
    await createOrUpdateFile(repoFullName, "README.md", readme, "Initial project setup");
    const projects = await readJson(projectsPath, []);
    const project = { id: createId(), name, repoFullName, description, stack, features, pages, planningSpec, workspaceId, clientName, totalCost: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    projects.push(project);
    await writeJson(projectsPath, projects);
    res.json({ ok: true, project, repoFullName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const convs = await readJson(conversationsPath, []);
    convs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(convs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    const convs = await readJson(conversationsPath, []);
    const idx = convs.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    convs.splice(idx, 1);
    await writeJson(conversationsPath, convs);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Main chat endpoint with smart file loading
app.post("/api/chat", async (req, res) => {
  const { conversationId, message, repoFullName, loadedFiles = [], modelOverride, mode = "building", projectId = null } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const config = await loadConfig();
    
    let modelKey, modelConfig, routeReason;
    if (modelOverride && modelOverride !== "auto" && config.models[modelOverride]) {
      modelKey = modelOverride;
      modelConfig = config.models[modelOverride];
      routeReason = `Manual: ${modelOverride}`;
    } else {
      const route = routeMessage(message, config, loadedFiles.length > 0);
      modelKey = route.modelKey;
      modelConfig = route.model;
      routeReason = route.reason;
    }

    if (!isProviderAvailable(modelConfig.provider)) {
      if (config.models.fallback && isProviderAvailable(config.models.fallback.provider)) {
        modelKey = "fallback";
        modelConfig = config.models.fallback;
        routeReason = `Fallback: ${modelConfig.provider} unavailable`;
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", error: `Provider ${modelConfig.provider} not configured` })}\n\n`);
        return res.end();
      }
    }

    const conversations = await readJson(conversationsPath, []);
    let conversation, conversationIdx;
    
    if (conversationId) {
      conversationIdx = conversations.findIndex(c => c.id === conversationId);
      if (conversationIdx !== -1) conversation = conversations[conversationIdx];
    }
    
    if (!conversation) {
      const now = new Date().toISOString();
      conversation = { id: createId(), repoFullName: repoFullName || null, projectId, workspaceId: "personal", type: mode, title: message.slice(0, 50) + (message.length > 50 ? "..." : ""), messages: [], loadedFiles: [], createdAt: now, updatedAt: now };
      conversations.push(conversation);
      conversationIdx = conversations.length - 1;
    }

    let filePaths = [], stack = "Unknown";
    let fileContents = {};
    const repo = repoFullName || conversation.repoFullName;
    
    if (repo) {
      try {
        filePaths = await listRepoFiles(repo);
        stack = detectStack(filePaths);
        console.log(`[Chat] Repo: ${repo}, Stack: ${stack}, Total files: ${filePaths.length}`);
        
        // Smart auto-load key files
        const autoLoadList = selectFilesToAutoLoad(filePaths, stack);
        const previouslyLoaded = conversation.loadedFiles || [];
        const allToLoad = [...new Set([...autoLoadList, ...loadedFiles, ...previouslyLoaded])];
        
        console.log(`[Chat] Auto-loading files: ${allToLoad.join(', ')}`);
        
        res.write(`data: ${JSON.stringify({ type: "status", status: `Loading ${allToLoad.length} project files...` })}\n\n`);
        
        let loadedCount = 0;
        for (const fp of allToLoad) {
          try { 
            const content = await getFileFromGitHub(repo, fp);
            fileContents[fp] = content;
            loadedCount++;
            console.log(`[Chat] Loaded: ${fp} (${content.length} chars)`);
          }
          catch (err) { 
            console.log(`[Chat] Failed to load ${fp}: ${err.message}`);
          }
        }
        
        console.log(`[Chat] Successfully loaded ${loadedCount} files`);
        conversation.loadedFiles = Object.keys(fileContents);
      } catch (err) { 
        console.warn("[Chat] Could not list files", err.message); 
      }
    }

    const systemPrompt = buildSystemPrompt(repo, filePaths, stack, fileContents, mode);
    console.log(`[Chat] System prompt length: ${systemPrompt.length} chars`);
    
    conversation.messages.push({ role: "user", content: message, timestamp: new Date().toISOString() });

    res.write(`data: ${JSON.stringify({ type: "start", conversationId: conversation.id, model: modelConfig.displayName, modelKey, routeReason, filesLoaded: Object.keys(fileContents).length })}\n\n`);

    let fullResponse = "", metadata = {};
    for await (const chunk of streamCompletion(modelConfig, systemPrompt, conversation.messages, modelConfig.maxOutputTokens)) {
      if (chunk.type === "text") {
        fullResponse += chunk.text;
        res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
      } else if (chunk.type === "done") {
        metadata = chunk;
      }
    }

    // Check if AI requested additional files
    const requestedFiles = parseFileRequests(fullResponse);
    let additionalFilesLoaded = [];
    
    if (requestedFiles.length > 0 && repo) {
      console.log(`[Chat] AI requested files: ${requestedFiles.join(', ')}`);
      res.write(`data: ${JSON.stringify({ type: "status", status: `Loading ${requestedFiles.length} requested files...` })}\n\n`);
      
      for (const fp of requestedFiles) {
        if (!fileContents[fp]) {
          try {
            const content = await getFileFromGitHub(repo, fp);
            fileContents[fp] = content;
            additionalFilesLoaded.push(fp);
            const displayContent = content.length > 5000 ? content.slice(0, 5000) + '\n... (truncated)' : content;
            fullResponse += `\n\n---\n📄 **${fp}:**\n\`\`\`\n${displayContent}\n\`\`\`\n`;
            res.write(`data: ${JSON.stringify({ type: "text", text: `\n\n---\n📄 **${fp}:**\n\`\`\`\n${displayContent}\n\`\`\`\n` })}\n\n`);
          } catch (err) {
            console.log(`[Chat] Failed to load requested file ${fp}: ${err.message}`);
            fullResponse += `\n\n⚠️ Could not load ${fp}: ${err.message}`;
            res.write(`data: ${JSON.stringify({ type: "text", text: `\n\n⚠️ Could not load ${fp}: ${err.message}` })}\n\n`);
          }
        }
      }
      conversation.loadedFiles = [...new Set([...(conversation.loadedFiles || []), ...additionalFilesLoaded])];
    }

    const cost = calculateCost(modelConfig, metadata.inputTokens || 0, metadata.outputTokens || 0);
    await updateStats(modelKey, metadata.inputTokens || 0, metadata.outputTokens || 0, cost, projectId);
    if (projectId) await updateProjectCost(projectId, cost);

    let projectCreated = null;
    const createMatch = fullResponse.match(/CREATE_PROJECT:(\{[\s\S]*?\})/);
    if (createMatch) {
      try {
        const projectData = JSON.parse(createMatch[1]);
        const createRes = await fetch(`http://localhost:${PORT}/api/projects/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...projectData, planningSpec: conversation.messages.map(m => `${m.role}: ${m.content}`).join("\n\n") })
        });
        const createResult = await createRes.json();
        if (createResult.ok) {
          projectCreated = createResult;
          fullResponse = fullResponse.replace(/CREATE_PROJECT:\{[\s\S]*?\}/, `\n\n✅ **Project Created!** Repository: [${createResult.repoFullName}](https://github.com/${createResult.repoFullName})`);
        }
      } catch (e) { console.error("Failed to create project", e); }
    }

    conversation.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), model: modelConfig.displayName });
    conversation.updatedAt = new Date().toISOString();
    if (projectCreated) { conversation.projectId = projectCreated.project.id; conversation.repoFullName = projectCreated.repoFullName; }
    conversations[conversationIdx] = conversation;
    await writeJson(conversationsPath, conversations);

    res.write(`data: ${JSON.stringify({ type: "done", model: modelConfig.displayName, modelKey, cost, inputTokens: metadata.inputTokens, outputTokens: metadata.outputTokens, projectCreated, additionalFilesLoaded })}\n\n`);
    res.end();
  } catch (err) {
    console.error("[Chat] Error:", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

app.post("/api/apply-change", async (req, res) => {
  const { repoFullName, filePath, newContent, commitMessage } = req.body;
  if (!repoFullName || !filePath || newContent === undefined) return res.status(400).json({ error: "repoFullName, filePath, newContent required" });
  try {
    const result = await createOrUpdateFile(repoFullName, filePath, newContent, commitMessage || `Update ${filePath}`);
    res.json({ ok: true, path: result.content?.path || filePath, commitSha: result.commit?.sha, commitUrl: result.commit?.html_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 AI Code Helper running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Admin panel at http://0.0.0.0:${PORT}/admin`);
  console.log("\nProvider Status:");
  console.log(`  OpenAI:    ${providerStatus.openai ? "✓" : "✗"}`);
  console.log(`  Anthropic: ${providerStatus.anthropic ? "✓" : "✗"}`);
  console.log(`  Google:    ${providerStatus.google ? "✓" : "✗"}`);
});
