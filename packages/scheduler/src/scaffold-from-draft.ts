import type { DraftPlan } from "./draft-planner.js";

export type ScaffoldFile = {
  path: string;
  content: string;
};

/**
 * Thin runnable shell only. The runtime agent (brain) implements the product.
 * Prefer zero npm dependencies so greenfield preview can skip registry installs.
 */
export function scaffoldFilesFromDraft(
  plan: DraftPlan,
  opts: { title: string; prompt: string },
): ScaffoldFile[] {
  const paths = new Set(plan.files.map((file) => file.path));
  const files: ScaffoldFile[] = [];
  const lower = opts.prompt.toLowerCase();
  const title = opts.title.trim() || "Devin app";

  if (paths.has("README.md")) {
    files.push({
      path: "README.md",
      content: `# ${title}

${opts.prompt}

## Getting started

\`\`\`bash
npm start
\`\`\`

_Scaffold only — the sandbox agent implements the product and commits as it goes._
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
    lower.includes("todo") ||
    lower.includes("chat") ||
    lower.includes("app") ||
    lower.includes("next.js") ||
    lower.includes("nextjs") ||
    lower.includes("next js") ||
    lower.includes("react");

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
        },
        null,
        2,
      )}\n`,
    });

    files.push({
      path: entry,
      content: thinNodeServerSource(title),
    });
  }

  const generatedPaths = new Set(files.map((file) => file.path));
  for (const planned of plan.files) {
    if (planned.path === "src/index.ts" && generatedPaths.has("src/index.js")) {
      continue;
    }
    // Never ship product stubs from the control plane — the agent owns those paths.
    if (
      planned.path.startsWith("src/routes/") ||
      planned.path === "src/index.ts"
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

function thinNodeServerSource(title: string): string {
  const safe = escapeHtml(title);
  return `const http = require("http");

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(\`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safe}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #111; }
    main { width: min(28rem, 92vw); }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    p { margin: 0; color: #444; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <h1>${safe}</h1>
    <p>Scaffold is running. Implement the full app (UI + API), then keep <code>GET /</code> user-facing.</p>
  </main>
</body>
</html>\`);
});

server.listen(port, "0.0.0.0", () => {
  console.log("listening on :" + port);
});
`;
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
