import { RuntimeClient } from "@devin/agent-sdk";
import type { TaskService } from "./task-service.js";
import {
  loadCachedDesktopSnapshot,
  startDevboxPreviewWatcher,
} from "./desktop-capture.js";
import { ensurePendingJob } from "./resolve-task.js";

export async function restoreFromStore(svc: TaskService): Promise<void> {
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
