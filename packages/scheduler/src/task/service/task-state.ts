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

export function emit(
  svc: TaskService,
  type: TaskEventType,
  taskId: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  const sequence = nextEventSequence(svc, taskId);
  const event: TaskEvent = {
    id: crypto.randomUUID(),
    taskId,
    type,
    message,
    timestamp: new Date().toISOString(),
    data: {
      source: "scheduler",
      sequence,
      ...(data ?? {}),
    },
  };
  svc.eventBus.publish(event);
  void svc.taskStore.appendEvent(event, sequence);
}

export function emitRuntime(
  svc: TaskService,
  taskId: string,
  type: TaskEventType,
  message: string,
  data?: Record<string, unknown>,
): void {
  const sequence = nextEventSequence(svc, taskId);
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
  svc.eventBus.publish(event);
  void svc.taskStore.appendEvent(event, sequence);
}

export function nextEventSequence(svc: TaskService, taskId: string): number {
  const next = (svc.eventSequences.get(taskId) ?? 0) + 1;
  svc.eventSequences.set(taskId, next);
  return next;
}
