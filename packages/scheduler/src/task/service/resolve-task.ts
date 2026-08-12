import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { hydrateTaskRuntime } from "./config.js";

/** Merge Postgres task state into memory (worker updates do not reach brain RAM). */
export async function syncTaskFromStore(
  svc: TaskService,
  taskId: string,
): Promise<Task | undefined> {
  const stored = await svc.taskStore.getTask(taskId);
  if (!stored) {
    const memory = svc.tasks.get(taskId);
    return memory ? hydrateTaskRuntime(memory) : undefined;
  }

  const hydrated = hydrateTaskRuntime(stored);
  const memory = svc.tasks.get(taskId);
  if (!memory || hydrated.updatedAt >= memory.updatedAt) {
    svc.tasks.set(taskId, hydrated);
  }
  const current = svc.tasks.get(taskId);
  return current ? hydrateTaskRuntime(current) : hydrated;
}

/** Load a task from memory or Postgres and hydrate the in-memory map. */
export async function ensureTaskLoaded(
  svc: TaskService,
  taskId: string,
): Promise<Task | undefined> {
  return syncTaskFromStore(svc, taskId);
}

/** Restore pending job metadata from session store when brain/worker restarts. */
export async function ensurePendingJob(
  svc: TaskService,
  taskId: string,
): Promise<ScheduleJob | undefined> {
  const existing = svc.pendingJobs.get(taskId);
  if (existing) {
    return existing;
  }

  const session = await svc.taskStore.getSession(taskId);
  if (session) {
    svc.pendingJobs.set(taskId, session.job);
    return session.job;
  }

  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    return undefined;
  }

  const job: ScheduleJob = {
    taskId: task.id,
    prompt: task.prompt,
    agent: task.agent,
    runtime: task.runtime,
    userId: task.userId,
    repository: task.repository,
    autoStartSandbox: true,
    enqueuedAt: task.updatedAt,
  };
  svc.pendingJobs.set(taskId, job);
  return job;
}
