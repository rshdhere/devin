import type { TaskEvent } from "@devin/events";
import { formatSSE } from "@devin/events";
import type { Request, Response } from "express";
import type { TaskService } from "../task/service.js";
import { syncTaskFromStore } from "../task/service/resolve-task.js";
import { fetchWorkerEventHistory } from "./task-events-poll.js";

export async function handleTaskEvents(
  tasks: TaskService,
  taskId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const task =
    (await syncTaskFromStore(tasks, taskId)) ??
    tasks.getTask(taskId) ??
    (await tasks.getTaskStore().getTask(taskId));
  if (!task) {
    res.status(404).json({ error: "task not found" });
    return;
  }

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const memoryHistory = tasks.getEventHistory(taskId);
  const history = tasks.getTaskStore().isEnabled()
    ? await tasks.getTaskStore().loadEvents(taskId)
    : memoryHistory.length > 0
      ? memoryHistory
      : await tasks.getTaskStore().loadEvents(taskId);

  const sentEventIds = new Set<string>();
  let lastSequence = 0;

  const pushEvent = (event: TaskEvent): void => {
    if (sentEventIds.has(event.id)) {
      return;
    }
    sentEventIds.add(event.id);
    res.write(formatSSE(event));
    const sequence = Number(event.data?.sequence ?? 0);
    if (sequence > lastSequence) {
      lastSequence = sequence;
    }
  };

  for (const event of history) {
    pushEvent(event);
  }

  const unsubscribe = tasks.getEventBus().subscribe(taskId, (event) => {
    pushEvent(event);
  });

  const pollInterval =
    tasks.getMode() === "brain"
      ? setInterval(async () => {
          await syncTaskFromStore(tasks, taskId);

          if (tasks.getTaskStore().isEnabled()) {
            const fresh = await tasks
              .getTaskStore()
              .loadEventsSince(taskId, lastSequence);
            for (const event of fresh) {
              pushEvent(event);
            }
          }

          if (tasks.executionWorkerUrl?.trim()) {
            const workerEvents = await fetchWorkerEventHistory(
              tasks.executionWorkerUrl,
              taskId,
            );
            for (const event of workerEvents) {
              pushEvent(event);
            }
          }
        }, 750)
      : undefined;

  // Keep under common proxy idle limits (often ~30–60s) so long agent runs
  // do not surface "Error in input stream" to the browser.
  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 10_000);

  req.on("close", () => {
    clearInterval(keepalive);
    if (pollInterval) clearInterval(pollInterval);
    unsubscribe();
  });
}
