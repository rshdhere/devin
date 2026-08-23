import type { TaskEvent, TaskEventType } from "@devin/events";
import type { Task, TaskStatus } from "../types.js";
import type { TaskService } from "./task-service.js";

export function updateTask(
  svc: TaskService,
  taskId: string,
  status: TaskStatus,
  message: string,
): void {
  const task = svc.tasks.get(taskId);
  if (!task) {
    return;
  }
  task.status = status;
  task.message = message;
  task.updatedAt = new Date().toISOString();
  void svc.taskStore.upsertTask(task);
}

export function patchTask(
  svc: TaskService,
  taskId: string,
  patch: Partial<
    Pick<
      Task,
      | "previewUrl"
      | "deployStatus"
      | "branch"
      | "prUrl"
      | "sessionActive"
      | "sessionSleeping"
      | "sandboxName"
    >
  >,
): void {
  const task = svc.tasks.get(taskId);
  if (!task) {
    return;
  }
  Object.assign(task, patch);
  task.updatedAt = new Date().toISOString();
  void svc.taskStore.upsertTask(task);
}

export async function nextEventSequenceFromStore(
  svc: TaskService,
  taskId: string,
): Promise<number> {
  if (svc.mode === "brain" && svc.taskStore.isEnabled()) {
    const max = await svc.taskStore.maxEventSequence(taskId);
    const memory = svc.eventSequences.get(taskId) ?? 0;
    const next = Math.max(max, memory) + 1;
    svc.eventSequences.set(taskId, next);
    return next;
  }
  return nextEventSequence(svc, taskId);
}

function publishEvent(
  svc: TaskService,
  event: TaskEvent,
  sequence: number,
): void {
  svc.eventBus.publish(event);
  void svc.taskStore.appendEvent(event, sequence).catch(() => undefined);
}

export function emit(
  svc: TaskService,
  type: TaskEventType,
  taskId: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  // Publish to the in-memory bus immediately so SSE / worker history reflect
  // Brain harness tool steps without waiting on Postgres append.
  const memorySequence = nextEventSequence(svc, taskId);
  const event: TaskEvent = {
    id: crypto.randomUUID(),
    taskId,
    type,
    message,
    timestamp: new Date().toISOString(),
    data: {
      source: "scheduler",
      sequence: memorySequence,
      ...(data ?? {}),
    },
  };
  svc.eventBus.publish(event);

  void (async () => {
    if (!svc.taskStore.isEnabled()) {
      return;
    }
    try {
      const sequence = await nextEventSequenceFromStore(svc, taskId);
      const durable: TaskEvent = {
        ...event,
        data: {
          ...event.data,
          sequence,
        },
      };
      await svc.taskStore.appendEvent(durable, sequence);
    } catch {
      // best-effort persistence
    }
  })();
}

export function emitRuntime(
  svc: TaskService,
  taskId: string,
  type: TaskEventType,
  message: string,
  data?: Record<string, unknown>,
): void {
  void (async () => {
    const sequence = await nextEventSequenceFromStore(svc, taskId);
    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data: {
        source: "runtime",
        sequence,
        ...(data ?? {}),
      },
    };
    publishEvent(svc, event, sequence);
  })();
}

export function nextEventSequence(svc: TaskService, taskId: string): number {
  const next = (svc.eventSequences.get(taskId) ?? 0) + 1;
  svc.eventSequences.set(taskId, next);
  return next;
}
