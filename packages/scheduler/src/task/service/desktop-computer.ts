import type { IncomingMessage, ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { TaskService } from "./task-service.js";
import {
  ensureDevboxAppForPreview,
  resolveLiveSession,
} from "./desktop-capture-render.js";
import {
  brainDelegateOrRuntime,
  requestWorkerRehydrate,
} from "./resolve-session-proxy.js";
import { wakeSession } from "./session-lifecycle.js";
import {
  contentTypeForVncAsset,
  rewriteDesktopVncHtml,
} from "./desktop-vnc-html.js";
import { emit } from "./task-state.js";

function bridgeWebSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });
  client.on("close", () => upstream.close());
  upstream.on("close", () => client.close());
  client.on("error", () => upstream.close());
  upstream.on("error", () => client.close());
}

function workerVNCWebSocketUrl(svc: TaskService, taskId: string): string {
  const base = svc
    .executionWorkerUrl!.replace(/^http/, "ws")
    .replace(/\/$/, "");
  return `${base}/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-vnc/ws`;
}

function openWorkerVNCWebSocket(
  svc: TaskService,
  taskId: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const upstream = new WebSocket(workerVNCWebSocketUrl(svc, taskId));
    upstream.once("open", () => resolve(upstream));
    upstream.once("error", reject);
  });
}

async function proxyBrainDesktopVNCWebSocket(
  svc: TaskService,
  taskId: string,
  clientWs: WebSocket,
): Promise<void> {
  if (!svc.executionWorkerUrl?.trim()) {
    clientWs.close(1011, "no execution worker");
    return;
  }

  const connect = async (): Promise<WebSocket> => {
    try {
      return await openWorkerVNCWebSocket(svc, taskId);
    } catch {
      const rehydrated = await requestWorkerRehydrate(svc, taskId);
      if (!rehydrated.ok) {
        throw new Error("no devbox session");
      }
      return openWorkerVNCWebSocket(svc, taskId);
    }
  };

  try {
    const upstream = await connect();
    bridgeWebSockets(clientWs, upstream);
  } catch {
    clientWs.close(1011, "no devbox session");
  }
}

async function resolveDesktopSession(
  svc: TaskService,
  taskId: string,
): Promise<Awaited<ReturnType<typeof resolveLiveSession>>> {
  const session =
    (await resolveLiveSession(svc, taskId)) ?? (await wakeSession(svc, taskId));
  if (session) {
    void svc.taskStore.touchSession(taskId);
  }
  return session;
}

export async function ensureDesktopComputer(
  svc: TaskService,
  taskId: string,
): Promise<Response> {
  if (svc.mode === "brain") {
    // Worker path below starts the product app + navigates Chromium after VNC.
    return brainDelegateOrRuntime(
      svc,
      taskId,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop/ensure`,
      "/desktop/ensure",
      { method: "POST" },
    );
  }
  const session = await resolveDesktopSession(svc, taskId);
  if (!session) {
    return new Response(JSON.stringify({ error: "no devbox session" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const ensureResponse = await fetch(
    `${session.runtimeBaseUrl}/desktop/ensure`,
    { method: "POST" },
  );
  if (!ensureResponse.ok) {
    return ensureResponse;
  }

  // Interactive CDP browser defaults to localhost:3000; product preview is on
  // the managed snapshot port (3099). Start/rediscover and navigate Chromium.
  try {
    const port = await ensureDevboxAppForPreview(svc, session, taskId);
    emit(svc, "agent.log", taskId, "Interactive desktop app ready", {
      desktop: true,
      interactive: true,
      previewPort: port ?? session.devboxPreviewPort ?? null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(svc, "agent.log", taskId, "Interactive app preview ensure failed", {
      desktop: true,
      interactive: true,
      detail: detail.slice(0, 240),
    });
  }

  return ensureResponse;
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
  const session = await resolveDesktopSession(svc, taskId);
  if (!session) {
    return new Response("No devbox session", { status: 404 });
  }
  await ensureDesktopComputer(svc, taskId);
  return fetch(`${session.runtimeBaseUrl}/desktop/vnc`);
}

export async function proxyDesktopVNCAsset(
  svc: TaskService,
  taskId: string,
  assetPath: string,
): Promise<Response> {
  const relative = assetPath.replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => part === "..")) {
    return new Response("Not found", { status: 404 });
  }

  if (svc.mode === "brain") {
    try {
      return await brainDelegateOrRuntime(
        svc,
        taskId,
        `/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-vnc/assets/${relative}`,
        `/desktop/vnc/assets/${relative}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "desktop vnc asset failed";
      if (message.includes("no devbox session")) {
        return new Response(JSON.stringify({ error: message }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: message }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const session = await resolveDesktopSession(svc, taskId);
  if (!session) {
    return new Response(JSON.stringify({ error: "no devbox session" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  await ensureDesktopComputer(svc, taskId);
  try {
    return await fetch(
      `${session.runtimeBaseUrl}/desktop/vnc/assets/${relative}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "runtime unreachable";
    return new Response(JSON.stringify({ error: message }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function proxyRuntimeWebSocket(
  svc: TaskService,
  taskId: string,
  runtimePath: string,
  clientWs: WebSocket,
): Promise<void> {
  if (svc.mode === "brain") {
    await proxyBrainDesktopVNCWebSocket(svc, taskId, clientWs);
    return;
  }

  const session = await resolveDesktopSession(svc, taskId);
  if (!session) {
    clientWs.close(1011, "no devbox session");
    return;
  }
  const base = session.runtimeBaseUrl.replace(/^http/, "ws");
  const upstream = new WebSocket(`${base}${runtimePath}`);
  upstream.on("open", () => {
    bridgeWebSockets(clientWs, upstream);
  });
  upstream.on("error", () => clientWs.close(1011, "runtime websocket failed"));
}

export async function proxyDesktopVNCPageHttp(
  svc: TaskService,
  taskId: string,
  res: ServerResponse,
): Promise<void> {
  const upstream = await proxyDesktopVNCPage(svc, taskId);
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  let body = Buffer.from(await upstream.arrayBuffer()).toString("utf8");
  if (upstream.ok) {
    body = rewriteDesktopVncHtml(body, taskId);
  }
  res.end(body);
}

export async function proxyDesktopVNCAssetHttp(
  svc: TaskService,
  taskId: string,
  assetPath: string,
  res: ServerResponse,
): Promise<void> {
  const upstream = await proxyDesktopVNCAsset(svc, taskId, assetPath);
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
  const forcedType = contentTypeForVncAsset(assetPath);
  if (forcedType) {
    res.setHeader("Content-Type", forcedType);
  }
  res.end(Buffer.from(await upstream.arrayBuffer()));
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
