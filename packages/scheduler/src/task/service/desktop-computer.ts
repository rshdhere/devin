import type { IncomingMessage, ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { TaskService } from "./task-service.js";
import { resolveLiveSession } from "./desktop-capture-render.js";
import {
  brainDelegateOrRuntime,
  requestWorkerRehydrate,
} from "./resolve-session-proxy.js";
import { wakeSession } from "./session-lifecycle.js";

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
  if (svc.mode === "brain") {
    await proxyBrainDesktopVNCWebSocket(svc, taskId, clientWs);
    return;
  }

  const session =
    (await resolveLiveSession(svc, taskId)) ?? (await wakeSession(svc, taskId));
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
    res.setHeader(key, value);
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
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
