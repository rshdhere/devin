import type { RuntimeClient } from "@devin/agent-sdk";

export type BootstrapEmitter = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

function looksLikeNodeProject(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("node") ||
    lower.includes("express") ||
    lower.includes("todo") ||
    lower.includes("api") ||
    lower.includes("javascript") ||
    lower.includes("typescript")
  );
}

function buildCommitMessage(
  subject: string,
  botName: string,
  botEmail: string,
) {
  return `${subject}\n\nCo-authored-by: ${botName} <${botEmail}>`;
}

export async function bootstrapGreenfieldProject(opts: {
  runtime: RuntimeClient;
  taskId: string;
  repoCwd: string;
  prompt: string;
  title: string;
  botName: string;
  botEmail: string;
  canPush: boolean;
  emit: BootstrapEmitter;
}): Promise<void> {
  if (!looksLikeNodeProject(opts.prompt)) {
    return;
  }

  opts.emit("agent.log", "Bootstrapping Node.js project scaffold", {
    stack: "nodejs",
  });

  const serverJs = `const express = require("express");

const app = express();
app.use(express.json());

const todos = [];

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/signup", (req, res) => {
  res.status(501).json({ message: "signup not implemented yet", body: req.body });
});

app.post("/signin", (req, res) => {
  res.status(501).json({ message: "signin not implemented yet", body: req.body });
});

app.post("/createTodo", (req, res) => {
  res.status(501).json({ message: "createTodo not implemented yet", body: req.body });
});

app.delete("/deleteTodo/:id", (req, res) => {
  res.status(501).json({ message: "deleteTodo not implemented yet", id: req.params.id });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(\`Server listening on port \${port}\`);
});
`;

  const readme = `# ${opts.title}

${opts.prompt}

## Getting started

\`\`\`bash
npm install
npm start
\`\`\`
`;

  await opts.runtime.terminal({
    taskId: opts.taskId,
    cwd: opts.repoCwd,
    command: "npm init -y && npm install express",
  });

  await opts.runtime.writeFile({
    path: `${opts.repoCwd}/server.js`,
    content: serverJs,
  });
  await opts.runtime.writeFile({
    path: `${opts.repoCwd}/README.md`,
    content: readme,
  });
  await opts.runtime.writeFile({
    path: `${opts.repoCwd}/.gitignore`,
    content: "node_modules/\n.env\n",
  });

  await opts.runtime.terminal({
    taskId: opts.taskId,
    cwd: opts.repoCwd,
    command:
      "node -e \"const pkg=require('./package.json'); pkg.main='server.js'; pkg.scripts={start:'node server.js'}; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));\"",
  });

  const commitMessage = buildCommitMessage(
    `devin: bootstrap ${opts.title}`,
    opts.botName,
    opts.botEmail,
  );

  await opts.runtime.gitCommit({
    taskId: opts.taskId,
    cwd: opts.repoCwd,
    message: commitMessage,
    paths: ["."],
  });

  opts.emit("git.commit", "Bootstrapped initial Node.js scaffold", {
    auto: true,
    bootstrap: true,
  });

  if (opts.canPush) {
    const pushResult = await opts.runtime.gitPush({
      taskId: opts.taskId,
      cwd: opts.repoCwd,
      branch: "main",
    });
    if (pushResult.status === "completed") {
      opts.emit("git.push", "Pushed bootstrap scaffold to main", {
        branch: "main",
        bootstrap: true,
      });
    }
  }
}
