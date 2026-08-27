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
import { ensurePendingJob, ensureTaskLoaded } from "./resolve-task.js";
import { emit, patchTask, updateTask } from "./task-state.js";
import {
  buildDurableSessionContext,
  isSessionWithinRetention,
  persistTaskContextMemory,
  resolveSessionRetentionMs,
} from "../../context/session-context.js";
import { isHydraDbEnabled } from "../../context/hydradb.js";
import { resolveAgentMaxWaitMs } from "./config.js";

/** Grace period past agent max-wait before reclaiming an orphaned running task. */
export const ORPHAN_RUNNING_BUFFER_MS = 5 * 60 * 1000;

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
  if (svc.processingTasks.has(taskId)) {
    throw new Error("agent is already working on this session");
  }
  if (
    svc.pendingJobs.get(taskId)?.resumeSession === true &&
    (task.status === "queued" ||
      task.status === "scheduling" ||
      task.status === "sandbox_starting" ||
      task.status === "runtime_ready" ||
      task.status === "running")
  ) {
    throw new Error("a follow-up is already queued for this session");
  }

  let session =
    svc.activeSessions.get(taskId) ?? svc.reviewSessions.get(taskId);
  let persisted = await svc.taskStore.getSession(taskId);
  let workerRehydrated = false;

  const retentionAnchor =
    persisted?.lastActiveAt ?? task.updatedAt ?? task.createdAt;
  if (!isSessionWithinRetention(retentionAnchor)) {
    throw new Error(
      "This session is older than the retention window (default 30 days). Start a new session.",
    );
  }

  if (!session && task.sessionSleeping) {
    if (svc.mode === "brain") {
      try {
        await delegateRequestToWorker(
          svc,
          `/api/v1/tasks/${encodeURIComponent(taskId)}/wake`,
          { method: "POST" },
        );
      } catch {
        // Wake may fail when the sandbox CR is gone — recoverSession handles that.
      }
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
    workerRehydrated = (await requestWorkerRehydrate(svc, taskId)).ok;
    persisted = await svc.taskStore.getSession(taskId);
  }

  const jobBase =
    session?.job ?? persisted?.job ?? (await ensurePendingJob(svc, taskId));
  const runtimeBaseUrl = (
    session?.runtimeBaseUrl ?? persisted?.runtimeBaseUrl
  )?.trim();
  const sandboxName = (session?.sandboxName ?? persisted?.sandboxName)?.trim();

  if (!jobBase) {
    throw new Error("no active devbox session for this task");
  }
  const recoverSession =
    !runtimeBaseUrl ||
    !sandboxName ||
    /Devbox ended — send a follow-up/i.test(task.message ?? "") ||
    (svc.mode === "brain" && !session && !workerRehydrated);
  if (recoverSession && (!jobBase.repository || !jobBase.cloneUrl)) {
    throw new Error(
      "devbox is missing and the repository metadata required to restore it is unavailable",
    );
  }

  // Keep job.prompt as the raw user text so chat/events stay clean. Follow-up
  // framing for the agent is applied later in buildAgentPrompt(resumeSession).
  const storedEvents = await svc.taskStore.loadEvents(taskId);
  const sessionEvents =
    storedEvents.length > 0 ? storedEvents : svc.getEventHistory(taskId);
  const sessionContext = await buildDurableSessionContext({
    task,
    events: sessionEvents,
    followUpPrompt: trimmed,
  });
  if (!isHydraDbEnabled()) {
    emit(
      svc,
      "agent.log",
      taskId,
      "HydraDB context disabled — Brain missing HYDRADB_API_KEY / HYDRADB_DATABASE",
      { hydradb: false },
    );
  }
  void persistTaskContextMemory(
    task,
    sessionEvents,
    `Follow-up queued: ${trimmed.slice(0, 240)}`,
  );
  const followUpJob: ScheduleJob = {
    ...jobBase,
    prompt: trimmed,
    taskId,
    skipDraft: true,
    resumeSession: true,
    sessionContext,
    recoverSession,
    runtimeBaseUrl: recoverSession ? undefined : runtimeBaseUrl,
    sandboxName: recoverSession ? undefined : sandboxName,
    agentModel: agentModel?.trim() || jobBase.agentModel,
    enqueuedAt: new Date().toISOString(),
  };

  task.sessionSleeping = false;
  task.sessionActive = true;
  svc.pendingJobs.set(taskId, followUpJob);
  updateTask(
    svc,
    taskId,
    "queued",
    recoverSession
      ? "Devbox missing — queued repository restoration"
      : "Follow-up queued for devbox session",
  );
  emit(svc, "task.scheduled", taskId, "Follow-up prompt queued", {
    followUp: true,
    recoverSession,
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
  if (!persisted.sandboxName.trim() || !persisted.runtimeBaseUrl.trim()) {
    return undefined;
  }

  try {
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
    session.lastDesktopScreenshot = await loadCachedDesktopSnapshot(
      svc,
      taskId,
    );

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
  } catch {
    emit(
      svc,
      "agent.log",
      taskId,
      "Failed to wake sleeping devbox — send a follow-up to restore from repository",
      {
        sandboxName: persisted.sandboxName,
        wakeFailed: true,
      },
    );
    // Drop the dead binding so continueTask / Interactive can recoverSession.
    try {
      await svc.taskStore.detachSessionSandbox(taskId);
      const task = svc.tasks.get(taskId);
      if (task) {
        task.sessionActive = false;
        task.sessionSleeping = false;
        task.sandboxName = undefined;
        await svc.taskStore.upsertTask(task);
      }
    } catch {
      // best-effort
    }
    return undefined;
  }
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

    task.pushedToGitHub = pushedToGitHub;
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
  await reapOrphanRunningTasks(svc);

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

  try {
    const expired = await svc.taskStore.deleteExpiredSessions(
      resolveSessionRetentionMs(),
    );
    for (const row of expired) {
      svc.activeSessions.delete(row.taskId);
      svc.reviewSessions.delete(row.taskId);
      const task = svc.tasks.get(row.taskId);
      if (task) {
        task.sessionActive = false;
        task.sessionSleeping = false;
        task.sandboxName = undefined;
        void svc.taskStore.upsertTask(task);
      }
      if (row.sandboxName.trim()) {
        void deleteSandbox(svc, row.sandboxName);
      }
    }
  } catch {
    // Retention prune is best-effort.
  }
}

/**
 * Reclaim tasks left in `running` after a worker crash or lost runAndWait.
 * Live workers keep the task in processingTasks; those are left alone.
 */
export async function reapOrphanRunningTasks(
  svc: TaskService,
): Promise<number> {
  const maxAgeMs = resolveAgentMaxWaitMs() + ORPHAN_RUNNING_BUFFER_MS;
  const now = Date.now();
  let reaped = 0;

  for (const task of svc.tasks.values()) {
    if (task.status !== "running") {
      continue;
    }
    if (svc.processingTasks.has(task.id)) {
      continue;
    }

    const updated = Date.parse(task.updatedAt);
    if (!Number.isFinite(updated) || now - updated < maxAgeMs) {
      continue;
    }

    const ageMin = Math.round((now - updated) / 60_000);
    const message =
      `Agent run orphaned after ${ageMin}m with no active worker — ` +
      "likely a hung smoke curl/start or crashed control plane. Send a follow-up to continue.";

    const session =
      svc.activeSessions.get(task.id) ?? svc.reviewSessions.get(task.id);
    if (session?.runtime) {
      try {
        await session.runtime.cancelRun(task.id, message);
      } catch {
        // Best-effort cancel in the guest.
      }
    }

    updateTask(svc, task.id, "failed", message);
    svc.processingTasks.delete(task.id);
    emit(svc, "task.failed", task.id, message, {
      orphanRunning: true,
      ageMinutes: ageMin,
    });
    reaped += 1;
  }

  return reaped;
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
