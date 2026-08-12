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

export async function probeSandboxDns(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  host: string,
): Promise<{ ok: boolean; detail: string }> {
  // Wrap getent in timeout — a wedged resolver can hang for many minutes and
  // leave the UI sitting on an empty agent panel after hydrate.
  const result = await runtime.terminalAllowFailure({
    taskId,
    command: `timeout 5 getent ahostsv4 '${escapeShell(host)}' 2>/dev/null | awk 'NR==1{print $1; exit}' || timeout 5 getent ahosts '${escapeShell(host)}' 2>/dev/null | awk '/STREAM/{print $1; exit}'`,
  });
  const address = result.stdout.trim();
  if (result.exitCode === 0 && address) {
    return { ok: true, detail: address };
  }
  return {
    ok: false,
    detail: (result.stderr || result.stdout || "DNS lookup failed").trim(),
  };
}

export async function probeSandboxHttps(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  url: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await runtime.terminalAllowFailure({
    taskId,
    command: [
      "set +e",
      `url='${escapeShell(url)}'`,
      "if command -v curl >/dev/null 2>&1; then",
      "  out=$(curl -4sS --connect-timeout 5 --max-time 8 -o /dev/null -w '%{http_code}' \"$url\" 2>&1)",
      "  code=$?",
      '  echo "$out"',
      "  if echo \"$out\" | grep -qi 'Structure needs cleaning'; then",
      "    echo 'guest-fs-corrupt'",
      "  fi",
      "  exit $code",
      "fi",
      "if command -v node >/dev/null 2>&1; then",
      '  node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>{console.log(r.status); process.exit(0)}).catch(e=>{console.error(String(e)); process.exit(1)})" "$url"',
      "  exit $?",
      "fi",
      "echo 'no-https-client'",
      "exit 127",
    ].join("\n"),
  });
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (/guest-fs-corrupt|Structure needs cleaning/i.test(combined)) {
    return {
      ok: false,
      detail:
        "guest filesystem corrupt (Structure needs cleaning) — rebuild agent/nextjs snapshots",
    };
  }
  const httpCode =
    combined
      .split(/\s+/)
      .reverse()
      .find((token) => /^[0-9]{3}$/.test(token)) ?? "";
  if (httpCode && httpCode !== "000") {
    return { ok: true, detail: `HTTP ${httpCode}` };
  }
  return {
    ok: false,
    detail: combined || `exit ${result.exitCode}`,
  };
}
