import { RuntimeClient } from "@devin/agent-sdk";
import {
  delegateRequestToWorker,
  hydrateSessionFromStore,
  isWorkerDelegateTimeout,
  wakeSession,
  WORKER_DELEGATE_PREVIEW_TIMEOUT_MS,
  WORKER_DELEGATE_REHYDRATE_TIMEOUT_MS,
  WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS,
  WORKER_DELEGATE_TIMEOUT_MS,
  type WorkerDelegateOptions,
} from "./session-lifecycle.js";
import { hydrateSessionFromOrchestrator } from "./orchestrator-session.js";
import { persistSession } from "./persistence.js";
import { ensurePendingJob } from "./resolve-task.js";
import { patchTask } from "./task-state.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";

export type RehydrateWorkerResult = {
  ok: boolean;
  runtimeBaseUrl?: string;
  sandboxName?: string;
  previewPort?: number;
};

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

async function persistBrainSessionFromRehydrate(
  svc: TaskService,
  taskId: string,
  body: RehydrateWorkerResult,
): Promise<void> {
  if (svc.mode !== "brain" || !body.runtimeBaseUrl || !body.sandboxName) {
    return;
  }

  const task = svc.tasks.get(taskId) ?? (await svc.taskStore.getTask(taskId));
  if (!task) {
    return;
  }

  const persisted = await svc.taskStore.getSession(taskId);
  const job = persisted?.job ?? (await ensurePendingJob(svc, taskId));
  if (!job) {
    return;
  }

  const runtime = new RuntimeClient({ baseUrl: body.runtimeBaseUrl });
  const session: ReviewSession = {
    runtime,
    sandboxName: body.sandboxName,
    runtimeBaseUrl: body.runtimeBaseUrl,
    repoCwd: persisted?.repoCwd ?? "repo",
    job,
    githubToken: persisted?.githubToken ?? job.githubToken,
    createdNewRepo: persisted?.createdNewRepo ?? false,
    guestHost: persisted?.guestHost,
    devboxPreviewPort: body.previewPort ?? persisted?.previewPort,
  };

  const state =
    persisted?.state === "review" || persisted?.state === "sleeping"
      ? persisted.state
      : "active";

  if (state === "review") {
    svc.reviewSessions.set(taskId, session);
  } else {
    svc.activeSessions.set(taskId, session);
  }

  task.sessionActive = true;
  task.sandboxName = body.sandboxName;
  svc.tasks.set(taskId, task);
  void svc.taskStore.upsertTask(task);
  void persistSession(svc, taskId, session, state);
  patchTask(svc, taskId, {
    sessionActive: true,
    sandboxName: body.sandboxName,
  });
}

export async function requestWorkerRehydrate(
  svc: TaskService,
  taskId: string,
): Promise<RehydrateWorkerResult> {
  if (!svc.executionWorkerUrl?.trim()) {
    return { ok: false };
  }
  try {
    const upstream = await delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/rehydrate`,
      { method: "POST" },
      { timeoutMs: WORKER_DELEGATE_REHYDRATE_TIMEOUT_MS },
    );
    if (!upstream.ok) {
      return { ok: false };
    }
    const body = (await upstream.json().catch(() => ({}))) as {
      runtimeBaseUrl?: string;
      sandboxName?: string;
      previewPort?: number;
    };
    const result: RehydrateWorkerResult = {
      ok: true,
      runtimeBaseUrl: body.runtimeBaseUrl,
      sandboxName: body.sandboxName,
      previewPort:
        typeof body.previewPort === "number" ? body.previewPort : undefined,
    };
    await persistBrainSessionFromRehydrate(svc, taskId, result);
    return result;
  } catch {
    return { ok: false };
  }
}

export function workerPathTimeoutMs(path: string): number {
  if (path.includes("/rehydrate")) {
    return WORKER_DELEGATE_REHYDRATE_TIMEOUT_MS;
  }
  if (path.includes("/devbox-preview")) {
    return WORKER_DELEGATE_PREVIEW_TIMEOUT_MS;
  }
  if (path.includes("/desktop-screenshot")) {
    return WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS;
  }
  if (path.includes("/desktop-vnc")) {
    return WORKER_DELEGATE_PREVIEW_TIMEOUT_MS;
  }
  return WORKER_DELEGATE_TIMEOUT_MS;
}

export async function brainDelegateOrRuntime(
  svc: TaskService,
  taskId: string,
  workerPath: string,
  _runtimePath: string,
  init?: RequestInit,
  options?: WorkerDelegateOptions,
): Promise<Response> {
  if (!svc.executionWorkerUrl?.trim()) {
    throw new Error(
      "EXECUTION_WORKER_URL is not configured on brain — cannot reach the execution-host worker for files/desktop",
    );
  }

  const timeoutMs = options?.timeoutMs ?? workerPathTimeoutMs(workerPath);

  try {
    let upstream = await delegateRequestToWorker(svc, workerPath, init, {
      timeoutMs,
    });

    if (upstream.status === 404) {
      const bodyText = await upstream.text();
      const sessionMissing = /no devbox session/i.test(bodyText);
      // Guest file-not-found is also HTTP 404 — do not treat it as a dead session.
      if (!sessionMissing) {
        return new Response(bodyText, {
          status: 404,
          headers: {
            "Content-Type":
              upstream.headers.get("content-type") ?? "application/json",
          },
        });
      }

      const rehydrated = await requestWorkerRehydrate(svc, taskId);
      if (rehydrated.ok) {
        upstream = await delegateRequestToWorker(svc, workerPath, init, {
          timeoutMs,
        });
        return upstream;
      }

      throw new Error(
        "Devbox session not found on the execution worker (rehydrate failed). Wait for sandbox ready, then retry.",
      );
    }

    return upstream;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Devbox session")) {
      throw error;
    }
    if (isWorkerDelegateTimeout(error)) {
      return new Response("Devbox warming — retry shortly", { status: 504 });
    }
    const detail =
      error instanceof Error ? error.message : "worker unreachable";
    throw new Error(
      `Cannot reach execution worker for this task (${detail}). Check EXECUTION_WORKER_URL and worker health.`,
    );
  }
}

export { hydrateSessionFromOrchestrator } from "./orchestrator-session.js";
