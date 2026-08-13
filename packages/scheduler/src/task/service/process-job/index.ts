import type { ScheduleJob } from "../types.js";
import type { TaskService } from "../task-service.js";
import { hydrateTaskRuntime } from "../config.js";
import { deleteSandbox } from "../sandbox-lifecycle.js";
import { emergencyPushAgentWork } from "../greenfield-provision-2.js";
import { isGuestFilesystemCorrupt } from "../guest-fs-corrupt.js";
import { emit, updateTask } from "../task-state.js";
import { runAgentPhase } from "./agent-phase.js";
import { runSandboxSetupPhase } from "./sandbox-phase.js";
import type { ProcessJobState } from "./state.js";

export async function processJob(
  svc: TaskService,
  job: ScheduleJob,
): Promise<void> {
  let task = svc.tasks.get(job.taskId);
  if (!task) {
    task = await svc.taskStore.getTask(job.taskId);
    if (task) {
      svc.tasks.set(job.taskId, task);
    }
  }
  if (!task) {
    return;
  }
  task = hydrateTaskRuntime(task);
  if (job.runtime) {
    task.runtime = job.runtime;
    svc.tasks.set(task.id, task);
  }

  if (
    (task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled") &&
    !job.resumeSession
  ) {
    return;
  }

  if (task.status === "awaiting_review" && !job.resumeSession) {
    return;
  }

  if (task.status === "running") {
    return;
  }

  if (svc.processingTasks.has(job.taskId) && !job.resumeSession) {
    return;
  }

  if (task.status === "draft_ready" && !job.skipDraft) {
    return;
  }

  if (
    !job.skipDraft &&
    (task.status === "sandbox_starting" || task.status === "runtime_ready")
  ) {
    return;
  }

  svc.processingTasks.add(job.taskId);

  const state: ProcessJobState = {
    retainSandboxForPreview: false,
    pausedForReview: false,
    repoCwd: "repo",
    createdNewRepo: false,
    repoHydratedLocally: false,
  };

  try {
    await runSandboxSetupPhase(svc, job, task, state);
    await runAgentPhase(svc, job, task, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task failed";

    if (
      !job.forceSandboxRecreate &&
      isGuestFilesystemCorrupt(message) &&
      state.sandboxName
    ) {
      emit(
        svc,
        "agent.log",
        task.id,
        "Guest filesystem corrupt — deleting devbox and retrying once with a fresh microVM",
        { sandboxName: state.sandboxName },
      );
      await deleteSandbox(svc, state.sandboxName);
      state.sandboxName = undefined;
      state.runtime = undefined;
      state.runtimeBaseUrl = undefined;
      state.guestHost = undefined;
      svc.activeSessions.delete(task.id);
      updateTask(
        svc,
        task.id,
        "sandbox_starting",
        "Recreating devbox after guest filesystem error",
      );
      const retryJob: ScheduleJob = {
        ...job,
        forceSandboxRecreate: true,
        enqueuedAt: new Date().toISOString(),
      };
      state.retainSandboxForPreview = true;
      svc.processingTasks.delete(job.taskId);
      return processJob(svc, retryJob);
    }

    if (
      state.repository &&
      state.cloneUrl &&
      job.permissions?.canPush &&
      state.runtime
    ) {
      try {
        await emergencyPushAgentWork(
          svc,
          state.runtime,
          task,
          job,
          state.repoCwd,
          state.githubToken,
          { greenfield: state.createdNewRepo },
        );
      } catch {
        // Best-effort recovery push; original failure still wins.
      }
    }
    if (task.status === "drafting" || task.status === "draft_ready") {
      emit(svc, "draft.failed", task.id, message, {
        phase: "drafting",
        source: "scheduler",
        error: message,
      });
    }
    updateTask(svc, task.id, "failed", message);
    task.sessionActive = false;
    svc.activeSessions.delete(task.id);
    svc.reviewSessions.delete(task.id);
    void svc.taskStore.deleteSession(task.id);
    emit(svc, "task.failed", task.id, message);
    throw error;
  } finally {
    svc.processingTasks.delete(job.taskId);
    if (
      state.sandboxName &&
      !state.retainSandboxForPreview &&
      !state.pausedForReview &&
      !svc.activeSessions.has(job.taskId) &&
      !svc.reviewSessions.has(job.taskId)
    ) {
      await deleteSandbox(svc, state.sandboxName);
    }
  }
}
