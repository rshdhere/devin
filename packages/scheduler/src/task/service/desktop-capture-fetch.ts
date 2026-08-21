import { usesRuntimeAgent } from "../../agent/defaults.js";
import {
  buildDesktopScreenshotScript,
  buildDiscoverDevboxPortScript,
  buildStartDevServerForSnapshotScript,
  buildStopDevServerForSnapshotScript,
  buildWaitForDevServerScript,
  buildSnapshotSmokeStartScript,
  buildWaitForPortScript,
  DEVIN_SNAPSHOT_SERVER_PORT,
  snapshotWaitSecondsForStartCommand,
} from "../../devbox/preview.js";
import {
  loadTaskDesktopSnapshot,
  saveTaskDesktopSnapshot,
} from "../../devbox/snapshot-store.js";
import { sanitizeProxyResponseHeaders } from "../../devbox/proxy-headers.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import {
  captureDesktopScreenshot,
  captureDesktopScreenshotWithDevServer,
  resolveLiveSession,
} from "./desktop-capture-render.js";
import {
  delegateRequestToWorker,
  wakeSession,
  WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS,
} from "./session-lifecycle.js";
import { requestWorkerRehydrate } from "./resolve-session-proxy.js";
import { emit, patchTask } from "./task-state.js";

export async function fetchDesktopScreenshot(
  svc: TaskService,
  taskId: string,
  opts?: { fresh?: boolean },
): Promise<Response> {
  if (svc.mode === "brain") {
    const freshQuery = opts?.fresh ? "?fresh=1" : "";
    try {
      let upstream = await delegateRequestToWorker(
        svc,
        `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-screenshot${freshQuery}`,
        undefined,
        { timeoutMs: WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS },
      );
      if (upstream.status === 404) {
        const rehydrated = await requestWorkerRehydrate(svc, taskId);
        if (rehydrated.ok) {
          upstream = await delegateRequestToWorker(
            svc,
            `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-screenshot${freshQuery}`,
            undefined,
            { timeoutMs: WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS },
          );
        }
      }
      if (upstream.ok || upstream.status !== 404) {
        return upstream;
      }
    } catch {
      // Worker unreachable after rehydrate attempt.
    }
    const cached = await loadCachedDesktopSnapshot(svc, taskId);
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "X-Desktop-Snapshot-Source": "durable-cache",
        },
      });
    }
    return new Response("No desktop snapshot available", { status: 404 });
  }

  const cached = opts?.fresh
    ? undefined
    : await loadCachedDesktopSnapshot(svc, taskId);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  }

  const session =
    (await resolveLiveSession(svc, taskId)) ??
    (svc.tasks.get(taskId)?.sessionSleeping
      ? await wakeSession(svc, taskId)
      : undefined);

  if (!session) {
    return new Response("No devbox session", { status: 404 });
  }

  // Spin whenever Refresh asks OR there is no cached PNG yet (polls / Done).
  const buffer = await captureDesktopScreenshotWithDevServer(
    svc,
    session,
    taskId,
    {
      allowSpin: true,
      keepServer: true,
      bypassSpinCooldown: Boolean(opts?.fresh),
    },
  );
  if (!buffer) {
    const disk = await loadCachedDesktopSnapshot(svc, taskId);
    if (disk) {
      return new Response(disk, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        },
      });
    }
    return new Response("Desktop snapshot not available yet", {
      status: 503,
    });
  }
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}

export async function loadCachedDesktopSnapshot(
  svc: TaskService,
  taskId: string,
): Promise<Buffer | undefined> {
  const disk = await loadTaskDesktopSnapshot(taskId);
  if (disk) {
    return disk;
  }
  const fromDb = await svc.taskStore.loadDesktopSnapshot(taskId);
  if (fromDb) {
    await saveTaskDesktopSnapshot(taskId, fromDb);
    return fromDb;
  }
  return undefined;
}

export async function persistDesktopSnapshot(
  svc: TaskService,
  taskId: string,
  session: ReviewSession,
  buffer: Buffer,
): Promise<void> {
  session.lastDesktopScreenshot = buffer;
  await Promise.all([
    saveTaskDesktopSnapshot(taskId, buffer),
    svc.taskStore.saveDesktopSnapshot(taskId, buffer),
  ]);
  emit(svc, "agent.log", taskId, "Sandbox desktop snapshot saved", {
    desktop: true,
    desktopSnapshot: true,
  });
}

/**
 * After a cursor agent run, start the product server and capture Desktop so
 * Done has a PNG even when the agent tore down its smoke server.
 */

export function schedulePostCompletionDesktopCapture(
  svc: TaskService,
  session: ReviewSession,
  task: Task,
  repoCwd: string,
  runtimeAgentTask: boolean,
): void {
  void (async () => {
    try {
      if (runtimeAgentTask && session.runtime && usesRuntimeAgent(task.agent)) {
        await captureDevboxPreviewAfterAgent(svc, session, task, repoCwd);
      }
      await Promise.race([
        captureDesktopScreenshotWithDevServer(svc, session, task.id, {
          allowSpin: true,
          keepServer: true,
          bypassSpinCooldown: true,
        }),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 180_000),
        ),
      ]);
    } catch {
      // Desktop capture is best-effort after Done.
    }
  })();
}

export async function captureDevboxPreviewAfterAgent(
  svc: TaskService,
  session: ReviewSession,
  task: Task,
  repoCwd: string,
): Promise<void> {
  if (session.devboxPreviewPort) {
    const existing = await captureDesktopScreenshot(svc, session, task.id);
    if (existing) {
      return;
    }
  }

  const probes = await session.runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: [
      "set +e",
      'has_next="no"; has_pkg="no"; has_go="no"; has_py="no"; has_rust="no"',
      "if [ -f package.json ]; then has_pkg=yes; grep -qE '\"next\"' package.json 2>/dev/null && has_next=yes; fi",
      "test -f next.config.ts -o -f next.config.js -o -f next.config.mjs && has_next=yes",
      "test -d .next && has_next=yes",
      "test -f go.mod -o -f main.go && has_go=yes",
      "test -f requirements.txt -o -f pyproject.toml -o -f main.py && has_py=yes",
      "test -f Cargo.toml && has_rust=yes",
      'echo "$has_next $has_pkg $has_go $has_py $has_rust"',
    ].join("\n"),
  });
  const parts = probes.stdout.trim().split(/\s+/);
  const hasNext = parts[0] === "yes";
  const hasPkg = parts[1] === "yes";
  const hasGo = parts[2] === "yes";
  const hasPy = parts[3] === "yes";
  const hasRust = parts[4] === "yes";

  if (hasRust) {
    await smokeAndCaptureDevboxPreview(svc, session.runtime, task, repoCwd, {
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
      waitSeconds: 120,
    });
    return;
  }

  if (hasGo && !hasNext && !hasPkg) {
    await smokeAndCaptureDevboxPreview(svc, session.runtime, task, repoCwd, {
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
    return;
  }

  if (hasPy) {
    await smokeAndCaptureDevboxPreview(svc, session.runtime, task, repoCwd, {
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
    return;
  }

  if (hasPkg || hasNext) {
    const startCommand = buildSnapshotSmokeStartScript();
    await smokeAndCaptureDevboxPreview(svc, session.runtime, task, repoCwd, {
      startCommand,
      // The platform-owned preview server uses a dedicated port so an agent's
      // own smoke test on 3000 cannot collide with or replace Desktop preview.
      port: DEVIN_SNAPSHOT_SERVER_PORT,
      waitSeconds: snapshotWaitSecondsForStartCommand(startCommand),
    });
  }
}

/**
 * Start the product server, wait for HTTP on a known app port, keep it running,
 * and kick off a Desktop snapshot. Used after greenfield verify so Done has a PNG.
 */

export async function smokeAndCaptureDevboxPreview(
  svc: TaskService,
  runtime: RuntimeClient,
  task: Task,
  repoCwd: string,
  opts: { startCommand: string; port: number; waitSeconds: number },
): Promise<void> {
  await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: opts.startCommand,
  });

  const wait = await runtime.terminalAllowFailure({
    taskId: task.id,
    cwd: repoCwd,
    command: buildWaitForPortScript(opts.port, opts.waitSeconds),
  });

  const port = Number.parseInt(wait.stdout.trim(), 10);
  if (!Number.isFinite(port) || port <= 0) {
    emit(
      svc,
      "agent.log",
      task.id,
      "Smoke check skipped or failed — continuing",
      {
        detail: (wait.stderr || wait.stdout).trim(),
        port: opts.port,
      },
    );
    return;
  }

  emit(svc, "agent.log", task.id, "Smoke check passed (HTTP 200)", {
    endpoint: `http://127.0.0.1:${port}`,
  });

  const shotSession = svc.activeSessions.get(task.id);
  if (!shotSession) {
    return;
  }
  shotSession.devboxPreviewPort = port;
  void svc.taskStore.setPreviewPort(task.id, port);
  const previewPath = `/api/v1/tasks/${encodeURIComponent(task.id)}/devbox-preview?path=/`;
  patchTask(svc, task.id, { previewUrl: previewPath });
  void captureDesktopScreenshotWithDevServer(svc, shotSession, task.id, {
    allowSpin: false,
    keepServer: true,
  });
}

/** Spin up dev server briefly if needed, then Playwright capture (Devin-style). */
