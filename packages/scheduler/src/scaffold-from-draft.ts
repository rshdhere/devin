import type { DraftPlan } from "./draft-planner.js";

export type ScaffoldFile = {
  path: string;
  content: string;
};

/**
 * Control-plane scaffold must stay thin: a runnable shell the agent builds on.
 * Shipping a full todo app here left agents with nothing to commit and browsers
 * hitting Express "Cannot GET /" when only /todos + /health existed.
 */
export function scaffoldFilesFromDraft(
  plan: DraftPlan,
  opts: { title: string; prompt: string },
): ScaffoldFile[] {
  const paths = new Set(plan.files.map((file) => file.path));
  const files: ScaffoldFile[] = [];
  const lower = opts.prompt.toLowerCase();
  const isTodo = lower.includes("todo");
  const title = opts.title.trim() || "Devin app";

  if (paths.has("README.md")) {
    files.push({
      path: "README.md",
      content: `# ${title}

${opts.prompt}

## Getting started

\`\`\`bash
npm install
npm start
\`\`\`

_Scaffold only — implement the product in the sandbox, commit as you go._
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
    paths.has("src/index.js") ||
    paths.has("server.js") ||
    lower.includes("node") ||
    lower.includes("express") ||
    lower.includes("api") ||
    isTodo;

  if (wantsNode) {
    const slug = opts.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const entry = "src/index.js";
    files.push({
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: slug || "devin-app",
          version: "1.0.0",
          private: true,
          main: entry,
          scripts: {
            start: `node ${entry}`,
            dev: `node --watch ${entry}`,
          },
          dependencies: {
            express: "^4.21.2",
          },
        },
        null,
        2,
      )}\n`,
    });

    const mountTodos =
      paths.has("src/routes/todos.ts") ||
      paths.has("src/routes/todos.js") ||
      isTodo;

    files.push({
      path: entry,
      content: `const express = require("express");
${mountTodos ? 'const todosRouter = require("./routes/todos");\n' : ""}
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.type("html").send(\`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #111; }
    main { width: min(28rem, 92vw); }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    p { margin: 0 0 1rem; color: #444; line-height: 1.45; }
    a { color: #0b57d0; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>Scaffold is running. Implement the full app (UI + API), then keep <code>GET /</code> user-facing.</p>
    <p><a href="/health">/health</a>${mountTodos ? ' · <a href="/todos">/todos</a>' : ""}</p>
  </main>
</body>
</html>\`);
});
${
  mountTodos
    ? `
app.use("/todos", todosRouter);
`
    : ""
}
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(\`Server listening on http://0.0.0.0:\${port}\`);
});
`,
    });

    if (mountTodos) {
      files.push({
        path: "src/routes/todos.js",
        content: `const express = require("express");

const router = express.Router();

// TODO: implement todo CRUD (list/create/update/delete) for the user prompt.
router.get("/", (_req, res) => {
  res.json([]);
});

module.exports = router;
`,
      });
    }
  }

  const generatedPaths = new Set(files.map((file) => file.path));
  for (const planned of plan.files) {
    // Prefer .js entry points we already emitted over draft .ts stubs.
    if (planned.path === "src/index.ts" && generatedPaths.has("src/index.js")) {
      continue;
    }
    if (
      planned.path === "src/routes/todos.ts" &&
      generatedPaths.has("src/routes/todos.js")
    ) {
      continue;
    }
    if (!generatedPaths.has(planned.path)) {
      files.push({
        path: planned.path,
        content: stubContentForPath(planned.path, planned.summary),
      });
      generatedPaths.add(planned.path);
    }
  }

  if (files.length === 0) {
    files.push({
      path: "README.md",
      content: `# ${title}\n\n${opts.prompt}\n`,
    });
  }

  if (!files.some((file) => file.path === "README.md")) {
    files.unshift({
      path: "README.md",
      content: `# ${title}

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stubContentForPath(path: string, summary: string): string {
  const lower = path.toLowerCase();
  const safeSummary = summary.trim() || "implement planned change";

  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx")
  ) {
    return `// TODO: ${safeSummary}\n`;
  }
  if (lower.endsWith(".py")) {
    return `# TODO: ${safeSummary}\n`;
  }
  if (lower.endsWith(".md")) {
    return `# ${safeSummary}\n`;
  }
  if (lower.endsWith(".json")) {
    return `${JSON.stringify({ note: safeSummary }, null, 2)}\n`;
  }
  return `# TODO: ${safeSummary}\n`;
}
