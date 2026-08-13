import type { IncomingMessage, ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  loadTaskSessionRecordingS3,
  saveTaskSessionRecordingS3,
} from "../../devbox/recording-s3.js";
import type { TaskService } from "./task-service.js";
import { resolveLiveSession } from "./desktop-capture-render.js";
import { brainDelegateOrRuntime } from "./resolve-session-proxy.js";
import { delegateRequestToWorker, wakeSession } from "./session-lifecycle.js";

export async function ensureDesktopComputer(
  svc: TaskService,
  taskId: string,
): Promise<Response> {
  if (svc.mode === "brain") {
    return brainDelegateOrRuntime(
      svc,
      taskId,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop/ensure`,
      "/desktop/ensure",
      { method: "POST" },
    );
  }
  const session = await resolveLiveSession(svc, taskId);
  if (!session) {
    return new Response(JSON.stringify({ error: "no devbox session" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fetch(`${session.runtimeBaseUrl}/desktop/ensure`, { method: "POST" });
}

export async function proxyDesktopVNCPage(
  svc: TaskService,
  taskId: string,
): Promise<Response> {
  if (svc.mode === "brain") {
    return brainDelegateOrRuntime(
      svc,
      taskId,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-vnc`,
      "/desktop/vnc",
    );
  }
  const session = await resolveLiveSession(svc, taskId);
  if (!session) {
    return new Response("No devbox session", { status: 404 });
  }
  await ensureDesktopComputer(svc, taskId);
  return fetch(`${session.runtimeBaseUrl}/desktop/vnc`);
}

export async function proxyRuntimeWebSocket(
  svc: TaskService,
  taskId: string,
  runtimePath: string,
  clientWs: WebSocket,
): Promise<void> {
  const session =
    (await resolveLiveSession(svc, taskId)) ?? (await wakeSession(svc, taskId));
  if (!session) {
    clientWs.close(1011, "no devbox session");
    return;
  }
  const base = session.runtimeBaseUrl.replace(/^http/, "ws");
  const upstream = new WebSocket(`${base}${runtimePath}`);
  upstream.on("open", () => {
    clientWs.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });
  });
  upstream.on("close", () => clientWs.close());
  upstream.on("error", () => clientWs.close(1011, "runtime websocket failed"));
  clientWs.on("close", () => upstream.close());
  clientWs.on("error", () => upstream.close());
}

export async function startSessionRecording(
  svc: TaskService,
  taskId: string,
): Promise<Response> {
  if (svc.mode === "brain") {
    return delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop/recording/start`,
      { method: "POST" },
    );
  }
  const session =
    (await resolveLiveSession(svc, taskId)) ?? (await wakeSession(svc, taskId));
  if (!session) {
    return new Response(JSON.stringify({ error: "no devbox session" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  await ensureDesktopComputer(svc, taskId);
  return svc.proxyRuntimeRequest(taskId, "/desktop/recording/start", {
    method: "POST",
  });
}

export async function stopAndPersistSessionRecording(
  svc: TaskService,
  taskId: string,
): Promise<void> {
  if (svc.mode === "brain") {
    await delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop/recording/stop`,
      { method: "POST" },
    );
    return;
  }
  const session =
    svc.activeSessions.get(taskId) ??
    svc.reviewSessions.get(taskId) ??
    (await resolveLiveSession(svc, taskId));
  if (!session) {
    return;
  }
  try {
    await svc.proxyRuntimeRequest(taskId, "/desktop/recording/stop", {
      method: "POST",
    });
  } catch {
    // best-effort
  }
  try {
    const upstream = await svc.proxyRuntimeRequest(
      taskId,
      "/desktop/recording",
    );
    if (!upstream.ok) {
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length < 1024) {
      return;
    }
    await saveTaskSessionRecordingS3(taskId, buffer);
    await svc.taskStore.saveSessionRecordingKey(taskId);
  } catch {
    // best-effort
  }
}

export async function fetchSessionRecording(
  svc: TaskService,
  taskId: string,
): Promise<Response> {
  if (svc.mode === "brain") {
    return delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/session-recording`,
    );
  }

  const cached = await loadTaskSessionRecordingS3(taskId);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        "Content-Type": "video/webm",
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
    return new Response("No session recording", { status: 404 });
  }
  const upstream = await svc.proxyRuntimeRequest(taskId, "/desktop/recording");
  if (!upstream.ok) {
    return new Response("No session recording", { status: 404 });
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length >= 1024) {
    void saveTaskSessionRecordingS3(taskId, buffer);
    void svc.taskStore.saveSessionRecordingKey(taskId);
  }
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "video/webm",
      "Cache-Control": "no-store",
    },
  });
}

export async function proxyDesktopVNCPageHttp(
  svc: TaskService,
  taskId: string,
  res: ServerResponse,
): Promise<void> {
  const upstream = await proxyDesktopVNCPage(svc, taskId);
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
}

export function startDesktopRecordingWatcher(
  svc: TaskService,
  taskId: string,
): () => void {
  void startSessionRecording(svc, taskId);
  return () => {
    void stopAndPersistSessionRecording(svc, taskId);
  };
}

export function attachDesktopVNCWebSocketUpgrade(
  svc: TaskService,
  server: import("node:http").Server,
): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/desktop-vnc\/ws\/?$/);
    if (!match?.[1]) {
      return;
    }
    const taskId = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      void proxyRuntimeWebSocket(svc, taskId, "/desktop/vnc/ws", clientWs);
    });
  });
}

export type { IncomingMessage };
