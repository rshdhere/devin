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

export function forwardRuntimeEvents(
  svc: TaskService,
  runtimeBaseUrl: string,
  taskId: string,
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(
        `${runtimeBaseUrl}/events?taskId=${encodeURIComponent(taskId)}`,
        { signal: controller.signal },
      );
      if (!response.ok || !response.body) {
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        let splitIndex = buffer.indexOf("\n\n");
        while (splitIndex >= 0) {
          const chunk = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          relayRuntimeChunk(svc, taskId, chunk);
          splitIndex = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // stream closed when task finishes
    }
  })();

  return () => controller.abort();
}

export function relayRuntimeChunk(
  svc: TaskService,
  taskId: string,
  chunk: string,
): void {
  const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    return;
  }

  try {
    const payload = JSON.parse(dataLine.slice(6)) as {
      type?: string;
      message?: string;
      data?: Record<string, unknown>;
    };
    if (!payload.type || !payload.message) {
      return;
    }
    emitRuntime(
      svc,
      taskId,
      payload.type as TaskEventType,
      payload.message,
      payload.data,
    );
    maybeTriggerDesktopSnapshotFromRuntime(
      svc,
      taskId,
      payload.message ?? "",
      payload.data,
    );
  } catch {
    // ignore malformed chunks
  }
}

/**
 * Commit any remaining dirty files and push agent work to GitHub.
 * Returns true when a push to the remote succeeded.
 *
 * Important: Cursor agents usually leave a *clean* tree (they already
 * committed). Previously we returned early on a clean tree and never pushed,
 * so greenfield repos stayed on the scaffold while the UI claimed success.
 */

export async function finalizeGitWork(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  githubToken?: string,
  opts?: { greenfield?: boolean; createPullRequest?: boolean },
): Promise<boolean> {
  const permissions = job.permissions;
  if (!permissions || !job.repository) {
    return false;
  }

  const createPullRequest = opts?.createPullRequest ?? true;
  const gitEnv = gitRuntimeEnv(svc, githubToken);

  const status = await runtime.terminal({
    taskId: task.id,
    command: "git status --porcelain",
    cwd: repoCwd,
    env: gitEnv,
  });

  const dirty = Boolean(status.stdout.trim());
  const useMainBranch =
    opts?.greenfield === true && createPullRequest === false;
  const branchName = useMainBranch ? "main" : `devin/${task.id.slice(0, 8)}`;
  task.branch = branchName;

  if (!useMainBranch && permissions.canPush) {
    await runtime.terminalAllowFailure({
      taskId: task.id,
      command: `git checkout -b ${branchName}`,
      cwd: repoCwd,
      env: gitEnv,
    });
  }

  if (dirty && permissions.canCommit) {
    await runtime.gitCommit({
      taskId: task.id,
      message: buildCommitMessage(`devin: ${task.title ?? "agent changes"}`),
      paths: ["."],
      cwd: repoCwd,
      env: gitEnv,
    });
    emit(svc, "git.commit", task.id, "Committed agent changes", {
      auto: !createPullRequest,
      userApproved: true,
    });
  }

  if (!permissions.canPush) {
    return false;
  }

  // Nothing dirty and not greenfield-to-main: still push when the agent
  // already committed on this HEAD (common for runtime agents).
  await ensureGitPushAuth(
    svc,
    runtime,
    task.id,
    repoCwd,
    githubToken,
    job.cloneUrl,
  );

  if (useMainBranch) {
    const pushed = await pushGreenfieldMain(
      svc,
      runtime,
      task.id,
      repoCwd,
      githubToken,
      job.cloneUrl,
    );
    if (!pushed) {
      emit(svc, "git.push", task.id, "Push skipped or failed", {
        branch: branchName,
        failed: true,
      });
      return false;
    }
  } else {
    const pushResult = await runtime.gitPush({
      taskId: task.id,
      branch: branchName,
      cwd: repoCwd,
      env: gitEnv,
    });

    if (pushResult.status !== "completed") {
      emit(svc, "git.push", task.id, "Push skipped or failed", {
        branch: branchName,
        failed: true,
      });
      return false;
    }
  }

  emit(svc, "git.push", task.id, `Pushed branch ${branchName}`, {
    branch: branchName,
    userApproved: true,
  });

  if (!createPullRequest || !permissions.canCreatePr || !job.githubToken) {
    return true;
  }

  const [owner, repo] = job.repository.split("/");
  if (!owner || !repo) {
    return true;
  }

  try {
    const defaultBranch = await fetchDefaultBranch(
      job.githubToken,
      owner,
      repo,
    );
    const pr = await createGitHubPullRequest(job.githubToken, owner, repo, {
      title: task.title ?? `Devin: ${task.prompt.slice(0, 60)}`,
      body: `Automated changes by Devin.\n\n**Prompt:** ${task.prompt}`,
      head: branchName,
      base: defaultBranch,
    });
    task.prUrl = pr.html_url;
    emit(svc, "git.pr", task.id, `Opened pull request #${pr.number}`, {
      prUrl: pr.html_url,
      number: pr.number,
      userApproved: true,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create pull request";
    emit(svc, "git.pr", task.id, message, { error: message });
  }

  return true;
}

export async function initializeEmptyRepository(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  cloneUrl: string,
  repoCwd: string,
): Promise<void> {
  await runtime.terminal({
    taskId,
    env: gitRuntimeEnv(svc),
    command: `mkdir -p ${repoCwd} && git -C ${repoCwd} init -b main && git -C ${repoCwd} remote add origin '${escapeShell(cloneUrl)}'`,
  });
}

export async function configureSandboxGit(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  owner: GitHubUserIdentity | undefined,
  opts?: {
    repoCwd?: string;
    cloneUrl?: string;
    githubToken?: string;
  },
): Promise<void> {
  const fallback = resolveBotAuthor();
  const name = owner?.name || owner?.login || fallback.name;
  const email =
    owner?.email || `${owner?.login ?? "devin"}@users.noreply.github.com`;

  const commands = [
    shellPrepareWritableHome(),
    `git config --global user.name '${escapeShell(name)}'`,
    `git config --global user.email '${escapeShell(email)}'`,
  ];

  if (opts?.repoCwd && opts.cloneUrl) {
    commands.push(
      `git -C ${opts.repoCwd} remote set-url origin '${escapeShell(opts.cloneUrl)}'`,
    );
  }

  if (opts?.githubToken) {
    commands.push(
      "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
    );
  }

  await runtime.terminal({
    taskId,
    env: gitRuntimeEnv(svc, opts?.githubToken),
    command: commands.join(" && "),
  });

  await disableAgentCommitAttribution(svc, runtime, taskId);
}

export async function disableAgentCommitAttribution(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  const result = await runtime.terminalAllowFailure({
    taskId,
    env: gitRuntimeEnv(svc),
    command: buildAgentAttributionOptOutScript(),
  });

  if (result.exitCode !== 0) {
    emit(
      svc,
      "agent.log",
      taskId,
      "could not disable agent commit attribution in sandbox",
      {
        detail: (result.stderr || result.stdout || "").trim().slice(0, 240),
      },
    );
  }
}

export async function ensureGitPushAuth(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  githubToken?: string,
  cloneUrl?: string,
): Promise<void> {
  if (!githubToken || !cloneUrl) {
    return;
  }

  await runtime.terminal({
    taskId,
    cwd: repoCwd,
    env: gitRuntimeEnv(svc, githubToken),
    command: [
      `git remote set-url origin '${escapeShell(cloneUrl)}'`,
      "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
    ].join(" && "),
  });
}

export function gitRuntimeEnv(
  svc: TaskService,
  githubToken?: string,
): Record<string, string> {
  return sandboxProcessEnv(githubToken);
}

export {
  startGreenfieldPushWatcher,
  startAutoCommitWatcher,
  readGitHead,
  assertGreenfieldAgentProgress,
  runTests,
  createTaskIssue,
  runtimeSecrets,
} from "./git-operations-watchers.js";
