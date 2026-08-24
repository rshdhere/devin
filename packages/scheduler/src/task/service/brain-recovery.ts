import type { Task } from "../types.js";
import { delegateJobToWorker } from "./session-lifecycle.js";
import { ensurePendingJob } from "./resolve-task.js";
import { syncTaskFromWorker } from "./sync-task-from-worker.js";
import { runBrainHarnessOnBrain } from "./brain-harness-runner.js";
import type { TaskService } from "./task-service.js";
import { emit, updateTask } from "./task-state.js";

const STUCK_QUEUED_GRACE_MS = 45_000;

function isStuckDelegatableStatus(status: Task["status"]): boolean {
  return status === "queued" || status === "scheduling";
}

/** Re-send jobs that stayed queued after brain/worker restarts or failed delegation. */
export async function recoverStuckQueuedTasks(svc: TaskService): Promise<void> {
  if (svc.mode !== "brain" || !svc.executionWorkerUrl) {
    return;
  }

  const cutoff = Date.now() - STUCK_QUEUED_GRACE_MS;
  for (const task of svc.tasks.values()) {
    if (task.status === "runtime_ready" && task.agent === "brain") {
      void runBrainHarnessOnBrain(svc, task.id).catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : "Brain harness recovery failed";
        console.error(`[brain-recovery] ${task.id}: ${message}`);
      });
      continue;
    }

    if (!isStuckDelegatableStatus(task.status)) {
      continue;
    }
    if (new Date(task.updatedAt).getTime() > cutoff) {
      continue;
    }

    const job = await ensurePendingJob(svc, task.id);
    if (!job) {
      continue;
    }

    const synced = await syncTaskFromWorker(svc, task.id);
    if (synced && !isStuckDelegatableStatus(synced.status)) {
      if (synced.status === "runtime_ready" && synced.agent === "brain") {
        void runBrainHarnessOnBrain(svc, synced.id).catch(() => undefined);
      }
      continue;
    }

    try {
      await delegateJobToWorker(svc, job);
      emit(
        svc,
        "task.scheduled",
        task.id,
        "Re-delegated task to execution worker",
        {
          redelivered: true,
        },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to delegate task to execution worker";
      updateTask(svc, task.id, "failed", message);
      emit(svc, "task.failed", task.id, message);
    }
  }
}
