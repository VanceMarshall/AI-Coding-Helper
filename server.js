import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ---------- OpenAI setup ----------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Rough prices for cost estimate. Adjust if OpenAI pricing changes.
const PRICING = {
  "gpt-5.1-mini": { in: 0.25 / 1_000_000, out: 2.0 / 1_000_000 },
  "gpt-5.1": { in: 1.25 / 1_000_000, out: 10.0 / 1_000_000 }
};

function estimateCost(model, inputChars, outputCharsEstimate) {
  const cfg = PRICING[model];
  if (!cfg) return { estimated: 0, warning: false };

  const inTokens = inputChars / 4;        // rough 4 chars per token
  const outTokens = outputCharsEstimate / 4;

  const estimated =
    inTokens * cfg.in +
    outTokens * cfg.out;

  const warning = estimated > 0.25;       // warn above 25 cents
  return { estimated, warning };
}

// Choose models by mode (standard vs deep)
function modelForMode(mode, kind) {
  if (mode === "deep") {
    return "gpt-5.1";
  }
  return "gpt-5.1-mini";
}

// ---------- GitHub setup ----------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = "https://api.github.com";

let pinned = [];
try {
  const raw = fs.readFileSync("pinnedProjects.json", "utf8");
  pinned = JSON.parse(raw).pinned || [];
} catch (e) {
  console.warn("No pinnedProjects.json or invalid JSON, continuing without pinned list");
}

async function gh(path, params = {}) {
  const url = `${GITHUB_API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "ai-code-helper",
      Accept: "application/vnd.github+json"
    },
    ...params
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// ---------- Simple JSON storage for ideas and tasks ----------

const IDEAS_FILE = "ideasStore.json";
const TASKS_FILE = "tasksStore.json";

function loadIdeas() {
  try {
    const raw = fs.readFileSync(IDEAS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    return [];
  }
}

function saveIdeas(ideas) {
  fs.writeFileSync(IDEAS_FILE, JSON.stringify(ideas, null, 2), "utf8");
}

function loadTasks() {
  try {
    const raw = fs.readFileSync(TASKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (e) {
    return [];
  }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf8");
}

// ---------- API: list projects ----------

app.get("/api/projects", async (req, res) => {
  try {
    const pinnedOnly = req.query.pinned === "1";
    const repos = await gh("/user/repos?per_page=100");
    const pinnedSet = new Set(pinned);

    let list = repos.map(r => ({
      id: r.full_name,
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      private: r.private,
      defaultBranch: r.default_branch,
      pinned: pinnedSet.has(r.full_name)
    }));

    if (pinnedOnly) {
      list = list.filter(r => r.pinned);
    }

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch projects", details: err.message });
  }
});

// ---------- API: brainstorm ideas / feasibility ----------

app.post("/api/ideas", async (req, res) => {
  try {
    const { repoFullName, ideaText, mode } = req.body;
    if (!ideaText) {
      return res.status(400).json({ error: "ideaText is required" });
    }

    const model = modelForMode(mode, "ideas");

    let fileTreeString = "";
    if (repoFullName) {
      try {
        const repo = await gh(`/repos/${repoFullName}`);
        const defaultBranch = repo.default_branch;
        const treeData = await gh(
          `/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`
        );
        const paths = (treeData.tree || [])
          .filter(item => item.type === "blob")
          .map(item => item.path);
        fileTreeString = paths.join("\n").slice(0, 40_000);
      } catch (e) {
        console.warn("Could not load repo file tree for ideas:", e.message);
      }
    }

    const brainstormPrompt = `
You are a senior product and engineering strategist.

You are given:
- An app or feature idea (ideaText).
- Optionally, the name of a GitHub repo and its file paths.

Your job:
1) Evaluate feasibility at a high level. Be honest about tradeoffs and complexity.
2) If a repo and file tree are provided, infer the likely stack and describe how this idea could fit into the existing architecture.
3) Describe a possible architecture or design:
   - Core components or services
   - Data model sketch
   - Key flows or screens
4) Suggest an MVP version (smallest useful version) and optional v2+ enhancements.
5) Call out any major risks, tricky parts, or dependencies to investigate.
6) Suggest concrete next steps.

Do not write detailed code. Use clear, practical language.

Idea:
${ideaText}

Repo:
${repoFullName || "(none selected)"}

File paths (may be empty):
${fileTreeString || "(not provided)"}
`;

    const approxInputChars = brainstormPrompt.length;
    const { estimated, warning } = estimateCost(model, approxInputChars, approxInputChars * 0.8);

    const response = await client.responses.create({
      model,
      input: brainstormPrompt
    });

    const brainstorming = response.output[0].content[0].text;

    // Save idea to disk
    const ideas = loadIdeas();
    const now = new Date().toISOString();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const ideaRecord = {
      id,
      createdAt: now,
      repoFullName: repoFullName || "",
      mode: mode || "standard",
      ideaText,
      brainstorming,
      modelUsed: model,
      starred: false
    };

    ideas.unshift(ideaRecord);
    saveIdeas(ideas);

    res.json({
      brainstorming,
      modelUsed: model,
      estimatedCost: estimated,
      costWarning: warning,
      ideaId: id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to brainstorm", details: err.message });
  }
});

// List saved ideas (with optional repo and starred filters)
app.get("/api/ideas", (req, res) => {
  try {
    const ideas = loadIdeas();
    const repoFilter = req.query.repoFullName || "";
    const starredOnly = req.query.starred === "1";

    let list = ideas;
    if (repoFilter) {
      list = list.filter(i => i.repoFullName === repoFilter);
    }
    if (starredOnly) {
      list = list.filter(i => i.starred);
    }

    const summaries = list.map(i => ({
      id: i.id,
      createdAt: i.createdAt,
      repoFullName: i.repoFullName,
      mode: i.mode,
      starred: !!i.starred,
      ideaSnippet: i.ideaText.slice(0, 140) + (i.ideaText.length > 140 ? "..." : "")
    }));

    res.json(summaries);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load ideas" });
  }
});

// Get a single idea
app.get("/api/ideas/:id", (req, res) => {
  try {
    const ideas = loadIdeas();
    const found = ideas.find(i => i.id === req.params.id);
    if (!found) {
      return res.status(404).json({ error: "Idea not found" });
    }
    res.json(found);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load idea" });
  }
});

// Star / unstar an idea
app.post("/api/ideas/:id/star", (req, res) => {
  try {
    const { starred } = req.body;
    const ideas = loadIdeas();
    const idx = ideas.findIndex(i => i.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: "Idea not found" });
    }
    ideas[idx].starred = !!starred;
    saveIdeas(ideas);
    res.json({ ok: true, starred: ideas[idx].starred });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update idea star" });
  }
});

// ---------- API: plan change (structured JSON) ----------

app.post("/api/plan", async (req, res) => {
  try {
    const { repoFullName, task, mode } = req.body;
    if (!repoFullName || !task) {
      return res.status(400).json({ error: "repoFullName and task are required" });
    }

    const repo = await gh(`/repos/${repoFullName}`);
    const defaultBranch = repo.default_branch;

    const treeData = await gh(
      `/repos/${repoFullName}/git/trees/${defaultBranch}?recursive=1`
    );
    const paths = (treeData.tree || [])
      .filter(item => item.type === "blob")
      .map(item => item.path);

    const fileTreeString = paths.join("\n").slice(0, 40_000);

    const model = modelForMode(mode, "plan");

    const plannerPrompt = `
You are a senior software architect and tech lead for this codebase.

You are given:
- A high level feature request (task).
- The GitHub repo name.
- A list of file paths from the repo.

Your job is to think carefully and return a single JSON object that describes:
- The likely stack (frameworks, languages, DB) you infer from the file tree.
- Whether the feature is realistically feasible.
- A short comment explaining any big caveats.
- Which specific files should be changed, and why.
- A clear, minimal sequence of implementation steps.
- For each file, a focused "subtaskPrompt" describing exactly what to change in that file.

Constraints:
- Do NOT write code. Planning only.
- Keep the number of files as small as reasonably possible.
- Prefer working with existing patterns and libraries used in this repo instead of introducing new technologies.
- Return valid JSON only, no extra commentary, no markdown fences.

The JSON shape should be:

{
  "stack": "string",
  "feasible": true,
  "comment": "string",
  "files": [
    {
      "path": "string",
      "reason": "string",
      "changeSummary": "string",
      "subtaskPrompt": "string"
    }
  ],
  "steps": [
    "string"
  ]
}

Task:
${task}

Repo:
${repoFullName}

File paths:
${fileTreeString}
`;

    const approxInputChars = plannerPrompt.length;
    const { estimated, warning } = estimateCost(model, approxInputChars, approxInputChars * 0.3);

    const response = await client.responses.create({
      model,
      input: plannerPrompt
    });

    let text = response.output[0].content[0].text.trim();

    if (text.startsWith("```")) {
      text = text.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "").trim();
    }

    let plan;
    try {
      plan = JSON.parse(text);
    } catch (e) {
      plan = {
        stack: "unknown",
        feasible: true,
        comment: "Model returned non JSON. Raw text in planText.",
        files: [],
        steps: [],
        planText: text
      };
    }

    // Save plan/task to disk
    const tasks = loadTasks();
    const now = new Date().toISOString();
    const taskId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const taskRecord = {
      id: taskId,
      createdAt: now,
      repoFullName,
      mode: mode || "standard",
      taskText: task,
      plan,
      modelUsed: model,
      starred: false
    };

    tasks.unshift(taskRecord);
    saveTasks(tasks);

    res.json({
      plan,
      modelUsed: model,
      estimatedCost: estimated,
      costWarning: warning,
      taskId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate plan", details: err.message });
  }
});

// List saved plans/tasks
app.get("/api/tasks", (req, res) => {
  try {
    const tasks = loadTasks();
    const repoFilter = req.query.repoFullName || "";
    const starredOnly = req.query.starred === "1";

    let list = tasks;
    if (repoFilter) {
      list = list.filter(t => t.repoFullName === repoFilter);
    }
    if (starredOnly) {
      list = list.filter(t => t.starred);
    }

    const summaries = list.map(t => ({
      id: t.id,
      createdAt: t.createdAt,
      repoFullName: t.repoFullName,
      mode: t.mode,
      starred: !!t.starred,
      taskSnippet: t.taskText.slice(0, 140) + (t.taskText.length > 140 ? "..." : "")
    }));

    res.json(summaries);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load tasks" });
  }
});

// Get a single saved plan/task
app.get("/api/tasks/:id", (req, res) => {
  try {
    const tasks = loadTasks();
    const found = tasks.find(t => t.id === req.params.id);
    if (!found) {
      return res.status(404).json({ error: "Task not found" });
    }
    res.json(found);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load task" });
  }
});

// Star / unstar a plan/task
app.post("/api/tasks/:id/star", (req, res) => {
  try {
    const { starred } = req.body;
    const tasks = loadTasks();
    const idx = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: "Task not found" });
    }
    tasks[idx].starred = !!starred;
    saveTasks(tasks);
    res.json({ ok: true, starred: tasks[idx].starred });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update task star" });
  }
});

// ---------- API: edit a single file from GitHub ----------

app.post("/api/edit-from-github", async (req, res) => {
  try {
    const { repoFullName, filePath, subtaskPrompt, mode } = req.body;
    if (!repoFullName || !filePath || !subtaskPrompt) {
      return res.status(400).json({ error: "repoFullName, filePath, and subtaskPrompt are required" });
    }

    const repo = await gh(`/repos/${repoFullName}`);
    const ref = repo.default_branch;

    const fileData = await gh(
      `/repos/${repoFullName}/contents/${encodeURIComponent(filePath)}?ref=${ref}`
    );

    if (!fileData.content) {
      return res.status(400).json({ error: "No file content returned from GitHub" });
    }

    const buff = Buffer.from(fileData.content, "base64");
    const content = buff.toString("utf8");

    const model = modelForMode(mode, "edit");

    const editorPrompt = `
You are a senior full stack engineer editing a single file in a known repo.

You are given:
- The repo name and file path.
- A focused subtask describing the change for this file.
- The current contents of that file.

Rules:
- Modify only the provided file.
- Make the smallest safe change that satisfies the subtask.
- Keep code style and patterns consistent with the existing code.
- Ensure imports and exports remain correct.
- If you must make assumptions, add a short comment at the top of the file explaining them.
- Return ONLY the full updated file content, with no extra commentary.

Repo:
${repoFullName}
File path:
${filePath}

Subtask:
${subtaskPrompt}

Current file contents:
${content}
`;

    const approxInputChars = editorPrompt.length;
    const { estimated, warning } = estimateCost(model, approxInputChars, content.length);

    const response = await client.responses.create({
      model,
      input: editorPrompt
    });

    const updatedContent = response.output[0].content[0].text;

    res.json({
      updatedContent,
      modelUsed: model,
      estimatedCost: estimated,
      costWarning: warning
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to edit file", details: err.message });
  }
});

// ---------- API: debug console errors ----------

app.post("/api/debug", async (req, res) => {
  try {
    const { repoFullName, errorText, mode } = req.body;
    if (!errorText) {
      return res.status(400).json({ error: "errorText is required" });
    }

    const model = modelForMode(mode, "debug");

    const debugPrompt = `
You are a senior engineer helping debug an application.

I will give you:
- The repo name (may be empty if unknown).
- Raw console error output and stack traces.

Your job:
1) Explain in plain language what is likely going wrong.
2) Identify which parts of the codebase are probably involved (for example specific components, routes, or files by name if they appear in the error).
3) Propose a small set of concrete changes or checks I should make, referencing file names if they appear.
4) If appropriate, suggest what I should ask the code editor AI to change in specific files.

Do not write full code. Focus on explanation and next steps.

Repo:
${repoFullName || "(not provided)"}

Error output:
${errorText}
`;

    const approxInputChars = debugPrompt.length;
    const { estimated, warning } = estimateCost(model, approxInputChars, approxInputChars * 0.5);

    const response = await client.responses.create({
      model,
      input: debugPrompt
    });

    const explanation = response.output[0].content[0].text;

    res.json({
      explanation,
      modelUsed: model,
      estimatedCost: estimated,
      costWarning: warning
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to debug", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI helper running on port ${PORT}`);
});

