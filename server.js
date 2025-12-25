import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// ---------- Paths / storage ----------
const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DATA_DIR ||
  path.join(__dirname, "data");

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const MODEL_OPTIONS_PATH = path.join(DATA_DIR, "model-options.json");
const STATS_PATH = path.join(DATA_DIR, "stats.json");
const CONVERSATIONS_PATH = path.join(DATA_DIR, "conversations.json");

// ---------- Provider keys (env-first) ----------
const ENV_KEYS = {
  openai: process.env.OPENAI_API_KEY || "",
  anthropic: process.env.ANTHROPIC_API_KEY || "",
  google: process.env.GOOGLE_API_KEY || "",
  github: process.env.GITHUB_TOKEN || "",
};

const PORT = Number(process.env.PORT || 8080);

// ---------- Helpers ----------
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, obj) {
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function safeString(x) {
  if (typeof x === "string") return x;
  if (x == null) return "";
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// ---------- Admin auth (stateless signed token) ----------
const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  process.env.ADMIN_SESSION_KEY ||
  ""; // strongly recommended to set in Railway

const ADMIN_PASSWORD_HASH_ENV = process.env.ADMIN_PASSWORD_HASH || ""; // optional
const ADMIN_PASSWORD_ENV = process.env.ADMIN_PASSWORD || ""; // optional (not recommended)

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function unb64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function hmacSha256(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

function signToken(payload) {
  // Minimal JWT-like token: base64url(header).base64url(payload).base64url(sig)
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const toSign = `${header}.${body}`;
  const sig = b64url(hmacSha256(ADMIN_SESSION_SECRET, toSign));
  return `${toSign}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return { ok: false };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  if (!ADMIN_SESSION_SECRET) return { ok: false, reason: "missing_secret" };

  const [h, b, s] = parts;
  const toSign = `${h}.${b}`;
  const expected = b64url(hmacSha256(ADMIN_SESSION_SECRET, toSign));

  // timing-safe compare
  const a = Buffer.from(expected);
  const bb = Buffer.from(s);
  if (a.length !== bb.length) return { ok: false };

  if (!crypto.timingSafeEqual(a, bb)) return { ok: false };

  let payload;
  try {
    payload = JSON.parse(unb64url(b).toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (payload.exp && Date.now() > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

function getAdminToken(req) {
  // Accept either X-Admin-Session or Authorization: Bearer ...
  const x = req.get("x-admin-session") || req.get("X-Admin-Session");
  if (x) return x;
  const auth = req.get("authorization") || req.get("Authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  const v = verifyToken(token);
  if (!v.ok) return res.status(401).json({ ok: false, error: "Unauthorized" });
  return next();
}

// ---------- Defaults ----------
const DEFAULT_CONFIG = {
  systemPrompt: "",
  modelRouting: {
    fast: "gemini-3-flash",
    full: "gpt-5.2",
    fallback: "claude-sonnet-4.5",
  },
  guardrails: {
    maxCostPerRequestUSD: 0.25,
    maxTokensPerRequest: 4000,
  },
};

const DEFAULT_MODEL_OPTIONS = {
  updatedAt: new Date(0).toISOString(),
  options: [
    { id: "gemini-3-flash", provider: "google", displayName: "Gemini 3 Flash (fast)" },
    { id: "gpt-5.2", provider: "openai", displayName: "GPT-5.2 (full)" },
    { id: "claude-sonnet-4.5", provider: "anthropic", displayName: "Claude Sonnet 4.5 (fallback)" },
  ],
};

const DEFAULT_STATS = {
  totalMessages: 0,
  totalCostUSD: 0,
  providersUsed: {},
  lastUpdatedAt: null,
};

async function initStorage() {
  await ensureDir(DATA_DIR);

  const cfg = await readJson(CONFIG_PATH, null);
  if (!cfg) await writeJson(CONFIG_PATH, DEFAULT_CONFIG);

  const mo = await readJson(MODEL_OPTIONS_PATH, null);
  if (!mo) await writeJson(MODEL_OPTIONS_PATH, DEFAULT_MODEL_OPTIONS);

  const st = await readJson(STATS_PATH, null);
  if (!st) await writeJson(STATS_PATH, DEFAULT_STATS);

  const conv = await readJson(CONVERSATIONS_PATH, null);
  if (!conv) await writeJson(CONVERSATIONS_PATH, []);
}

// ---------- Middleware ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Health ----------
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- Public API ----------
app.get("/api/config", async (req, res) => {
  const cfg = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
  res.json(cfg);
});

app.get("/api/stats", async (req, res) => {
  const st = await readJson(STATS_PATH, DEFAULT_STATS);
  res.json(st);
});

app.post("/api/stats/reset", async (req, res) => {
  await writeJson(STATS_PATH, DEFAULT_STATS);
  res.json({ ok: true });
});

// ---------- Admin auth/status ----------
function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function getAdminStore() {
  const p = path.join(DATA_DIR, "admin.json");
  const store = await readJson(p, { passwordHash: "" });
  return { path: p, store };
}

async function setAdminPassword(password) {
  const { path: p, store } = await getAdminStore();
  store.passwordHash = sha256Hex(password);
  await writeJson(p, store);
}

function checkPassword(password, storedHash) {
  const candidate = sha256Hex(password);
  const a = Buffer.from(candidate);
  const b = Buffer.from(storedHash || "");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get("/api/admin/auth-status", async (req, res) => {
  const token = getAdminToken(req);
  const verified = verifyToken(token);

  const diskHash = (await getAdminStore()).store?.passwordHash || "";
  const needsPassword = !(ADMIN_PASSWORD_HASH_ENV || ADMIN_PASSWORD_ENV || diskHash);

  res.json({
    ok: true,
    needsPassword,
    isAuthenticated: verified.ok,
  });
});

app.post("/api/admin/set-password", async (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ ok: false, error: "Password must be at least 8 characters." });
  }
  await setAdminPassword(password);
  return res.json({ ok: true });
});

app.post("/api/admin/login", async (req, res) => {
  if (!ADMIN_SESSION_SECRET) {
    console.warn("ADMIN_SESSION_SECRET is not set. Admin auth will be unreliable across restarts.");
  }

  const { password } = req.body || {};
  if (!password || typeof password !== "string") {
    return res.status(400).json({ ok: false, error: "Missing password" });
  }

  // Determine stored hash (env wins, then disk)
  let storedHash = ADMIN_PASSWORD_HASH_ENV;
  if (!storedHash && ADMIN_PASSWORD_ENV) storedHash = sha256Hex(ADMIN_PASSWORD_ENV);
  if (!storedHash) storedHash = (await getAdminStore()).store.passwordHash || "";

  if (!storedHash) {
    return res
      .status(400)
      .json({ ok: false, error: "Admin password not set. Use /api/admin/set-password first." });
  }

  if (!checkPassword(password, storedHash)) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  const token = signToken({ sub: "admin", exp: Date.now() + 1000 * 60 * 60 * 24 * 7 }); // 7 days
  // Return BOTH names for compatibility with older frontends
  return res.json({ ok: true, token, sessionToken: token });
});

// ---------- Admin protected endpoints ----------
app.get("/api/admin/api-keys", requireAdmin, async (req, res) => {
  // never return full keys; show masked
  const mask = (k) => {
    if (!k) return "";
    const s = String(k);
    if (s.length <= 8) return "****";
    return `${s.slice(0, 2)}…${s.slice(-4)}`;
  };

  res.json({
    ok: true,
    keys: {
      openai: mask(ENV_KEYS.openai),
      anthropic: mask(ENV_KEYS.anthropic),
      google: mask(ENV_KEYS.google),
      github: mask(ENV_KEYS.github),
    },
    has: {
      openai: !!ENV_KEYS.openai,
      anthropic: !!ENV_KEYS.anthropic,
      google: !!ENV_KEYS.google,
      github: !!ENV_KEYS.github,
    },
  });
});

app.get("/api/model-options", requireAdmin, async (req, res) => {
  const mo = await readJson(MODEL_OPTIONS_PATH, DEFAULT_MODEL_OPTIONS);
  res.json({ ok: true, ...mo });
});

// Sync adds options only (append-only). True discovery would call provider APIs.
app.post("/api/model-options/sync", requireAdmin, async (req, res) => {
  const mo = await readJson(MODEL_OPTIONS_PATH, DEFAULT_MODEL_OPTIONS);
  const extra = [];

  if (ENV_KEYS.google) {
    extra.push({ id: "gemini-3-flash", provider: "google", displayName: "Gemini 3 Flash" });
    extra.push({ id: "gemini-3-pro", provider: "google", displayName: "Gemini 3 Pro" });
  }
  if (ENV_KEYS.openai) {
    extra.push({ id: "gpt-5.2", provider: "openai", displayName: "GPT-5.2" });
    extra.push({ id: "gpt-5.2-mini", provider: "openai", displayName: "GPT-5.2 Mini" });
  }
  if (ENV_KEYS.anthropic) {
    extra.push({ id: "claude-sonnet-4.5", provider: "anthropic", displayName: "Claude Sonnet 4.5" });
    extra.push({ id: "claude-opus-4.5", provider: "anthropic", displayName: "Claude Opus 4.5" });
  }

  const byId = new Map((mo.options || []).map((o) => [o.id, o]));
  for (const o of extra) if (!byId.has(o.id)) byId.set(o.id, o);

  const next = {
    updatedAt: new Date().toISOString(),
    options: Array.from(byId.values()),
  };

  await writeJson(MODEL_OPTIONS_PATH, next);
  res.json({ ok: true, ...next });
});

app.post("/api/admin/save-config", requireAdmin, async (req, res) => {
  const incoming = req.body || {};
  const current = await readJson(CONFIG_PATH, DEFAULT_CONFIG);

  const merged = {
    ...current,
    ...incoming,
    modelRouting: { ...current.modelRouting, ...(incoming.modelRouting || {}) },
    guardrails: { ...current.guardrails, ...(incoming.guardrails || {}) },
  };

  await writeJson(CONFIG_PATH, merged);
  res.json({ ok: true });
});

// ---------- GitHub helpers ----------
async function ghFetch(url) {
  if (!ENV_KEYS.github) throw new Error("Missing GITHUB_TOKEN");
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ENV_KEYS.github}`,
      "User-Agent": "ai-coding-helper",
      Accept: "application/vnd.github+json",
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub error ${r.status}: ${t}`);
  }
  return r.json();
}

app.get("/api/projects", async (req, res) => {
  try {
    const data = await ghFetch("https://api.github.com/user/repos?per_page=100&sort=updated");
    const projects = data.map((r) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      owner: r.owner?.login,
      private: r.private,
      default_branch: r.default_branch,
    }));
    res.json({ ok: true, projects });
  } catch (e) {
    res.status(500).json({ ok: false, error: safeString(e.message || e) });
  }
});

app.get("/api/projects/:owner/:repo/files", async (req, res) => {
  const { owner, repo } = req.params;
  try {
    const repoInfo = await ghFetch(`https://api.github.com/repos/${owner}/${repo}`);
    const branch = repoInfo.default_branch || "main";
    const tree = await ghFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
    );
    const files = (tree.tree || [])
      .filter((x) => x.type === "blob")
      .map((x) => ({ path: x.path, size: x.size || 0, sha: x.sha }));
    res.json({ ok: true, owner, repo, branch, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: safeString(e.message || e) });
  }
});

// ---------- Conversations ----------
app.get("/api/conversations", async (req, res) => {
  const list = await readJson(CONVERSATIONS_PATH, []);
  res.json({ ok: true, conversations: list });
});

app.post("/api/conversations", async (req, res) => {
  const { title } = req.body || {};
  const list = await readJson(CONVERSATIONS_PATH, []);
  const id = crypto.randomUUID();
  const item = { id, title: title || "New chat", createdAt: new Date().toISOString() };
  list.unshift(item);
  await writeJson(CONVERSATIONS_PATH, list);
  res.json({ ok: true, conversation: item });
});

// ---------- Chat endpoint hardening (prevents 500s) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body || {};
    let message = body.message;

    // normalize common shapes
    if (typeof message === "object" && message && "text" in message) message = message.text;
    message = safeString(message);

    if (!message.trim()) {
      return res.status(400).json({ ok: false, error: "Empty message" });
    }

    const cfg = await readJson(CONFIG_PATH, DEFAULT_CONFIG);

    // FIX: prevent message.toLowerCase crash
    const mode = safeString(body.mode || body.modelOverride || "").toLowerCase();
    const wantsFast = mode.includes("fast");
    const chosen = wantsFast ? cfg.modelRouting.fast : cfg.modelRouting.full;

    // Placeholder response so chat doesn't die.
    // (If you already had provider streaming, re-add it here.)
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.write(`Using model: ${chosen}\n\n`);
    res.write(`You said: ${message}\n`);
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: safeString(e.message || e) });
  }
});

// ---------- Routes ----------
app.get("/admin", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Boot ----------
await initStorage();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
});
