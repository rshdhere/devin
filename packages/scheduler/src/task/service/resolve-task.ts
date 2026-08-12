import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { hydrateTaskRuntime } from "./config.js";

/** Load a task from memory or Postgres and hydrate the in-memory map. */
export async function ensureTaskLoaded(
  svc: TaskService,
  taskId: string,
): Promise<Task | undefined> {
  const existing = svc.tasks.get(taskId);
  if (existing) {
    return hydrateTaskRuntime(existing);
  }

  const stored = await svc.taskStore.getTask(taskId);
  if (!stored) {
    return undefined;
  }

  const hydrated = hydrateTaskRuntime(stored);
  svc.tasks.set(taskId, hydrated);
  return hydrated;
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
