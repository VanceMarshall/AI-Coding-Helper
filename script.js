// filepath: server.js
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
    'pages/index.js', 'pages/index.tsx', 'pages/_app.js', 'pages/_app.tsx'
  ];
  entryPoints.forEach(f => addIfExists(f));
  
  // Look for important directories and add key files
  const remainingSlots = maxFiles - selected.length;
  if (remainingSlots > 0) {
    const candidates = filePaths
      .filter(f => !selected.includes(f))
      .filter(f => {
        const parts = f.split('/');
        return parts.some(part => IMPORTANT_DIRS.includes(part)) || 
               f.endsWith('.js') || f.endsWith('.ts') || f.endsWith('.tsx') || 
               f.endsWith('.jsx') || f.endsWith('.py') || f.endsWith('.go') || f.endsWith('.rs');
      })
      .slice(0, remainingSlots);
    
    selected.push(...candidates);
  }
  
  return selected.slice(0, maxFiles);
}

// Parse code blocks from message content to extract file information
function parseCodeBlocks(content) {
  const codeBlocks = [];
  const codeBlockRegex = /```(\w+)?\s*(?:\/\/\s*filepath:\s*([^\n]+))?\n([\s\S]*?)```/g;
  let match;
  
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const [, language, filepath, code] = match;
    if (filepath && filepath.trim()) {
      codeBlocks.push({
        language: language || 'text',
        filepath: filepath.trim(),
        code: code.trim(),
        id: createId()
      });
    }
  }
  
  return codeBlocks;
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Admin routes
app.post("/admin/login", async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    
    const secrets = await loadSecrets();
    if (!secrets.adminPassword) {
      // First time setup
      secrets.adminPassword = password;
      await saveSecrets(secrets);
      const sessionToken = generateSessionToken();
      adminSessions.set(sessionToken, { expires: Date.now() + SESSION_DURATION });
      return res.json({ sessionToken, firstTime: true });
    }
    
    if (secrets.adminPassword !== password) {
      return res.status(401).json({ error: "Invalid password" });
    }
    
    const sessionToken = generateSessionToken();
    adminSessions.set(sessionToken, { expires: Date.now() + SESSION_DURATION });
    res.json({ sessionToken });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/admin/stats", requireAdminAuth, async (req, res) => {
  try {
    const config = await loadConfig();
    const secrets = await loadSecrets();
    const stats = await readJson(statsPath, { totalCost: 0, totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, breakdown: {} });
    
    const apiKeys = await Promise.all([
      { provider: "openai", name: "OpenAI" },
      { provider: "anthropic", name: "Anthropic" },
      { provider: "google", name: "Google" },
      { provider: "github", name: "GitHub" }
    ].map(async ({ provider, name }) => {
      const { key, source } = await getApiKeyWithFallback(provider);
      return {
        provider,
        name,
        maskedKey: maskKey(key),
        source,
        connected: !!key
      };
    }));
    
    res.json({
      providers: await reloadProvidersWithSecrets(),
      apiKeys,
      models: config.models,
      stats
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

app.post("/admin/create-repo", requireAdminAuth, async (req, res) => {
  try {
    const { name, description, private: isPrivate } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: "Repository name is required" });
    }
    
    const repo = await createGitHubRepo(name, description, isPrivate);
    res.json(repo);
  } catch (err) {
    console.error("Create repo error:", err);
    res.status(500).json({ error: err.message });
  }
});

// API routes
app.get("/api/repos", async (req, res) => {
  try {
    const repos = await listRepos();
    res.json(repos);
  } catch (err) {
    console.error("Repos error:", err);
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

app.post("/api/repos/:owner/:repo/file", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { filePath } = req.body;
    const content = await getFileFromGitHub(`${owner}/${repo}`, filePath);
    res.json({ content });
  } catch (err) {
    console.error("Get file error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/repos/:owner/:repo/create-file", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { filePath, content, message = "Create file via AI Code Helper" } = req.body;
    const result = await createOrUpdateFile(`${owner}/${repo}`, filePath, content, message);
    res.json(result);
  } catch (err) {
    console.error("Create file error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/create-repo-from-chat", async (req, res) => {
  try {
    const { name, description, private: isPrivate, conversationId } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: "Repository name is required" });
    }
    
    const repo = await createGitHubRepo(name, description, isPrivate);
    
    // Update conversation to associate with this repo
    if (conversationId) {
      const conversations = await readJson(conversationsPath, []);
      const convIndex = conversations.findIndex(c => c.id === conversationId);
      if (convIndex >= 0) {
        conversations[convIndex].repoFullName = repo.full_name;
        await writeJson(conversationsPath, conversations);
      }
    }
    
    res.json(repo);
  } catch (err) {
    console.error("Create repo from chat error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const conversations = await readJson(conversationsPath, []);
    res.json(conversations);
  } catch (err) {
    console.error("Conversations error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/conversations", async (req, res) => {
  try {
    const { title, type = "general" } = req.body;
    const conversations = await readJson(conversationsPath, []);
    const newConv = {
      id: createId(),
      title: title || "New Chat",
      type,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      repoFullName: null,
      loadedFiles: []
    };
    conversations.unshift(newConv);
    await writeJson(conversationsPath, conversations);
    res.json(newConv);
  } catch (err) {
    console.error("Create conversation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    const conversations = await readJson(conversationsPath, []);
    const conv = conversations.find(c => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json(conv);
  } catch (err) {
    console.error("Get conversation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Transfer-Encoding", "chunked");
  
  try {
    const { message, conversationId, projectRepo, loadedFiles = [], modelMode = "auto" } = req.body;
    
    const config = await loadConfig();
    const conversations = await readJson(conversationsPath, []);
    const convIndex = conversations.findIndex(c => c.id === conversationId);
    
    if (convIndex === -1) {
      res.write("data: " + JSON.stringify({ error: "Conversation not found" }) + "\n\n");
      return res.end();
    }
    
    const conversation = conversations[convIndex];
    const userMessage = { role: "user", content: message, timestamp: Date.now() };
    conversation.messages.push(userMessage);
    
    // Update repo and files if provided
    if (projectRepo) conversation.repoFullName = projectRepo;
    if (loadedFiles.length > 0) conversation.loadedFiles = loadedFiles;
    
    // Determine model to use
    let selectedModel;
    if (modelMode === "auto") {
      const routing = routeMessage(message, config, loadedFiles.length > 0);
      selectedModel = routing.model;
    } else {
      selectedModel = config.models[modelMode];
    }
    
    if (!selectedModel || !isProviderAvailable(selectedModel.provider)) {
      res.write("data: " + JSON.stringify({ error: "Selected model not available" }) + "\n\n");
      return res.end();
    }
    
    // Build context
    let systemPrompt = `You are an expert full-stack engineer. You have FULL ACCESS to this repository's files.

## IMPORTANT: File Access
✅ ${loadedFiles.length} files have been pre-loaded below - you can see their COMPLETE contents.
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
ALWAYS include the filepath as the first line comment so the Apply button works:
\`\`\`javascript
// filepath: src/components/Button.jsx
import React from 'react';
export function Button({ children }) {
  return <button>{children}</button>;
}
\`\`\``;

    if (projectRepo) {
      systemPrompt += `\n\n## Project: ${projectRepo}`;
    }
    
    if (loadedFiles.length > 0) {
      systemPrompt += `\n\n## 📂 Pre-loaded File Contents (${loadedFiles.length} files)\nYou can see the COMPLETE contents of these files:\n\n`;
      loadedFiles.forEach(file => {
        systemPrompt += `### 📄 ${file.path}\n\`\`\`${file.language || ''}\n${file.content}\n\`\`\`\n\n`;
      });
    }
    
    // Check if this is a new project conversation and suggest repo creation
    const shouldSuggestRepo = conversation.type === "planning" && 
                             !conversation.repoFullName && 
                             (message.toLowerCase().includes("build") || 
                              message.toLowerCase().includes("create") || 
                              message.toLowerCase().includes("project") ||
                              message.toLowerCase().includes("implement"));
    
    if (shouldSuggestRepo) {
      systemPrompt += `\n\n## Repository Creation
If the user is ready to start building/implementing code, you should suggest creating a GitHub repository for this project. You can mention that they can create a new repository directly from this chat.`;
    }
    
    const messages = conversation.messages.slice(-10); // Keep last 10 messages for context
    
    let assistantMessage = { role: "assistant", content: "", timestamp: Date.now(), codeBlocks: [] };
    let fullContent = "";
    
    try {
      const stream = streamCompletion(selectedModel, systemPrompt, messages, selectedModel.maxOutputTokens);
      
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          assistantMessage.content += chunk.text;
          fullContent += chunk.text;
          res.write("data: " + JSON.stringify({ type: "text", text: chunk.text }) + "\n\n");
        } else if (chunk.type === "done") {
          // Parse code blocks from the complete response
          assistantMessage.codeBlocks = parseCodeBlocks(fullContent);
          
          conversation.messages.push(assistantMessage);
          conversation.updatedAt = Date.now();
          await writeJson(conversationsPath, conversations);
          
          // Update stats
          const stats = await readJson(statsPath, { totalCost: 0, totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, breakdown: {} });
          const cost = calculateCost(selectedModel, chunk.inputTokens, chunk.outputTokens);
          stats.totalCost += cost;
          stats.totalRequests += 1;
          stats.totalInputTokens += chunk.inputTokens;
          stats.totalOutputTokens += chunk.outputTokens;
          
          if (!stats.breakdown[selectedModel.id]) {
            stats.breakdown[selectedModel.id] = { cost: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
          }
          stats.breakdown[selectedModel.id].cost += cost;
          stats.breakdown[selectedModel.id].requests += 1;
          stats.breakdown[selectedModel.id].inputTokens += chunk.inputTokens;
          stats.breakdown[selectedModel.id].outputTokens += chunk.outputTokens;
          
          await writeJson(statsPath, stats);
          
          res.write("data: " + JSON.stringify({ 
            type: "done", 
            inputTokens: chunk.inputTokens, 
            outputTokens: chunk.outputTokens,
            cost: cost.toFixed(4),
            model: selectedModel.displayName,
            codeBlocks: assistantMessage.codeBlocks,
            shouldSuggestRepo: shouldSuggestRepo && !conversation.repoFullName
          }) + "\n\n");
        }
      }
    } catch (error) {
      console.error("Stream error:", error);
      res.write("data: " + JSON.stringify({ error: error.message }) + "\n\n");
    }
    
    res.end();
  } catch (err) {
    console.error("Chat error:", err);
    res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
    res.end();
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (err) {
    console.error("Config error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/route-preview", async (req, res) => {
  try {
    const { message, hasFiles } = req.query;
    const config = await loadConfig();
    const preview = previewRoute(message, config, hasFiles === "true");
    res.json(preview);
  } catch (err) {
    console.error("Route preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 AI Code Helper running on port ${PORT}`);
  console.log(`📊 Admin panel: http://localhost:${PORT}/admin.html`);
});
