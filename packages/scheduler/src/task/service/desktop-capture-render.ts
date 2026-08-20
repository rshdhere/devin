import { usesRuntimeAgent } from "../../agent/defaults.js";
import {
  buildDesktopScreenshotScript,
  buildDiscoverDevboxPortScript,
  buildStartDevServerForSnapshotScript,
  buildStopDevServerForSnapshotScript,
  buildWaitForDevServerScript,
  buildSnapshotSmokeStartScript,
  buildWaitForPortScript,
  snapshotWaitSecondsForStartCommand,
} from "../../devbox/preview.js";
import {
  loadTaskDesktopSnapshot,
  saveTaskDesktopSnapshot,
} from "../../devbox/snapshot-store.js";
import { sanitizeProxyResponseHeaders } from "../../devbox/proxy-headers.js";
import { maybeRewriteDevboxPreviewBody } from "../../devbox/preview-html.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import {
  loadCachedDesktopSnapshot,
  persistDesktopSnapshot,
} from "./desktop-capture-fetch.js";
import {
  delegateRequestToWorker,
  hydrateSessionFromStore,
  isWorkerDelegateTimeout,
  wakeSession,
  WORKER_DELEGATE_PREVIEW_TIMEOUT_MS,
} from "./session-lifecycle.js";
import {
  requestWorkerRehydrate,
  resolveRuntimeSession,
} from "./resolve-session-proxy.js";
import { navigateDesktopBrowserToPort } from "./desktop-navigate.js";
import { emit, patchTask } from "./task-state.js";

const DESKTOP_CAPTURE_TIMEOUT_MS = 120_000;

export async function captureDesktopScreenshotWithDevServer(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
  opts?: {
    allowSpin?: boolean;
    keepServer?: boolean;
    bypassSpinCooldown?: boolean;
  },
): Promise<Buffer | undefined> {
  const existing = svc.desktopCaptureInFlight.get(taskId);
  if (existing) {
    return existing;
  }

  const promise = Promise.race([
    runDesktopScreenshotWithDevServer(
      svc,
      session,
      taskId,
      opts?.allowSpin !== false,
      opts?.keepServer === true,
      opts?.bypassSpinCooldown === true,
    ),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), DESKTOP_CAPTURE_TIMEOUT_MS),
    ),
  ]).finally(() => {
    if (svc.desktopCaptureInFlight.get(taskId) === promise) {
      svc.desktopCaptureInFlight.delete(taskId);
    }
  });
  svc.desktopCaptureInFlight.set(taskId, promise);
  return promise;
}

export async function runDesktopScreenshotWithDevServer(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
  allowSpin: boolean,
  keepServer: boolean,
  bypassSpinCooldown: boolean,
): Promise<Buffer | undefined> {
  let buffer = await captureDesktopScreenshot(svc, session, taskId);
  if (buffer) {
    return buffer;
  }

  const cached = await loadCachedDesktopSnapshot(svc, taskId);
  if (cached) {
    session.lastDesktopScreenshot = cached;
    return cached;
  }

  if (!allowSpin) {
    return session.lastDesktopScreenshot;
  }

  const now = Date.now();
  const lastSpin = svc.lastSnapshotSpinAt.get(taskId) ?? 0;
  if (!bypassSpinCooldown && now - lastSpin < svc.snapshotSpinCooldownMs) {
    return session.lastDesktopScreenshot;
  }
  svc.lastSnapshotSpinAt.set(taskId, now);

  let spunUp = false;
  try {
    await ensureDevboxAppForPreview(svc, session, taskId);
    spunUp = true;
    buffer = await captureDesktopScreenshot(svc, session, taskId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "snapshot spin failed";
    emit(svc, "agent.log", taskId, `Desktop snapshot failed: ${message}`, {
      desktop: true,
    });
  } finally {
    // Keep the server up after completion so Desktop / Refresh keep working
    // (Devin-style computer-use preview). Only tear down mid-run spins.
    if (spunUp && !keepServer) {
      await session.runtime.terminalAllowFailure({
        taskId,
        cwd: session.repoCwd,
        command: buildStopDevServerForSnapshotScript(),
      });
    }
  }

  return buffer;
}

export async function captureDesktopScreenshot(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
): Promise<Buffer | undefined> {
  await refreshDevboxPreviewPort(svc, session, taskId);

  // Only hit a known-live preview port. An empty list used to skip capture
  // entirely; spraying every common port with Playwright hung completions.
  // When discovery finds nothing, return quickly so allowSpin can start the app.
  if (!session.devboxPreviewPort) {
    return (
      session.lastDesktopScreenshot ??
      (await fetchRuntimePersistedScreenshot(svc, taskId))
    );
  }

  const ports = [session.devboxPreviewPort];

  let buffer: Buffer | undefined;
  for (const port of ports) {
    const target = `http://127.0.0.1:${port}/`;
    buffer = await fetchRuntimeLiveScreenshot(svc, taskId, target);
    if (buffer) {
      break;
    }
    try {
      await session.runtime.terminalAllowFailure({
        taskId,
        cwd: session.repoCwd,
        command: buildDesktopScreenshotScript(
          target,
          "/workspace/.home/desktop-preview.png",
        ),
      });
    } catch {
      // playwright/chromium may be missing in older snapshots
    }
    buffer = await fetchRuntimePersistedScreenshot(svc, taskId);
    if (buffer) {
      break;
    }
  }

  if (buffer) {
    await persistDesktopSnapshot(svc, taskId, session, buffer);
    return buffer;
  }

  return (
    session.lastDesktopScreenshot ??
    (await fetchRuntimePersistedScreenshot(svc, taskId))
  );
}

export async function fetchRuntimeLiveScreenshot(
  svc: TaskService,
  taskId: string,
  targetUrl: string,
): Promise<Buffer | undefined> {
  try {
    const upstream = await svc.proxyRuntimeRequest(
      taskId,
      `/browser/screenshot?url=${encodeURIComponent(targetUrl)}`,
      { signal: AbortSignal.timeout(25_000) },
    );
    if (!upstream.ok) {
      return undefined;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > 128) {
      return buffer;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function fetchRuntimePersistedScreenshot(
  svc: TaskService,
  taskId: string,
): Promise<Buffer | undefined> {
  try {
    const upstream = await svc.proxyRuntimeRequest(
      taskId,
      "/browser/last-screenshot",
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!upstream.ok) {
      return undefined;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > 128) {
      return buffer;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function refreshDevboxPreviewPort(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
): Promise<void> {
  try {
    // Drop a previously cached supervisor port so capture can re-discover.
    if (
      session.devboxPreviewPort &&
      (RUNTIME_SUPERVISOR_PORTS as readonly number[]).includes(
        session.devboxPreviewPort,
      )
    ) {
      session.devboxPreviewPort = undefined;
    }

    const result = await session.runtime.terminalAllowFailure({
      taskId,
      cwd: session.repoCwd,
      command: buildDiscoverDevboxPortScript(),
    });
    const port = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }
    if ((RUNTIME_SUPERVISOR_PORTS as readonly number[]).includes(port)) {
      return;
    }
    const portChanged = session.devboxPreviewPort !== port;
    session.devboxPreviewPort = port;
    if (portChanged) {
      void svc.taskStore.setPreviewPort(taskId, port);
      const previewPath = `/api/v1/tasks/${encodeURIComponent(taskId)}/devbox-preview?path=/`;
      patchTask(svc, taskId, { previewUrl: previewPath });
      emit(svc, "agent.log", taskId, "Devbox localhost preview available", {
        port,
        guestHost: session.guestHost,
        desktop: true,
      });
    }
    // Keep Chromium on the live preview URL so snapshots show the app, not about:blank.
    void navigateDesktopBrowserToPort(svc, session, taskId, port);
    if (portChanged) {
      void captureDesktopScreenshot(svc, session, taskId);
    }
  } catch {
    // best-effort
  }
}

export async function resolveLiveSession(
  svc: TaskService,
  taskId: string,
): Promise<ReviewSession | undefined> {
  return resolveRuntimeSession(svc, taskId);
}

/** Start or rediscover the product dev server before live preview / capture. */
export async function ensureDevboxAppForPreview(
  svc: TaskService,
  session: ReviewSession,
  taskId: string,
): Promise<number | undefined> {
  await refreshDevboxPreviewPort(svc, session, taskId);

  if (session.devboxPreviewPort) {
    const probe = await session.runtime.terminalAllowFailure({
      taskId,
      cwd: session.repoCwd,
      command: buildWaitForPortScript(session.devboxPreviewPort, 8),
    });
    if (probe.exitCode === 0) {
      return session.devboxPreviewPort;
    }
  }

  emit(svc, "agent.log", taskId, "Starting app for desktop preview", {
    desktop: true,
    warm: true,
  });

  const startCommand = buildStartDevServerForSnapshotScript();
  const waitSeconds = snapshotWaitSecondsForStartCommand(startCommand);
  await session.runtime.terminalAllowFailure({
    taskId,
    cwd: session.repoCwd,
    command: startCommand,
  });
  const wait = await session.runtime.terminalAllowFailure({
    taskId,
    cwd: session.repoCwd,
    command: buildWaitForDevServerScript(waitSeconds),
  });
  const port = Number.parseInt(wait.stdout.trim(), 10);
  if (Number.isFinite(port) && port > 0) {
    session.devboxPreviewPort = port;
    void svc.taskStore.setPreviewPort(taskId, port);
    const previewPath = `/api/v1/tasks/${encodeURIComponent(taskId)}/devbox-preview?path=/`;
    patchTask(svc, taskId, { previewUrl: previewPath });
    emit(svc, "agent.log", taskId, "Devbox app ready for preview", {
      port,
      desktop: true,
    });
    void navigateDesktopBrowserToPort(svc, session, taskId, port);
    return port;
  }

  return session.devboxPreviewPort;
}

export function startDevboxPreviewWatcher(
  svc: TaskService,
  taskId: string,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) {
      return;
    }
    const session =
      svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
    if (!session) {
      return;
    }
    await refreshDevboxPreviewPort(svc, session, taskId);
    if (session.devboxPreviewPort) {
      await navigateDesktopBrowserToPort(
        svc,
        session,
        taskId,
        session.devboxPreviewPort,
      );
    }
    // Do not capture while the agent is working. The final screenshot is
    // scheduled only after the completed work has been pushed to GitHub.
  };

  const interval = setInterval(() => {
    void tick();
  }, 12_000);
  const initial = setTimeout(() => {
    void tick();
  }, 6_000);

  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(initial);
  };
}

export async function proxyDevboxPreview(
  svc: TaskService,
  taskId: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { warm?: boolean },
): Promise<void> {
  if (svc.mode === "brain") {
    const previewPath =
      typeof path === "string" && path.startsWith("/") ? path : `/${path}`;
    const warmQuery = opts?.warm ? "&warm=1" : "";
    const workerPath = `/api/v1/tasks/${encodeURIComponent(taskId)}/devbox-preview?path=${encodeURIComponent(previewPath)}${warmQuery}`;
    try {
      let upstream = await delegateRequestToWorker(
        svc,
        workerPath,
        {
          method: req.method === "HEAD" ? "HEAD" : "GET",
          headers: {
            Accept: "*/*",
            "Accept-Encoding": "identity",
          },
        },
        { timeoutMs: WORKER_DELEGATE_PREVIEW_TIMEOUT_MS },
      );
      if (upstream.status === 404) {
        const rehydrated = await requestWorkerRehydrate(svc, taskId);
        if (rehydrated.ok) {
          upstream = await delegateRequestToWorker(
            svc,
            workerPath,
            {
              method: req.method === "HEAD" ? "HEAD" : "GET",
              headers: {
                Accept: "*/*",
                "Accept-Encoding": "identity",
              },
            },
            { timeoutMs: WORKER_DELEGATE_PREVIEW_TIMEOUT_MS },
          );
        }
      }
      if (upstream.ok || upstream.status !== 404) {
        res.status(upstream.status);
        upstream.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (
            lower === "transfer-encoding" ||
            lower === "content-encoding" ||
            lower === "content-length"
          ) {
            return;
          }
          res.setHeader(key, value);
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        const body = await upstream.arrayBuffer();
        res.end(Buffer.from(body));
        return;
      }
    } catch (error) {
      if (isWorkerDelegateTimeout(error)) {
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "text/plain" });
          res.end("Devbox warming — retry shortly");
        }
        return;
      }
    }
    if (!res.headersSent) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("No live devbox session");
    }
    return;
  }

  const session = await resolveLiveSession(svc, taskId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No live devbox session");
    return;
  }

  if (opts?.warm) {
    await ensureDevboxAppForPreview(svc, session, taskId);
  }

  await refreshDevboxPreviewPort(svc, session, taskId);
  const previewPort = session.devboxPreviewPort ?? 3000;
  const proxyPath = path.startsWith("/") ? path : `/${path}`;

  try {
    const upstream = await svc.proxyRuntimeRequest(
      taskId,
      `/browser/proxy?port=${previewPort}&path=${encodeURIComponent(proxyPath)}`,
      {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: {
          Accept: "*/*",
          "Accept-Encoding": "identity",
        },
      },
    );
    if (!upstream.ok) {
      const detail = await upstream.text();
      if (!res.headersSent) {
        res.writeHead(upstream.status, { "Content-Type": "text/plain" });
      }
      res.end(
        detail.trim() || `Devbox preview unavailable: HTTP ${upstream.status}`,
      );
      return;
    }
    const headerRecord: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    if (!res.headersSent) {
      res.writeHead(
        upstream.status,
        sanitizeProxyResponseHeaders(headerRecord),
      );
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";
    const body = maybeRewriteDevboxPreviewBody(
      taskId,
      contentType,
      Buffer.concat(chunks),
    );
    res.end(body);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end(
      `Devbox preview unavailable: ${error instanceof Error ? error.message : "proxy error"}`,
    );
  }
}
