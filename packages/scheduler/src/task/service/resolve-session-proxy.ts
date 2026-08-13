import {
  delegateRequestToWorker,
  hydrateSessionFromStore,
  wakeSession,
} from "./session-lifecycle.js";
import { hydrateSessionFromOrchestrator } from "./orchestrator-session.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";

/**
 * Resolve a live devbox session for UI proxy routes (preview, files, desktop).
 * On brain, returns undefined — caller should delegate to worker + rehydrate.
 */
export async function resolveSessionForProxy(
  svc: TaskService,
  taskId: string,
): Promise<ReviewSession | undefined> {
  const inMemory =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  if (inMemory) {
    return inMemory;
  }

  const persisted = await svc.taskStore.getSession(taskId);
  if (
    persisted &&
    (persisted.state === "active" ||
      persisted.state === "review" ||
      persisted.state === "sleeping")
  ) {
    return hydrateSessionFromStore(svc, taskId, persisted);
  }

  if (svc.mode === "brain") {
    return undefined;
  }

  return hydrateSessionFromOrchestrator(svc, taskId);
}

/** Resolve a session for runtime HTTP/WebSocket proxying (includes worker wake). */
export async function resolveRuntimeSession(
  svc: TaskService,
  taskId: string,
): Promise<ReviewSession | undefined> {
  const fromProxy = await resolveSessionForProxy(svc, taskId);
  if (fromProxy) {
    return fromProxy;
  }

  if (svc.mode !== "brain") {
    const woken = await wakeSession(svc, taskId);
    if (woken) {
      return woken;
    }
    return hydrateSessionFromOrchestrator(svc, taskId);
  }

  return undefined;
}

export async function requestWorkerRehydrate(
  svc: TaskService,
  taskId: string,
): Promise<boolean> {
  if (!svc.executionWorkerUrl?.trim()) {
    return false;
  }
  try {
    const upstream = await delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/rehydrate`,
      { method: "POST" },
    );
    return upstream.ok;
  } catch {
    return false;
  }
}

export async function brainDelegateOrRuntime(
  svc: TaskService,
  taskId: string,
  workerPath: string,
  _runtimePath: string,
  init?: RequestInit,
): Promise<Response> {
  if (svc.executionWorkerUrl?.trim()) {
    try {
      let upstream = await delegateRequestToWorker(svc, workerPath, init);
      if (upstream.status === 404) {
        await requestWorkerRehydrate(svc, taskId);
        upstream = await delegateRequestToWorker(svc, workerPath, init);
      }
      if (upstream.ok || upstream.status !== 404) {
        return upstream;
      }
    } catch {
      // Fall through — worker unreachable.
    }
  }

  throw new Error("no devbox session for task");
}

export { hydrateSessionFromOrchestrator } from "./orchestrator-session.js";
