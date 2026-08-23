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
      description: "Read a UTF-8 file from the Devbox.",
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
      description: "Write a UTF-8 file in the Devbox.",
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
      description: "List directory entries in the Devbox.",
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
      const res = await promisify<{ content?: string }>(
        ctx.client.ReadFile.bind(ctx.client),
        { ...base, path: String(args.path ?? "") },
      );
      return { content: truncate(res.content ?? "") };
    }
    case "write_file": {
      const res = await promisify<{ status?: string; path?: string }>(
        ctx.client.WriteFile.bind(ctx.client),
        {
          ...base,
          path: String(args.path ?? ""),
          content: String(args.content ?? ""),
        },
      );
      return {
        content: `wrote ${res.path ?? args.path} (${res.status ?? "ok"})`,
      };
    }
    case "list_dir": {
      const res = await promisify<{ entries?: string[] }>(
        ctx.client.ListDir.bind(ctx.client),
        { ...base, path: String(args.path ?? ctx.workDir) },
      );
      return { content: truncate((res.entries ?? []).join("\n")) };
    }
    case "git_commit": {
      const res = await promisify<GitResult>(
        ctx.client.GitCommit.bind(ctx.client),
        {
          ...base,
          message: String(args.message ?? ""),
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
        const probe = await promisify<ExecResult>(
          ctx.client.Exec.bind(ctx.client),
          {
            ...base,
            command: [
              "set +e",
              "grep -RIl -E 'Scaffold ready|Scaffold is running|Implement the full app' --include='*.js' --include='*.ts' --include='*.html' --include='*.tsx' --include='*.jsx' . 2>/dev/null | head -8",
            ].join("\n"),
            cwd: ctx.workDir,
            timeoutSec: 45,
            timeout_sec: 45,
          },
        );
        const leaks = (probe.stdout ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) =>
              line &&
              (line.endsWith(".js") ||
                line.endsWith(".ts") ||
                line.endsWith(".tsx") ||
                line.endsWith(".jsx") ||
                line.endsWith(".html")),
          );
        if (leaks.length > 0) {
          return {
            content:
              `Cannot finish yet — scaffold placeholders remain in: ${leaks.slice(0, 5).join(", ")}. ` +
              "Replace them with the full product UI/API, make focused commits, then call finish again.",
          };
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
}
