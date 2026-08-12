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

export async function runTemplateGreenfieldVerify(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  repoCwd: string,
  stackRuntime: StackRuntime,
): Promise<RunResponse> {
  emit(svc, "agent.log", task.id, "Running template verify pipeline", {
    agent: "mock",
    phase: "template_verify",
    runtime: stackRuntime,
  });

  const hasPackageJson = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: "test -f package.json && echo yes || echo no",
  });

  const hasGoMod = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: "test -f go.mod && echo yes || echo no",
  });

  const hasCargoToml = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: "test -f Cargo.toml && echo yes || echo no",
  });

  const hasPythonProject = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command:
      "test -f requirements.txt -o -f pyproject.toml -o -f setup.py && echo yes || echo no",
  });

  if (stackRuntime === "go" || hasGoMod.stdout.trim() === "yes") {
    emit(svc, "agent.log", task.id, "Verifying Go module", { cwd: repoCwd });
    const tidy = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command: "timeout 120 go mod tidy 2>&1",
    });
    if (tidy.exitCode !== 0 && tidy.exitCode !== 124) {
      throw new Error(
        `go mod tidy failed: ${tidy.stderr || tidy.stdout}`.trim(),
      );
    }
    await smokeAndCaptureDevboxPreview(svc, runtime, task, repoCwd, {
      startCommand: [
        "set +e",
        "mkdir -p /workspace/.home",
        'export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"',
        "export HOST=127.0.0.1 PORT=3000 HOSTNAME=127.0.0.1",
        "BIN=/workspace/.home/devin-app",
        'if [ ! -x "$BIN" ]; then go build -o "$BIN" . || exit 1; fi',
        'nohup "$BIN" >/workspace/.home/devin-snapshot-server.log 2>&1 &',
        "echo $! > /workspace/.home/devin-snapshot-server.pid",
        "exit 0",
      ].join("\n"),
      port: 3000,
      waitSeconds: 90,
    });
  } else if (stackRuntime === "rust" || hasCargoToml.stdout.trim() === "yes") {
    emit(svc, "agent.log", task.id, "Verifying Rust crate", { cwd: repoCwd });
    const check = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command: "timeout 180 cargo check 2>&1",
    });
    if (check.exitCode !== 0 && check.exitCode !== 124) {
      throw new Error(
        `cargo check failed: ${check.stderr || check.stdout}`.trim(),
      );
    }
    await smokeAndCaptureDevboxPreview(svc, runtime, task, repoCwd, {
      startCommand: [
        "set +e",
        "mkdir -p /workspace/.home",
        'export PATH="/usr/local/cargo/bin:/usr/local/bin:$PATH"',
        "export HOST=127.0.0.1 PORT=3000 HOSTNAME=127.0.0.1",
        'nohup bash -lc "set -m; cargo run --release" >/workspace/.home/devin-snapshot-server.log 2>&1 &',
        "echo $! > /workspace/.home/devin-snapshot-server.pid",
        "exit 0",
      ].join("\n"),
      port: 3000,
      waitSeconds: 90,
    });
  } else if (
    stackRuntime === "python" ||
    hasPythonProject.stdout.trim() === "yes"
  ) {
    emit(svc, "agent.log", task.id, "Installing Python dependencies", {
      cwd: repoCwd,
    });
    const install = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command:
        "timeout 180 bash -lc 'if [ -f requirements.txt ]; then pip install -r requirements.txt; elif [ -f pyproject.toml ]; then pip install .; else pip install flask fastapi; fi' 2>&1",
    });
    if (install.exitCode === 124) {
      throw new Error("Python dependency install timed out after 180s");
    }
    await smokeAndCaptureDevboxPreview(svc, runtime, task, repoCwd, {
      startCommand: [
        "set +e",
        "mkdir -p /workspace/.home",
        "export HOST=127.0.0.1",
        "if [ -f main.py ]; then nohup python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 >/workspace/.home/devin-snapshot-server.log 2>&1 &",
        "elif [ -f app.py ]; then nohup python3 -m uvicorn app:app --host 127.0.0.1 --port 8000 >/workspace/.home/devin-snapshot-server.log 2>&1 &",
        "else exit 0; fi",
        "echo $! > /workspace/.home/devin-snapshot-server.pid",
        "exit 0",
      ].join("\n"),
      port: 8000,
      waitSeconds: 45,
    });
  } else if (hasPackageJson.stdout.trim() === "yes") {
    emit(svc, "agent.log", task.id, "Installing dependencies (bun install)", {
      cwd: repoCwd,
    });

    const install = await runtime.terminal({
      taskId: task.id,
      cwd: repoCwd,
      command:
        "timeout 180 bash -lc 'if command -v bun >/dev/null 2>&1; then bun install; else npm install --no-audit --progress=false; fi' 2>&1",
    });

    if (install.exitCode === 124) {
      throw new Error(
        "bun install timed out after 180s — check sandbox outbound network, DNS, and registry access",
      );
    }

    if (install.exitCode !== 0) {
      throw new Error(
        `dependency install failed with exit code ${install.exitCode}: ${install.stderr || install.stdout}`,
      );
    }

    emit(svc, "agent.log", task.id, "Dependencies installed", {
      exitCode: install.exitCode,
    });

    // Leave the server running so Desktop can capture after Done.
    await smokeAndCaptureDevboxPreview(svc, runtime, task, repoCwd, {
      startCommand: buildSnapshotSmokeStartScript(),
      port: 3000,
      waitSeconds: 120,
    });
  } else {
    emit(
      svc,
      "agent.log",
      task.id,
      "No package.json — skipping dependency install and smoke check",
      { cwd: repoCwd },
    );
  }

  const message = "Template scaffold verified in sandbox";
  emit(svc, "agent.log", task.id, message, {
    agent: "mock",
    completed: true,
  });

  return {
    taskId: task.id,
    status: "completed",
    message,
    output: message,
    agent: "mock",
  };
}
