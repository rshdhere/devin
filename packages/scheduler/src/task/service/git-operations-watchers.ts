import { RuntimeClient } from "@devin/agent-sdk";
import type { TaskEventType } from "@devin/events";
import { resolveCursorAgentModel } from "@devin/types";
import {
  createGitHubIssue,
  createGitHubPullRequest,
  fetchDefaultBranch,
  type GitHubUserIdentity,
} from "../../github/client.js";
import {
  buildPushGreenfieldMainScript,
  greenfieldCommitPlateauReason,
  GREENFIELD_PLATEAU_MIN_COMMITS,
  GREENFIELD_PLATEAU_MS,
} from "../../greenfield/git-sync.js";
import {
  sandboxProcessEnv,
  shellPrepareWritableHome,
} from "../../sandbox/env.js";
import { buildAgentAttributionOptOutScript } from "../attribution.js";
import type { AgentProvider, ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import {
  buildCommitMessage,
  escapeShell,
  resolveAgentTimeoutMinutes,
  resolveBotAuthor,
} from "./config.js";
import { maybeTriggerDesktopSnapshotFromRuntime } from "./desktop-capture.js";
import { pushGreenfieldMain } from "./greenfield-provision-2.js";
import { emit, emitRuntime } from "./task-state.js";

export function startGreenfieldPushWatcher(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  job: ScheduleJob,
  repoCwd: string,
  githubToken?: string,
  preAgentHead?: string,
  onPlateau?: (reason: string) => void,
): () => void {
  let stopped = false;
  let lastSyncedHead = preAgentHead?.trim() ?? "";
  let lastSeenHead = lastSyncedHead;
  let lastHeadChangeAt = Date.now();
  let plateauCancelRequested = false;
  const baseHead = preAgentHead?.trim() ?? "";

  const tick = async () => {
    if (stopped) {
      return;
    }
    try {
      const probe = await runtime.terminalAllowFailure({
        taskId,
        cwd: repoCwd,
        env: gitRuntimeEnv(svc, githubToken),
        command: [
          "set +e",
          "head=$(git rev-parse HEAD 2>/dev/null || true)",
          "commits=0",
          `base='${baseHead.replace(/'/g, "")}'`,
          'if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then',
          '  commits=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)',
          'elif [ -n "$head" ]; then',
          "  commits=$(git rev-list --count HEAD 2>/dev/null || echo 0)",
          "fi",
          'echo "head=$head commits=$commits"',
        ].join("\n"),
      });
      const output = `${probe.stdout}\n${probe.stderr}`;
      const head = output.match(/^head=(\S+)/m)?.[1]?.trim() ?? "";
      const commits = Number(output.match(/commits=(\d+)/)?.[1] ?? 0);

      if (head && head !== lastSeenHead) {
        lastSeenHead = head;
        lastHeadChangeAt = Date.now();
      }

      if (head && head !== lastSyncedHead) {
        const pushed = await pushGreenfieldMain(
          svc,
          runtime,
          taskId,
          repoCwd,
          githubToken,
          job.cloneUrl,
        );
        if (pushed) {
          lastSyncedHead = head;
          emit(svc, "git.push", taskId, "Synced agent commits to GitHub", {
            branch: "main",
            auto: true,
            commits,
          });
        }
      }

      if (
        !plateauCancelRequested &&
        commits >= GREENFIELD_PLATEAU_MIN_COMMITS &&
        Date.now() - lastHeadChangeAt >= GREENFIELD_PLATEAU_MS
      ) {
        plateauCancelRequested = true;
        const reason = greenfieldCommitPlateauReason(commits);
        emit(svc, "agent.log", taskId, reason, {
          commits,
          plateauMs: GREENFIELD_PLATEAU_MS,
          softComplete: true,
        });
        onPlateau?.(reason);
        try {
          await runtime.cancelRun(taskId, reason);
        } catch {
          // Old guest runtimes may lack /run/cancel; control-plane abort is enough.
        }
      }
    } catch {
      // best-effort background sync
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, 30_000);
  const initial = setTimeout(() => {
    void tick();
  }, 20_000);

  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(initial);
  };
}

export function startAutoCommitWatcher(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  gitOwner?: GitHubUserIdentity,
  greenfield = false,
  githubToken?: string,
): () => void {
  if (!job.permissions?.canCommit) {
    return () => undefined;
  }

  let stopped = false;
  let lastDirtyFingerprint = "";

  const tick = async () => {
    if (stopped) {
      return;
    }

    const gitEnv = gitRuntimeEnv(svc, githubToken);

    try {
      const status = await runtime.terminal({
        taskId: task.id,
        command: "git status --porcelain",
        cwd: repoCwd,
        env: gitEnv,
      });
      const dirty = status.stdout.trim();
      if (!dirty || dirty === lastDirtyFingerprint) {
        return;
      }

      const diff = await runtime.terminal({
        taskId: task.id,
        command: "git diff --stat && git diff --cached --stat",
        cwd: repoCwd,
        env: gitEnv,
      });

      await runtime.gitCommit({
        taskId: task.id,
        message: buildCommitMessage(
          `devin: checkpoint — ${task.title ?? "work in progress"}`,
        ),
        paths: ["."],
        cwd: repoCwd,
        env: gitEnv,
      });

      lastDirtyFingerprint = "";

      emit(svc, "git.commit", task.id, "Auto-committed checkpoint", {
        auto: true,
        author: gitOwner?.login,
        coAuthor: resolveBotAuthor().name,
        diff: diff.stdout.trim(),
      });

      if (job.permissions?.canPush && greenfield) {
        const pushed = await pushGreenfieldMain(
          svc,
          runtime,
          task.id,
          repoCwd,
          githubToken,
          job.cloneUrl,
        );
        if (pushed) {
          emit(svc, "git.push", task.id, "Pushed checkpoint to main", {
            branch: "main",
            auto: true,
          });
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Auto-commit failed";
      emit(svc, "git.commit", task.id, `Checkpoint skipped: ${message}`, {
        auto: true,
        error: message,
      });
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, 60_000);
  const initial = setTimeout(() => {
    void tick();
  }, 45_000);

  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(initial);
  };
}

export async function readGitHead(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  githubToken?: string,
): Promise<string> {
  const result = await runtime.terminalAllowFailure({
    taskId,
    cwd: repoCwd,
    env: gitRuntimeEnv(svc, githubToken),
    command: "git rev-parse HEAD 2>/dev/null || true",
  });
  return result.stdout.trim();
}

/**
 * Cursor agent CLI shebang is `#!/usr/bin/env bash`. Guests often boot with a
 * PATH that omits /bin:/usr/bin, so env cannot find bash even when /bin/bash
 * exists. Old runtime snapshots also prepend only /usr/local/bin — put bash
 * there and rewrite agent shebangs so launches work before snapshot rebuild.
 *
 * Never `ln -sfn` bash onto itself: with /usr/local/bin first on PATH,
 * `command -v bash` can return /usr/local/bin/bash and that creates a
 * self-referential symlink ("Too many levels of symbolic links").
 */

export async function assertGreenfieldAgentProgress(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  repoCwd: string,
  githubToken: string | undefined,
  preAgentHead: string,
): Promise<void> {
  const gitEnv = gitRuntimeEnv(svc, githubToken);
  const probe = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    env: gitEnv,
    command: [
      "set +e",
      "head=$(git rev-parse HEAD 2>/dev/null || true)",
      "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')",
      "new_commits=0",
      `base='${preAgentHead.replace(/'/g, "")}'`,
      'if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then',
      '  new_commits=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)',
      "fi",
      'echo "head=$head dirty=$dirty new_commits=$new_commits base=$base"',
      "grep -RIl -E 'Scaffold ready|Scaffold is running|Implement the full app' --include='*.js' --include='*.ts' --include='*.html' --include='*.tsx' --include='*.jsx' . 2>/dev/null | head -8",
    ].join("\n"),
  });

  const output = `${probe.stdout}\n${probe.stderr}`.trim();
  const headMatch = output.match(/^head=(\S+)/m);
  const dirtyMatch = output.match(/dirty=(\d+)/);
  const newCommitsMatch = output.match(/new_commits=(\d+)/);
  const head = headMatch?.[1] ?? "";
  const dirty = Number(dirtyMatch?.[1] ?? 0);
  const newCommits = Number(newCommitsMatch?.[1] ?? 0);
  const movedHead =
    Boolean(preAgentHead) && Boolean(head) && head !== preAgentHead;
  const leakLines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("head=") &&
        (line.endsWith(".js") ||
          line.endsWith(".ts") ||
          line.endsWith(".tsx") ||
          line.endsWith(".jsx") ||
          line.endsWith(".html")),
    );

  emit(svc, "agent.log", task.id, "Checking greenfield agent progress", {
    preAgentHead: preAgentHead || null,
    head: head || null,
    dirty,
    newCommits,
    movedHead,
    scaffoldLeakFiles: leakLines,
  });

  if (!movedHead && newCommits < 1 && dirty < 1) {
    throw new Error(
      "Agent finished without product commits — scaffold was left unchanged. " +
        "The cursor agent must edit files and commit (CLI missing, sandbox, or no-op run).",
    );
  }

  if (leakLines.length > 0 && newCommits < 2 && dirty < 1) {
    throw new Error(
      `Agent left scaffold placeholders in place (${leakLines.slice(0, 3).join(", ")}). Implement the full product with multiple focused commits.`,
    );
  }
}

export async function runTests(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  testCommand: string,
  repoCwd: string,
): Promise<void> {
  emit(svc, "tests.running", task.id, `Running tests: ${testCommand}`, {
    command: testCommand,
  });

  const result = await runtime.terminal({
    taskId: task.id,
    command: testCommand,
    cwd: repoCwd,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `tests failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
    );
  }

  emit(svc, "tests.running", task.id, "Tests passed", {
    command: testCommand,
    exitCode: result.exitCode,
  });
}

export async function createTaskIssue(
  svc: TaskService,
  task: Task,
  repository: string,
  token: string,
  job: ScheduleJob,
): Promise<void> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || !job.issueTitle) {
    return;
  }

  try {
    const issue = await createGitHubIssue(token, owner, repo, {
      title: job.issueTitle,
      body:
        job.issueBody ??
        `Created by Devin for task ${task.id}.\n\n**Prompt:** ${task.prompt}`,
    });
    emit(svc, "git.issue", task.id, `Opened issue #${issue.number}`, {
      issueUrl: issue.htmlUrl,
      number: issue.number,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create issue";
    emit(svc, "git.issue", task.id, message, { error: message });
  }
}

export function runtimeSecrets(
  svc: TaskService,
  githubToken?: string,
  agent?: AgentProvider,
  agentModel?: string,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const key of ["CURSOR_API_KEY", "ANTHROPIC_API_KEY"] as const) {
    const value = process.env[key]?.trim();
    if (value) {
      secrets[key] = value;
    }
  }
  const agentTimeout = String(resolveAgentTimeoutMinutes());
  secrets.AGENT_RUN_TIMEOUT_MIN = agentTimeout;
  const resolvedAgent = agent ?? "cursor";
  if (resolvedAgent === "cursor") {
    secrets.AGENT_MODEL = resolveCursorAgentModel(
      agentModel,
      process.env.AGENT_MODEL,
    );
  } else if (process.env.AGENT_MODEL?.trim()) {
    secrets.AGENT_MODEL = process.env.AGENT_MODEL.trim();
  }
  if (githubToken) {
    secrets.GITHUB_TOKEN = githubToken;
  }
  return secrets;
}
