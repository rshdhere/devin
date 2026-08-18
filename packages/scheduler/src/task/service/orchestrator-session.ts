import { RuntimeClient } from "@devin/agent-sdk";
import type { ScheduleJob, Task, TaskStatus } from "../types.js";
import { ensurePendingJob, ensureTaskLoaded } from "./resolve-task.js";
import { persistSession } from "./persistence.js";
import { fetchSandbox } from "./sandbox-lifecycle.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";

const PROXYABLE_STATUSES = new Set<TaskStatus>([
  "sandbox_starting",
  "runtime_ready",
  "running",
  "awaiting_review",
]);

function taskMayHaveLiveSandbox(task: Task): boolean {
  return Boolean(
    task.sessionActive ||
    PROXYABLE_STATUSES.has(task.status) ||
    task.sessionSleeping,
  );
}

/** Rebuild a devbox session from orchestrator when the worker lost in-memory state. */
export async function hydrateSessionFromOrchestrator(
  svc: TaskService,
  taskId: string,
): Promise<ReviewSession | undefined> {
  let task = await ensureTaskLoaded(svc, taskId);
  if (!task && svc.taskStore.isEnabled()) {
    const stored = await svc.taskStore.getTask(taskId);
    if (stored) {
      task = stored;
      svc.tasks.set(taskId, stored);
    }
  }

  const sandboxName = task?.sandboxName ?? `sbx-${taskId.slice(0, 8)}`;
  const sandbox = await fetchSandbox(svc, sandboxName);
  if (sandbox?.status?.phase !== "Running") {
    return undefined;
  }

  if (!task) {
    task = {
      id: taskId,
      prompt: "",
      agent: "cursor",
      status: "running",
      title: "",
      sandboxName,
      sessionActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    svc.tasks.set(taskId, task);
  }

  const persisted = await svc.taskStore.getSession(taskId);
  const persistedSessionIsLive =
    persisted?.state === "active" || persisted?.state === "review";
  if (!taskMayHaveLiveSandbox(task) && !persistedSessionIsLive) {
    return undefined;
  }

  const runtimeBaseUrl = sandbox.status.runtimeURL?.replace(/\/$/, "");
  if (!runtimeBaseUrl) {
    return undefined;
  }

  const runtime = new RuntimeClient({ baseUrl: runtimeBaseUrl });
  try {
    const health = await runtime.health();
    if (health.status !== "ok") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const job =
    (await ensurePendingJob(svc, taskId)) ??
    ({
      taskId: task.id,
      prompt: task.prompt,
      agent: task.agent,
      runtime: task.runtime,
      userId: task.userId,
      repository: task.repository,
      autoStartSandbox: true,
      enqueuedAt: task.updatedAt,
    } satisfies ScheduleJob);

  let guestHost: string | undefined;
  try {
    guestHost = new URL(runtimeBaseUrl).hostname;
  } catch {
    guestHost = undefined;
  }

  const session: ReviewSession = {
    runtime,
    sandboxName,
    runtimeBaseUrl,
    repoCwd: persisted?.repoCwd ?? "repo",
    job,
    githubToken: persisted?.githubToken ?? job.githubToken,
    createdNewRepo: persisted?.createdNewRepo ?? false,
    guestHost: persisted?.guestHost ?? guestHost,
    devboxPreviewPort: persisted?.previewPort,
  };

  svc.activeSessions.set(taskId, session);
  task.sessionActive = true;
  task.sandboxName = sandboxName;
  svc.tasks.set(taskId, task);
  void svc.taskStore.upsertTask(task);
  void persistSession(svc, taskId, session, "active");

  return session;
}
