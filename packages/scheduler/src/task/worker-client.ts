import type { TaskEvent } from "@devin/events";
import type { Task } from "./types.js";

export async function fetchWorkerTask(
  executionWorkerUrl: string,
  taskId: string,
): Promise<Task | undefined> {
  try {
    const response = await fetch(
      `${executionWorkerUrl.replace(/\/$/, "")}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as Task;
  } catch {
    return undefined;
  }
}

export async function fetchWorkerEventHistory(
  executionWorkerUrl: string,
  taskId: string,
): Promise<TaskEvent[]> {
  try {
    const response = await fetch(
      `${executionWorkerUrl.replace(/\/$/, "")}/api/v1/tasks/${encodeURIComponent(taskId)}/events/history`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    return Array.isArray(payload) ? (payload as TaskEvent[]) : [];
  } catch {
    return [];
  }
}
