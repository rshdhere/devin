import { ensureBotCommitMessage } from "./commit-message.js";
import { checkProductFinishGuards } from "./finish-guards.js";
import { promisify, toolErrorMessage, truncate } from "./output.js";
import {
  isForbiddenProjectPath,
  isForegroundServerCommand,
  isWrongStackPath,
  resolveRepoPath,
  wrongStackMessage,
} from "./paths.js";
import type {
  DevboxToolsClient,
  ExecResult,
  GitResult,
  ToolContext,
  ToolResult,
} from "./types.js";
import { executeToolViaWorker } from "./worker-proxy.js";

function toolBase(ctx: ToolContext): Record<string, unknown> {
  return {
    taskId: ctx.taskId,
    task_id: ctx.taskId,
    runtimeBaseUrl: ctx.runtimeBaseUrl,
    runtime_base_url: ctx.runtimeBaseUrl,
  };
}

async function executeShell(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (isForegroundServerCommand(command)) {
    return {
      content:
        `refused long-lived server command: ${command.slice(0, 120)}. ` +
        "Do not run start/dev servers in the foreground — they hang the harness. " +
        "Use a short timed smoke check (e.g. timeout 8s …) or call finish after builds/tests.",
    };
  }
  const res = await promisify<ExecResult>(toolsClient.Exec.bind(toolsClient), {
    ...toolBase(ctx),
    command,
    cwd: String(args.cwd ?? ctx.workDir),
    timeoutSec: Number(args.timeout_sec ?? 120),
    timeout_sec: Number(args.timeout_sec ?? 120),
  });
  const code = res.exitCode ?? res.exit_code ?? 0;
  return {
    content: truncate(
      `exit=${code}\nstdout:\n${res.stdout ?? ""}\nstderr:\n${res.stderr ?? ""}`,
    ),
  };
}

async function executeReadFile(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
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
    { ...toolBase(ctx), path },
  );
  return { content: truncate(res.content ?? "") };
}

async function executeWriteFile(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
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
      ...toolBase(ctx),
      path,
      content: String(args.content ?? ""),
    },
  );
  return {
    content: `wrote ${res.path ?? path} (${res.status ?? "ok"})`,
  };
}

async function executeListDir(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const path = resolveRepoPath(ctx.workDir, String(args.path ?? ctx.workDir));
  if (isForbiddenProjectPath(path)) {
    return {
      content: `refused to list ${path} — stay in project source, not node_modules.`,
    };
  }
  const res = await promisify<{ entries?: string[] }>(
    toolsClient.ListDir.bind(toolsClient),
    { ...toolBase(ctx), path },
  );
  return { content: truncate((res.entries ?? []).join("\n")) };
}

async function executeGitCommit(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const commitMessage = ensureBotCommitMessage(String(args.message ?? ""));
  const subject =
    commitMessage.split(/\n\n+/)[0]?.trim() || "devin: agent changes";

  // Avoid empty / duplicate commits that spam Progress and undercount
  // greenfield progress when the model calls git_commit on a clean tree.
  const probe = await promisify<ExecResult>(
    toolsClient.Exec.bind(toolsClient),
    {
      ...toolBase(ctx),
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
  if (lastSubject && lastSubject.toLowerCase() === subject.toLowerCase()) {
    return {
      content: `skipped duplicate commit subject "${subject}" — make a different focused change before committing again.`,
    };
  }

  const res = await promisify<GitResult>(
    toolsClient.GitCommit.bind(toolsClient),
    {
      ...toolBase(ctx),
      message: commitMessage,
      cwd: ctx.workDir,
      paths: Array.isArray(args.paths) ? args.paths : ["."],
    },
  );
  return { content: `${res.status ?? "ok"}: ${subject}` };
}

async function executeFinish(
  toolsClient: DevboxToolsClient,
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (ctx.requireProductImplementation) {
    const refusal = await checkProductFinishGuards({
      toolsClient,
      base: toolBase(ctx),
      workDir: ctx.workDir,
      stackRuntime: ctx.stackRuntime,
    });
    if (refusal) {
      return refusal;
    }
  }
  return {
    content: "finished",
    done: true,
    summary: String(args.summary ?? "done"),
  };
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: string,
  onSaveMemory?: (facts: string[]) => Promise<void>,
): Promise<ToolResult> {
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

  try {
    switch (name) {
      case "shell":
        return executeShell(toolsClient, ctx, args);
      case "read_file":
        return executeReadFile(toolsClient, ctx, args);
      case "write_file":
        return executeWriteFile(toolsClient, ctx, args);
      case "list_dir":
        return executeListDir(toolsClient, ctx, args);
      case "git_commit":
        return executeGitCommit(toolsClient, ctx, args);
      case "git_push": {
        const res = await promisify<GitResult>(
          toolsClient.GitPush.bind(toolsClient),
          {
            ...toolBase(ctx),
            branch: String(args.branch ?? ""),
            cwd: ctx.workDir,
          },
        );
        return { content: `${res.status ?? "ok"}: ${res.message ?? ""}` };
      }
      case "browser_open": {
        const res = await promisify<{ status?: string }>(
          toolsClient.BrowserOpen.bind(toolsClient),
          { ...toolBase(ctx), url: String(args.url ?? "") },
        );
        return { content: res.status ?? "ok" };
      }
      case "desktop_screenshot": {
        await promisify(
          toolsClient.DesktopScreenshot.bind(toolsClient),
          toolBase(ctx),
        );
        return { content: "screenshot captured" };
      }
      case "finish":
        return executeFinish(toolsClient, ctx, args);
      default:
        return { content: `unknown tool: ${name}` };
    }
  } catch (error) {
    // Never abort the harness on a single tool failure (missing files, etc.).
    return { content: toolErrorMessage(error) };
  }
}
