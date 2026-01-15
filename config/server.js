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

// Resolve project root (one level above this /config folder).
const ROOT_DIR = path.resolve(__dirname, '..');

let providerStatus = initializeProviders();

// Persist all runtime state (conversations, projects, stats, admin password, etc.)
// to a stable directory. On Railway, this should point at your mounted volume.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');

// Model routing/config lives in a JSON file. We bootstrap it into DATA_DIR on first run
// so admin changes survive redeploys.
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config', 'models.json');
const LEGACY_DEFAULT_CONFIG_PATH = path.join(__dirname, 'models.json');

async function getBundledDefaultsPath() {
  for (const candidate of [DEFAULT_CONFIG_PATH, LEGACY_DEFAULT_CONFIG_PATH]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}
const CONFIG_PATH = path.join(DATA_DIR, 'models.json');

// Secrets (hashed admin password + optional provider keys if you choose to store them)
// are stored in DATA_DIR so they persist across deploys without committing to git.
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
const LEGACY_SECRETS_PATH = path.join(__dirname, 'config', 'secrets.json');

const conversationsPath = path.join(DATA_DIR, 'conversations.json');
const projectsPath = path.join(DATA_DIR, 'projects.json');
const statsPath = path.join(DATA_DIR, 'stats.json');

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

const IMPORTANT_DIRS = ['src', 'app', 'pages', 'components', 'lib', 'utils', 'api', 'routes', 'models', 'services'];

async function loadConfig() {
  try {
    const text = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    // If we haven't bootstrapped config yet, fall back to the bundled default.
    const fallbackPath = (await getBundledDefaultsPath()) || DEFAULT_CONFIG_PATH;
    const text = await fs.readFile(fallbackPath, 'utf8');
    return JSON.parse(text);
  }
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function looksLikeLegacyDefaults(cfg){
  const m = cfg?.models || {};
  return (
    m.fast?.provider === 'google' && m.fast?.model === 'gemini-2.0-flash' &&
    m.full?.provider === 'anthropic' && m.full?.model === 'claude-sonnet-4-20250514' &&
    m.fallback?.provider === 'openai' && m.fallback?.model === 'gpt-4o'
  );
}

async function configMeta(cfg){
  const persisted = await fs.access(CONFIG_PATH).then(()=>true).catch(()=>false);
  return {
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    defaultConfigPath: DEFAULT_CONFIG_PATH,
    legacyDefaultConfigPath: LEGACY_DEFAULT_CONFIG_PATH,
    isPersisted: persisted,
    isLegacyDefaults: looksLikeLegacyDefaults(cfg),
  };
}

async function loadSecrets() {
  try {
    const text = await fs.readFile(SECRETS_PATH, 'utf8');
    const parsed = JSON.parse(text);
    return {
      adminPassword: parsed.adminPassword || null,
      apiKeys: parsed.apiKeys || {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;

    // Migrate legacy secrets if they exist (older builds stored them under /config/config).
    try {
      const legacyText = await fs.readFile(LEGACY_SECRETS_PATH, 'utf8');
      const legacy = JSON.parse(legacyText);
      const migrated = {
        adminPassword: legacy.adminPassword || null,
        apiKeys: legacy.apiKeys || legacy.keys || {},
      };
      await saveSecrets(migrated);
      return migrated;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('Legacy secrets read failed:', e.message);
    }

    return { adminPassword: null, apiKeys: {} };
  }
}

async function saveSecrets(secrets) {
  const normalized = {
    adminPassword: secrets.adminPassword || null,
    apiKeys: secrets.apiKeys || {},
  };
  await fs.writeFile(SECRETS_PATH, JSON.stringify(normalized, null, 2), 'utf8');
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
// Bootstrap persisted config file into DATA_DIR on first run.
try {
  await fs.access(CONFIG_PATH);
} catch (err) {
  try {
    const bundled = await getBundledDefaultsPath();
    if (!bundled) throw new Error('No bundled models.json found under /config.');
    const base = await fs.readFile(bundled, 'utf8');
    await fs.writeFile(CONFIG_PATH, base, 'utf8');
    console.log(`[boot] created ${CONFIG_PATH} from ${bundled}`);
  } catch (e) {
    console.warn('[boot] failed to bootstrap models.json:', e.message);
  }
}


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


function encodeGitHubRefName(refName) {
  return (refName || "").split("/").map(encodeURIComponent).join("/");
}

function normalizeRepoFilePath(filePath) {
  if (typeof filePath !== "string") throw new Error("filePath must be a string");
  let p = filePath.replace(/\\/g, "/").trim();
  if (p.startsWith("./")) p = p.slice(2);
  if (!p) throw new Error("filePath is empty");
  if (p.startsWith("/")) throw new Error("filePath must be relative (no leading /)");
  // Prevent traversal.
  const parts = p.split("/");
  for (const part of parts) {
    if (!part) throw new Error("filePath contains empty path segment");
    if (part === "." || part === "..") throw new Error("filePath contains invalid segment");
  }
  if (p.includes("/.git/") || p.startsWith(".git/")) throw new Error("Refusing to write into .git/");
  return p;
}

function makeAiBranchName(conversationId) {
  const safe = (conversationId || "adhoc")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .slice(0, 40) || "adhoc";
  const ts = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
  return `ai/${safe}-${ts}`;
}

async function getRepoInfo(repoFullName) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);
  return fetchGitHubJson(`https://api.github.com/repos/${owner}/${repo}`, token);
}

async function getBranchHeadSha(repoFullName, branch) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);
  const ref = await fetchGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeGitHubRefName(branch)}`,
    token
  );
  return ref?.object?.sha;
}

async function createBranchFrom(repoFullName, newBranch, fromBranch) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);

  const baseSha = await getBranchHeadSha(repoFullName, fromBranch);
  if (!baseSha) throw new Error(`Could not resolve base branch SHA for ${fromBranch}`);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: baseSha }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create branch: ${res.status} ${body}`);
  }
  return res.json();
}

async function createOrUpdateFileInBranch(repoFullName, branch, filePath, content, message) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);

  const safePath = normalizeRepoFilePath(filePath);
  const urlBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGitHubPath(safePath)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  let sha;
  try {
    const existing = await fetch(`${urlBase}?ref=${encodeURIComponent(branch)}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    });
    if (existing.ok) sha = (await existing.json()).sha;
  } catch {}

  const body = {
    message,
    content: Buffer.from(content ?? "", "utf8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(urlBase, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Failed to write ${safePath}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteFileInBranch(repoFullName, branch, filePath, message) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);

  const safePath = normalizeRepoFilePath(filePath);
  const urlBase = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGitHubPath(safePath)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const existing = await fetch(`${urlBase}?ref=${encodeURIComponent(branch)}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    });
  if (!existing.ok) throw new Error(`Cannot delete ${safePath}: ${existing.status} ${await existing.text()}`);
  const existingJson = await existing.json();
  const sha = existingJson.sha;
  if (!sha) throw new Error(`Cannot delete ${safePath}: missing sha`);

  const res = await fetch(urlBase, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok) throw new Error(`Failed to delete ${safePath}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createDraftPullRequest(repoFullName, headBranch, baseBranch, title, body) {
  const token = await getGitHubToken();
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const { owner, repo } = parseRepoFullName(repoFullName);

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: title || "AI changes",
      head: `${owner}:${headBranch}`,
      base: baseBranch,
      body: body || "",
      draft: true,
    }),
  });

  if (!res.ok) throw new Error(`Failed to create PR: ${res.status} ${await res.text()}`);
  return res.json();
}

async function applyChangesAsDraftPR({ repoFullName, conversationId, prTitle, prBody, changes }) {
  if (!repoFullName) throw new Error("repoFullName is required");
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("changes must be a non-empty array");

  const repoInfo = await getRepoInfo(repoFullName);
  const baseBranch = repoInfo.default_branch;
  if (!baseBranch) throw new Error("Could not resolve default branch");

  let branchName = makeAiBranchName(conversationId);
  // Ensure unique branch if name already exists.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await createBranchFrom(repoFullName, branchName, baseBranch);
      break;
    } catch (e) {
      const msg = String(e.message || "");
      if (msg.includes("Reference already exists") || msg.includes("422")) {
        branchName = `${branchName}-${Math.random().toString(36).slice(2, 6)}`;
        continue;
      }
      throw e;
    }
  }

  const applied = [];
  for (const ch of changes) {
    const action = (ch.action || "upsert").toLowerCase();
    const filePath = normalizeRepoFilePath(ch.filePath || ch.path);
    if (action === "delete") {
      await deleteFileInBranch(repoFullName, branchName, filePath, ch.commitMessage || `Delete ${filePath}`);
      applied.push({ filePath, action: "delete" });
    } else {
      await createOrUpdateFileInBranch(repoFullName, branchName, filePath, ch.content ?? "", ch.commitMessage || `Update ${filePath}`);
      applied.push({ filePath, action: "upsert" });
    }
  }

  const pr = await createDraftPullRequest(
    repoFullName,
    branchName,
    baseBranch,
    prTitle || `AI changes (${conversationId || "adhoc"})`,
    prBody || `Draft PR created by AI Code Helper.\n\nConversation: ${conversationId || "adhoc"}\n\nFiles:\n${applied.map(a => `- ${a.action.toUpperCase()}: ${a.filePath}`).join("\n")}`
  );

  return { branchName, baseBranch, prUrl: pr.html_url, prNumber: pr.number, prTitle: pr.title, applied };
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
  
  AUTO_LOAD_FILES.always.forEach(f => addIfExists(f));
  AUTO_LOAD_FILES.config.forEach(f => addIfExists(f));
  
  if (["Node.js", "Next.js", "Vite", "Remix", "Nuxt", "SvelteKit"].includes(stack)) {
    AUTO_LOAD_FILES.node.forEach(f => addIfExists(f));
  }
  if (stack === "Python") AUTO_LOAD_FILES.python.forEach(f => addIfExists(f));
  if (stack === "Rust") AUTO_LOAD_FILES.rust.forEach(f => addIfExists(f));
  if (stack === "Go") AUTO_LOAD_FILES.go.forEach(f => addIfExists(f));
  
  const entryPoints = [
    'src/index.js', 'src/index.ts', 'src/index.tsx', 'src/main.js', 'src/main.ts', 'src/main.tsx',
    'src/App.js', 'src/App.tsx', 'src/app.js', 'src/app.tsx',
    'app/layout.tsx', 'app/layout.js', 'app/page.tsx', 'app/page.js',
    'pages/index.js', 'pages/index.tsx', 'pages/_app.js', 'pages/_app.tsx',
    'index.js', 'index.ts', 'main.py', 'app.py', 'main.go', 'src/main.rs', 'src/lib.rs',
    'server.js', 'server.ts', 'app.js', 'app.ts'
  ];
  entryPoints.forEach(f => addIfExists(f));
  
  for (const dir of IMPORTANT_DIRS) {
    const dirFiles = filePaths.filter(f => f.startsWith(dir + '/') && !f.includes('test') && !f.includes('spec'));
    const indexFiles = dirFiles.filter(f => f.match(/\/(index|main)\.(js|ts|tsx|py|go|rs)$/));
    indexFiles.slice(0, 2).forEach(f => addIfExists(f));
    if (selected.length < maxFiles) dirFiles.slice(0, 2).forEach(f => addIfExists(f));
  }
  
  return selected.slice(0, maxFiles);
}

function parseFileRequests(response) {
  const patterns = [
  // Support multiple syntaxes so "open file" works reliably across models/prompts.
  // Preferred: [READ_FILE: path/to/file]
    /\[(?:READ|LOAD|VIEW|OPEN)_FILE:\s*([^\]]+)\]/gi,
    /\bOPEN_FILE:\s*([^\n\r]+)\b/gi,
    /\/(?:open|read)\s+([^\s]+)\b/gi
  ];
  const files = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const file = match[1].trim();
      if (file && !files.includes(file)) files.push(file);
    }
  }
  return files;
}


// ------------------------------
// Token budgeting / context packing (approximate, but effective)
// ------------------------------
function approxTokensFromText(text) {
  // Rough heuristic: ~4 chars/token for English/code mixed.
  // This intentionally errs on the side of "too many" to avoid provider 400s.
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function approxTokensFromMessages(messages = []) {
  let total = 0;
  for (const m of messages) {
    total += 8; // small per-message overhead
    total += approxTokensFromText(m?.content);
  }
  return total;
}

function stripBigCodeBlocks(text, { maxBlockChars = 1500 } = {}) {
  if (!text || typeof text !== 'string') return text;
  // Replace large fenced code blocks with a short placeholder to preserve narrative.
  return text.replace(/```([\s\S]*?)```/g, (m, inner) => {
    if (inner.length <= maxBlockChars) return m;
    const head = inner.slice(0, Math.min(400, inner.length));
    return "```\n" + head + "\n... (code block omitted from context)\n```";
  });
}

function prepareMessagesForModel(conversationMessages, { systemPrompt, modelConfig }) {
  const contextWindow = modelConfig?.contextWindow || 200000;
  const reservedOut = modelConfig?.maxOutputTokens || 8192;
  const safetyMargin = 2000;

  const maxInputBudget = Math.max(8000, contextWindow - reservedOut - safetyMargin);
  const systemTokens = approxTokensFromText(systemPrompt);
  let budgetForMessages = maxInputBudget - systemTokens;

  if (budgetForMessages < 2000) budgetForMessages = 2000;

  const src = Array.isArray(conversationMessages) ? conversationMessages : [];
  const trimmed = [];

  // Keep the most recent messages first, drop older ones until we fit.
  // Also strip huge code blocks from older assistant messages (beyond the last few turns).
  const keepUnstripped = 8;
  for (let i = src.length - 1; i >= 0; i--) {
    const msg = { ...src[i] };
    const ageFromEnd = (src.length - 1) - i;
    if (msg.role === 'assistant' && ageFromEnd > keepUnstripped) {
      msg.content = stripBigCodeBlocks(msg.content);
    }
    const msgTokens = approxTokensFromText(msg.content) + 8;
    if (approxTokensFromMessages(trimmed) + msgTokens > budgetForMessages) break;
    trimmed.unshift(msg);
  }

  const droppedCount = src.length - trimmed.length;
  return { messages: trimmed, droppedCount, maxInputBudget, systemTokens };
}

function isTokenLimitError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  return msg.includes('input tokens exceed') || msg.includes('context length') || msg.includes('maximum context') || msg.includes('too many tokens') || msg.includes('token limit');
}

function cleanFileRequestTags(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\[(?:READ|LOAD|VIEW|OPEN)_FILE:[^\]]+\]/gi, '')
    .replace(/\bOPEN_FILE:[^\n\r]+\b/gi, '')
    .replace(/\/(?:open|read)\s+[^\s]+\b/gi, '')
    .trim();
}

function buildSystemPrompt(repoFullName, filePaths, stack, fileContents = {}, mode = "building") {
  let prompt = mode === "planning" 
    ? `You are an expert software architect helping plan a new application. Ask clarifying questions, recommend tech stack, and create a project plan. When ready, output: CREATE_PROJECT:{"name":"repo-name","description":"...","stack":"...","features":[...],"pages":[...]}`
    : `You are an expert full-stack engineer with FULL ACCESS to read any file in this repository.

## Your Capabilities
- You can see the complete file structure below
- Key project files have been pre-loaded for you
- To see ANY other file, use: [READ_FILE: path/to/file]
- The system will automatically load requested files

## When You Need More Files
Just say: [READ_FILE: src/components/Button.tsx]
You can request multiple: [READ_FILE: src/utils/api.ts] [READ_FILE: src/hooks/useAuth.ts]

## Code Changes
When modifying code, show the complete file:
\`\`\`javascript
// filepath: src/components/Button.jsx
// ... complete file content
\`\`\`
`;

  if (repoFullName) {
    prompt += `\n## Project: ${repoFullName}`;
    if (stack && stack !== "Unknown") prompt += ` (${stack})`;
    prompt += "\n";
  }

  if (filePaths?.length > 0) {
    prompt += `\n## Repository Structure (${filePaths.length} files)\n\`\`\`\n`;
    const dirs = {};
    filePaths.forEach(p => {
      const parts = p.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push(parts[parts.length - 1]);
    });
    Object.keys(dirs).sort().slice(0, 50).forEach(dir => {
      if (dir === '.') dirs[dir].forEach(f => prompt += `${f}\n`);
      else {
        prompt += `${dir}/\n`;
        dirs[dir].slice(0, 10).forEach(f => prompt += `  ${f}\n`);
        if (dirs[dir].length > 10) prompt += `  ... and ${dirs[dir].length - 10} more\n`;
      }
    });
    prompt += "```\n";
  }

  if (Object.keys(fileContents).length > 0) {
    prompt += "\n## Pre-loaded Files\n";
    for (const [fp, content] of Object.entries(fileContents)) {
      const ext = fp.split('.').pop();
      const maxChars = 25000;
      const hardMax = 60000;
      let truncated = content;
      if (content.length > maxChars) {
        // Keep head+tail so the model sees imports/exports and end-of-file behaviors.
        const head = content.slice(0, Math.min(18000, content.length));
        const tailLen = Math.min(8000, content.length);
        const tail = content.slice(content.length - tailLen);
        truncated = head + "\n\n... (truncated: request the file again for full content) ...\n\n" + tail;
        if (truncated.length > hardMax) truncated = truncated.slice(0, hardMax) + "\n... (hard truncated)";
      }
      prompt += `### ${fp}\n\`\`\`${ext}\n${truncated}\n\`\`\`\n\n`;
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
const PUBLIC_DIR = await (async () => {
  // Single source of truth: serve ONLY from /config/public (this file lives in /config).
  // You may override with STATIC_DIR, but ROOT/public is intentionally disabled to avoid confusion.
  const rootPublic = path.join(ROOT_DIR, 'public');
  const preferred = path.join(__dirname, 'public'); // /config/public

  // Warn if legacy ROOT/public exists; it is ignored.
  try {
    await fs.access(rootPublic);
    console.warn(`[static] Found legacy static dir at ${rootPublic} (ignored). UI is served from ${preferred}.`);
  } catch {}

  const override = process.env.STATIC_DIR;
  if (override) {
    const candidate = path.isAbsolute(override) ? override : path.join(ROOT_DIR, override);
    if (path.resolve(candidate) === path.resolve(rootPublic)) {
      throw new Error(`[static] STATIC_DIR points to ${rootPublic}, which is disabled. Use STATIC_DIR=config/public instead.`);
    }
    await fs.access(candidate);
    return candidate;
  }

  // Default: /config/public must exist.
  await fs.access(preferred);
  return preferred;
})();

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

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
    const meta = await configMeta(config);
    res.json({
      models: config.models,
      routing: config.routing,
      templates: config.templates,
      providers: {
        openai: providerStatus.openai || false,
        anthropic: providerStatus.anthropic || false,
        google: providerStatus.google || false
      },
      _meta: meta
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

app.post("/api/config/reset", requireAdminAuth, async (req, res) => {
  try{
    const bundled = await getBundledDefaultsPath();
    if (!bundled) throw new Error("No bundled models.json found under /config.");
    const base = await fs.readFile(bundled, 'utf8');
    const parsed = JSON.parse(base);
    await saveConfig(parsed);
    const meta = await configMeta(parsed);
    res.json({ ok: true, config: { ...parsed, _meta: meta } });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
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
        
        // Smart auto-load key files
        const autoLoadList = selectFilesToAutoLoad(filePaths, stack);
        const previouslyLoaded = Array.isArray(conversation.loadedFiles) ? conversation.loadedFiles : [];
        const MAX_PERSISTED_OPEN_FILES = 8;
        const MAX_FILES_TO_LOAD = 16;
        const trimmedPrev = previouslyLoaded.slice(-MAX_PERSISTED_OPEN_FILES);
        const allToLoad = [...new Set([...autoLoadList, ...loadedFiles, ...trimmedPrev])].slice(0, MAX_FILES_TO_LOAD);
        
        res.write(`data: ${JSON.stringify({ type: "status", status: `Loading ${allToLoad.length} project files...` })}\n\n`);
        
        for (const fp of allToLoad) {
          try { fileContents[fp] = await getFileFromGitHub(repo, fp); }
          catch (err) { console.warn(`Could not load ${fp}`, err.message); }
        }
        
        conversation.loadedFiles = Object.keys(fileContents).slice(-24);
      } catch (err) { console.warn("Could not list files", err.message); }
    }

    const systemPrompt = buildSystemPrompt(repo, filePaths, stack, fileContents, mode);
    conversation.messages.push({ role: "user", content: message, timestamp: new Date().toISOString() });

    // Pack context and, if necessary, auto-switch to a larger-context model to prevent hard failures.
    let packed = prepareMessagesForModel(conversation.messages, { systemPrompt, modelConfig });
    let messagesForModel = packed.messages;

    // If still too large for the chosen model, try the Gemini "fast" model which has a much larger context window.
    const estInputTokens = packed.systemTokens + approxTokensFromMessages(messagesForModel);
    const currentLimit = (modelConfig.contextWindow || 200000) - (modelConfig.maxOutputTokens || 8192) - 2000;
    if (estInputTokens > currentLimit) {
      const fastModel = config.models?.fast;
      if (fastModel && isProviderAvailable(fastModel.provider) && (fastModel.contextWindow || 0) >= (modelConfig.contextWindow || 0)) {
        modelKey = "fast";
        modelConfig = fastModel;
        routeReason = `Auto: context too large (~${estInputTokens} tokens est) -> ${fastModel.displayName}`;
        packed = prepareMessagesForModel(conversation.messages, { systemPrompt, modelConfig });
        messagesForModel = packed.messages;
      }
    }

    if (packed.droppedCount > 0) {
      res.write(`data: ${JSON.stringify({ type: "status", status: `Trimmed ${packed.droppedCount} older messages to fit context` })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: "start", conversationId: conversation.id, model: modelConfig.displayName, routeReason, filesLoaded: Object.keys(fileContents).length })}\n\n`);

    let fullResponse = "", metadata = {};
    try {
      for await (const chunk of streamCompletion(modelConfig, systemPrompt, messagesForModel, modelConfig.maxOutputTokens)) {
        if (chunk.type === "text") {
          fullResponse += chunk.text;
          res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
        } else if (chunk.type === "done") {
          metadata = chunk;
        }
      }
    } catch (err) {
      // If the selected model throws a context-length error, transparently retry with Gemini (huge context) instead of failing the request.
      if (isTokenLimitError(err)) {
        const fastModel = config.models?.fast;
        if (fastModel && isProviderAvailable(fastModel.provider) && modelKey !== "fast") {
          res.write(`data: ${JSON.stringify({ type: "status", status: `Context too large for ${modelConfig.displayName}. Retrying with ${fastModel.displayName}...` })}\n\n`);
          modelKey = "fast";
          modelConfig = fastModel;
          routeReason = `Auto-retry: token limit -> ${fastModel.displayName}`;
          res.write(`data: ${JSON.stringify({ type: "start", conversationId: conversation.id, model: modelConfig.displayName, routeReason, filesLoaded: Object.keys(fileContents).length })}\n\n`);
          packed = prepareMessagesForModel(conversation.messages, { systemPrompt, modelConfig });
          messagesForModel = packed.messages;
          fullResponse = "";
          metadata = {};
          for await (const chunk of streamCompletion(modelConfig, systemPrompt, messagesForModel, modelConfig.maxOutputTokens)) {
            if (chunk.type === "text") {
              fullResponse += chunk.text;
              res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
            } else if (chunk.type === "done") {
              metadata = chunk;
            }
          }
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

// Check if AI requested additional files
    const requestedFiles = parseFileRequests(fullResponse);
    let additionalFilesLoaded = [];
    let continuationResponse = "";
    let metadata2 = {};

    if (requestedFiles.length > 0 && repo) {
      res.write(`data: ${JSON.stringify({ type: "status", status: `Loading ${requestedFiles.length} requested files...` })}\n\n`);

      for (const fpRaw of requestedFiles) {
        const fp = String(fpRaw || '').trim();
        if (!fp) continue;
        if (!fileContents[fp]) {
          try {
            const content = await getFileFromGitHub(repo, fp);
            fileContents[fp] = content;
            additionalFilesLoaded.push(fp);

            // Show a preview to the user, but DO NOT store it in conversation history (prevents token bloat).
            const preview = content.length > 5000 ? content.slice(0, 5000) + '\n... (preview truncated)' : content;
            res.write(`data: ${JSON.stringify({ type: "text", text: `\n\n---\n📄 **${fp}:**\n\`\`\`\n${preview}\n\`\`\`\n` })}\n\n`);
          } catch (err) {
            res.write(`data: ${JSON.stringify({ type: "text", text: `\n\n⚠️ Could not load ${fp}: ${err.message}` })}\n\n`);
          }
        }
      }

      conversation.loadedFiles = [...new Set([...(Array.isArray(conversation.loadedFiles) ? conversation.loadedFiles : []), ...additionalFilesLoaded])].slice(-24);
    }

    // If we loaded files, do one "auto-continue" pass so the model can actually use them.
    if (additionalFilesLoaded.length > 0 && repo) {
      res.write(`data: ${JSON.stringify({ type: "status", status: `Continuing with loaded files...` })}\n\n`);

      const systemPrompt2 = buildSystemPrompt(repo, filePaths, stack, fileContents, mode);

      const internalInstruction = [
        "The system has loaded the following files you requested:",
        ...additionalFilesLoaded.map(f => `- ${f}`),
        "",
        "Continue the work now that these files are available.",
        "Do not reprint the file contents unless asked.",
        "If you still need more files, request them using [READ_FILE: path/to/file]."
      ].join("\n");

      const messages2 = [...conversation.messages, { role: "user", content: internalInstruction, timestamp: new Date().toISOString() }];

      let packed2 = prepareMessagesForModel(messages2, { systemPrompt: systemPrompt2, modelConfig });
      let messagesForModel2 = packed2.messages;

      // If continuation would overflow this model, switch to fast Gemini.
      const est2 = packed2.systemTokens + approxTokensFromMessages(messagesForModel2);
      const limit2 = (modelConfig.contextWindow || 200000) - (modelConfig.maxOutputTokens || 8192) - 2000;
      if (est2 > limit2) {
        const fastModel = config.models?.fast;
        if (fastModel && isProviderAvailable(fastModel.provider) && modelKey !== "fast") {
          modelKey = "fast";
          modelConfig = fastModel;
          routeReason = `Auto: continuation context too large -> ${fastModel.displayName}`;
          packed2 = prepareMessagesForModel(messages2, { systemPrompt: systemPrompt2, modelConfig });
          messagesForModel2 = packed2.messages;
        }
      }

      try {
        for await (const chunk of streamCompletion(modelConfig, systemPrompt2, messagesForModel2, modelConfig.maxOutputTokens)) {
          if (chunk.type === "text") {
            continuationResponse += chunk.text;
            res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
          } else if (chunk.type === "done") {
            metadata2 = chunk;
          }
        }
      } catch (err) {
        // If continuation hits token limit, retry with Gemini.
        if (isTokenLimitError(err)) {
          const fastModel = config.models?.fast;
          if (fastModel && isProviderAvailable(fastModel.provider) && modelKey !== "fast") {
            res.write(`data: ${JSON.stringify({ type: "status", status: `Continuation exceeded context. Retrying with ${fastModel.displayName}...` })}\n\n`);
            modelKey = "fast";
            modelConfig = fastModel;
            routeReason = `Auto-retry: continuation token limit -> ${fastModel.displayName}`;
            res.write(`data: ${JSON.stringify({ type: "start", conversationId: conversation.id, model: modelConfig.displayName, routeReason, filesLoaded: Object.keys(fileContents).length })}\n\n`);
            packed2 = prepareMessagesForModel(messages2, { systemPrompt: systemPrompt2, modelConfig });
            messagesForModel2 = packed2.messages;
            continuationResponse = "";
            metadata2 = {};
            for await (const chunk of streamCompletion(modelConfig, systemPrompt2, messagesForModel2, modelConfig.maxOutputTokens)) {
              if (chunk.type === "text") {
                continuationResponse += chunk.text;
                res.write(`data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`);
              } else if (chunk.type === "done") {
                metadata2 = chunk;
              }
            }
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    // Clean stored response: remove file-request tags and do not include file previews.
    fullResponse = cleanFileRequestTags(fullResponse);
    if (continuationResponse) {
      fullResponse = (fullResponse ? fullResponse + "\n\n" : "") + continuationResponse;
    }

const totalInputTokens = (metadata.inputTokens || 0) + (metadata2.inputTokens || 0);
    const totalOutputTokens = (metadata.outputTokens || 0) + (metadata2.outputTokens || 0);
    const cost = calculateCost(modelConfig, totalInputTokens, totalOutputTokens);
    await updateStats(modelKey, totalInputTokens, totalOutputTokens, cost, projectId);
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

    res.write(`data: ${JSON.stringify({ type: "done", model: modelConfig.displayName, modelKey, cost, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, projectCreated, additionalFilesLoaded })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Chat error", err);
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});



app.post("/api/apply-pr", async (req, res) => {
  const { repoFullName, conversationId, title, body, changes } = req.body || {};
  if (!repoFullName) return res.status(400).json({ error: "repoFullName required" });
  if (!Array.isArray(changes) || changes.length === 0) return res.status(400).json({ error: "changes must be a non-empty array" });

  try {
    // Basic guardrails
    if (changes.length > 50) return res.status(400).json({ error: "Too many changes in one PR (max 50)" });

    const normalized = changes.map((c) => {
      const filePath = normalizeRepoFilePath(c.filePath || c.path || "");
      const action = (c.action || "upsert").toLowerCase();
      const content = c.content ?? "";
      if (action !== "upsert" && action !== "delete") throw new Error(`Invalid action for ${filePath}`);
      if (action === "upsert" && typeof content !== "string") throw new Error(`Content for ${filePath} must be a string`);
      if (action === "upsert" && content.length > 750000) throw new Error(`File too large to apply safely: ${filePath}`);
      return {
        filePath,
        action,
        content,
        commitMessage: c.commitMessage,
      };
    });

    const result = await applyChangesAsDraftPR({
      repoFullName,
      conversationId,
      prTitle: title,
      prBody: body,
      changes: normalized,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/apply-change", async (req, res) => {
  // Legacy endpoint: kept for backwards compatibility.
  // SAFETY: never commits to default branch; always creates a draft PR.
  const { repoFullName, filePath, newContent, commitMessage, conversationId } = req.body || {};
  if (!repoFullName || !filePath || newContent === undefined) return res.status(400).json({ error: "repoFullName, filePath, newContent required" });
  try {
    const result = await applyChangesAsDraftPR({
      repoFullName,
      conversationId,
      prTitle: `AI change: ${filePath}`,
      changes: [{
        filePath,
        action: "upsert",
        content: String(newContent),
        commitMessage: commitMessage || `Update ${filePath} via AI Code Helper`,
      }],
    });
    res.json({ ok: true, prUrl: result.prUrl, branchName: result.branchName, baseBranch: result.baseBranch, applied: result.applied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 AI Code Helper running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Admin panel at http://0.0.0.0:${PORT}/admin`);
  console.log("\nProvider Status:");
  console.log(`  OpenAI:    ${providerStatus.openai ? "✓" : "✗"}`);
  console.log(`  Anthropic: ${providerStatus.anthropic ? "✓" : "✗"}`);
  console.log(`  Google:    ${providerStatus.google ? "✓" : "✗"}`);
});
