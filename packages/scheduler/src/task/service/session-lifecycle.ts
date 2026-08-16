import { RuntimeClient } from "@devin/agent-sdk";
import type { ScheduleJob, Task } from "../types.js";
import type { PersistedSession } from "../store.js";
import type { TaskService } from "./task-service.js";
import type { ReviewSession } from "./types.js";
import { loadCachedDesktopSnapshot } from "./desktop-capture.js";
import {
  createTaskIssue,
  finalizeGitWork,
  runTests,
} from "./git-operations.js";
import { persistSession } from "./persistence.js";
import {
  deleteSandbox,
  resolveRuntimeUrl,
  suspendSandbox,
  waitForRuntime,
  wakeSandbox,
} from "./sandbox-lifecycle.js";
import { requestWorkerRehydrate } from "./resolve-session-proxy.js";
import { ensureTaskLoaded } from "./resolve-task.js";
import { emit, patchTask, updateTask } from "./task-state.js";

export async function continueTask(
  svc: TaskService,
  taskId: string,
  prompt: string,
  agentModel?: string,
): Promise<Task> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("prompt is required");
  }

  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    throw new Error("task not found");
  }

  let session =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  let persisted = await svc.taskStore.getSession(taskId);

  if (!session && task.sessionSleeping) {
    if (svc.mode === "brain") {
      await delegateRequestToWorker(
        svc,
        `/api/v1/tasks/${encodeURIComponent(taskId)}/wake`,
        { method: "POST" },
      );
      const refreshed = await svc.taskStore.getTask(taskId);
      if (refreshed) {
        svc.tasks.set(taskId, refreshed);
      }
      persisted = await svc.taskStore.getSession(taskId);
    } else {
      session = await wakeSession(svc, taskId);
      persisted = await svc.taskStore.getSession(taskId);
    }
  }

  if (
    !session &&
    persisted &&
    (persisted.state === "active" || persisted.state === "review") &&
    svc.mode !== "brain"
  ) {
    session = await hydrateSessionFromStore(svc, taskId, persisted);
  }

  if (!session && svc.mode === "brain") {
    await requestWorkerRehydrate(svc, taskId);
    persisted = await svc.taskStore.getSession(taskId);
  }

  const jobBase = session?.job ?? persisted?.job;
  const runtimeBaseUrl = session?.runtimeBaseUrl ?? persisted?.runtimeBaseUrl;
  const sandboxName = session?.sandboxName ?? persisted?.sandboxName;

  if (!jobBase || !runtimeBaseUrl || !sandboxName) {
    throw new Error("no active devbox session for this task");
  }

  // Keep job.prompt as the raw user text so chat/events stay clean. Follow-up
  // framing for the agent is applied later in buildAgentPrompt(resumeSession).
  const followUpJob: ScheduleJob = {
    ...jobBase,
    prompt: trimmed,
    taskId,
    skipDraft: true,
    resumeSession: true,
    runtimeBaseUrl,
    sandboxName,
    agentModel: agentModel?.trim() || jobBase.agentModel,
    enqueuedAt: new Date().toISOString(),
  };

  task.sessionSleeping = false;
  task.sessionActive = true;
  svc.pendingJobs.set(taskId, followUpJob);
  updateTask(svc, taskId, "queued", "Follow-up queued for devbox session");
  emit(svc, "task.scheduled", taskId, "Follow-up prompt queued", {
    followUp: true,
    prompt: trimmed,
    sessionActive: true,
  });

  if (svc.mode === "brain") {
    await delegateJobToWorker(svc, followUpJob);
  } else {
    await svc.queue.enqueue(followUpJob);
  }
  return task;
}

export async function hydrateSessionFromStore(
  svc: TaskService,
  taskId: string,
  persisted: PersistedSession,
): Promise<ReviewSession> {
  const runtime = new RuntimeClient(persisted.runtimeBaseUrl);
  const session: ReviewSession = {
    runtime,
    sandboxName: persisted.sandboxName,
    runtimeBaseUrl: persisted.runtimeBaseUrl,
    repoCwd: persisted.repoCwd,
    job: persisted.job,
    githubToken: persisted.githubToken,
    createdNewRepo: persisted.createdNewRepo,
    guestHost: persisted.guestHost,
    devboxPreviewPort: persisted.previewPort,
  };
  session.lastDesktopScreenshot = await loadCachedDesktopSnapshot(svc, taskId);

  if (persisted.state === "review") {
    svc.reviewSessions.set(taskId, session);
  } else {
    svc.activeSessions.set(taskId, session);
  }
  return session;
}

export async function wakeSession(
  svc: TaskService,
  taskId: string,
): Promise<ReviewSession | undefined> {
  if (svc.mode === "brain") {
    await delegateRequestToWorker(
      svc,
      `/api/v1/tasks/${encodeURIComponent(taskId)}/wake`,
      { method: "POST" },
    );
    const task = await svc.taskStore.getTask(taskId);
    if (task) {
      svc.tasks.set(taskId, task);
    }
    return undefined;
  }

  const persisted = await svc.taskStore.getSession(taskId);
  if (!persisted || persisted.state !== "sleeping") {
    return undefined;
  }

  await wakeSandbox(svc, persisted.sandboxName);
  const runtimeBaseUrl = await resolveRuntimeUrl(svc, persisted.sandboxName);
  const runtime = new RuntimeClient(runtimeBaseUrl);
  await waitForRuntime(svc, runtime, taskId, runtimeBaseUrl);

  const session: ReviewSession = {
    runtime,
    sandboxName: persisted.sandboxName,
    runtimeBaseUrl,
    repoCwd: persisted.repoCwd,
    job: persisted.job,
    githubToken: persisted.githubToken,
    createdNewRepo: persisted.createdNewRepo,
    guestHost: persisted.guestHost,
    devboxPreviewPort: persisted.previewPort,
  };
  session.lastDesktopScreenshot = await loadCachedDesktopSnapshot(svc, taskId);

  svc.activeSessions.set(taskId, session);
  const task = svc.tasks.get(taskId);
  if (task) {
    task.sessionActive = true;
    task.sessionSleeping = false;
    task.sandboxName = persisted.sandboxName;
    await svc.taskStore.upsertTask(task);
  }

  await persistSession(svc, taskId, session, "active");
  await svc.taskStore.touchSession(taskId);
  emit(
    svc,
    "task.phase_changed",
    taskId,
    "Devbox session woke from idle sleep",
    {
      phase: "running",
      sessionActive: true,
      sandboxName: persisted.sandboxName,
    },
  );

  return session;
}

export async function terminateSession(
  svc: TaskService,
  taskId: string,
): Promise<Task> {
  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    throw new Error("task not found");
  }

  const session =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  const sandboxName =
    session?.sandboxName ?? task.sandboxName ?? `sbx-${taskId.slice(0, 8)}`;

  if (sandboxName) {
    await deleteSandbox(svc, sandboxName);
  }
  if (session) {
    svc.activeSessions.delete(taskId);
    svc.reviewSessions.delete(taskId);
    await svc.taskStore.deleteSession(taskId);
  }

  task.sessionActive = false;
  task.sessionSleeping = false;
  if (task.status === "awaiting_review") {
    updateTask(
      svc,
      taskId,
      "cancelled",
      "Session ended — sandbox terminated without push",
    );
    emit(svc, "task.phase_changed", taskId, "Devbox session terminated", {
      phase: "terminated",
      sessionActive: false,
    });
  } else if (task.status !== "completed" && task.status !== "failed") {
    patchTask(svc, taskId, {});
    updateTask(svc, taskId, task.status, "Devbox session terminated");
  } else {
    updateTask(svc, taskId, task.status, "Devbox session terminated");
  }

  return task;
}

export async function finalizeReviewedTask(
  svc: TaskService,
  taskId: string,
  opts: { createPullRequest: boolean },
): Promise<Task> {
  const task = svc.tasks.get(taskId);
  const session = svc.reviewSessions.get(taskId);
  if (!task || !session) {
    throw new Error("task is not awaiting review");
  }
  if (task.status !== "awaiting_review") {
    throw new Error("task is not awaiting review");
  }

  const { runtime, sandboxName, repoCwd, job, githubToken, createdNewRepo } =
    session;

  try {
    if (job.testCommand) {
      await runTests(svc, runtime, task, job.testCommand, repoCwd);
    }

    let pushedToGitHub = false;
    if (job.permissions && job.repository) {
      pushedToGitHub = await finalizeGitWork(
        svc,
        runtime,
        task,
        job,
        repoCwd,
        githubToken,
        {
          greenfield: createdNewRepo,
          createPullRequest: opts.createPullRequest,
        },
      );
    }

    if (
      job.issueTitle &&
      job.permissions?.canCreateIssue &&
      githubToken &&
      job.repository
    ) {
      await createTaskIssue(svc, task, job.repository, githubToken, job);
    }

    const completionMessage = !pushedToGitHub
      ? "Changes ready — push to GitHub failed"
      : opts.createPullRequest
        ? task.prUrl
          ? "Changes pushed and pull request opened"
          : "Changes pushed to GitHub"
        : "Changes committed and pushed to GitHub";

    updateTask(svc, task.id, "completed", completionMessage);
    emit(svc, "task.completed", task.id, completionMessage, {
      agent: task.agent,
      prUrl: task.prUrl,
      branch: task.branch,
      pushedToGitHub,
      userApproved: true,
      createPullRequest: opts.createPullRequest,
    });
  } finally {
    svc.reviewSessions.delete(taskId);
    svc.activeSessions.delete(taskId);
    await svc.taskStore.deleteSession(taskId);
    await deleteSandbox(svc, sandboxName);
    task.sessionActive = false;
    task.sessionSleeping = false;
    void svc.taskStore.upsertTask(task);
  }

  return task;
}

export function startIdleWatchdog(svc: TaskService): void {
  if (svc.idleWatchdog || svc.mode === "brain") {
    return;
  }

  svc.idleWatchdog = setInterval(() => {
    void runIdleWatchdog(svc);
  }, 60_000);
}

export async function runIdleWatchdog(svc: TaskService): Promise<void> {
  const cutoff = Date.now() - svc.idleTimeoutMs;
  for (const [taskId, session] of svc.activeSessions) {
    const persisted = await svc.taskStore.getSession(taskId);
    const lastActive = persisted
      ? new Date(persisted.lastActiveAt).getTime()
      : Date.now();
    if (lastActive >= cutoff) {
      continue;
    }
    await sleepIdleSession(svc, taskId, session);
  }
}

export async function sleepIdleSession(
  svc: TaskService,
  taskId: string,
  session: ReviewSession,
): Promise<void> {
  if (svc.processingTasks.has(taskId)) {
    return;
  }

  await suspendSandbox(svc, session.sandboxName);
  svc.activeSessions.delete(taskId);
  await svc.taskStore.markSessionSleeping(taskId);

  const task = svc.tasks.get(taskId);
  if (task) {
    task.sessionActive = false;
    task.sessionSleeping = true;
    await svc.taskStore.upsertTask(task);
  }

  emit(svc, "task.phase_changed", taskId, "Devbox idle — session sleeping", {
    phase: "sleeping",
    sessionActive: false,
    sessionSleeping: true,
    sandboxName: session.sandboxName,
  });
}

export const WORKER_DELEGATE_TIMEOUT_MS = 30_000;
export const WORKER_DELEGATE_PREVIEW_TIMEOUT_MS = 180_000;
export const WORKER_DELEGATE_SCREENSHOT_TIMEOUT_MS = 180_000;
export const WORKER_DELEGATE_REHYDRATE_TIMEOUT_MS = 60_000;

export type WorkerDelegateOptions = {
  timeoutMs?: number;
};

export function isWorkerDelegateTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function delegateJobToWorker(
  svc: TaskService,
  job: ScheduleJob,
): Promise<void> {
  if (!svc.executionWorkerUrl) {
    throw new Error("EXECUTION_WORKER_URL is required when SERVICE_MODE=brain");
  }

  const response = await fetch(
    `${svc.executionWorkerUrl.replace(/\/$/, "")}/internal/v1/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(WORKER_DELEGATE_TIMEOUT_MS),
    },
  ).catch((error: unknown) => {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `Execution worker timed out after ${WORKER_DELEGATE_TIMEOUT_MS}ms at ${svc.executionWorkerUrl} — check EXECUTION_WORKER_URL and worker NLB health`,
      );
    }
    throw error;
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      body.error ?? `worker rejected job: HTTP ${response.status}`,
    );
  }
}

export async function delegateRequestToWorker(
  svc: TaskService,
  path: string,
  init?: RequestInit,
  options?: WorkerDelegateOptions,
): Promise<Response> {
  if (!svc.executionWorkerUrl) {
    throw new Error("EXECUTION_WORKER_URL is required when SERVICE_MODE=brain");
  }
  const timeoutMs = options?.timeoutMs ?? WORKER_DELEGATE_TIMEOUT_MS;
  const signal =
    init?.signal ??
    (typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : undefined);
  return fetch(`${svc.executionWorkerUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    signal,
  });
}
