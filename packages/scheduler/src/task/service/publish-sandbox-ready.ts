import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { persistSession } from "./persistence.js";
import { emit, patchTask, updateTask } from "./task-state.js";
import { startDevboxPreviewWatcher } from "./desktop-capture.js";
import type { ProcessJobState } from "./process-job/state.js";

export type SandboxReadyPayload = {
  taskId: string;
  sandboxName: string;
  repoCwd: string;
  createdNewRepo: boolean;
  repository?: string;
  previewPort?: number;
  resumeSession?: boolean;
};

/** Resolve Brain callback base URL for worker → brain sandbox-ready pushes. */
export function resolveBrainInternalUrl(): string | undefined {
  const raw =
    process.env.BRAIN_INTERNAL_URL?.trim() ||
    process.env.BRAIN_URL?.trim() ||
    process.env.SCHEDULER_BRAIN_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : undefined;
}

/**
 * Persist the live Devbox session after sandbox setup and notify Brain so it
 * can run the harness. Does not expose guest CNI addresses to Brain.
 */
export async function publishSandboxReady(
  svc: TaskService,
  job: ScheduleJob,
  task: Task,
  state: ProcessJobState,
): Promise<void> {
  if (!state.runtime || !state.runtimeBaseUrl || !state.sandboxName) {
    throw new Error("devbox session is not available before sandbox-ready");
  }

  svc.activeSessions.set(task.id, {
    runtime: state.runtime,
    sandboxName: state.sandboxName,
    runtimeBaseUrl: state.runtimeBaseUrl,
    repoCwd: state.repoCwd,
    job,
    githubToken: state.githubToken,
    createdNewRepo: state.createdNewRepo,
    guestHost: state.guestHost,
  });
  await persistSession(
    svc,
    task.id,
    svc.activeSessions.get(task.id)!,
    "active",
  );
  task.sessionActive = true;
  task.sessionSleeping = false;
  task.sandboxName = state.sandboxName;
  patchTask(svc, task.id, {
    sessionActive: true,
    sandboxName: state.sandboxName,
  });

  updateTask(
    svc,
    task.id,
    "runtime_ready",
    job.resumeSession
      ? "Devbox ready for follow-up — Brain harness starting"
      : "Devbox ready — Brain harness starting",
  );
  emit(svc, "runtime.ready", task.id, "Runtime supervisor is ready", {
    sandboxName: state.sandboxName,
    repoCwd: state.repoCwd,
    brainOwnsHarness: true,
  });
  emit(svc, "task.phase_changed", task.id, "Devbox ready for Brain harness", {
    phase: "runtime_ready",
    sessionActive: true,
    sandboxName: state.sandboxName,
  });

  startDevboxPreviewWatcher(svc, task.id);

  const payload: SandboxReadyPayload = {
    taskId: task.id,
    sandboxName: state.sandboxName,
    repoCwd: state.repoCwd,
    createdNewRepo: state.createdNewRepo,
    repository: state.repository ?? task.repository,
    resumeSession: job.resumeSession === true,
  };

  const brainUrl = resolveBrainInternalUrl();
  if (!brainUrl) {
    emit(
      svc,
      "agent.log",
      task.id,
      "BRAIN_INTERNAL_URL unset — Brain must poll runtime_ready to start harness",
      { sandboxReady: true },
    );
    return;
  }

  try {
    const response = await fetch(
      `${brainUrl}/internal/v1/tasks/${encodeURIComponent(task.id)}/sandbox-ready`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Brain sandbox-ready rejected HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    emit(svc, "agent.log", task.id, "Notified Brain that Devbox is ready", {
      brainUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Brain sandbox-ready failed";
    emit(svc, "agent.log", task.id, `sandbox-ready notify failed: ${message}`, {
      brainUrl,
    });
    // Session stays live; Brain recovery / poll can still start the harness.
  }
}
