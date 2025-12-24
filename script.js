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
const projectsPath = path.join(__dirname, "data", "projects.json");
const statsPath = path.join(__dirname, "data", "stats.json");

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
    if (err.code === "ENOENT") {
      console.warn("Secrets file not found, using defaults.");
      return { adminPassword: null, apiKeys: {} };
    }
    console.error("Error loading secrets:", err); // Added error logging
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
function parseRepoFullName(full) {
