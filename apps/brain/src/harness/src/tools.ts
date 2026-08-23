import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../proto/devbox/v1/tools.proto",
);

const MAX_OUTPUT_CHARS = 8_000;

export type DevboxToolsClient = {
  Exec: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: ExecResult) => void,
  ) => void;
  ReadFile: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { content?: string }) => void,
  ) => void;
  WriteFile: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { status?: string; path?: string }) => void,
  ) => void;
  ListDir: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { entries?: string[] }) => void,
  ) => void;
  GitClone: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  GitCommit: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  GitPush: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: GitResult) => void,
  ) => void;
  DesktopScreenshot: (
    req: Record<string, unknown>,
    cb: (
      err: Error | null,
      res: { png?: Buffer; contentType?: string },
    ) => void,
  ) => void;
  BrowserOpen: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: { status?: string }) => void,
  ) => void;
  close?: () => void;
};

type ExecResult = {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
};

type GitResult = {
  status?: string;
  message?: string;
};

function truncate(value: string, max = MAX_OUTPUT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}\n… (truncated; narrow your command)`;
}

const FORBIDDEN_COAUTHOR =
  /co-authored-by:\s*.*(cursor|claude|anthropic|openai|codex|copilot|gemini)/i;

export function resolveBotCommitAuthor(): { name: string; email: string } {
  const name = process.env.GITHUB_BOT_NAME?.trim() || "baby-devin-bot";
  const email =
    process.env.GITHUB_BOT_EMAIL?.trim() ||
    "baby-devin-bot@users.noreply.github.com";
  return { name, email };
}

/**
 * Ensure every Brain git_commit includes baby-devin-bot and drops vendor AI
 * co-authors the model may have invented.
 */
export function ensureBotCommitMessage(raw: string): string {
  const bot = resolveBotCommitAuthor();
  const trailer = `Co-authored-by: ${bot.name} <${bot.email}>`;
  const trimmed = raw.trim() || "devin: agent changes";
  const parts = trimmed.split(/\n\n+/);
  const subject = (parts[0] ?? "devin: agent changes")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !FORBIDDEN_COAUTHOR.test(line))
    .join("\n")
    .trim();
  const bodyLines = parts
    .slice(1)
    .join("\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim();
      if (!t) {
        return true;
      }
      if (FORBIDDEN_COAUTHOR.test(t)) {
        return false;
      }
      // Drop duplicate baby-devin-bot trailers; we re-append once below.
      if (/^co-authored-by:\s*baby-devin-bot\b/i.test(t)) {
        return false;
      }
      if (
        new RegExp(
          `^co-authored-by:\\s*${bot.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(t)
      ) {
        return false;
      }
      return true;
    });
  while (
    bodyLines.length > 0 &&
    bodyLines[bodyLines.length - 1]?.trim() === ""
  ) {
    bodyLines.pop();
  }
  const body = [...bodyLines, trailer].join("\n").trim();
  return `${subject}\n\n${body}`;
}

/**
 * File tools resolve against the guest /workspace root. Models usually pass
 * repo-relative paths (app/page.tsx); prefix with workDir so they land in
 * /workspace/<repo>/… instead of /workspace/app/….
 */
export function resolveRepoPath(workDir: string, rawPath: string): string {
  const root = workDir.trim().replace(/^\/+|\/+$/g, "") || "repo";
  let p = rawPath.trim().replace(/\\/g, "/");
  if (!p || p === ".") {
    return root;
  }

  while (p.startsWith("/workspace/")) {
    p = p.slice("/workspace/".length);
  }
  while (p.startsWith("workspace/")) {
    p = p.slice("workspace/".length);
  }
  p = p
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== ".")
    .join("/");

  if (!p || p === root || p.startsWith(`${root}/`)) {
    return p || root;
  }
  return `${root}/${p}`;
}

function promisify<T>(
  fn: (
    req: Record<string, unknown>,
    cb: (err: Error | null, res: T) => void,
  ) => void,
  req: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  });
}

export function createDevboxToolsClient(
  target = process.env.TOOL_GATEWAY_GRPC_URL?.trim() || "127.0.0.1:9095",
): DevboxToolsClient {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as {
    devbox: {
      v1: {
        DevboxTools: new (
          addr: string,
          creds: grpc.ChannelCredentials,
        ) => DevboxToolsClient;
      };
    };
  };
  const addr = target.replace(/^grpc:\/\//, "").replace(/^http:\/\//, "");
  return new proto.devbox.v1.DevboxTools(
    addr,
    grpc.credentials.createInsecure(),
  );
}

export type ToolContext = {
  taskId: string;
  runtimeBaseUrl: string;
  workDir: string;
  client: DevboxToolsClient;
  requireProductImplementation?: boolean;
  stackRuntime?: "nextjs" | "node" | "go" | "rust" | "python";
};

export const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "shell",
      description: "Run a shell command in the Devbox workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeout_sec: { type: "integer" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 file from the Devbox. Path is relative to the repo root (e.g. app/page.tsx). Do not read node_modules.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Write a UTF-8 file in the Devbox. Path is relative to the repo root (e.g. app/page.tsx). Do not write under node_modules.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description:
        "List directory entries in the Devbox. Path is relative to the repo root (default: .). Avoid listing node_modules.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "git_commit",
      description: "Commit tracked changes in the Devbox repo.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          paths: { type: "array", items: { type: "string" } },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "git_push",
      description: "Push the current branch to origin.",
      parameters: {
        type: "object",
        properties: { branch: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_open",
      description: "Open a URL in the Devbox browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "desktop_screenshot",
      description: "Capture a desktop screenshot from the Devbox.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "save_memory",
      description: "Persist durable facts about this session for later turns.",
      parameters: {
        type: "object",
        properties: {
          facts: { type: "array", items: { type: "string" } },
        },
        required: ["facts"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "finish",
      description:
        "Mark the task complete and stop. Call when the request is done.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
      },
    },
  },
];

function isForbiddenProjectPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/.next/") ||
    normalized.startsWith(".next/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/.git/") ||
    normalized.includes("/__pycache__/") ||
    normalized.includes("/target/debug/") ||
    normalized.includes("/target/release/")
  );
}

/** Block Next.js App Router paths when the task stack is python/rust/go. */
function isWrongStackPath(
  stack: ToolContext["stackRuntime"],
  path: string,
): boolean {
  if (stack !== "python" && stack !== "rust" && stack !== "go") {
    return false;
  }
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    /(^|\/)app\/.+\.(tsx|jsx)$/.test(p) ||
    p.endsWith("/app/layout.tsx") ||
    p.endsWith("next.config.js") ||
    p.endsWith("next.config.mjs") ||
    p.endsWith("next.config.ts")
  );
}

function wrongStackMessage(stack: string, path: string): string {
  return (
    `refused ${path} — this task is a ${stack} project. ` +
    "Do not create Next.js App Router files (app/*.tsx). " +
    "Use list_dir and edit the stack entry files instead."
  );
}

function toolErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message.trim();
  if (/NOT_FOUND|no such file|ENOENT|HTTP 404/i.test(message)) {
    return `file not found: ${message.slice(0, 240)} — use list_dir / check the path under the repo root (never node_modules)`;
  }
  return `tool error: ${message.slice(0, 400)}`;
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: string,
  onSaveMemory?: (facts: string[]) => Promise<void>,
): Promise<{ content: string; done?: boolean; summary?: string }> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return { content: `invalid JSON arguments: ${rawArgs}` };
  }

  const base = {
    taskId: ctx.taskId,
    task_id: ctx.taskId,
    runtimeBaseUrl: ctx.runtimeBaseUrl,
    runtime_base_url: ctx.runtimeBaseUrl,
  };

  try {
    switch (name) {
      case "shell": {
        const command = String(args.command ?? "");
        const res = await promisify<ExecResult>(
          ctx.client.Exec.bind(ctx.client),
          {
            ...base,
            command,
            cwd: String(args.cwd ?? ctx.workDir),
            timeoutSec: Number(args.timeout_sec ?? 120),
            timeout_sec: Number(args.timeout_sec ?? 120),
          },
        );
        const code = res.exitCode ?? res.exit_code ?? 0;
        return {
          content: truncate(
            `exit=${code}\nstdout:\n${res.stdout ?? ""}\nstderr:\n${res.stderr ?? ""}`,
          ),
        };
      }
      case "read_file": {
        const path = resolveRepoPath(ctx.workDir, String(args.path ?? ""));
        if (isForbiddenProjectPath(path)) {
          return {
            content:
              `refused to read ${path} — do not touch dependency/build trees ` +
              "(node_modules, .next, dist, target, __pycache__). Use project source instead.",
          };
        }
        if (isWrongStackPath(ctx.stackRuntime, path)) {
          return { content: wrongStackMessage(ctx.stackRuntime!, path) };
        }
        const res = await promisify<{ content?: string }>(
          ctx.client.ReadFile.bind(ctx.client),
          { ...base, path },
        );
        return { content: truncate(res.content ?? "") };
      }
      case "write_file": {
        const path = resolveRepoPath(ctx.workDir, String(args.path ?? ""));
        if (isForbiddenProjectPath(path)) {
          return {
            content:
              `refused to write ${path} — never edit dependency/build trees. ` +
              "Write project source files instead.",
          };
        }
        if (isWrongStackPath(ctx.stackRuntime, path)) {
          return { content: wrongStackMessage(ctx.stackRuntime!, path) };
        }
        const res = await promisify<{ status?: string; path?: string }>(
          ctx.client.WriteFile.bind(ctx.client),
          {
            ...base,
            path,
            content: String(args.content ?? ""),
          },
        );
        return {
          content: `wrote ${res.path ?? path} (${res.status ?? "ok"})`,
        };
      }
      case "list_dir": {
        const path = resolveRepoPath(
          ctx.workDir,
          String(args.path ?? ctx.workDir),
        );
        if (isForbiddenProjectPath(path)) {
          return {
            content: `refused to list ${path} — stay in project source, not node_modules.`,
          };
        }
        const res = await promisify<{ entries?: string[] }>(
          ctx.client.ListDir.bind(ctx.client),
          { ...base, path },
        );
        return { content: truncate((res.entries ?? []).join("\n")) };
      }
      case "git_commit": {
        const res = await promisify<GitResult>(
          ctx.client.GitCommit.bind(ctx.client),
          {
            ...base,
            message: ensureBotCommitMessage(String(args.message ?? "")),
            cwd: ctx.workDir,
            paths: Array.isArray(args.paths) ? args.paths : ["."],
          },
        );
        return { content: `${res.status ?? "ok"}: ${res.message ?? ""}` };
      }
      case "git_push": {
        const res = await promisify<GitResult>(
          ctx.client.GitPush.bind(ctx.client),
          {
            ...base,
            branch: String(args.branch ?? ""),
            cwd: ctx.workDir,
          },
        );
        return { content: `${res.status ?? "ok"}: ${res.message ?? ""}` };
      }
      case "browser_open": {
        const res = await promisify<{ status?: string }>(
          ctx.client.BrowserOpen.bind(ctx.client),
          { ...base, url: String(args.url ?? "") },
        );
        return { content: res.status ?? "ok" };
      }
      case "desktop_screenshot": {
        await promisify(ctx.client.DesktopScreenshot.bind(ctx.client), base);
        return { content: "screenshot captured" };
      }
      case "save_memory": {
        const facts = Array.isArray(args.facts)
          ? args.facts.map(String).filter(Boolean)
          : [];
        if (onSaveMemory && facts.length > 0) {
          await onSaveMemory(facts);
        }
        return { content: `saved ${facts.length} fact(s)` };
      }
      case "finish": {
        if (ctx.requireProductImplementation) {
          const stack = ctx.stackRuntime;
          const isJs =
            stack === "nextjs" || stack === "node" || stack === undefined;
          if (isJs) {
            const probe = await promisify<ExecResult>(
              ctx.client.Exec.bind(ctx.client),
              {
                ...base,
                command: [
                  "set +e",
                  "echo '---SCAFFOLD---'",
                  "grep -RIl -E 'Scaffold ready|Scaffold is running|Implement the full app|App Router scaffold' --include='*.js' --include='*.ts' --include='*.html' --include='*.tsx' --include='*.jsx' . 2>/dev/null | head -8",
                  "echo '---STUB---'",
                  "grep -RIl -E 'Play .+ online with friends|View Leaderboard|Start Game|coming soon' --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.html' . 2>/dev/null | head -8",
                  "echo '---BOARD---'",
                  "grep -RIl -E 'chessboard|Chessboard|game-board|GameBoard|grid-cols-8|squares\\.map' --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.css' . 2>/dev/null | head -5",
                  "echo '---COMMITS---'",
                  "git rev-list --count HEAD 2>/dev/null || echo 0",
                ].join("\n"),
                cwd: ctx.workDir,
                timeoutSec: 45,
                timeout_sec: 45,
              },
            );
            const out = probe.stdout ?? "";
            const section = (start: string, end?: string): string[] => {
              const i = out.indexOf(start);
              if (i < 0) {
                return [];
              }
              const slice = out.slice(i + start.length);
              const j = end ? slice.indexOf(end) : -1;
              const body = j >= 0 ? slice.slice(0, j) : slice;
              return body
                .split("\n")
                .map((line) => line.trim())
                .filter(
                  (line) =>
                    line &&
                    !line.startsWith("---") &&
                    (line.endsWith(".js") ||
                      line.endsWith(".ts") ||
                      line.endsWith(".tsx") ||
                      line.endsWith(".jsx") ||
                      line.endsWith(".html") ||
                      line.endsWith(".css")),
                );
            };
            const leaks = section("---SCAFFOLD---", "---STUB---");
            const stubs = section("---STUB---", "---BOARD---");
            const boards = section("---BOARD---", "---COMMITS---");
            if (leaks.length > 0) {
              return {
                content:
                  `Cannot finish yet — scaffold placeholders remain in: ${leaks.slice(0, 5).join(", ")}. ` +
                  "Replace them with the full product UI/API, make focused commits, then call finish again.",
              };
            }
            if (stubs.length > 0 && boards.length === 0) {
              return {
                content:
                  `Cannot finish yet — marketing stub UI still present (${stubs.slice(0, 3).join(", ")}) without a real interactive product. ` +
                  "Build the actual app (e.g. playable board + moves for games), commit, then finish.",
              };
            }
          } else {
            // Non-JS stacks: only refuse finish if the thin health-only scaffold
            // is still the only product code (entry file barely changed).
            const entry =
              stack === "python"
                ? "app.py"
                : stack === "rust"
                  ? "src/main.rs"
                  : "main.go";
            const probe = await promisify<ExecResult>(
              ctx.client.Exec.bind(ctx.client),
              {
                ...base,
                command: [
                  "set +e",
                  `wc -l < '${entry}' 2>/dev/null || echo 0`,
                  "git rev-list --count HEAD 2>/dev/null || echo 0",
                ].join("\n"),
                cwd: ctx.workDir,
                timeoutSec: 20,
                timeout_sec: 20,
              },
            );
            const lines = (probe.stdout ?? "")
              .trim()
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            const entryLines = Number(lines[0] ?? 0);
            if (entryLines > 0 && entryLines < 25) {
              return {
                content:
                  `Cannot finish yet — ${entry} still looks like the thin scaffold (~${entryLines} lines). ` +
                  "Implement the full product in this stack, make focused commits, then finish.",
              };
            }
          }
        }
        return {
          content: "finished",
          done: true,
          summary: String(args.summary ?? "done"),
        };
      }
      default:
        return { content: `unknown tool: ${name}` };
    }
  } catch (error) {
    // Never abort the harness on a single tool failure (missing files, etc.).
    return { content: toolErrorMessage(error) };
  }
}
