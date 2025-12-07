import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- OpenAI setup ----------

const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  console.warn(
    "Warning: OPENAI_API_KEY is not set. OpenAI endpoints will fail until you add it in Replit secrets."
  );
}

const openai = new OpenAI({ apiKey: openaiApiKey });

// Default models - you can override with env variables if you want
const MINI_MODEL = process.env.MINI_MODEL || "gpt-4.1-mini";
const FULL_MODEL = process.env.FULL_MODEL || "gpt-4.1";

// Approx pricing per token (for cost estimates only)
const MODEL_PRICES = {
  [MINI_MODEL]: { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 }, // $0.40 / $1.60 per 1M
  [FULL_MODEL]: { input: 2.0 / 1_000_000, output: 8.0 / 1_000_000 }, // $2.00 / $8.00 per 1M
};

function pickModel(mode) {
  return mode === "deep" ? FULL_MODEL : MINI_MODEL;
}

function estimateCost(model, usage) {
  if (!usage) return null;
  const pricing = MODEL_PRICES[model];
  if (!pricing) return null;

  const inputTokens =
    usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens =
    usage.output_tokens ?? usage.completion_tokens ?? 0;

  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output
  );
}

async function callModelWithInstructions(
  mode,
  instructions,
  inputText,
  { maxOutputTokens = 2048 } = {}
) {
  const model = pickModel(mode);
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const response = await openai.responses.create({
    model,
    instructions,
    input: inputText,
    max_output_tokens: maxOutputTokens,
  });

  const text = response.output_text || "";
  const usage = response.usage || null;
  const estimatedCost = estimateCost(model, usage);
  const costWarning = estimatedCost != null && estimatedCost > 0.25;

  return { text, usage, modelUsed: model, estimatedCost, costWarning };
}

// ---------- Simple JSON storage ----------

const DATA_DIR = path.join(__dirname, "data");
const ideasPath = path.join(DATA_DIR, "ideasStore.json");
const tasksPath = path.join(DATA_DIR, "tasksStore.json");
const pinnedPath = path.join(__dirname, "pinnedProjects.json");

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") {
      console.error("Error creating data dir", err);
    }
  }
}

await ensureDataDir();

async function readJson(filePath, defaultValue) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") return defaultValue;
    console.error("Error reading JSON", filePath, err);
    return defaultValue;
  }
}

async function writeJson(filePath, value) {
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing JSON", filePath, err);
  }
}

function createId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

// ---------- GitHub helpers ----------

function parseRepoFullName(full) {
  const [owner, repo] = (full || "").split("/");
  return { owner, repo };
}

async function fetchGitHubJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function listRepos(pinnedOnly) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Set it in Replit secrets to use GitHub features."
    );
  }

  const pinnedConfig = await readJson(pinnedPath, { pinned: [] });
  const pinned =
    Array.isArray(pinnedConfig.pinned)
      ? pinnedConfig.pinned
      : Array.isArray(pinnedConfig.repos)
      ? pinnedConfig.repos
      : [];

  const url =
    "https://api.github.com/user/repos?per_page=100&sort=updated";
  const repos = await fetchGitHubJson(url, token);

  const mapped = repos.map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
    pinned: pinned.includes(r.full_name),
  }));

  if (pinnedOnly) {
    return mapped.filter((r) => r.pinned);
  }
  return mapped;
}

async function listRepoFiles(repoFullName) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const { owner, repo } = parseRepoFullName(repoFullName);
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const json = await fetchGitHubJson(url, token);
  if (!Array.isArray(json.tree)) return [];
  return json.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path);
}

async function getFileFromGitHub(repoFullName, filePath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  const { owner, repo } = parseRepoFullName(repoFullName);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
    filePath
  )}`;
  const json = await fetchGitHubJson(url, token);
  if (!json.content) {
    throw new Error("GitHub content response missing content field");
  }
  const buff = Buffer.from(json.content, "base64");
  return buff.toString("utf8");
}

function detectStack(filePaths) {
  const files = new Set(filePaths || []);
  const has = (name) =>
    files.has(name) ||
    [...files].some((p) => p.endsWith("/" + name));

  if (has("next.config.js") || has("next.config.mjs")) {
    return "Next.js app";
  }
  if (has("remix.config.js")) {
    return "Remix app";
  }
  if (
    has("package.json") &&
    [...files].some(
      (p) => p.startsWith("src/") || p.startsWith("app/")
    )
  ) {
    return "React front end with Node/Express back end";
  }
  if ([...files].some((p) => p.endsWith(".py"))) {
    return "Python app";
  }
  return "Unknown stack";
}

// ---------- Express setup ----------

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- API: projects ----------

app.get("/api/projects", async (req, res) => {
  const pinnedOnly = req.query.pinned === "1";
  try {
    const repos = await listRepos(pinnedOnly);
    res.json(repos);
  } catch (err) {
    console.error("Error in /api/projects", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Helpers for idea conversations ----------

function buildConversationTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  return messages
    .map((m) =>
      (m.role === "user" ? "You: " : "AI: ") + (m.text || "")
    )
    .join("\n\n");
}

// ---------- API: ideas (brainstorm + conversation) ----------

// Create a new brainstorm
app.post("/api/ideas", async (req, res) => {
  const { repoFullName = "", ideaText, mode = "standard" } =
    req.body || {};

  if (!ideaText || !ideaText.trim()) {
    return res
      .status(400)
      .json({ error: "ideaText is required" });
  }

  try {
    const instructions =
      "You are an expert full stack engineer and product partner. " +
      "Help brainstorm and refine software ideas for the user. " +
      "Be concrete, realistic, and helpful. Suggest next steps.";

    let context = "";
    if (repoFullName) {
      context += `Project: ${repoFullName}\n`;
    }
    context +=
      "User idea or question:\n" +
      ideaText +
      "\n\n" +
      "Provide a helpful brainstorm with bullet points and practical options.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(
      mode,
      instructions,
      context,
      { maxOutputTokens: 1800 }
    );

    const now = new Date().toISOString();
    const ideas = await readJson(ideasPath, []);

    const messages = [
      { role: "user", text: ideaText },
      { role: "assistant", text },
    ];

    const idea = {
      id: createId(),
      repoFullName: repoFullName || null,
      mode,
      ideaText,
      brainstorming: text, // first reply only
      messages,
      starred: false,
      createdAt: now,
      updatedAt: now,
    };

    ideas.push(idea);
    await writeJson(ideasPath, ideas);

    const conversationText = buildConversationTranscript(messages);

    res.json({
      ideaId: idea.id,
      brainstorming: text,
      conversationText,
      messages,
      estimatedCost,
      costWarning,
      modelUsed,
    });
  } catch (err) {
    console.error("Error in /api/ideas", err);
    res.status(500).json({
      error: "Failed to run brainstorm",
      details: err.message,
    });
  }
});

// Add a follow up to an existing idea thread
app.post("/api/ideas/:id/reply", async (req, res) => {
  const { id } = req.params;
  const { followupText, mode = "standard" } = req.body || {};

  if (!followupText || !followupText.trim()) {
    return res
      .status(400)
      .json({ error: "followupText is required" });
  }

  try {
    const ideas = await readJson(ideasPath, []);
    const idx = ideas.findIndex((i) => i.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Idea not found" });
    }

    const idea = ideas[idx];
    const messages =
      Array.isArray(idea.messages) && idea.messages.length
        ? idea.messages
        : [
            { role: "user", text: idea.ideaText || "" },
            { role: "assistant", text: idea.brainstorming || "" },
          ];

    messages.push({ role: "user", text: followupText });

    const convoForModel = messages
      .map((m) =>
        (m.role === "user" ? "User: " : "Assistant: ") +
        (m.text || "")
      )
      .join("\n\n");

    const instructions =
      "You are continuing a technical brainstorming conversation with a developer. " +
      "Respect previous context and avoid repeating yourself. " +
      "Give specific suggestions and next steps.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(
      mode,
      instructions,
      convoForModel +
        "\n\nAssistant: Continue the conversation by replying to the last user message.",
      { maxOutputTokens: 1800 }
    );

    messages.push({ role: "assistant", text });

    idea.messages = messages;
    idea.brainstorming = text; // most recent answer
    idea.updatedAt = new Date().toISOString();
    ideas[idx] = idea;

    await writeJson(ideasPath, ideas);

    const conversationText = buildConversationTranscript(messages);

    res.json({
      ideaId: idea.id,
      brainstorming: text,
      conversationText,
      messages,
      estimatedCost,
      costWarning,
      modelUsed,
    });
  } catch (err) {
    console.error("Error in /api/ideas/:id/reply", err);
    res.status(500).json({
      error: "Failed to add follow up",
      details: err.message,
    });
  }
});

// List ideas (optionally by repo, and starred only)
app.get("/api/ideas", async (req, res) => {
  const { repoFullName, starred } = req.query;
  try {
    const ideas = await readJson(ideasPath, []);
    let filtered = ideas;
    if (repoFullName) {
      filtered = filtered.filter(
        (i) => i.repoFullName === repoFullName
      );
    }
    if (starred === "1") {
      filtered = filtered.filter((i) => i.starred);
    }
    filtered.sort(
      (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    res.json(filtered);
  } catch (err) {
    console.error("Error in GET /api/ideas", err);
    res.status(500).json({ error: err.message });
  }
});

// Star / unstar idea
app.post("/api/ideas/:id/star", async (req, res) => {
  const { id } = req.params;
  const { starred } = req.body || {};
  try {
    const ideas = await readJson(ideasPath, []);
    const idx = ideas.findIndex((i) => i.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Idea not found" });
    }
    ideas[idx].starred = !!starred;
    ideas[idx].updatedAt = new Date().toISOString();
    await writeJson(ideasPath, ideas);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in POST /api/ideas/:id/star", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: plan / tasks ----------

app.post("/api/plan", async (req, res) => {
  const { repoFullName, task, mode = "standard" } = req.body || {};

  if (!repoFullName) {
    return res
      .status(400)
      .json({ error: "repoFullName is required" });
  }
  if (!task || !task.trim()) {
    return res
      .status(400)
      .json({ error: "task is required" });
  }

  try {
    const filePaths = await listRepoFiles(repoFullName);
    const stack = detectStack(filePaths);

    const planPrompt =
      "You are a senior full stack engineer planning a change to a codebase.\n\n" +
      `Repository: ${repoFullName}\n` +
      `Inferred stack: ${stack}\n\n` +
      "Known files in the repo:\n" +
      filePaths
        .slice(0, 200)
        .map((p) => "- " + p)
        .join("\n") +
      "\n\n" +
      "Developer request:\n" +
      task +
      "\n\n" +
      "Respond with STRICT JSON only and no extra text, in this shape:\n" +
      `{
  "planText": "High level explanation and numbered steps in plain English",
  "files": [
    {
      "path": "relative/path/file.ext",
      "reason": "why this file should change",
      "changeSummary": "short description of the change for this file",
      "subtaskPrompt": "focused instruction for an AI code editor to update ONLY this file"
    }
  ]
}\n` +
      "Use at most 8 files. Use real paths from the list. If you are unsure, choose your best guess and explain in the reason field.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(mode, "", planPrompt, {
      maxOutputTokens: 2200,
    });

    let planObj;
    try {
      planObj = JSON.parse(text);
    } catch (err) {
      console.warn("Plan JSON parse failed, returning raw text");
      planObj = {
        planText: text,
        files: [],
      };
    }

    const now = new Date().toISOString();
    const tasks = await readJson(tasksPath, []);
    const taskId = createId();

    const taskItem = {
      id: taskId,
      repoFullName,
      task,
      plan: planObj,
      planText: planObj.planText || "",
      starred: false,
      createdAt: now,
      updatedAt: now,
    };

    tasks.push(taskItem);
    await writeJson(tasksPath, tasks);

    res.json({
      taskId,
      plan: planObj,
      estimatedCost,
      costWarning,
      modelUsed,
    });
  } catch (err) {
    console.error("Error in /api/plan", err);
    res.status(500).json({
      error: "Failed to generate plan",
      details: err.message,
    });
  }
});

app.get("/api/tasks", async (req, res) => {
  const { repoFullName, starred } = req.query;
  try {
    const tasks = await readJson(tasksPath, []);
    let filtered = tasks;
    if (repoFullName) {
      filtered = filtered.filter(
        (t) => t.repoFullName === repoFullName
      );
    }
    if (starred === "1") {
      filtered = filtered.filter((t) => t.starred);
    }
    filtered.sort(
      (a, b) =>
        new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    res.json(filtered);
  } catch (err) {
    console.error("Error in GET /api/tasks", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/:id/star", async (req, res) => {
  const { id } = req.params;
  const { starred } = req.body || {};
  try {
    const tasks = await readJson(tasksPath, []);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    tasks[idx].starred = !!starred;
    tasks[idx].updatedAt = new Date().toISOString();
    await writeJson(tasksPath, tasks);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in POST /api/tasks/:id/star", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- API: edit from GitHub ----------

app.post("/api/edit-from-github", async (req, res) => {
  const {
    repoFullName,
    filePath,
    subtaskPrompt,
    mode = "standard",
  } = req.body || {};

  if (!repoFullName) {
    return res
      .status(400)
      .json({ error: "repoFullName is required" });
  }
  if (!filePath) {
    return res
      .status(400)
      .json({ error: "filePath is required" });
  }
  if (!subtaskPrompt || !subtaskPrompt.trim()) {
    return res
      .status(400)
      .json({ error: "subtaskPrompt is required" });
  }

  try {
    const currentContent = await getFileFromGitHub(
      repoFullName,
      filePath
    );

    const instructions =
      "You are an AI pair programmer editing a single file. " +
      "Return the FULL updated file content as plain text. " +
      "Do not return a diff or comments. Keep existing style and unrelated code intact.";

    const editPrompt =
      `Repository: ${repoFullName}\n` +
      `File path: ${filePath}\n\n` +
      "Current file content:\n\n" +
      currentContent +
      "\n\n" +
      "Requested change for this file:\n" +
      subtaskPrompt +
      "\n\n" +
      "Return only the complete updated file content.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(
      mode,
      instructions,
      editPrompt,
      { maxOutputTokens: 6000 }
    );

    res.json({
      updatedContent: text,
      estimatedCost,
      costWarning,
      modelUsed,
    });
  } catch (err) {
    console.error("Error in /api/edit-from-github", err);
    res.status(500).json({
      error: "Failed to update file",
      details: err.message,
    });
  }
});

// ---------- API: debug ----------

app.post("/api/debug", async (req, res) => {
  const {
    repoFullName = "",
    errorText,
    mode = "standard",
  } = req.body || {};

  if (!errorText || !errorText.trim()) {
    return res
      .status(400)
      .json({ error: "errorText is required" });
  }

  try {
    let filePaths = [];
    if (repoFullName) {
      try {
        filePaths = await listRepoFiles(repoFullName);
      } catch (err) {
        console.warn(
          "Could not list repo files for debug, continuing",
          err.message
        );
      }
    }

    const debugPrompt =
      "You are a senior engineer helping debug an application.\n\n" +
      (repoFullName
        ? "Repository: " + repoFullName + "\n"
        : "") +
      (filePaths.length
        ? "Some known files in the project:\n" +
          filePaths
            .slice(0, 80)
            .map((p) => "- " + p)
            .join("\n") +
          "\n\n"
        : "") +
      "Error output or stack trace:\n" +
      errorText +
      "\n\n" +
      "Explain what is likely going wrong and give concrete steps to fix it. " +
      "Reference file names when it is helpful. Include example code snippets where appropriate.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(
      mode,
      "",
      debugPrompt,
      { maxOutputTokens: 2500 }
    );

    res.json({
      explanation: text,
      estimatedCost,
      costWarning,
      modelUsed,
    });
  } catch (err) {
    console.error("Error in /api/debug", err);
    res.status(500).json({
      error: "Failed to debug",
      details: err.message,
    });
  }
});

// ---------- Start server ----------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Server running on http://0.0.0.0:${PORT}`
  );
});