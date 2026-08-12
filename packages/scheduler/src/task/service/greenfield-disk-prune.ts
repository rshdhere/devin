import type { RuntimeClient } from "@devin/agent-sdk";
import { buildPruneWorkspaceDiskScript } from "../../devbox/preview.js";
import type { TaskService } from "./task-service.js";

export function startWorkspaceDiskPruneWatcher(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) {
      return;
    }
    if (!svc.activeSessions.has(taskId)) {
      return;
    }
    await runtime.terminalAllowFailure({
      taskId,
      command: buildPruneWorkspaceDiskScript(),
    });
  };

  const interval = setInterval(() => {
    void tick();
  }, 45_000);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
