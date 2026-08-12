import type { TaskEvent } from "@devin/events";
import type { Task } from "../types.js";
import { fetchWorkerEventHistory, fetchWorkerTask } from "../worker-client.js";
import { hydrateTaskRuntime } from "./config.js";
import type { TaskService } from "./task-service.js";

const TERMINAL_STATUSES = new Set<Task["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function shouldAdoptWorkerTask(brain: Task, worker: Task): boolean {
  const brainUpdated = new Date(brain.updatedAt).getTime();
  const workerUpdated = new Date(worker.updatedAt).getTime();
  if (workerUpdated > brainUpdated) {
    return true;
  }
  if (
    (brain.status === "queued" || brain.status === "scheduling") &&
    TERMINAL_STATUSES.has(worker.status)
  ) {
    return true;
  }
  if (brain.status === "queued" && worker.status !== "queued") {
    return true;
  }
  return false;
}

function mergeWorkerTask(brain: Task, worker: Task): Task {
  if (!shouldAdoptWorkerTask(brain, worker)) {
    return hydrateTaskRuntime(brain);
  }

  return hydrateTaskRuntime({
    ...brain,
    ...worker,
    id: brain.id,
    userId: brain.userId ?? worker.userId,
    createdAt: brain.createdAt,
  });
}

async function ingestWorkerEvents(
  svc: TaskService,
  taskId: string,
  events: TaskEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const knownIds = new Set<string>();
  for (const event of svc.getEventHistory(taskId)) {
    knownIds.add(event.id);
  }
  if (svc.getTaskStore().isEnabled()) {
    for (const event of await svc.getTaskStore().loadEvents(taskId)) {
      knownIds.add(event.id);
    }
  }

  const sorted = [...events].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );

  for (const event of sorted) {
    if (event.taskId !== taskId || knownIds.has(event.id)) {
      continue;
    }
    knownIds.add(event.id);

    svc.getEventBus().publish(event);
    if (!svc.getTaskStore().isEnabled()) {
      continue;
    }

    const sequence = (await svc.getTaskStore().maxEventSequence(taskId)) + 1;
    await svc.getTaskStore().appendEvent(event, sequence);
    const currentMax = svc.eventSequences.get(taskId) ?? 0;
    if (sequence > currentMax) {
      svc.eventSequences.set(taskId, sequence);
    }
  }
}

/** Mirror execution-worker task state and events into brain when worker is not durable. */
export async function syncTaskFromWorker(
  svc: TaskService,
  taskId: string,
): Promise<Task | undefined> {
  if (svc.mode !== "brain" || !svc.executionWorkerUrl?.trim()) {
    return svc.getTask(taskId);
  }

  const brain =
    (await svc.syncTaskFromStore(taskId)) ??
    svc.getTask(taskId) ??
    (await svc.getTaskStore().getTask(taskId));
  if (!brain) {
    return undefined;
  }

  const worker = await fetchWorkerTask(svc.executionWorkerUrl, taskId);
  if (!worker) {
    return hydrateTaskRuntime(brain);
  }

  const merged = mergeWorkerTask(brain, worker);
  if (merged.updatedAt !== brain.updatedAt || merged.status !== brain.status) {
    svc.tasks.set(taskId, merged);
    await svc.taskStore.upsertTask(merged);
  }

  const workerEvents = await fetchWorkerEventHistory(
    svc.executionWorkerUrl,
    taskId,
  );
  await ingestWorkerEvents(svc, taskId, workerEvents);

  return merged;
}
