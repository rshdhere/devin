import { EventBus } from "@devin/events";
import { createQueue, type TaskQueue } from "@devin/queue";
import { resolveRuntimeForTask } from "@devin/types";
import { resolveDefaultAgent } from "../../agent/defaults.js";
import {
  collectInfraDiagnostics,
  fetchSandboxByName,
  type InfraDiagnostics,
  type TaskDiagnostics,
} from "../../diagnostics/collect.js";
import { resolvePreferredHost } from "../../host/preferred-host.js";
import type {
  CreateTaskInput,
  ScheduleJob,
  ServiceMode,
  Task,
} from "../types.js";
import { TaskStore } from "../store.js";
import {
  proxyDevboxPreview as proxyDevboxPreviewImpl,
  fetchDesktopScreenshot as fetchDesktopScreenshotImpl,
} from "./desktop-capture.js";
import {
  ensureDesktopComputer as ensureDesktopComputerImpl,
  proxyDesktopVNCPageHttp as proxyDesktopVNCPageHttpImpl,
} from "./desktop-computer.js";
import { processJob as processJobImpl } from "./process-job/index.js";
import {
  restoreFromStore,
  persistSession as persistSessionImpl,
} from "./persistence.js";
import {
  continueTask as continueTaskImpl,
  wakeSession as wakeSessionImpl,
  terminateSession as terminateSessionImpl,
  finalizeReviewedTask as finalizeReviewedTaskImpl,
  startIdleWatchdog as startIdleWatchdogImpl,
  delegateJobToWorker as delegateJobToWorkerImpl,
  delegateRequestToWorker as delegateRequestToWorkerImpl,
} from "./session-lifecycle.js";
import {
  emit as emitImpl,
  emitRuntime as emitRuntimeImpl,
  updateTask as updateTaskImpl,
  patchTask as patchTaskImpl,
  nextEventSequence as nextEventSequenceImpl,
} from "./task-state.js";
import {
  hydrateTaskRuntime,
  resolveServiceMode,
  resolveTimeoutMs,
} from "./config.js";
import {
  ensurePendingJob,
  ensureTaskLoaded,
  materializeTaskFromJob,
  syncTaskFromStore,
} from "./resolve-task.js";
import { recoverStuckQueuedTasks } from "./brain-recovery.js";
import {
  resolveRuntimeSession,
  brainDelegateOrRuntime,
} from "./resolve-session-proxy.js";
import { hydrateSessionFromOrchestrator } from "./orchestrator-session.js";
import { syncTaskFromWorker as syncTaskFromWorkerImpl } from "./sync-task-from-worker.js";
import type {
  ReviewSession,
  TaskServiceHost,
  TaskServiceOptions,
} from "./types.js";
import type { TaskEventType } from "@devin/events";
import type { IncomingMessage, ServerResponse } from "node:http";

export class TaskService implements TaskServiceHost {
  readonly tasks = new Map<string, Task>();
  readonly pendingJobs = new Map<string, ScheduleJob>();
  readonly activeSessions = new Map<string, ReviewSession>();
  readonly reviewSessions = new Map<string, ReviewSession>();
  readonly eventSequences = new Map<string, number>();
  readonly eventBus: EventBus;
  readonly queue: TaskQueue<ScheduleJob>;
  readonly orchestratorUrl: string;
  readonly runtimeUrl: string;
  readonly firecrackerHostUrl?: string;
  readonly preferredHost?: string;
  readonly defaultAgent: TaskServiceOptions["defaultAgent"] & {};
  readonly sandboxReadyTimeoutMs: number;
  readonly runtimeReadyTimeoutMs: number;
  readonly taskStore: TaskStore;
  readonly mode: ServiceMode;
  readonly executionWorkerUrl?: string;
  readonly idleTimeoutMs: number;
  idleWatchdog?: ReturnType<typeof setInterval>;
  workerStarted = false;
  readonly processingTasks = new Set<string>();
  restored = false;
  readonly snapshotSpinCooldownMs = 45_000;
  readonly lastSnapshotSpinAt = new Map<string, number>();
  readonly lastSnapshotTriggerAt = new Map<string, number>();
  readonly desktopCaptureInFlight = new Map<
    string,
    Promise<Buffer | undefined>
  >();

  constructor(options: TaskServiceOptions) {
    this.orchestratorUrl = options.orchestratorUrl.replace(/\/$/, "");
    this.runtimeUrl = options.runtimeUrl.replace(/\/$/, "");
    this.firecrackerHostUrl =
      options.firecrackerHostUrl?.trim() ||
      process.env.FIRECRACKER_HOST_URL?.trim() ||
      undefined;
    this.preferredHost =
      options.preferredHost?.trim() || resolvePreferredHost() || undefined;
    this.defaultAgent = options.defaultAgent ?? resolveDefaultAgent();
    this.sandboxReadyTimeoutMs =
      options.sandboxReadyTimeoutMs ??
      resolveTimeoutMs("SANDBOX_READY_TIMEOUT_SECONDS", 300);
    this.runtimeReadyTimeoutMs =
      options.runtimeReadyTimeoutMs ??
      resolveTimeoutMs("RUNTIME_READY_TIMEOUT_SECONDS", 120);
    this.eventBus = options.eventBus ?? new EventBus();
    this.queue = options.queue ?? createQueue<ScheduleJob>();
    this.taskStore = new TaskStore(options.databaseUrl);
    this.mode = options.mode ?? resolveServiceMode();
    this.executionWorkerUrl =
      options.executionWorkerUrl?.trim() ||
      process.env.EXECUTION_WORKER_URL?.trim() ||
      undefined;
    this.idleTimeoutMs = resolveTimeoutMs("DEVBOX_IDLE_TIMEOUT_SECONDS", 1800);
  }

  async initialize(): Promise<void> {
    if (this.restored || !this.taskStore.isEnabled()) {
      return;
    }
    this.restored = true;
    await restoreFromStore(this);
    startIdleWatchdogImpl(this);
    if (this.mode === "brain") {
      await recoverStuckQueuedTasks(this);
    }
  }

  getMode(): ServiceMode {
    return this.mode;
  }

  getTaskStore(): TaskStore {
    return this.taskStore;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getEventHistory(taskId: string) {
    return this.eventBus.historyFor(taskId);
  }

  async retryTask(taskId: string): Promise<Task> {
    const task = await ensureTaskLoaded(this, taskId);
    const job =
      (await ensurePendingJob(this, taskId)) ?? this.pendingJobs.get(taskId);
    if (!task || !job) {
      throw new Error("task not found");
    }
    if (task.status !== "failed") {
      throw new Error("only failed tasks can be retried");
    }

    const retryJob: ScheduleJob = {
      ...job,
      skipDraft: Boolean(job.draftPlan || job.greenfieldPushed),
      autoStartSandbox: true,
      forceSandboxRecreate: true,
      enqueuedAt: new Date().toISOString(),
    };
    this.pendingJobs.set(taskId, retryJob);
    this.updateTask(taskId, "queued", "Retrying task");
    this.emit("task.scheduled", taskId, "Task retry queued", {
      retry: true,
      skipDraft: retryJob.skipDraft,
    });

    if (this.mode === "brain") {
      try {
        await delegateJobToWorkerImpl(this, retryJob);
        this.emit(
          "task.scheduled",
          taskId,
          "Task retry delegated to execution worker",
          { delegated: true, retry: true },
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to delegate retry to execution worker";
        this.updateTask(taskId, "failed", message);
        this.emit("task.failed", taskId, message);
      }
      const refreshed = this.getTask(taskId);
      if (!refreshed) {
        throw new Error("task not found");
      }
      return refreshed;
    }

    await this.queue.enqueue(retryJob);
    return task;
  }

  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const requested = input.agent ?? this.defaultAgent;
    const agent =
      requested === "mock" && process.env.ALLOW_TEMPLATE_AGENT !== "true"
        ? "cursor"
        : requested;
    const runtime = resolveRuntimeForTask(
      agent,
      input.prompt.trim(),
      input.runtime,
    );
    const title =
      input.prompt.trim().slice(0, 80) +
      (input.prompt.trim().length > 80 ? "…" : "");
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: input.prompt.trim(),
      agent,
      runtime,
      status: "queued",
      userId: input.userId,
      repository: input.repository,
      title,
      createdAt: now,
      updatedAt: now,
    };

    if (!task.prompt) {
      throw new Error("prompt is required");
    }

    this.tasks.set(task.id, task);

    const job: ScheduleJob = {
      taskId: task.id,
      prompt: task.prompt,
      agent: task.agent,
      runtime: task.runtime,
      userId: input.userId,
      repository: input.repository,
      createRepository: input.createRepository,
      autoCreateRepository: input.autoCreateRepository,
      autoStartSandbox: input.autoStartSandbox ?? true,
      cloneUrl: input.cloneUrl,
      githubToken: input.githubToken,
      permissions: input.permissions,
      testCommand: input.testCommand,
      issueTitle: input.issueTitle,
      issueBody: input.issueBody,
      agentModel: input.agentModel,
      requireReviewBeforePush: input.requireReviewBeforePush ?? false,
      enqueuedAt: now,
    };
    this.pendingJobs.set(task.id, job);

    void (async () => {
      await this.taskStore.upsertTask(task);
      this.emit("task.created", task.id, "Task accepted", {
        agent: task.agent,
        runtime: task.runtime,
        repository: task.repository,
        prompt: task.prompt,
      });

      if (this.mode === "brain") {
        try {
          await delegateJobToWorkerImpl(this, job);
          this.emit(
            "task.scheduled",
            task.id,
            "Task delegated to execution worker",
            {
              delegated: true,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to delegate job";
          this.updateTask(task.id, "failed", message);
          this.emit("task.failed", task.id, message);
        }
        return;
      }

      try {
        await this.queue.enqueue(job);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to enqueue task";
        this.updateTask(task.id, "failed", message);
        this.emit("task.failed", task.id, message);
      }
    })();

    return task;
  }

  async ingestWorkerJob(job: ScheduleJob): Promise<void> {
    let task = await syncTaskFromStore(this, job.taskId);
    if (!task) {
      task = materializeTaskFromJob(job);
      this.tasks.set(task.id, task);
      await this.taskStore.upsertTask(task);
    }
    this.pendingJobs.set(job.taskId, job);
    await this.queue.enqueue(job);
  }

  async startExecution(taskId: string): Promise<Task> {
    const task = await ensureTaskLoaded(this, taskId);
    const job =
      (await ensurePendingJob(this, taskId)) ?? this.pendingJobs.get(taskId);
    if (!task || !job) {
      throw new Error("task not found");
    }
    if (task.status !== "draft_ready") {
      throw new Error("task is not waiting for sandbox execution");
    }

    const executionJob: ScheduleJob = {
      ...job,
      skipDraft: true,
      autoStartSandbox: true,
      enqueuedAt: new Date().toISOString(),
    };
    this.pendingJobs.set(taskId, executionJob);
    await this.queue.enqueue(executionJob);
    return task;
  }

  async commitTaskWork(taskId: string): Promise<Task> {
    return finalizeReviewedTaskImpl(this, taskId, { createPullRequest: false });
  }

  async raiseTaskPullRequest(taskId: string): Promise<Task> {
    return finalizeReviewedTaskImpl(this, taskId, { createPullRequest: true });
  }

  async continueTask(
    taskId: string,
    prompt: string,
    agentModel?: string,
  ): Promise<Task> {
    return continueTaskImpl(this, taskId, prompt, agentModel);
  }

  async wakeSession(taskId: string): Promise<ReviewSession | undefined> {
    return wakeSessionImpl(this, taskId);
  }

  async terminateSession(taskId: string): Promise<Task> {
    return terminateSessionImpl(this, taskId);
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? hydrateTaskRuntime(task) : undefined;
  }

  async syncTaskFromStore(taskId: string): Promise<Task | undefined> {
    return syncTaskFromStore(this, taskId);
  }

  async syncTaskFromWorker(taskId: string): Promise<Task | undefined> {
    return syncTaskFromWorkerImpl(this, taskId);
  }

  async rehydrateDevboxSession(
    taskId: string,
  ): Promise<ReviewSession | undefined> {
    return hydrateSessionFromOrchestrator(this, taskId);
  }

  listTasks(): Task[] {
    if (this.tasks.size > 0) {
      return [...this.tasks.values()]
        .map(hydrateTaskRuntime)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return [];
  }

  async listTasksFromStore(userId?: string): Promise<Task[]> {
    const stored = await this.taskStore.listTasks(userId);
    for (const task of stored) {
      const hydrated = hydrateTaskRuntime(task);
      const memory = this.tasks.get(hydrated.id);
      if (!memory || hydrated.updatedAt >= memory.updatedAt) {
        this.tasks.set(hydrated.id, hydrated);
      }
    }

    if (this.mode === "brain" && this.executionWorkerUrl?.trim()) {
      const staleCutoff = Date.now() - 30_000;
      const stale = stored.filter(
        (task) =>
          (task.status === "queued" || task.status === "scheduling") &&
          new Date(task.updatedAt).getTime() < staleCutoff,
      );
      await Promise.all(
        stale
          .slice(0, 12)
          .map((task) =>
            syncTaskFromWorkerImpl(this, task.id).catch(() => undefined),
          ),
      );
      if (stale.length > 0) {
        const refreshed = await this.taskStore.listTasks(userId);
        return refreshed.map(hydrateTaskRuntime);
      }
    }

    return stored.map(hydrateTaskRuntime);
  }

  async getInfraDiagnostics(): Promise<InfraDiagnostics> {
    return collectInfraDiagnostics({
      orchestratorUrl: this.orchestratorUrl,
      firecrackerHostUrl: this.firecrackerHostUrl,
      mode: this.mode,
      executionWorkerUrl: this.executionWorkerUrl,
      durable: this.taskStore.isEnabled(),
    });
  }

  async getTaskDiagnostics(
    taskId: string,
  ): Promise<TaskDiagnostics | undefined> {
    const task = await ensureTaskLoaded(this, taskId);
    if (!task) {
      return undefined;
    }

    const sandboxName = task.sandboxName ?? `sbx-${taskId.slice(0, 8)}`;
    const sandbox = await fetchSandboxByName(this.orchestratorUrl, sandboxName);
    return {
      taskId,
      sandboxName,
      sandbox,
    };
  }

  startWorker(): void {
    if (this.workerStarted || this.mode === "brain") {
      return;
    }
    this.workerStarted = true;

    this.queue.startWorker(async (job) => {
      await this.processJob(job.payload);
    });
  }

  stopWorker(): void {
    this.queue.stopWorker?.();
    this.workerStarted = false;
  }

  async processJob(job: ScheduleJob): Promise<void> {
    return processJobImpl(this, job);
  }

  updateTask(taskId: string, status: Task["status"], message: string): void {
    updateTaskImpl(this, taskId, status, message);
  }

  patchTask(
    taskId: string,
    patch: Parameters<TaskServiceHost["patchTask"]>[1],
  ): void {
    patchTaskImpl(this, taskId, patch);
  }

  emit(
    type: TaskEventType,
    taskId: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    emitImpl(this, type, taskId, message, data);
  }

  emitRuntime(
    taskId: string,
    type: TaskEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    emitRuntimeImpl(this, taskId, type, message, data);
  }

  nextEventSequence(taskId: string): number {
    return nextEventSequenceImpl(this, taskId);
  }

  async proxyDevboxPreview(
    taskId: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    opts?: { warm?: boolean },
  ): Promise<void> {
    return proxyDevboxPreviewImpl(this, taskId, path, req, res, opts);
  }

  async fetchDesktopScreenshot(
    taskId: string,
    opts?: { fresh?: boolean },
  ): Promise<Response> {
    return fetchDesktopScreenshotImpl(this, taskId, opts);
  }

  async proxyRuntimeRequest(
    taskId: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    if (this.mode === "brain") {
      const workerPath = path.startsWith("/terminal")
        ? `/api/v1/tasks/${encodeURIComponent(taskId)}/terminal`
        : path.startsWith("/files/list")
          ? `/api/v1/tasks/${encodeURIComponent(taskId)}/files?${path.split("?")[1] ?? ""}`
          : path.startsWith("/files/read")
            ? `/api/v1/tasks/${encodeURIComponent(taskId)}/files/read?${path.split("?")[1] ?? ""}`
            : `/api/v1/tasks/${encodeURIComponent(taskId)}/runtime-proxy?path=${encodeURIComponent(path)}`;

      if (path.startsWith("/terminal/stream")) {
        return delegateRequestToWorkerImpl(this, workerPath, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(init?.headers as Record<string, string> | undefined),
          },
          body: init?.body,
        });
      }

      const workerInit =
        path.startsWith("/files/list") || path.startsWith("/files/read")
          ? { method: "GET" as const }
          : path.startsWith("/terminal")
            ? {
                method: "POST" as const,
                headers: {
                  "Content-Type": "application/json",
                  ...(init?.headers as Record<string, string> | undefined),
                },
                body: init?.body,
              }
            : {
                method: init?.method ?? "GET",
                headers: init?.headers,
                signal: init?.signal,
              };

      return brainDelegateOrRuntime(this, taskId, workerPath, path, workerInit);
    }

    const session = await resolveRuntimeSession(this, taskId);
    if (!session) {
      throw new Error("no devbox session for task");
    }

    return fetch(`${session.runtimeBaseUrl}${path}`, init);
  }

  async ensureDesktopComputer(taskId: string): Promise<Response> {
    return ensureDesktopComputerImpl(this, taskId);
  }

  async proxyDesktopVNCPageHttp(
    taskId: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    return proxyDesktopVNCPageHttpImpl(this, taskId, res);
  }

  async persistSession(
    taskId: string,
    session: ReviewSession,
    state: "active" | "review" | "sleeping",
  ): Promise<void> {
    return persistSessionImpl(this, taskId, session, state);
  }
}

export type { TaskServiceOptions } from "./types.js";
