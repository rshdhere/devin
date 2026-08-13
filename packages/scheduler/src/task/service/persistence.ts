import { RuntimeClient } from "@devin/agent-sdk";
import type { TaskService } from "./task-service.js";
import {
  loadCachedDesktopSnapshot,
  startDevboxPreviewWatcher,
} from "./desktop-capture.js";
import { resolveTimeoutMs } from "./config.js";
import { ensurePendingJob } from "./resolve-task.js";

async function restoreFromStoreInner(svc: TaskService): Promise<void> {
  const sequences = await svc.taskStore.restoreEventSequences();
  for (const [taskId, seq] of sequences) {
    svc.eventSequences.set(taskId, seq);
  }

  const tasks = await svc.taskStore.listTasks();
  for (const task of tasks) {
    svc.tasks.set(task.id, task);
    const events = await svc.taskStore.loadEvents(task.id);
    for (const event of events) {
      svc.eventBus.publish(event);
    }
    if (!svc.pendingJobs.has(task.id)) {
      await ensurePendingJob(svc, task.id);
    }
  }

  const sessions = await svc.taskStore.loadActiveSessions();
  for (const persisted of sessions) {
    if (persisted.state === "sleeping") {
      continue;
    }
    const task = svc.tasks.get(persisted.taskId);
    if (!task) {
      continue;
    }
    const runtime = new RuntimeClient(persisted.runtimeBaseUrl);
    try {
      const health = await runtime.health();
      if (health.status !== "ok") {
        task.sessionActive = false;
        continue;
      }
    } catch {
      task.sessionActive = false;
      continue;
    }

    const session: ReviewSession = {
      runtime,
      sandboxName: persisted.sandboxName,
      runtimeBaseUrl: persisted.runtimeBaseUrl,
      repoCwd: persisted.repoCwd,
      job: persisted.job,
      githubToken: persisted.githubToken,
      createdNewRepo: persisted.createdNewRepo,
      guestHost: persisted.guestHost,
      devboxPreviewPort: persisted.previewPort,
    };
    session.lastDesktopScreenshot = await loadCachedDesktopSnapshot(
      svc,
      persisted.taskId,
    );

    if (persisted.state === "review") {
      svc.reviewSessions.set(persisted.taskId, session);
    } else {
      svc.activeSessions.set(persisted.taskId, session);
    }
    svc.pendingJobs.set(persisted.taskId, persisted.job);
    task.sessionActive = true;
    task.sandboxName = persisted.sandboxName;
    startDevboxPreviewWatcher(svc, persisted.taskId);
  }
}

export async function restoreFromStore(svc: TaskService): Promise<void> {
  const timeoutMs =
    resolveTimeoutMs("TASK_STORE_RESTORE_TIMEOUT_SECONDS", 30) * 1000;
  await Promise.race([
    restoreFromStoreInner(svc),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("task store restore timed out")),
        timeoutMs,
      );
    }),
  ]).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "task store restore failed",
    );
  });
}

export async function persistSession(
  svc: TaskService,
  taskId: string,
  session: ReviewSession,
  state: PersistedSession["state"],
): Promise<void> {
  await svc.taskStore.upsertSession({
    taskId,
    sandboxName: session.sandboxName,
    runtimeBaseUrl: session.runtimeBaseUrl,
    repoCwd: session.repoCwd,
    state,
    job: session.job,
    githubToken: session.githubToken,
    createdNewRepo: session.createdNewRepo,
    guestHost: session.guestHost,
    previewPort: session.devboxPreviewPort,
    lastActiveAt: new Date().toISOString(),
  });
}
