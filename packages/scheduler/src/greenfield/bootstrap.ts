import type { RuntimeClient } from "@devin/agent-sdk";
import type { StackRuntime } from "@devin/types";

export type BootstrapEmitter = (
  type: string,
  message: string,
  data?: Record<string, unknown>,
) => void;

function buildCommitMessage(
  subject: string,
  botName: string,
  botEmail: string,
) {
  return `${subject}\n\nCo-authored-by: ${botName} <${botEmail}>`;
}

async function repositoryHasCommits(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  env?: Record<string, string>,
): Promise<boolean> {
  const result = await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env,
    command:
      "git rev-parse --verify HEAD >/dev/null 2>&1 && echo yes || echo no",
  });
  return result.stdout.trim() === "yes";
}

async function bootstrapNodeShell(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  gitEnv?: Record<string, string>,
): Promise<string[]> {
  const serverJs = `const express = require("express");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(\`Server listening on port \${port}\`);
});
`;

  await runtime.writeFile({
    path: `${repoCwd}/server.js`,
    content: serverJs,
  });

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: "npm init -y && npm install express",
  });

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command:
      "node -e \"const pkg=require('./package.json'); pkg.main='server.js'; pkg.scripts={start:'node server.js'}; require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));\"",
  });

  return ["server.js", "package.json", "package-lock.json"];
}

async function bootstrapGoShell(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  title: string,
  gitEnv?: Record<string, string>,
): Promise<string[]> {
  const moduleName =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 24) || "devinapp";

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: `go mod init example.com/${moduleName}`,
  });

  const mainGo = `package main

import (
  "encoding/json"
  "log"
  "net/http"
  "os"
)

func main() {
  mux := http.NewServeMux()
  mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
  })

  port := os.Getenv("PORT")
  if port == "" {
    port = "3000"
  }
  log.Printf("listening on :%s", port)
  log.Fatal(http.ListenAndServe(":"+port, mux))
}
`;

  await runtime.writeFile({
    path: `${repoCwd}/main.go`,
    content: mainGo,
  });

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: "go mod tidy",
  });

  return ["go.mod", "go.sum", "main.go"];
}

async function bootstrapRustShell(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  title: string,
  gitEnv?: Record<string, string>,
): Promise<string[]> {
  const crateName =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "devin-app";

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: `cargo init --name ${crateName}`,
  });

  const mainRs = `fn main() {
    println!("${title} — scaffold ready");
}
`;

  await runtime.writeFile({
    path: `${repoCwd}/src/main.rs`,
    content: mainRs,
  });

  return ["Cargo.toml", "Cargo.lock", "src/main.rs"];
}

async function bootstrapPythonShell(
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  gitEnv?: Record<string, string>,
): Promise<string[]> {
  const appPy = `from flask import Flask, jsonify

app = Flask(__name__)

@app.get("/health")
def health():
    return jsonify(ok=True)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(__import__("os").environ.get("PORT", 3000)))
`;

  await runtime.writeFile({
    path: `${repoCwd}/app.py`,
    content: appPy,
  });

  await runtime.writeFile({
    path: `${repoCwd}/requirements.txt`,
    content: "flask>=3.0.0\n",
  });

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: "pip install -r requirements.txt",
  });

  return ["app.py", "requirements.txt"];
}

function gitignoreForStack(stack: StackRuntime): string {
  const common = ".env\n.DS_Store\n";
  switch (stack) {
    case "go":
      return `${common}bin/\n*.exe\n`;
    case "rust":
      return `${common}target/\n`;
    case "python":
      return `${common}__pycache__/\n.venv/\n*.pyc\n`;
    case "nextjs":
    case "node":
    default:
      return `${common}node_modules/\n.next/\ndist/\n`;
  }
}

export async function bootstrapGreenfieldProject(opts: {
  runtime: RuntimeClient;
  taskId: string;
  repoCwd: string;
  prompt: string;
  stackRuntime: StackRuntime;
  title: string;
  botName: string;
  botEmail: string;
  canPush: boolean;
  githubToken?: string;
  cloneUrl?: string;
  emit: BootstrapEmitter;
}): Promise<void> {
  const gitEnv = opts.githubToken
    ? { GITHUB_TOKEN: opts.githubToken }
    : undefined;

  if (
    await repositoryHasCommits(opts.runtime, opts.taskId, opts.repoCwd, gitEnv)
  ) {
    opts.emit(
      "agent.log",
      "Repository already has commits, skipping bootstrap",
      {
        skipped: true,
      },
    );
    return;
  }

  opts.emit("agent.log", "Bootstrapping project scaffold", {
    stack: opts.stackRuntime,
    runtime: opts.stackRuntime,
  });

  const readme = `# ${opts.title}

${opts.prompt}

## Getting started

Scaffold created by Devin (${opts.stackRuntime} runtime). The agent will implement the requested functionality next.
`;

  await opts.runtime.writeFile({
    path: `${opts.repoCwd}/README.md`,
    content: readme,
  });
  await opts.runtime.writeFile({
    path: `${opts.repoCwd}/.gitignore`,
    content: gitignoreForStack(opts.stackRuntime),
  });

  const commitPaths = ["README.md", ".gitignore"];

  if (opts.stackRuntime === "go") {
    commitPaths.push(
      ...(await bootstrapGoShell(
        opts.runtime,
        opts.taskId,
        opts.repoCwd,
        opts.title,
        gitEnv,
      )),
    );
  } else if (opts.stackRuntime === "rust") {
    commitPaths.push(
      ...(await bootstrapRustShell(
        opts.runtime,
        opts.taskId,
        opts.repoCwd,
        opts.title,
        gitEnv,
      )),
    );
  } else if (opts.stackRuntime === "python") {
    commitPaths.push(
      ...(await bootstrapPythonShell(
        opts.runtime,
        opts.taskId,
        opts.repoCwd,
        gitEnv,
      )),
    );
  } else {
    commitPaths.push(
      ...(await bootstrapNodeShell(
        opts.runtime,
        opts.taskId,
        opts.repoCwd,
        gitEnv,
      )),
    );
  }

  const commitMessage = buildCommitMessage(
    `devin: bootstrap ${opts.title}`,
    opts.botName,
    opts.botEmail,
  );

  await opts.runtime.gitCommit({
    taskId: opts.taskId,
    cwd: opts.repoCwd,
    env: gitEnv,
    message: commitMessage,
    paths: commitPaths,
  });

  opts.emit("git.commit", "Bootstrapped initial project scaffold", {
    auto: true,
    bootstrap: true,
    runtime: opts.stackRuntime,
  });

  if (!opts.canPush) {
    return;
  }

  if (opts.cloneUrl && opts.githubToken) {
    await opts.runtime.terminal({
      taskId: opts.taskId,
      cwd: opts.repoCwd,
      env: gitEnv,
      command: [
        `git remote set-url origin '${opts.cloneUrl.replace(/'/g, `'\"'\"'`)}'`,
        `printf '%s' "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null || true`,
        "gh auth setup-git 2>/dev/null || true",
      ].join(" && "),
    });
  }

  await opts.runtime.gitPush({
    taskId: opts.taskId,
    cwd: opts.repoCwd,
    env: gitEnv,
    branch: "main",
  });

  opts.emit("git.push", "Pushed bootstrap scaffold to main", {
    branch: "main",
    bootstrap: true,
    runtime: opts.stackRuntime,
  });
}
