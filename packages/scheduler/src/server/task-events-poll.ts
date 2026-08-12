import type { TaskEvent } from "@devin/events";

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
