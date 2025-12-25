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

## IMPORTANT: Applying Code Changes
When you show code in a code block, the user will see an "Apply" button next to it.
- Clicking "Apply" will DIRECTLY COMMIT the code to their GitHub repository
- You do NOT need to manually push changes - the system handles it automatically
- Always include a filepath comment at the top so the system knows where to save it
- The user just clicks "Apply" and it's done!

## When Showing Code Changes
Show the complete file with a filepath comment:
ALWAYS include the filepath as the first line comment so the Apply button works:
\`\`\`javascript
// filepath: src/components/Button.jsx
import React from 'react';
