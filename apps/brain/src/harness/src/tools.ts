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

const ANY_COAUTHOR = /^co-authored-by:/i;

const CONVENTIONAL_TYPES =
  "feat|fix|refactor|perf|docs|test|build|ci|chore|style|revert";

const CONVENTIONAL_SUBJECT = new RegExp(
  `^(${CONVENTIONAL_TYPES})(\\([a-z0-9][a-z0-9/_-]{0,32}\\))?:\\s+(.+)$`,
  "i",
);

function isCoAuthorTrailer(line: string): boolean {
  return ANY_COAUTHOR.test(line.trim());
}

export function resolveBotCommitAuthor(): { name: string; email: string } {
  const name = process.env.GITHUB_BOT_NAME?.trim() || "baby-devin-bot";
  const email =
    process.env.GITHUB_BOT_EMAIL?.trim() ||
    "baby-devin-bot@users.noreply.github.com";
  return { name, email };
}

/** Lowercase the imperative verb after type(context): — per AGENTS.md. */
function normalizeImperativeSummary(summary: string): string {
  const trimmed = summary.trim().replace(/[.;:,]+$/g, "");
  if (!trimmed) {
    return "update project";
  }
  // Strip leading "Added/Implemented/Updated …" → imperative.
  const stripped = trimmed
    .replace(
      /^(added|implemented|implements|implement|updated|created|fixed|improved|changed|refactored)\s+/i,
      "",
    )
    .trim();
  const words = (stripped || trimmed).split(/\s+/);
  if (words[0]) {
    words[0] = words[0].toLowerCase();
  }
  // Prefer an imperative verb when the summary is a noun phrase.
  const first = words[0] ?? "update";
  if (
    !/^(add|fix|update|remove|rename|move|wire|implement|introduce|prevent|support|improve|refactor|document|test|build|ship)\b/i.test(
      first,
    )
  ) {
    return `add ${words.join(" ")}`.slice(0, 72);
  }
  return words.join(" ").slice(0, 72);
}

/**
 * Shape Brain commit subjects like AGENTS.md Conventional Commits:
 * `type(context): imperative summary`
 */
export function normalizeConventionalSubject(rawSubject: string): string {
  const subject = rawSubject.trim().replace(/\s+/g, " ");
  if (!subject || isCoAuthorTrailer(subject)) {
    return "chore(repo): update project files";
  }

  const match = subject.match(CONVENTIONAL_SUBJECT);
  if (match) {
    const type = match[1]!.toLowerCase();
    const scope = match[2]?.toLowerCase() ?? "";
    const summary = normalizeImperativeSummary(match[3] ?? "");
    return `${type}${scope}: ${summary}`.slice(0, 72);
  }

  // Bare "feat: …" without scope — keep type, normalize summary.
  const bare = subject.match(
    new RegExp(`^(${CONVENTIONAL_TYPES}):\\s*(.+)$`, "i"),
  );
  if (bare) {
    return `${bare[1]!.toLowerCase()}: ${normalizeImperativeSummary(bare[2] ?? "")}`.slice(
      0,
      72,
    );
  }

  return `feat: ${normalizeImperativeSummary(subject)}`.slice(0, 72);
}

function extractBulletPoints(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const bullet = t.match(/^[-*]\s+(.+)$/);
    if (bullet?.[1]) {
      const text = bullet[1].trim().replace(/[.;]+$/g, "");
      if (text && !isCoAuthorTrailer(text)) {
        bullets.push(`- ${text}`);
      }
    }
    if (bullets.length >= 4) {
      break;
    }
  }
  return bullets;
}

/**
 * Ensure every Brain git_commit follows AGENTS.md Conventional Commits fashion
 * and always attaches baby-devin-bot (product attribution trailer).
 */
export function ensureBotCommitMessage(raw: string): string {
  const bot = resolveBotCommitAuthor();
  const trailer = `Co-authored-by: ${bot.name} <${bot.email}>`;
  const trimmed = raw.trim();

  const contentLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    const t = line.trim();
    if (!t || isCoAuthorTrailer(t) || FORBIDDEN_COAUTHOR.test(t)) {
      continue;
    }
    contentLines.push(t);
  }

  const subject = normalizeConventionalSubject(contentLines[0] ?? "");
  const bullets = extractBulletPoints(contentLines.slice(1));
  const body = [...bullets, trailer].join("\n");
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
  client?: DevboxToolsClient;
  requireProductImplementation?: boolean;
  stackRuntime?: "nextjs" | "node" | "go" | "rust" | "python";
  /** When set, Devbox tools are proxied via the execution worker (Brain mode). */
  executionWorkerUrl?: string;
};

/**
 * Call a Devbox tool through the worker HTTP proxy (Brain → worker → gateway).
 * Worker resolves the live session by taskId — no guest IP on the Brain.
 */
export async function executeToolViaWorker(
  ctx: Pick<
    ToolContext,
    | "taskId"
    | "workDir"
    | "executionWorkerUrl"
    | "requireProductImplementation"
    | "stackRuntime"
  >,
  name: string,
  rawArgs: string,
): Promise<{ content: string; done?: boolean; summary?: string }> {
  const base = ctx.executionWorkerUrl?.replace(/\/$/, "");
  if (!base) {
    return { content: "tool error: EXECUTION_WORKER_URL is not configured" };
  }

  try {
    const response = await fetch(
      `${base}/api/v1/tasks/${encodeURIComponent(ctx.taskId)}/tools`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          arguments: rawArgs,
          workDir: ctx.workDir,
          stackRuntime: ctx.stackRuntime,
          requireProductImplementation: ctx.requireProductImplementation,
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      content?: string;
      done?: boolean;
      summary?: string;
      error?: string;
    };
    if (!response.ok) {
      return {
        content:
          body.error ?? body.content ?? `tool proxy HTTP ${response.status}`,
      };
    }
    return {
      content: body.content ?? "",
      done: body.done,
      summary: body.summary,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "worker tool proxy failed";
    return { content: `tool error: ${message}` };
  }
}

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
      description:
        "Commit tracked changes using Conventional Commits. Message format: type(context): imperative summary, optional blank line, then up to 4 '- ' bullets. Example: feat(ui): add flappy bird canvas\\n\\n- Render bird on canvas\\n- Add collision checks. Do not include Co-authored-by — baby-devin-bot is added automatically.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "Conventional commit: type(context): lowercase imperative summary, optionally followed by up to 4 bullet lines",
          },
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

function isForegroundServerCommand(command: string): boolean {
  const c = command.trim();
  // Long-lived servers hang the harness (UI spinner stuck on Ran `bun start`).
  return (
    /\b(bun|npm|yarn|pnpm)\s+(run\s+)?(start|dev)\b/i.test(c) ||
    /\b(bun|npm|yarn|pnpm)\s+start\b/i.test(c) ||
    /\bnext(\s+dev|\s+start)\b/i.test(c) ||
    /\bnpx\s+.*\b(next|vite|webpack-dev-server)\b/i.test(c) ||
    /\b(uvicorn|gunicorn|flask\s+run)\b/i.test(c) ||
    /\bpython(\d+(?:\.\d+)*)?\s+-m\s+(uvicorn|http\.server|flask)\b/i.test(c)
  );
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

  // save_memory stays on Brain (HydraDB / session memory); never proxy it.
  if (name === "save_memory") {
    const facts = Array.isArray(args.facts)
      ? args.facts.map(String).filter(Boolean)
      : [];
    if (onSaveMemory && facts.length > 0) {
      await onSaveMemory(facts);
    }
    return { content: `saved ${facts.length} fact(s)` };
  }

  if (ctx.executionWorkerUrl?.trim()) {
    return executeToolViaWorker(ctx, name, rawArgs);
  }

  if (!ctx.client) {
    return {
      content:
        "tool error: no Devbox tools client (set toolGatewayUrl or executionWorkerUrl)",
    };
  }
  const toolsClient = ctx.client;

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
        if (isForegroundServerCommand(command)) {
          return {
            content:
              `refused long-lived server command: ${command.slice(0, 120)}. ` +
              "Do not run start/dev servers in the foreground — they hang the harness. " +
              "Use a short timed smoke check (e.g. timeout 8s …) or call finish after builds/tests.",
          };
        }
        const res = await promisify<ExecResult>(
          toolsClient.Exec.bind(toolsClient),
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
          toolsClient.ReadFile.bind(toolsClient),
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
          toolsClient.WriteFile.bind(toolsClient),
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
          toolsClient.ListDir.bind(toolsClient),
          { ...base, path },
        );
        return { content: truncate((res.entries ?? []).join("\n")) };
      }
      case "git_commit": {
        const commitMessage = ensureBotCommitMessage(
          String(args.message ?? ""),
        );
        const subject =
          commitMessage.split(/\n\n+/)[0]?.trim() || "devin: agent changes";

        // Avoid empty / duplicate commits that spam Progress and undercount
        // greenfield progress when the model calls git_commit on a clean tree.
        const probe = await promisify<ExecResult>(
          toolsClient.Exec.bind(toolsClient),
          {
            ...base,
            command: [
              "set +e",
              "git add -A >/dev/null 2>&1",
              "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')",
              "last=$(git log -1 --format=%s 2>/dev/null || true)",
              'echo "dirty=$dirty"',
              'printf "last=%s\\n" "$last"',
            ].join("\n"),
            cwd: ctx.workDir,
            timeoutSec: 30,
            timeout_sec: 30,
          },
        );
        const probeOut = probe.stdout ?? "";
        const dirty = Number(probeOut.match(/^dirty=(\d+)/m)?.[1] ?? 0);
        const lastSubject = probeOut.match(/^last=(.*)$/m)?.[1]?.trim() ?? "";
        if (dirty < 1) {
          return {
            content:
              "nothing to commit — working tree clean. Edit files first, then git_commit with a new subject.",
          };
        }
        if (
          lastSubject &&
          lastSubject.toLowerCase() === subject.toLowerCase()
        ) {
          return {
            content: `skipped duplicate commit subject "${subject}" — make a different focused change before committing again.`,
          };
        }

        const res = await promisify<GitResult>(
          toolsClient.GitCommit.bind(toolsClient),
          {
            ...base,
            message: commitMessage,
            cwd: ctx.workDir,
            paths: Array.isArray(args.paths) ? args.paths : ["."],
          },
        );
        return { content: `${res.status ?? "ok"}: ${subject}` };
      }
      case "git_push": {
        const res = await promisify<GitResult>(
          toolsClient.GitPush.bind(toolsClient),
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
          toolsClient.BrowserOpen.bind(toolsClient),
          { ...base, url: String(args.url ?? "") },
        );
        return { content: res.status ?? "ok" };
      }
      case "desktop_screenshot": {
        await promisify(toolsClient.DesktopScreenshot.bind(toolsClient), base);
        return { content: "screenshot captured" };
      }
      case "finish": {
        if (ctx.requireProductImplementation) {
          const stack = ctx.stackRuntime;
          const isJs =
            stack === "nextjs" || stack === "node" || stack === undefined;
          if (isJs) {
            const probe = await promisify<ExecResult>(
              toolsClient.Exec.bind(toolsClient),
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
            // Non-JS stacks: refuse finish if thin health-only scaffold remains,
            // or if GET / is still a 404 (Desktop dumps that frame otherwise).
            const entry =
              stack === "python"
                ? "app.py"
                : stack === "rust"
                  ? "src/main.rs"
                  : "main.go";
            const probe = await promisify<ExecResult>(
              toolsClient.Exec.bind(toolsClient),
              {
                ...base,
                command: [
                  "set +e",
                  `wc -l < '${entry}' 2>/dev/null || echo 0`,
                  "git rev-list --count HEAD 2>/dev/null || echo 0",
                  "echo '---ROOT---'",
                  "ROOT_OK=no",
                  "if command -v ss >/dev/null 2>&1; then",
                  "  for p in 3000 3099 8000 8080 5000; do",
                  "    code=$(curl -s -o /tmp/devin-root-body -w '%{http_code}' -H 'Accept: text/html,*/*' --max-time 2 \"http://127.0.0.1:$p/\" 2>/dev/null || true)",
                  '    if [ "$code" = "200" ]; then',
                  "      body=$(head -c 512 /tmp/devin-root-body 2>/dev/null || true)",
                  "      if echo \"$body\" | grep -qiE '404 page not found|Cannot GET /'; then continue; fi",
                  "      if echo \"$body\" | grep -qiE '<!doctype html|<html|<body|<div|<h1|<form|Scaffold ready'; then ROOT_OK=yes; break; fi",
                  "      ROOT_OK=yes; break",
                  "    fi",
                  "  done",
                  "fi",
                  'echo "$ROOT_OK"',
                  "echo '---HANDLER---'",
                  `grep -E 'HandleFunc\\(\"/\"|Handle\\(\"/\"|@app\\.(get|route)\\(\"/\"|route\\(\"/\"|\\(\"/\"\\)' '${entry}' 2>/dev/null | head -3 || true`,
                ].join("\n"),
                cwd: ctx.workDir,
                timeoutSec: 30,
                timeout_sec: 30,
              },
            );
            const out = (probe.stdout ?? "").trim();
            const lines = out
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
            const rootIdx = lines.indexOf("---ROOT---");
            const rootOk = rootIdx >= 0 ? (lines[rootIdx + 1] ?? "no") : "no";
            const handlerIdx = lines.indexOf("---HANDLER---");
            const hasRootHandler =
              handlerIdx >= 0 &&
              lines.slice(handlerIdx + 1).some((l) => l.includes("/"));
            if (rootOk !== "yes" && !hasRootHandler) {
              return {
                content:
                  "Cannot finish yet — GET / does not serve a user-facing page (Desktop would show 404). " +
                  "Add an HTML UI at `/` (keep `/health`), smoke-check it, commit, then finish.",
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
