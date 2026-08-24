import type { RunResponse } from "@devin/agent-sdk";
import { usesRuntimeAgent } from "../../agent/defaults.js";
import { persistTaskContextMemory } from "../../context/session-context.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { schedulePostCompletionDesktopCapture } from "./desktop-capture.js";
import {
  createTaskIssue,
  finalizeGitWork,
  gitRuntimeEnv,
  runTests,
} from "./git-operations.js";
import { persistSession } from "./persistence.js";
import { ensurePendingJob, ensureTaskLoaded } from "./resolve-task.js";
import { resolveRuntimeSession } from "./resolve-session-proxy.js";
import { emit, patchTask, updateTask } from "./task-state.js";
import type { ProcessJobState } from "./process-job/state.js";

export type AgentCompleteRequest = {
  status: "completed" | "failed";
  message: string;
  output?: string;
  requireReviewBeforePush?: boolean;
};

/**
 * Worker-side finalize after Brain harness finishes.
 * Rebuilds ProcessJobState from the live session and runs git/review/complete.
 */
export async function handleAgentComplete(
  svc: TaskService,
  taskId: string,
  body: AgentCompleteRequest,
): Promise<Task> {
  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    throw new Error("task not found");
  }

  if (body.status === "failed") {
    updateTask(svc, taskId, "failed", body.message || "Agent run failed");
    emit(svc, "task.failed", taskId, body.message || "Agent run failed");
    svc.processingTasks.delete(taskId);
    return task;
  }

  const session = await resolveRuntimeSession(svc, taskId);
  if (!session) {
    throw new Error("no devbox session for agent-complete");
  }

  const job =
    session.job ??
    (await ensurePendingJob(svc, taskId)) ??
    svc.pendingJobs.get(taskId);
  if (!job) {
    throw new Error("no job for agent-complete");
  }

  const state: ProcessJobState = {
    retainSandboxForPreview: false,
    pausedForReview: false,
    sandboxName: session.sandboxName,
    runtimeBaseUrl: session.runtimeBaseUrl,
    runtime: session.runtime,
    repoCwd: session.repoCwd,
    repository: session.job.repository ?? task.repository,
    cloneUrl: session.job.cloneUrl ?? job.cloneUrl,
    githubToken: session.githubToken ?? job.githubToken,
    createdNewRepo: session.createdNewRepo,
    guestHost: session.guestHost,
    repoHydratedLocally: false,
  };

  const runResult: RunResponse = {
    taskId,
    status: "completed",
    message: body.message,
    output: body.output,
    agent: "brain",
  };

  if (body.requireReviewBeforePush === true) {
    job.requireReviewBeforePush = true;
  }

  await finalizeAgentRun(svc, job, task, state, runResult);
  svc.processingTasks.delete(taskId);
  return task;
}

/** Shared post-harness finalize (standalone agent-phase + Brain agent-complete). */
export async function finalizeAgentRun(
  svc: TaskService,
  job: ScheduleJob,
  task: Task,
  state: ProcessJobState,
  runResult: RunResponse,
): Promise<void> {
  const runtimeAgentTask = usesRuntimeAgent(task.agent);

  if (
    runtimeAgentTask &&
    state.repository &&
    state.cloneUrl &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl &&
    job.requireReviewBeforePush === true
  ) {
    const diffStat = await state.runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: state.repoCwd,
      command: "git diff --stat && git diff --cached --stat",
      env: gitRuntimeEnv(svc, state.githubToken),
    });

    svc.reviewSessions.set(task.id, {
      runtime: state.runtime,
      sandboxName: state.sandboxName,
      runtimeBaseUrl: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
      job,
      githubToken: state.githubToken,
      createdNewRepo: state.createdNewRepo,
      guestHost: state.guestHost,
    });
    void persistSession(
      svc,
      task.id,
      svc.reviewSessions.get(task.id)!,
      "review",
    );

    state.pausedForReview = true;
    state.retainSandboxForPreview = true;
    task.sessionActive = true;
    updateTask(
      svc,
      task.id,
      "awaiting_review",
      "Review agent changes, then commit or open a PR",
    );
    emit(svc, "task.phase_changed", task.id, "Agent work ready for review", {
      phase: "awaiting_review",
      awaitingReview: true,
      diff: diffStat.stdout.trim() || undefined,
      agent: task.agent,
      sessionActive: true,
    });
    if (diffStat.stdout.trim()) {
      emit(svc, "git.commit", task.id, "Uncommitted agent changes in devbox", {
        auto: false,
        awaitingReview: true,
        diff: diffStat.stdout.trim(),
      });
    }
    return;
  }

  let pushedToGitHub = false;
  if (state.repository && state.cloneUrl && state.runtime) {
    if (job.testCommand) {
      await runTests(svc, state.runtime, task, job.testCommand, state.repoCwd);
    }

    if (job.permissions) {
      pushedToGitHub = await finalizeGitWork(
        svc,
        state.runtime,
        task,
        job,
        state.repoCwd,
        state.githubToken,
        {
          greenfield: state.createdNewRepo,
          createPullRequest:
            job.requireReviewBeforePush === true ||
            !(state.createdNewRepo && runtimeAgentTask),
        },
      );
    }

    if (
      job.issueTitle &&
      job.permissions?.canCreateIssue &&
      state.githubToken &&
      state.repository
    ) {
      await createTaskIssue(
        svc,
        task,
        state.repository,
        state.githubToken,
        job,
      );
    }
  }

  const completionMessage =
    state.repository && state.cloneUrl
      ? pushedToGitHub
        ? "Work completed — pushed to GitHub"
        : "Work completed — local commits not pushed to GitHub"
      : runResult.message || "Task completed";

  task.pushedToGitHub = pushedToGitHub;
  const sessionBeforeComplete =
    svc.activeSessions.get(task.id) ?? svc.reviewSessions.get(task.id);

  if (
    usesRuntimeAgent(task.agent) &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl
  ) {
    task.sessionActive = true;
    task.sessionSleeping = false;
    task.sandboxName = state.sandboxName;
  }
  updateTask(svc, task.id, "completed", completionMessage);
  emit(svc, "task.completed", task.id, completionMessage, {
    output: runResult.output,
    agent: runResult.agent ?? task.agent,
    prUrl: task.prUrl,
    branch: task.branch,
    pushedToGitHub,
    sessionActive: usesRuntimeAgent(task.agent),
  });
  void (async () => {
    const stored = await svc.taskStore.loadEvents(task.id);
    const events = stored.length > 0 ? stored : svc.getEventHistory(task.id);
    await persistTaskContextMemory(task, events, completionMessage);
  })();

  if (
    usesRuntimeAgent(task.agent) &&
    state.runtime &&
    state.sandboxName &&
    state.runtimeBaseUrl
  ) {
    svc.activeSessions.set(task.id, {
      runtime: state.runtime,
      sandboxName: state.sandboxName,
      runtimeBaseUrl: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
      job,
      githubToken: state.githubToken,
      createdNewRepo: state.createdNewRepo,
      guestHost: state.guestHost,
      devboxPreviewPort: sessionBeforeComplete?.devboxPreviewPort,
      lastDesktopScreenshot: sessionBeforeComplete?.lastDesktopScreenshot,
    });
    await persistSession(
      svc,
      task.id,
      svc.activeSessions.get(task.id)!,
      "active",
    );
    await svc.taskStore.touchSession(task.id);
    task.sessionActive = true;
    patchTask(svc, task.id, { sessionActive: true });
    state.retainSandboxForPreview = true;

    if (pushedToGitHub) {
      const shotSession = svc.activeSessions.get(task.id)!;
      schedulePostCompletionDesktopCapture(
        svc,
        shotSession,
        task,
        state.repoCwd,
        runtimeAgentTask,
      );
    }
  } else if (sessionBeforeComplete && pushedToGitHub) {
    schedulePostCompletionDesktopCapture(
      svc,
      sessionBeforeComplete,
      task,
      state.repoCwd,
      runtimeAgentTask,
    );
  }
}
