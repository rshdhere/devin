import type { Task } from "@devin/types";
import { usesRuntimeAgent } from "@devin/types";

const ACTIVE_DEVBOX_STATUSES = new Set([
  "sandbox_starting",
  "runtime_ready",
  "running",
  "awaiting_review",
]);

/** Whether the web UI should expose Shell / Files / Browser for this task. */
export function canUseDevbox(task: Task): boolean {
  if (task.sessionActive || task.sessionSleeping) {
    return true;
  }

  if (task.status === "awaiting_review") {
    return true;
  }

  if (ACTIVE_DEVBOX_STATUSES.has(task.status) && usesRuntimeAgent(task.agent)) {
    return true;
  }

  return task.status === "completed" && usesRuntimeAgent(task.agent);
}

export function isDevboxLive(task: Task): boolean {
  return (
    canUseDevbox(task) &&
    !task.sessionSleeping &&
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled"
  );
}
