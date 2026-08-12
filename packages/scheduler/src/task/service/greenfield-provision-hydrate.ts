import { RuntimeClient } from "@devin/agent-sdk";
import { usesRuntimeAgent } from "../../agent/defaults.js";
import type { StackRuntime } from "@devin/types";
import {
  authenticatedCloneUrl,
  createGitHubInitialCommit,
  createGitHubRepositoryUnique,
  fetchGitHubUserIdentity,
  type GitHubUserIdentity,
} from "../../github/client.js";
import {
  generateDraftPlan,
  type DraftPlan,
} from "../../greenfield/draft-planner.js";
import { generateProjectMetadata } from "../../greenfield/project-metadata.js";
import { buildAlignHydratedRepoScript } from "../../greenfield/git-sync.js";
import { scaffoldFilesFromDraft } from "../../greenfield/scaffold-from-draft.js";
import { greenfieldShellScaffoldFiles } from "../../greenfield/shell-scaffold.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import {
  buildCommitMessage,
  escapeShell,
  isNetworkCloneFailure,
  resolveStackRuntime,
  sleep,
} from "./config.js";
import { configureSandboxGit, gitRuntimeEnv } from "./git-operations.js";
import { ensureSandboxDns } from "./sandbox-lifecycle.js";
import { emit } from "./task-state.js";

export async function hydrateRepositoryShellInSandbox(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  gitOwner: GitHubUserIdentity | undefined,
  cloneUrl: string,
  githubToken?: string,
): Promise<void> {
  const stackRuntime = resolveStackRuntime(task, job);
  const scaffoldFiles = greenfieldShellScaffoldFiles({
    title: task.title ?? "project",
    prompt: task.prompt,
    stackRuntime,
  });

  emit(svc, "git.clone", task.id, `Hydrating ${task.repository} in sandbox`, {
    repository: task.repository,
    hydrated: true,
    runtimeAgent: true,
    files: scaffoldFiles.map((file) => file.path),
  });

  const gitEnv = gitRuntimeEnv(svc, githubToken);

  await runtime.terminal({
    taskId: task.id,
    command: `rm -rf '${escapeShell(repoCwd)}' && mkdir -p '${escapeShell(repoCwd)}'`,
  });

  for (const file of scaffoldFiles) {
    const fullPath = `${repoCwd}/${file.path}`;
    const parentDir = fullPath.includes("/")
      ? fullPath.slice(0, fullPath.lastIndexOf("/"))
      : repoCwd;
    if (parentDir !== repoCwd) {
      await runtime.terminal({
        taskId: task.id,
        command: `mkdir -p '${escapeShell(parentDir)}'`,
      });
    }
    await runtime.writeFile({
      path: fullPath,
      content: file.content,
    });
  }

  await runtime.terminal({
    taskId: task.id,
    cwd: repoCwd,
    env: gitEnv,
    command: `git init -b main && git remote add origin '${escapeShell(cloneUrl)}'`,
  });

  await configureSandboxGit(svc, runtime, task.id, gitOwner, {
    repoCwd,
    cloneUrl,
    githubToken,
  });

  // Greenfield hydrate already wrote the same files the control plane pushed.
  // Skip origin align entirely for greenfield — guest GitHub egress is often
  // down this early and the failed fetch burns the UI on an empty agent panel.
  if (job.greenfieldPushed) {
    await runtime.gitCommit({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      message: buildCommitMessage(
        `devin: initialize ${task.title ?? "project"}`,
      ),
      paths: ["."],
    });
    emit(
      svc,
      "agent.log",
      task.id,
      "Hydrated greenfield scaffold locally (skipped origin align)",
      { repository: task.repository, skippedAlign: true },
    );
    return;
  }

  emit(
    svc,
    "agent.log",
    task.id,
    "Aligning hydrated repo with origin/main (best-effort)",
    { repository: task.repository },
  );
  const aligned = await alignHydratedRepoWithOriginMain(
    svc,
    runtime,
    task.id,
    repoCwd,
    githubToken,
    { hardReset: true },
  );
  if (!aligned) {
    await runtime.gitCommit({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      message: buildCommitMessage(
        `devin: initialize ${task.title ?? "project"}`,
      ),
      paths: ["."],
    });
  }
}

/**
 * When local hydrate created an orphan history, fetch origin/main and reset.
 * Hard reset is used for greenfield hydrate (files match control-plane push).
 */

export async function alignHydratedRepoWithOriginMain(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  githubToken?: string,
  opts?: { hardReset?: boolean },
): Promise<boolean> {
  const gitEnv = gitRuntimeEnv(svc, githubToken);
  const alignScript = buildAlignHydratedRepoScript({
    hardReset: opts?.hardReset !== false,
  });
  const result = await runtime.terminalAllowFailure({
    taskId,
    cwd: repoCwd,
    env: gitEnv,
    command: alignScript,
  });
  if (result.exitCode !== 0) {
    emit(
      svc,
      "agent.log",
      taskId,
      "Could not align hydrated repo with origin/main",
      {
        detail: (result.stderr || result.stdout || "").trim().slice(0, 400),
      },
    );
    return false;
  }
  emit(svc, "agent.log", taskId, "Aligned hydrated repo with origin/main", {
    hardReset: opts?.hardReset !== false,
  });
  return true;
}

/** @deprecated Use alignHydratedRepoWithOriginMain */

export async function rebaseHydratedRepoOntoOriginMain(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  githubToken?: string,
): Promise<void> {
  await alignHydratedRepoWithOriginMain(
    svc,
    runtime,
    taskId,
    repoCwd,
    githubToken,
    { hardReset: false },
  );
}
