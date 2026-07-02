import type { DraftPlan } from "./draft-planner.js";

export type ScaffoldFile = {
  path: string;
  content: string;
};

export function scaffoldFilesFromDraft(
  plan: DraftPlan,
  opts: { title: string; prompt: string },
): ScaffoldFile[] {
  const paths = new Set(plan.files.map((file) => file.path));
  const files: ScaffoldFile[] = [];
  const lower = opts.prompt.toLowerCase();
  const isTodo = lower.includes("todo");

  if (paths.has("README.md")) {
    files.push({
      path: "README.md",
      content: `# ${opts.title}

${opts.prompt}

## Getting started

\`\`\`bash
npm install
npm start
\`\`\`
`,
    });
  }

  files.push({
    path: ".gitignore",
    content: "node_modules/\n.env\n.DS_Store\n",
  });

  const wantsNode =
    paths.has("package.json") ||
    paths.has("src/index.ts") ||
    paths.has("server.js") ||
    lower.includes("node") ||
    lower.includes("express") ||
    lower.includes("api");

  if (wantsNode) {
    const slug = opts.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    files.push({
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: slug || "devin-app",
          version: "1.0.0",
          private: true,
          main: paths.has("src/index.ts") ? "src/index.ts" : "server.js",
          scripts: {
            start: paths.has("src/index.ts")
              ? "node src/index.ts"
              : "node server.js",
            dev: paths.has("src/index.ts")
              ? "node --watch src/index.ts"
              : "node --watch server.js",
          },
          dependencies: {
            express: "^4.21.2",
          },
        },
        null,
        2,
      )}\n`,
    });

    if (paths.has("src/index.ts")) {
      files.push({
        path: "src/index.ts",
        content: `const express = require("express");
const todosRouter = require("./routes/todos");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/todos", todosRouter);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(\`Server listening on http://localhost:\${port}\`);
});
`,
      });
    }

    if (paths.has("src/routes/todos.ts") || isTodo) {
      files.push({
        path: "src/routes/todos.ts",
        content: `const express = require("express");

const router = express.Router();
const todos = [];
let nextId = 1;

router.get("/", (_req, res) => {
  res.json(todos);
});

router.post("/", (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }
  const todo = { id: nextId++, title, completed: false };
  todos.push(todo);
  return res.status(201).json(todo);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const todo = todos.find((entry) => entry.id === id);
  if (!todo) {
    return res.status(404).json({ error: "not found" });
  }
  if (typeof req.body?.completed === "boolean") {
    todo.completed = req.body.completed;
  }
  if (typeof req.body?.title === "string" && req.body.title.trim()) {
    todo.title = req.body.title.trim();
  }
  return res.json(todo);
});

router.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const index = todos.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return res.status(404).json({ error: "not found" });
  }
  todos.splice(index, 1);
  return res.status(204).send();
});

module.exports = router;
`,
      });
    } else if (!paths.has("src/index.ts")) {
      files.push({
        path: "server.js",
        content: `const express = require("express");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(\`Server listening on http://localhost:\${port}\`);
});
`,
      });
    }
  }

  if (files.length === 0) {
    files.push({
      path: "README.md",
      content: `# ${opts.title}\n\n${opts.prompt}\n`,
    });
  }

  if (!files.some((file) => file.path === "README.md")) {
    files.unshift({
      path: "README.md",
      content: `# ${opts.title}

${opts.prompt}

## Getting started

\`\`\`bash
npm install
npm start
\`\`\`
`,
    });
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}
