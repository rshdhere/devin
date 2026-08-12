import { RuntimeClient, type RunResponse } from "@devin/agent-sdk";
import type { StackRuntime } from "@devin/types";
import {
  buildAlignHydratedRepoScript,
  buildPushGreenfieldMainScript,
} from "../../greenfield/git-sync.js";
import { scaffoldFilesFromDraft } from "../../greenfield/scaffold-from-draft.js";
import type { GitHubUserIdentity } from "../../github/client.js";
import {
  buildPruneWorkspaceDiskScript,
  buildSnapshotSmokeStartScript,
  buildWaitForPortScript,
  snapshotWaitSecondsForStartCommand,
} from "../../devbox/preview.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { buildCommitMessage, escapeShell } from "./config.js";
import { smokeAndCaptureDevboxPreview } from "./desktop-capture.js";
import {
  configureSandboxGit,
  ensureGitPushAuth,
  gitRuntimeEnv,
  readGitHead,
} from "./git-operations.js";
import { alignHydratedRepoWithOriginMain } from "./greenfield-provision.js";
import { ensureSandboxDns } from "./sandbox-lifecycle.js";
import { emit } from "./task-state.js";

export async function hydrateGreenfieldInSandbox(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  gitOwner: GitHubUserIdentity | undefined,
  cloneUrl: string,
  githubToken?: string,
): Promise<void> {
  const plan = job.draftPlan;
  if (!plan) {
    throw new Error("missing draft plan for greenfield hydration");
  }

  const scaffoldFiles = scaffoldFilesFromDraft(plan, {
    title: task.title ?? "project",
    prompt: task.prompt,
  });

  emit(svc, "git.clone", task.id, `Hydrating ${task.repository} in sandbox`, {
    repository: task.repository,
    hydrated: true,
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

  if (job.greenfieldPushed) {
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
          `devin: scaffold ${task.title ?? "project"}`,
        ),
        paths: ["."],
      });
    }
    return;
  }

  await runtime.gitCommit({
    taskId: task.id,
    cwd: repoCwd,
    env: gitEnv,
    message: buildCommitMessage(`devin: scaffold ${task.title ?? "project"}`),
    paths: ["."],
  });

  if (githubToken) {
    await ensureSandboxDns(svc, runtime, task.id);
    const syncResult = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: buildAlignHydratedRepoScript({ hardReset: false }),
    });
    if (syncResult.exitCode === 0) {
      emit(svc, "agent.log", task.id, "Synced hydrated repo with GitHub main", {
        repository: task.repository,
        synced: true,
      });
    } else {
      emit(
        svc,
        "agent.log",
        task.id,
        "Skipped GitHub sync during hydration (sandbox offline)",
        {
          repository: task.repository,
          synced: false,
          detail: (syncResult.stderr || syncResult.stdout).trim(),
        },
      );
    }
  }
}

export async function ensureSandboxConnectivity(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  emit(svc, "agent.log", taskId, "Checking sandbox outbound connectivity", {
    phase: "egress_probe",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensureSandboxDns(svc, runtime, taskId);
    if (attempt > 0) {
      await sleep(2_000);
    }

    const dnsCheck = await probeSandboxDns(
      svc,
      runtime,
      taskId,
      "api2.cursor.sh",
    );
    const cursorCheck = await probeSandboxHttps(
      svc,
      runtime,
      taskId,
      "https://api2.cursor.sh/",
    );
    const installCheck = await probeSandboxHttps(
      svc,
      runtime,
      taskId,
      "https://cursor.com/",
    );

    if (dnsCheck.ok && cursorCheck.ok) {
      emit(svc, "agent.log", taskId, "Sandbox outbound connectivity verified", {
        cursorApi: cursorCheck.detail,
        cursorCom: installCheck.ok
          ? installCheck.detail
          : `unreachable (${installCheck.detail})`,
        githubPending: true,
      });
      break;
    }

    emit(
      svc,
      "agent.log",
      taskId,
      `Sandbox egress probe attempt ${attempt + 1}/3`,
      {
        dns: dnsCheck,
        cursor: cursorCheck,
        cursorCom: installCheck,
        attempt: attempt + 1,
      },
    );

    if (attempt === 2) {
      const corrupt = /guest filesystem corrupt|Structure needs cleaning/i.test(
        `${dnsCheck.detail} ${cursorCheck.detail} ${installCheck.detail}`,
      );
      const message = corrupt
        ? "Sandbox guest filesystem is corrupt (rootfs/mem snapshot mismatch). " +
          "On the execution host rebuild snapshots: " +
          "DEVIN_FORCE_SNAPSHOT_REBUILD=true DEVIN_RUNTIMES='agent nextjs' " +
          "devin-infra bootstrap-snapshots <instance-id>."
        : "Sandbox has no outbound DNS/HTTPS to the Cursor API (api2.cursor.sh). " +
          "On the execution host run: sudo devin-infra fix-sandbox-dns && sudo devin-infra fix-cni, then rebuild the agent snapshot.";
      emit(svc, "agent.log", taskId, message, {
        cursorReachable: false,
        dns: dnsCheck,
        cursor: cursorCheck,
        cursorCom: installCheck,
        guestFsCorrupt: corrupt,
      });
      throw new Error(message);
    }
  }

  const githubCheck = await probeSandboxHttps(
    svc,
    runtime,
    taskId,
    "https://github.com/",
  );

  if (!githubCheck.ok) {
    emit(
      svc,
      "agent.log",
      taskId,
      "GitHub unreachable from sandbox; agent will work locally and push at end may fail",
      {
        githubReachable: false,
        github: githubCheck,
      },
    );
    return;
  }

  emit(svc, "agent.log", taskId, "Sandbox outbound connectivity verified", {
    cursorReachable: true,
    githubReachable: true,
  });
}

export {
  probeSandboxDns,
  probeSandboxHttps,
} from "./greenfield-connectivity-probes.js";

export async function emergencyPushAgentWork(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  githubToken?: string,
  opts?: { greenfield?: boolean },
): Promise<void> {
  const gitEnv = gitRuntimeEnv(svc, githubToken);
  const status = await runtime.terminal({
    taskId: task.id,
    command: "git status --porcelain",
    cwd: repoCwd,
    env: gitEnv,
  });

  const dirty = Boolean(status.stdout.trim());
  // Greenfield agents often finish with a clean tree (already committed) but
  // divergent hydrate history — still push those commits. Non-greenfield with
  // nothing dirty has nothing new to publish.
  if (!dirty && !opts?.greenfield) {
    return;
  }

  if (dirty) {
    await runtime.gitCommit({
      taskId: task.id,
      message: buildCommitMessage(
        `devin: partial work — ${task.title ?? "task incomplete"}`,
      ),
      paths: ["."],
      cwd: repoCwd,
      env: gitEnv,
    });
  }

  if (opts?.greenfield) {
    const pushed = await pushGreenfieldMain(
      svc,
      runtime,
      task.id,
      repoCwd,
      githubToken,
      job.cloneUrl,
    );
    if (pushed) {
      emit(
        svc,
        "git.push",
        task.id,
        "Pushed partial agent work after failure",
        {
          branch: "main",
          recovery: true,
        },
      );
    } else {
      emit(svc, "git.push", task.id, "Push skipped or failed", {
        branch: "main",
        recovery: true,
        failed: true,
      });
    }
    return;
  }

  await ensureGitPushAuth(
    svc,
    runtime,
    task.id,
    repoCwd,
    githubToken,
    job.cloneUrl,
  );

  const pushResult = await runtime.gitPush({
    taskId: task.id,
    branch: "main",
    cwd: repoCwd,
    env: gitEnv,
  });

  if (pushResult.status === "completed") {
    emit(svc, "git.push", task.id, "Pushed partial agent work after failure", {
      branch: "main",
      recovery: true,
    });
  }
}

/**
 * When a runtime agent is interrupted (timeout, idle-stall, Cursor
 * resource_exhausted / RetriableError), commit dirty work and push to main
 * with fetch + force-with-lease so divergent hydrate/checkpoint history still lands.
 */

export async function recoverGreenfieldAfterAgentInterruption(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  job: ScheduleJob,
  repoCwd: string,
  githubToken?: string,
  preAgentHead?: string,
): Promise<boolean> {
  try {
    const gitEnv = gitRuntimeEnv(svc, githubToken);
    // Hung `git commit` HEREDOCs often leave index.lock + orphan git after
    // the agent process is killed; clear that before status/commit.
    await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: [
        "set +e",
        "pkill -u \"$(id -u)\" -f '[g]it commit' 2>/dev/null || true",
        "sleep 0.5",
        "rm -f .git/index.lock .git/HEAD.lock .git/refs/heads/*.lock 2>/dev/null || true",
        "true",
      ].join("\n"),
    });
    const status = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: "git status --porcelain",
    });
    const dirty = status.stdout.trim();
    const head = await readGitHead(svc, runtime, task.id, repoCwd, githubToken);
    const movedHead =
      Boolean(preAgentHead) && Boolean(head) && head !== preAgentHead;

    if (!dirty && !movedHead) {
      emit(
        svc,
        "agent.log",
        task.id,
        "Agent interruption with no recoverable git work",
      );
      return false;
    }

    if (dirty && job.permissions?.canCommit) {
      await runtime.gitCommit({
        taskId: task.id,
        message: buildCommitMessage(
          `devin: agent interruption recovery — ${task.title ?? "partial work"}`,
        ),
        paths: ["."],
        cwd: repoCwd,
        env: gitEnv,
      });
    }

    if (!job.permissions?.canPush) {
      return Boolean(dirty || movedHead);
    }

    const pushed = await pushGreenfieldMain(
      svc,
      runtime,
      task.id,
      repoCwd,
      githubToken,
      job.cloneUrl,
    );
    if (!pushed) {
      emit(svc, "git.push", task.id, "Interruption recovery push failed", {
        branch: "main",
        recovery: true,
        timeout: true,
        failed: true,
      });
      return false;
    }

    emit(svc, "git.push", task.id, "Pushed agent work after interruption", {
      branch: "main",
      recovery: true,
      timeout: true,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recovery failed";
    emit(
      svc,
      "agent.log",
      task.id,
      `Greenfield interruption recovery failed: ${message}`,
    );
    return false;
  }
}

export async function pushGreenfieldMain(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  repoCwd: string,
  githubToken?: string,
  cloneUrl?: string,
): Promise<boolean> {
  await ensureGitPushAuth(svc, runtime, taskId, repoCwd, githubToken, cloneUrl);
  const result = await runtime.terminalAllowFailure({
    taskId,
    cwd: repoCwd,
    env: gitRuntimeEnv(svc, githubToken),
    command: buildPushGreenfieldMainScript(),
  });
  if (result.exitCode !== 0) {
    emit(svc, "agent.log", taskId, "GitHub push to main failed", {
      detail: (result.stderr || result.stdout || "").trim().slice(0, 500),
      gitPush: true,
    });
  }
  return result.exitCode === 0;
}

export {
  ensureBashInSandbox,
  ensureCursorAgentInSandbox,
  findCursorAgentBinary,
  linkCursorAgentBinary,
  runTemplateGreenfieldVerify,
  startWorkspaceDiskPruneWatcher,
} from "./greenfield-provision-agent.js";
export { runTemplateGreenfieldVerify } from "./greenfield-template-verify.js";

export { startWorkspaceDiskPruneWatcher } from "./greenfield-disk-prune.js";
