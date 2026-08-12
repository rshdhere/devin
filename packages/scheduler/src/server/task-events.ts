import { formatSSE } from "@devin/events";
import type { Request, Response } from "express";
import type { TaskService } from "../task/service.js";

export async function handleTaskEvents(
  tasks: TaskService,
  taskId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const task =
    tasks.getTask(taskId) ?? (await tasks.getTaskStore().getTask(taskId));
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

  for (const event of history) {
    res.write(formatSSE(event));
  }

  let lastSequence = history.reduce((max, event) => {
    const sequence = Number(event.data?.sequence ?? 0);
    return sequence > max ? sequence : max;
  }, 0);

  const unsubscribe = tasks.getEventBus().subscribe(taskId, (event) => {
    res.write(formatSSE(event));
    const sequence = Number(event.data?.sequence ?? 0);
    if (sequence > lastSequence) {
      lastSequence = sequence;
    }
  });

  const pollInterval =
    tasks.getMode() === "brain" && tasks.getTaskStore().isEnabled()
      ? setInterval(async () => {
          const fresh = await tasks
            .getTaskStore()
            .loadEventsSince(taskId, lastSequence);
          for (const event of fresh) {
            res.write(formatSSE(event));
            const sequence = Number(event.data?.sequence ?? 0);
            if (sequence > lastSequence) {
              lastSequence = sequence;
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
