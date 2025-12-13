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

// Model configuration with fallbacks
const MODEL_CONFIG = {
  standard: {
    primary: process.env.MINI_MODEL || "gpt-5.2-chat-latest",
    fallback: "gpt-4.1-mini"
  },
  deep: {
    primary: process.env.FULL_MODEL || "gpt-5.2",
    fallback: "gpt-4.1"
  }
};

// Approx pricing per token (for cost estimates only)
const MODEL_PRICES = {
  "gpt-5.2-chat-latest": { input: 1.75 / 1_000_000, output: 14.0 / 1_000_000 },
  "gpt-5.2": { input: 1.75 / 1_000_000, output: 14.0 / 1_000_000 },
  "gpt-4.1-mini": { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 },
  "gpt-4.1": { input: 2.0 / 1_000_000, output: 8.0 / 1_000_000 },
};

function getModelsForMode(mode) {
  const config = mode === "deep" ? MODEL_CONFIG.deep : MODEL_CONFIG.standard;
  return [config.primary, config.fallback];
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
  const models = getModelsForMode(mode);
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  let lastError = null;
  let usedFallback = false;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
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

      return { 
        text, 
        usage, 
        modelUsed: model, 
        estimatedCost, 
        costWarning,
        usedFallback: i > 0
      };
    } catch (err) {
      console.warn(`Model ${model} failed, trying fallback...`, err.message);
      lastError = err;
      usedFallback = true;
    }
  }

  throw lastError || new Error("All models failed");
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

function encodeGitHubPath(filePath) {
  return (filePath || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
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
  const encodedPath = encodeGitHubPath(filePath);
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const json = await fetchGitHubJson(url, token);
  if (!json.content) {
    throw new Error("GitHub content response missing content field");
  }
  const buff = Buffer.from(json.content, "base64");
  return buff.toString("utf8");
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch (e) {
    }
  }
  
  try {
    return JSON.parse(text.trim());
  } catch (e) {
  }
  
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
    }
  }
  
  return null;
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

function buildConversationForModel(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  return messages
    .map((m) =>
      (m.role === "user" ? "User: " : "Assistant: ") +
      (m.text || "")
    )
    .join("\n\n");
}

// ---------- API: ideas (conversation / brainstorming) ----------

// Create a new conversation entry
app.post("/api/ideas", async (req, res) => {
  const { repoFullName = "", ideaText, mode = "standard" } =
    req.body || {};

  if (!ideaText || !ideaText.trim()) {
    return res
      .status(400)
      .json({ error: "ideaText is required" });
  }

  try {
    let filePaths = [];
    let stack = "";
    if (repoFullName) {
      try {
        filePaths = await listRepoFiles(repoFullName);
        stack = detectStack(filePaths);
      } catch (err) {
        console.warn("Could not list repo files for ideas, continuing", err.message);
      }
    }

    const instructions =
      "You are an expert full stack engineer and product partner. " +
      "Help brainstorm and refine software ideas for the user. " +
      "Be concrete, realistic, and helpful. Suggest next steps. " +
      "You may be asked about new features or debugging issues. " +
      "When the user asks about specific files or code, reference the file structure provided.";

    let context = "";
    if (repoFullName) {
      context += `Project: ${repoFullName}\n`;
      if (stack) {
        context += `Detected stack: ${stack}\n`;
      }
      if (filePaths.length > 0) {
        context += `\nFiles in the repository (${filePaths.length} total):\n`;
        context += filePaths.slice(0, 150).map((p) => "- " + p).join("\n");
        if (filePaths.length > 150) {
          context += `\n... and ${filePaths.length - 150} more files`;
        }
        context += "\n\n";
      }
    }
    context +=
      "User idea or question:\n" +
      ideaText +
      "\n\n" +
      "Provide a helpful answer with bullet points and practical options. " +
      "If relevant, suggest how to implement this in the existing codebase.";

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
      brainstorming: text, // most recent answer
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
      error: "Failed to run conversation",
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
    const repoFullName = idea.repoFullName || "";
    
    let filePaths = [];
    let stack = "";
    if (repoFullName) {
      try {
        filePaths = await listRepoFiles(repoFullName);
        stack = detectStack(filePaths);
      } catch (err) {
        console.warn("Could not list repo files for reply, continuing", err.message);
      }
    }

    const messages =
      Array.isArray(idea.messages) && idea.messages.length
        ? idea.messages
        : [
            { role: "user", text: idea.ideaText || "" },
            { role: "assistant", text: idea.brainstorming || "" },
          ];

    messages.push({ role: "user", text: followupText });

    const convoForModel = buildConversationForModel(messages);

    let repoContext = "";
    if (repoFullName) {
      repoContext += `Project: ${repoFullName}\n`;
      if (stack) {
        repoContext += `Detected stack: ${stack}\n`;
      }
      if (filePaths.length > 0) {
        repoContext += `\nFiles in the repository (${filePaths.length} total):\n`;
        repoContext += filePaths.slice(0, 150).map((p) => "- " + p).join("\n");
        if (filePaths.length > 150) {
          repoContext += `\n... and ${filePaths.length - 150} more files`;
        }
        repoContext += "\n\n";
      }
    }

    const instructions =
      "You are continuing a technical conversation with a developer. " +
      "Respect previous context and avoid repeating yourself. " +
      "Give specific suggestions, code level guidance, and next steps. " +
      "When the user asks about specific files or code, reference the file structure provided.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(
      mode,
      instructions,
      repoContext + convoForModel +
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

// Existing /api/plan (direct task based) kept for flexibility, but main flow uses /api/plan/from-idea
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

    let planObj = extractJson(text);
    if (!planObj) {
      console.warn("Plan JSON parse failed in /api/plan, returning raw text");
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

// New: generate plan from an idea conversation thread
app.post("/api/plan/from-idea", async (req, res) => {
  const {
    ideaId,
    repoFullName: overrideRepoFullName,
    mode = "standard",
  } = req.body || {};

  if (!ideaId) {
    return res
      .status(400)
      .json({ error: "ideaId is required" });
  }

  try {
    const ideas = await readJson(ideasPath, []);
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea) {
      return res.status(404).json({ error: "Idea not found" });
    }

    const repoFullName =
      overrideRepoFullName ||
      idea.repoFullName ||
      "";

    let filePaths = [];
    let stack = "Unknown stack";

    if (repoFullName) {
      try {
        filePaths = await listRepoFiles(repoFullName);
        stack = detectStack(filePaths);
      } catch (err) {
        console.warn(
          "Could not list repo files in /api/plan/from-idea",
          err.message
        );
      }
    }

    const messages =
      Array.isArray(idea.messages) && idea.messages.length
        ? idea.messages
        : [
            { role: "user", text: idea.ideaText || "" },
            { role: "assistant", text: idea.brainstorming || "" },
          ];

    const convoForModel = buildConversationForModel(messages);
    const firstUserMessage = messages.find(
      (m) =>
        m.role === "user" &&
        (m.text || "").trim().length > 0
    );
    const taskDescription = firstUserMessage
      ? firstUserMessage.text.slice(0, 200)
      : "Plan from conversation";

    const planPrompt =
      "You are a senior full stack engineer planning concrete changes to a codebase.\n\n" +
      (repoFullName
        ? `Repository: ${repoFullName}\n`
        : "") +
      `Inferred stack: ${stack}\n\n` +
      (filePaths.length
        ? "Known files in the repo:\n" +
          filePaths
            .slice(0, 200)
            .map((p) => "- " + p)
            .join("\n") +
          "\n\n"
        : "") +
      "Here is the recent conversation between you (Assistant) and the developer:\n\n" +
      convoForModel +
      "\n\nBased on this conversation, produce a concrete implementation plan for the requested changes in this repository.\n\n" +
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
      "Use at most 8 files. Use real paths from the list when possible. " +
      "If you are unsure, choose your best guess and explain in the reason field.";

    const {
      text,
      modelUsed,
      estimatedCost,
      costWarning,
    } = await callModelWithInstructions(mode, "", planPrompt, {
      maxOutputTokens: 2200,
    });

    let planObj = extractJson(text);
    if (!planObj) {
      console.warn(
        "Plan JSON parse failed in /api/plan/from-idea, returning raw text"
      );
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
      repoFullName: repoFullName || null,
      task: taskDescription,
      plan: planObj,
      planText: planObj.planText || "",
      sourceIdeaId: ideaId,
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
    console.error("Error in /api/plan/from-idea", err);
    res.status(500).json({
      error: "Failed to generate plan from conversation",
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

// ---------- API: commit file to GitHub ----------

app.post("/api/commit-file", async (req, res) => {
  const {
    repoFullName,
    filePath,
    updatedContent,
    commitMessage,
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
  if (!updatedContent || !updatedContent.trim()) {
    return res
      .status(400)
      .json({ error: "updatedContent is required" });
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({
      error:
        "GITHUB_TOKEN is not set. Add it in Replit secrets to enable committing.",
    });
  }

  try {
    const { owner, repo } = parseRepoFullName(repoFullName);
    const encodedPath = encodeGitHubPath(filePath);
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;

    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Try to get existing file to obtain sha
    let sha = undefined;
    try {
      const getRes = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (getRes.status === 200) {
        const json = await getRes.json();
        if (json && json.sha) {
          sha = json.sha;
        }
      } else if (getRes.status !== 404) {
        const text = await getRes.text();
        throw new Error(
          `GitHub GET error ${getRes.status}: ${text}`
        );
      }
    } catch (err) {
      console.warn(
        "Error reading existing file before commit",
        err.message
      );
    }

    const contentBase64 = Buffer.from(
      updatedContent,
      "utf8"
    ).toString("base64");

    const message =
      commitMessage ||
      `AI update to ${filePath}`.slice(0, 100);

    const body = {
      message,
      content: contentBase64,
    };
    if (sha) {
      body.sha = sha;
    }

    const putRes = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (!putRes.ok) {
      const text = await putRes.text();
      throw new Error(
        `GitHub PUT error ${putRes.status}: ${text}`
      );
    }

    const result = await putRes.json();

    res.json({
      ok: true,
      path: result.content?.path || filePath,
      commitSha: result.commit?.sha || null,
      branch: result.content?.branch || null,
    });
  } catch (err) {
    console.error("Error in /api/commit-file", err);
    res.status(500).json({
      error: "Failed to commit file",
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
