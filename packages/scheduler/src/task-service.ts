import { RuntimeClient, type RunResponse } from "@devin/agent-sdk";
import { EventBus } from "@devin/events";
import type { TaskEvent, TaskEventType } from "@devin/events";
import { createQueue, type TaskQueue } from "@devin/queue";
import { resolveDefaultAgent, usesRuntimeAgent } from "./agent-defaults.js";
import {
  inferStackFromPrompt,
  resolveRuntimeForTask,
  type StackRuntime,
} from "@devin/types";
import { resolvePreferredHost } from "./preferred-host.js";
import {
  collectInfraDiagnostics,
  fetchSandboxByName,
  listSandboxes,
  validateFirecrackerHostForRuntime,
  type InfraDiagnostics,
  type TaskDiagnostics,
} from "./diagnostics.js";
import {
  authenticatedCloneUrl,
  createGitHubInitialCommit,
  createGitHubIssue,
  createGitHubPullRequest,
  createGitHubRepositoryUnique,
  fetchDefaultBranch,
  fetchGitHubUserIdentity,
  setRepositoryHomepage,
  type GitHubUserIdentity,
} from "./github.js";
import { generateProjectMetadata } from "./project-metadata.js";
import { bootstrapGreenfieldProject } from "./greenfield-bootstrap.js";
import {
  buildAlignHydratedRepoScript,
  buildPushGreenfieldMainScript,
  isAgentTimeoutMessage,
} from "./greenfield-git-sync.js";
import { greenfieldShellScaffoldFiles } from "./greenfield-shell-scaffold.js";
import { ensureExecutionHostRegistered } from "./register-execution-host.js";
import { generateDraftPlan, type DraftPlan } from "./draft-planner.js";
import { scaffoldFilesFromDraft } from "./scaffold-from-draft.js";
import { deployProductionPreview } from "./preview-deploy.js";
import type {
  AgentProvider,
  CreateTaskInput,
  ScheduleJob,
  ServiceMode,
  Task,
  TaskStatus,
} from "./types.js";
import { TaskStore, type PersistedSession } from "./task-store.js";

export interface TaskServiceOptions {
  orchestratorUrl: string;
  runtimeUrl: string;
  firecrackerHostUrl?: string;
  preferredHost?: string;
  defaultAgent?: AgentProvider;
  eventBus?: EventBus;
  queue?: TaskQueue<ScheduleJob>;
  /** Max time to wait for orchestrator sandbox phase Running (default 300s). */
  sandboxReadyTimeoutMs?: number;
  /** Max time to wait for runtime /health (default 60s). */
  runtimeReadyTimeoutMs?: number;
  /** Postgres URL for durable tasks/sessions (falls back to DATABASE_URL). */
  databaseUrl?: string;
  /** standalone = all-in-one; brain = cloud control plane; worker = execution host only. */
  mode?: ServiceMode;
  /** Worker scheduler URL when mode=brain (job execution delegation). */
  executionWorkerUrl?: string;
}

type SandboxRecord = {
  status?: {
    phase?: string;
    message?: string;
    runtimeURL?: string;
    vmId?: string;
    host?: string;
  };
};

type ReviewSession = {
  runtime: RuntimeClient;
  sandboxName: string;
  runtimeBaseUrl: string;
  repoCwd: string;
  job: ScheduleJob;
  githubToken?: string;
  createdNewRepo: boolean;
  guestHost?: string;
};

export class TaskService {
  private readonly tasks = new Map<string, Task>();
  private readonly pendingJobs = new Map<string, ScheduleJob>();
  /** Devbox sessions kept alive for follow-up prompts or manual review. */
  private readonly activeSessions = new Map<string, ReviewSession>();
  private readonly reviewSessions = new Map<string, ReviewSession>();
  private readonly eventSequences = new Map<string, number>();
  private readonly eventBus: EventBus;
  private readonly queue: TaskQueue<ScheduleJob>;
  private readonly orchestratorUrl: string;
  private readonly runtimeUrl: string;
  private readonly firecrackerHostUrl?: string;
  private readonly preferredHost?: string;
  private readonly defaultAgent: AgentProvider;
  private readonly sandboxReadyTimeoutMs: number;
  private readonly runtimeReadyTimeoutMs: number;
  private readonly taskStore: TaskStore;
  private readonly mode: ServiceMode;
  private readonly executionWorkerUrl?: string;
  private readonly idleTimeoutMs: number;
  private idleWatchdog?: ReturnType<typeof setInterval>;
  private workerStarted = false;
  private readonly processingTasks = new Set<string>();
  private restored = false;

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
      resolveTimeoutMs("RUNTIME_READY_TIMEOUT_SECONDS", 60);
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
    await this.restoreFromStore();
    this.startIdleWatchdog();
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
    const task = this.tasks.get(taskId);
    const job = this.pendingJobs.get(taskId);
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
      enqueuedAt: new Date().toISOString(),
    };
    this.pendingJobs.set(taskId, retryJob);
    this.updateTask(taskId, "queued", "Retrying task");
    this.emit("task.scheduled", taskId, "Task retry queued", {
      retry: true,
      skipDraft: retryJob.skipDraft,
    });
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
    void this.taskStore.upsertTask(task);
    this.emit("task.created", task.id, "Task accepted", {
      agent: task.agent,
      runtime: task.runtime,
      repository: task.repository,
    });

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
      requireReviewBeforePush: input.requireReviewBeforePush ?? false,
      enqueuedAt: now,
    };
    this.pendingJobs.set(task.id, job);

    if (this.mode === "brain") {
      void this.delegateJobToWorker(job).catch((error) => {
        const message =
          error instanceof Error ? error.message : "Failed to delegate job";
        this.updateTask(task.id, "failed", message);
        this.emit("task.failed", task.id, message);
      });
      return task;
    }

    void this.queue.enqueue(job).catch((error) => {
      const message =
        error instanceof Error ? error.message : "Failed to enqueue task";
      this.updateTask(task.id, "failed", message);
      this.emit("task.failed", task.id, message);
    });

    return task;
  }

  /** Accept a job from the cloud brain on the execution worker. */
  async ingestWorkerJob(job: ScheduleJob): Promise<void> {
    const task =
      this.tasks.get(job.taskId) ?? (await this.taskStore.getTask(job.taskId));
    if (!task) {
      throw new Error("task not found");
    }
    this.tasks.set(task.id, task);
    this.pendingJobs.set(job.taskId, job);
    await this.queue.enqueue(job);
  }

  async startExecution(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    const job = this.pendingJobs.get(taskId);
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
    return this.finalizeReviewedTask(taskId, { createPullRequest: false });
  }

  async raiseTaskPullRequest(taskId: string): Promise<Task> {
    return this.finalizeReviewedTask(taskId, { createPullRequest: true });
  }

  async continueTask(taskId: string, prompt: string): Promise<Task> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new Error("prompt is required");
    }

    const task = this.tasks.get(taskId);
    let session =
      this.activeSessions.get(taskId) ?? this.reviewSessions.get(taskId);

    if (!task) {
      throw new Error("task not found");
    }

    if (!session && task.sessionSleeping) {
      session = await this.wakeSession(taskId);
    }

    if (!session) {
      throw new Error("no active devbox session for this task");
    }

    const followUpJob: ScheduleJob = {
      ...session.job,
      prompt: trimmed,
      taskId,
      skipDraft: true,
      resumeSession: true,
      runtimeBaseUrl: session.runtimeBaseUrl,
      sandboxName: session.sandboxName,
      enqueuedAt: new Date().toISOString(),
    };

    task.prompt = trimmed;
    task.sessionSleeping = false;
    task.sessionActive = true;
    this.pendingJobs.set(taskId, followUpJob);
    this.updateTask(taskId, "queued", "Follow-up queued for devbox session");
    this.emit("task.scheduled", taskId, "Follow-up prompt queued", {
      followUp: true,
      sessionActive: true,
    });

    if (this.mode === "brain") {
      await this.delegateJobToWorker(followUpJob);
    } else {
      await this.queue.enqueue(followUpJob);
    }
    return task;
  }

  async wakeSession(taskId: string): Promise<ReviewSession | undefined> {
    if (this.mode === "brain") {
      await this.delegateRequestToWorker(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/wake`,
        { method: "POST" },
      );
      const task = await this.taskStore.getTask(taskId);
      if (task) {
        this.tasks.set(taskId, task);
      }
      return undefined;
    }

    const persisted = await this.taskStore.getSession(taskId);
    if (!persisted || persisted.state !== "sleeping") {
      return undefined;
    }

    await this.wakeSandbox(persisted.sandboxName);
    const runtimeBaseUrl = await this.resolveRuntimeUrl(persisted.sandboxName);
    const runtime = new RuntimeClient(runtimeBaseUrl);
    await this.waitForRuntime(runtime, taskId, runtimeBaseUrl);

    const session: ReviewSession = {
      runtime,
      sandboxName: persisted.sandboxName,
      runtimeBaseUrl,
      repoCwd: persisted.repoCwd,
      job: persisted.job,
      githubToken: persisted.githubToken,
      createdNewRepo: persisted.createdNewRepo,
      guestHost: persisted.guestHost,
    };

    this.activeSessions.set(taskId, session);
    const task = this.tasks.get(taskId);
    if (task) {
      task.sessionActive = true;
      task.sessionSleeping = false;
      task.sandboxName = persisted.sandboxName;
      await this.taskStore.upsertTask(task);
    }

    await this.persistSession(taskId, session, "active");
    await this.taskStore.touchSession(taskId);
    this.emit(
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

  async terminateSession(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error("task not found");
    }

    const session =
      this.activeSessions.get(taskId) ?? this.reviewSessions.get(taskId);
    const sandboxName =
      session?.sandboxName ?? task.sandboxName ?? `sbx-${taskId.slice(0, 8)}`;

    if (sandboxName) {
      await this.deleteSandbox(sandboxName);
    }
    if (session) {
      this.activeSessions.delete(taskId);
      this.reviewSessions.delete(taskId);
      await this.taskStore.deleteSession(taskId);
    }

    task.sessionActive = false;
    task.sessionSleeping = false;
    if (task.status === "awaiting_review") {
      this.updateTask(
        taskId,
        "cancelled",
        "Session ended — sandbox terminated without push",
      );
      this.emit("task.phase_changed", taskId, "Devbox session terminated", {
        phase: "terminated",
        sessionActive: false,
      });
    } else if (task.status !== "completed" && task.status !== "failed") {
      this.patchTask(taskId, {});
      this.updateTask(taskId, task.status, "Devbox session terminated");
    } else {
      this.updateTask(taskId, task.status, "Devbox session terminated");
    }

    return task;
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? hydrateTaskRuntime(task) : undefined;
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
      if (!this.tasks.has(hydrated.id)) {
        this.tasks.set(hydrated.id, hydrated);
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
    const task = this.tasks.get(taskId);
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

  private async processJob(job: ScheduleJob): Promise<void> {
    let task = this.tasks.get(job.taskId);
    if (!task) {
      task = await this.taskStore.getTask(job.taskId);
      if (task) {
        this.tasks.set(job.taskId, task);
      }
    }
    if (!task) {
      return;
    }
    task = hydrateTaskRuntime(task);
    if (job.runtime) {
      task.runtime = job.runtime;
      this.tasks.set(task.id, task);
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

    if (this.processingTasks.has(job.taskId)) {
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

    this.processingTasks.add(job.taskId);

    let sandboxName: string | undefined;
    let retainSandboxForPreview = false;
    let pausedForReview = false;
    let guestHost: string | undefined;
    let runtime: RuntimeClient | undefined;
    let repoCwd = "repo";
    let repository: string | undefined;
    let cloneUrl: string | undefined;
    let githubToken: string | undefined;
    let createdNewRepo = false;
    let runtimeBaseUrl: string | undefined;
    let gitOwner: GitHubUserIdentity | undefined;
    let repoHydratedLocally = false;

    try {
      const resumeSession =
        job.resumeSession === true
          ? (this.activeSessions.get(task.id) ??
            this.reviewSessions.get(task.id) ??
            (await this.wakeSession(task.id)))
          : undefined;

      if (resumeSession) {
        this.reviewSessions.delete(task.id);
        sandboxName = resumeSession.sandboxName;
        runtimeBaseUrl = resumeSession.runtimeBaseUrl;
        runtime = resumeSession.runtime;
        guestHost = resumeSession.guestHost;
        repoCwd = resumeSession.repoCwd;
        repository = resumeSession.job.repository ?? task.repository;
        cloneUrl = resumeSession.job.cloneUrl;
        githubToken = resumeSession.job.githubToken;
        createdNewRepo = resumeSession.createdNewRepo;
        Object.assign(job, resumeSession.job, {
          prompt: job.prompt,
          resumeSession: true,
        });
        task.sandboxName = sandboxName;
        task.sessionActive = true;
        this.updateTask(
          task.id,
          "running",
          "Follow-up running in devbox session",
        );
        this.emit("task.phase_changed", task.id, "Resuming devbox session", {
          phase: "running",
          sessionActive: true,
          followUp: true,
        });
      } else if (!job.skipDraft) {
        this.updateTask(task.id, "scheduling", "Scheduler picked up task");
        this.emit("task.scheduled", task.id, "Task scheduled", {
          agent: task.agent,
        });
        this.emit("task.phase_changed", task.id, "Entered scheduling phase", {
          phase: "scheduling",
        });

        this.validateAgentSecrets(task);

        if (usesRuntimeAgent(task.agent)) {
          this.emit(
            "task.phase_changed",
            task.id,
            "Runtime agent will implement changes in the sandbox",
            {
              phase: "scheduling",
              runtimeAgent: true,
            },
          );
        } else {
          this.validateGreenfieldDraftSecrets(job);

          this.updateTask(task.id, "drafting", "Preparing draft plan");
          this.emit("task.phase_changed", task.id, "Entered draft phase", {
            phase: "drafting",
          });
          await this.prepareDraft(task, job);

          const autoStartSandbox = job.autoStartSandbox !== false;
          if (!autoStartSandbox) {
            await this.provisionGreenfieldRepository(task, job);
            this.updateTask(
              task.id,
              "draft_ready",
              "Draft ready — approve sandbox to continue",
            );
            this.emit(
              "task.phase_changed",
              task.id,
              "Draft ready — waiting for sandbox approval",
              {
                phase: "draft_ready",
                awaitingApproval: true,
              },
            );
            return;
          }
        }
      } else {
        this.validateAgentSecrets(task);
      }

      if (!resumeSession) {
        if (
          usesRuntimeAgent(task.agent) &&
          (job.createRepository || job.autoCreateRepository)
        ) {
          await this.provisionGreenfieldRepositoryShell(task, job);
        } else {
          await this.provisionGreenfieldRepository(task, job);
        }

        this.updateTask(
          task.id,
          usesRuntimeAgent(task.agent) ? "sandbox_starting" : "draft_ready",
          usesRuntimeAgent(task.agent)
            ? "Booting devbox from snapshot"
            : "Draft ready; starting sandbox",
        );
        this.emit(
          "task.phase_changed",
          task.id,
          usesRuntimeAgent(task.agent)
            ? "Booting devbox"
            : "Draft ready; moving to sandbox execution",
          {
            phase: usesRuntimeAgent(task.agent)
              ? "sandbox_starting"
              : "draft_ready",
          },
        );
        this.emit(
          "execution.started",
          task.id,
          "Execution starting in devbox",
          {
            phase: "sandbox_starting",
          },
        );

        sandboxName = `sbx-${task.id.slice(0, 8)}`;
        task.sandboxName = sandboxName;
        this.updateTask(task.id, "sandbox_starting", "Creating devbox");

        const runtimeImage =
          task.runtime ??
          job.runtime ??
          resolveRuntimeForTask(task.agent, task.prompt);
        const sandboxCpu = resolveSandboxCpu(task);

        if (this.firecrackerHostUrl) {
          const hostIssue = await validateFirecrackerHostForRuntime(
            this.firecrackerHostUrl,
            runtimeImage,
          );
          if (hostIssue) {
            throw new Error(hostIssue);
          }
        }

        if (this.preferredHost) {
          this.emit(
            "agent.log",
            task.id,
            `Ensuring FirecrackerHost ${this.preferredHost} is registered`,
            { preferredHost: this.preferredHost },
          );
          await ensureExecutionHostRegistered({
            orchestratorUrl: this.orchestratorUrl,
            hostName: this.preferredHost,
            firecrackerHostUrl: this.firecrackerHostUrl,
          });
        }

        const reclaimed = await this.reclaimDevboxCapacity(task.id, sandboxCpu);
        if (reclaimed > 0) {
          await sleep(3_000);
        }

        this.emit(
          "sandbox.requested",
          task.id,
          "Requesting devbox from orchestrator",
          {
            sandboxName,
            runtime: runtimeImage,
            orchestratorUrl: this.orchestratorUrl,
            cpu: sandboxCpu,
            reclaimedSandboxes: reclaimed,
          },
        );

        await this.provisionSandboxWithCapacityRetry(
          sandboxName,
          task.id,
          {
            taskId: task.id,
            runtime: runtimeImage,
            cpu: sandboxCpu,
            memory: resolveSandboxMemory(task),
            ...(this.preferredHost
              ? { preferredHost: this.preferredHost }
              : {}),
          },
          sandboxCpu,
        );

        const sandbox = await this.waitForSandbox(sandboxName, task.id);
        this.assertSandboxOnLocalHost(sandbox, task.id);
        task.sessionActive = true;
        this.emit("sandbox.started", task.id, "Devbox microVM is running", {
          sandboxName,
          vmId: sandbox.status?.vmId,
          host: sandbox.status?.host,
          runtime: runtimeImage,
          sessionActive: true,
        });

        runtimeBaseUrl = sandbox.status?.runtimeURL?.replace(/\/$/, "");
        if (!runtimeBaseUrl) {
          throw new Error(
            "Sandbox is running but orchestrator did not publish a runtimeURL. Check firecracker and orchestrator sync.",
          );
        }
        guestHost = new URL(runtimeBaseUrl).hostname;
        runtime = new RuntimeClient({ baseUrl: runtimeBaseUrl });
        this.emit(
          "runtime.waiting",
          task.id,
          "Waiting for runtime supervisor health check",
          {
            runtimeURL: runtimeBaseUrl,
          },
        );
        await this.waitForRuntime(runtime, task.id, runtimeBaseUrl);
        await this.ensureSandboxDns(runtime, task.id);
        this.emit("runtime.ready", task.id, "Runtime supervisor is ready", {
          runtimeURL: runtimeBaseUrl,
        });
      }

      if (!runtime || !runtimeBaseUrl || !sandboxName) {
        throw new Error("devbox session is not available");
      }

      if (!resumeSession) {
        repoCwd = "repo";
        repository = job.repository ?? task.repository;
        cloneUrl = job.cloneUrl;
        githubToken = job.githubToken;
        createdNewRepo =
          Boolean(job.greenfieldPushed) ||
          (usesRuntimeAgent(task.agent) &&
            Boolean(job.createRepository || job.autoCreateRepository));
        repoHydratedLocally = false;

        if (githubToken) {
          try {
            gitOwner = await fetchGitHubUserIdentity(githubToken);
          } catch {
            // commits still work with bot co-author trailer if identity lookup fails
          }
        }

        if (!repository && (job.createRepository || job.autoCreateRepository)) {
          throw new Error(
            "Repository was not provisioned before sandbox execution",
          );
        }

        if (
          repository &&
          githubToken &&
          !cloneUrl &&
          (job.autoCreateRepository || job.createRepository)
        ) {
          cloneUrl = authenticatedCloneUrl(githubToken, repository);
          job.cloneUrl = cloneUrl;
          job.repository = repository;
          task.repository = repository;
          createdNewRepo = true;
        }

        if (cloneUrl && repository) {
          await this.ensureSandboxDns(runtime, task.id);

          if (
            usesRuntimeAgent(task.agent) &&
            createdNewRepo &&
            job.greenfieldPushed
          ) {
            // Hydrate first — same files the control plane just pushed. Avoids
            // multi-minute git clone DNS failures that dominate greenfield latency.
            this.emit(
              "agent.log",
              task.id,
              "Hydrating greenfield scaffold in sandbox (skip slow remote clone)",
              { repository, runtimeAgent: true, hydrateFirst: true },
            );
            await this.hydrateRepositoryShellInSandbox(
              runtime,
              task,
              job,
              repoCwd,
              gitOwner,
              cloneUrl,
              githubToken,
            );
            repoHydratedLocally = true;
          } else if (
            job.greenfieldPushed &&
            job.draftPlan &&
            !usesRuntimeAgent(task.agent)
          ) {
            this.emit(
              "agent.log",
              task.id,
              "Using local scaffold hydration for greenfield repo (skipping git clone)",
              { repository, fallback: "hydrate" },
            );
            await this.hydrateGreenfieldInSandbox(
              runtime,
              task,
              job,
              repoCwd,
              gitOwner,
              cloneUrl,
              githubToken,
            );
            repoHydratedLocally = true;
          } else {
            if (task.agent === "cursor") {
              await this.ensureSandboxConnectivity(runtime, task.id);
            }
            try {
              await this.cloneRepositoryInSandbox(
                runtime,
                task.id,
                cloneUrl,
                repoCwd,
                repository,
              );
            } catch (error) {
              if (
                job.draftPlan &&
                !usesRuntimeAgent(task.agent) &&
                isNetworkCloneFailure(error)
              ) {
                this.emit(
                  "agent.log",
                  task.id,
                  "Git clone failed in sandbox; hydrating from draft scaffold",
                  { repository, fallback: "hydrate" },
                );
                await this.hydrateGreenfieldInSandbox(
                  runtime,
                  task,
                  job,
                  repoCwd,
                  gitOwner,
                  cloneUrl,
                  githubToken,
                );
                repoHydratedLocally = true;
              } else {
                throw error;
              }
            }
          }
          if (!repoHydratedLocally) {
            await this.configureSandboxGit(runtime, task.id, gitOwner, {
              repoCwd,
              cloneUrl,
              githubToken,
            });
          }
          if (usesRuntimeAgent(task.agent) && createdNewRepo) {
            await this.assertGreenfieldDeliverable(
              runtime,
              task,
              repoCwd,
              resolveStackRuntime(task, job),
            );
          }
          if (
            !job.greenfieldPushed &&
            createdNewRepo &&
            !usesRuntimeAgent(task.agent)
          ) {
            const bot = resolveBotAuthor();
            try {
              await bootstrapGreenfieldProject({
                runtime,
                taskId: task.id,
                repoCwd,
                prompt: task.prompt,
                stackRuntime: resolveStackRuntime(task, job),
                title: task.title ?? "project",
                botName: bot.name,
                botEmail: bot.email,
                canPush: Boolean(job.permissions?.canPush),
                githubToken,
                cloneUrl,
                emit: (type, message, data) =>
                  this.emitRuntime(
                    task.id,
                    type as TaskEventType,
                    message,
                    data,
                  ),
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Bootstrap failed";
              this.emit("git.commit", task.id, `Bootstrap failed: ${message}`, {
                error: message,
                bootstrap: true,
              });
              throw error;
            }
          }
        } else if (githubToken) {
          await this.configureSandboxGit(runtime, task.id, gitOwner, {
            githubToken,
          });
        }
      }

      if (!gitOwner && githubToken) {
        try {
          gitOwner = await fetchGitHubUserIdentity(githubToken);
        } catch {
          // optional for follow-up prompts
        }
      }

      const agentPrompt = buildAgentPrompt(
        job.prompt,
        repository,
        repoCwd,
        gitOwner,
        resolveStackRuntime(task, job),
      );
      const repoReadyInSandbox = Boolean(repository && cloneUrl);

      const isTemplateGreenfield =
        task.agent === "mock" && Boolean(job.greenfieldPushed);
      const runtimeAgentTask = usesRuntimeAgent(task.agent);

      // Runtime agents own git history; auto-checkpoints fight them and cause
      // divergent main + repeated push rejections during long cursor runs.
      const stopAutoCommit =
        repository && cloneUrl && !isTemplateGreenfield && !runtimeAgentTask
          ? this.startAutoCommitWatcher(
              runtime,
              task,
              job,
              repoCwd,
              gitOwner,
              createdNewRepo,
              githubToken,
            )
          : () => undefined;

      const stopEvents = this.forwardRuntimeEvents(runtimeBaseUrl, task.id);

      // Always verify egress for cursor — hydrate-first greenfield still needs
      // api2.cursor.sh, and must not skip DNS just because clone was skipped.
      if (task.agent === "cursor") {
        await this.ensureSandboxConnectivity(runtime, task.id);
      }

      const preAgentHead =
        createdNewRepo && runtimeAgentTask && runtime
          ? await this.readGitHead(runtime, task.id, repoCwd, githubToken)
          : "";

      this.updateTask(
        task.id,
        "running",
        isTemplateGreenfield
          ? "Verifying scaffold in sandbox"
          : `${task.agent} agent executing task`,
      );
      this.emit(
        "agent.running",
        task.id,
        isTemplateGreenfield
          ? "Template execution started (OpenAI scaffold)"
          : `${task.agent} agent started`,
        {
          prompt: task.prompt,
          agent: task.agent,
          repository,
          templateGreenfield: isTemplateGreenfield,
        },
      );

      let runResult: RunResponse;
      try {
        if (isTemplateGreenfield) {
          runResult = await this.runTemplateGreenfieldVerify(
            runtime,
            task,
            repoCwd,
            resolveStackRuntime(task, job),
          );
        } else {
          if (task.agent === "cursor" && runtime) {
            await this.ensureBashInSandbox(runtime, task.id);
            await this.ensureCursorAgentInSandbox(runtime, task.id);
          }
          runResult = await runtime.runAndWait(
            {
              taskId: task.id,
              prompt: agentPrompt,
              agent: task.agent,
              workDir: repoReadyInSandbox ? repoCwd : undefined,
              env: this.runtimeSecrets(githubToken),
            },
            { maxWaitMs: resolveAgentMaxWaitMs() },
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Agent run failed";
        if (isAgentTimeoutMessage(message)) {
          this.emit("agent.failed", task.id, message, {
            timeout: true,
            maxWaitMs: resolveAgentMaxWaitMs(),
          });
          if (
            createdNewRepo &&
            runtimeAgentTask &&
            runtime &&
            repository &&
            cloneUrl
          ) {
            const recovered =
              await this.recoverGreenfieldAfterAgentInterruption(
                runtime,
                task,
                job,
                repoCwd,
                githubToken,
                preAgentHead,
              );
            if (recovered) {
              runResult = {
                status: "completed",
                taskId: task.id,
                message:
                  "Agent timed out; control plane finalized greenfield commits",
                agent: task.agent,
              };
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      } finally {
        stopAutoCommit();
        stopEvents();
      }

      if (runResult.status === "failed") {
        throw new Error(runResult.message);
      }

      if (createdNewRepo && runtimeAgentTask && runtime) {
        await this.assertGreenfieldAgentProgress(
          runtime,
          task,
          repoCwd,
          githubToken,
          preAgentHead,
        );
      }

      if (
        runtimeAgentTask &&
        repository &&
        cloneUrl &&
        runtime &&
        sandboxName &&
        runtimeBaseUrl &&
        job.requireReviewBeforePush === true
      ) {
        const diffStat = await runtime.terminalAllowFailure({
          taskId: task.id,
          cwd: repoCwd,
          command: "git diff --stat && git diff --cached --stat",
          env: this.gitRuntimeEnv(githubToken),
        });

        this.reviewSessions.set(task.id, {
          runtime,
          sandboxName,
          runtimeBaseUrl,
          repoCwd,
          job,
          githubToken,
          createdNewRepo,
          guestHost,
        });
        void this.persistSession(
          task.id,
          this.reviewSessions.get(task.id)!,
          "review",
        );

        pausedForReview = true;
        retainSandboxForPreview = true;
        task.sessionActive = true;
        this.updateTask(
          task.id,
          "awaiting_review",
          "Review agent changes, then commit or open a PR",
        );
        this.emit(
          "task.phase_changed",
          task.id,
          "Agent work ready for review",
          {
            phase: "awaiting_review",
            awaitingReview: true,
            diff: diffStat.stdout.trim() || undefined,
            agent: task.agent,
            sessionActive: true,
          },
        );
        if (diffStat.stdout.trim()) {
          this.emit(
            "git.commit",
            task.id,
            "Uncommitted agent changes in devbox",
            {
              auto: false,
              awaitingReview: true,
              diff: diffStat.stdout.trim(),
            },
          );
        }
        return;
      }

      if (repository && cloneUrl) {
        if (job.testCommand) {
          await this.runTests(runtime, task, job.testCommand, repoCwd);
        }

        if (job.permissions) {
          await this.finalizeGitWork(runtime, task, job, repoCwd, githubToken, {
            greenfield: createdNewRepo,
            createPullRequest:
              job.requireReviewBeforePush === true ||
              !(createdNewRepo && runtimeAgentTask),
          });
        }

        if (guestHost) {
          const preview = await deployProductionPreview({
            runtime,
            taskId: task.id,
            repoCwd,
            guestHost,
            emit: (type, message, data) =>
              this.emit(type, task.id, message, data),
          });
          if (preview) {
            retainSandboxForPreview = true;
            this.patchTask(task.id, {
              previewUrl: preview.previewUrl,
              deployStatus: "live",
            });
            if (githubToken && repository) {
              await this.attachPreviewHomepage(
                task.id,
                repository,
                preview.previewUrl,
                githubToken,
              );
            }
          } else {
            this.patchTask(task.id, { deployStatus: "failed" });
          }
        }

        if (
          job.issueTitle &&
          job.permissions?.canCreateIssue &&
          githubToken &&
          repository
        ) {
          await this.createTaskIssue(task, repository, githubToken, job);
        }
      }

      const completionMessage = task.previewUrl
        ? "Work completed — pushed to GitHub and preview deployed"
        : runResult.message || "Task completed";
      this.updateTask(task.id, "completed", completionMessage);
      this.emit("task.completed", task.id, completionMessage, {
        output: runResult.output,
        agent: runResult.agent ?? task.agent,
        prUrl: task.prUrl,
        branch: task.branch,
        previewUrl: task.previewUrl,
        pushedToGitHub: Boolean(repository && cloneUrl),
        sessionActive: usesRuntimeAgent(task.agent),
      });

      if (
        usesRuntimeAgent(task.agent) &&
        runtime &&
        sandboxName &&
        runtimeBaseUrl
      ) {
        this.activeSessions.set(task.id, {
          runtime,
          sandboxName,
          runtimeBaseUrl,
          repoCwd,
          job,
          githubToken,
          createdNewRepo,
          guestHost,
        });
        void this.persistSession(
          task.id,
          this.activeSessions.get(task.id)!,
          "active",
        );
        void this.taskStore.touchSession(task.id);
        task.sessionActive = true;
        retainSandboxForPreview = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed";
      if (repository && cloneUrl && job.permissions?.canPush && runtime) {
        try {
          await this.emergencyPushAgentWork(
            runtime,
            task,
            job,
            repoCwd,
            githubToken,
            { greenfield: createdNewRepo },
          );
        } catch {
          // Best-effort recovery push; original failure still wins.
        }
      }
      if (task.status === "drafting" || task.status === "draft_ready") {
        this.emit("draft.failed", task.id, message, {
          phase: "drafting",
          source: "scheduler",
          error: message,
        });
      }
      this.updateTask(task.id, "failed", message);
      task.sessionActive = false;
      this.emit("task.failed", task.id, message);
      throw error;
    } finally {
      this.processingTasks.delete(job.taskId);
      if (
        sandboxName &&
        !retainSandboxForPreview &&
        !pausedForReview &&
        !this.activeSessions.has(job.taskId) &&
        !this.reviewSessions.has(job.taskId)
      ) {
        await this.deleteSandbox(sandboxName);
      }
    }
  }

  private async finalizeReviewedTask(
    taskId: string,
    opts: { createPullRequest: boolean },
  ): Promise<Task> {
    const task = this.tasks.get(taskId);
    const session = this.reviewSessions.get(taskId);
    if (!task || !session) {
      throw new Error("task is not awaiting review");
    }
    if (task.status !== "awaiting_review") {
      throw new Error("task is not awaiting review");
    }

    const {
      runtime,
      sandboxName,
      repoCwd,
      job,
      githubToken,
      createdNewRepo,
      guestHost,
    } = session;

    try {
      if (job.testCommand) {
        await this.runTests(runtime, task, job.testCommand, repoCwd);
      }

      if (job.permissions && job.repository) {
        await this.finalizeGitWork(runtime, task, job, repoCwd, githubToken, {
          greenfield: createdNewRepo,
          createPullRequest: opts.createPullRequest,
        });
      }

      if (guestHost) {
        const preview = await deployProductionPreview({
          runtime,
          taskId: task.id,
          repoCwd,
          guestHost,
          emit: (type, message, data) =>
            this.emit(type, task.id, message, data),
        });
        if (preview) {
          this.patchTask(task.id, {
            previewUrl: preview.previewUrl,
            deployStatus: "live",
          });
          if (githubToken && job.repository) {
            await this.attachPreviewHomepage(
              task.id,
              job.repository,
              preview.previewUrl,
              githubToken,
            );
          }
        } else {
          this.patchTask(task.id, { deployStatus: "failed" });
        }
      }

      if (
        job.issueTitle &&
        job.permissions?.canCreateIssue &&
        githubToken &&
        job.repository
      ) {
        await this.createTaskIssue(task, job.repository, githubToken, job);
      }

      const completionMessage = opts.createPullRequest
        ? task.prUrl
          ? "Changes pushed and pull request opened"
          : "Changes pushed to GitHub"
        : task.previewUrl
          ? "Changes committed — preview deployed"
          : "Changes committed and pushed to GitHub";

      this.updateTask(task.id, "completed", completionMessage);
      this.emit("task.completed", task.id, completionMessage, {
        agent: task.agent,
        prUrl: task.prUrl,
        branch: task.branch,
        previewUrl: task.previewUrl,
        pushedToGitHub: Boolean(job.repository && job.cloneUrl),
        userApproved: true,
        createPullRequest: opts.createPullRequest,
      });
    } finally {
      this.reviewSessions.delete(taskId);
      this.activeSessions.delete(taskId);
      await this.taskStore.deleteSession(taskId);
      await this.deleteSandbox(sandboxName);
      task.sessionActive = false;
      task.sessionSleeping = false;
      void this.taskStore.upsertTask(task);
    }

    return task;
  }

  private validateGreenfieldDraftSecrets(job: ScheduleJob): void {
    if (!job.createRepository && !job.autoCreateRepository) {
      return;
    }

    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error(
        "OPENAI_API_KEY is not set on the scheduler. Add it to AWS SSM as a SecureString at /<env>/platform/openai_api_key, then run devin-sync-platform-config on the execution host.",
      );
    }
  }

  private validateAgentSecrets(task: Task): void {
    if (task.agent === "cursor" && !process.env.CURSOR_API_KEY?.trim()) {
      throw new Error(
        "Cursor agent credentials are not configured on the execution host. Ask your platform admin to configure agent secrets.",
      );
    }

    if (task.agent === "claude" && !process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error(
        "Claude agent credentials are not configured on the execution host. Ask your platform admin to configure agent secrets.",
      );
    }
  }

  private async prepareDraft(task: Task, job: ScheduleJob): Promise<void> {
    this.emit("draft.started", task.id, "Generating code plan", {
      phase: "drafting",
      steps: 0,
    });

    const plan = await generateDraftPlan(
      {
        prompt: task.prompt,
        repository: job.repository ?? task.repository,
        createRepository: job.createRepository,
        hasTestCommand: Boolean(job.testCommand),
        agent: task.agent,
      },
      {
        onStep: async (step, index, total) => {
          this.emit("draft.updated", task.id, step, {
            phase: "drafting",
            step: index + 1,
            totalSteps: total,
          });
        },
        onFile: async (file, index, total) => {
          this.emit("draft.diff", task.id, `Planned change: ${file.path}`, {
            phase: "drafting",
            path: file.path,
            changeType: file.changeType,
            summary: file.summary,
            fileIndex: index + 1,
            totalFiles: total,
          });
        },
      },
    );

    job.draftPlan = plan;

    this.emit("draft.completed", task.id, "Draft plan ready", {
      phase: "draft_ready",
      files: plan.files,
      summary: plan.summary,
      steps: plan.steps,
    });
  }

  private async provisionGreenfieldRepository(
    task: Task,
    job: ScheduleJob,
  ): Promise<void> {
    if (usesRuntimeAgent(task.agent)) {
      await this.provisionGreenfieldRepositoryShell(task, job);
      return;
    }

    if (job.repository && job.cloneUrl) {
      return;
    }

    if (!job.createRepository && !job.autoCreateRepository) {
      return;
    }

    const githubToken = job.githubToken;
    if (!githubToken) {
      throw new Error("GitHub token is required for repository creation");
    }
    if (!job.permissions?.canCreateRepo) {
      throw new Error("repository creation is not permitted");
    }

    const metadata = generateProjectMetadata(task.prompt);
    task.title = metadata.title;

    const created = await createGitHubRepositoryUnique(githubToken, {
      description: metadata.description,
      preferredName: job.createRepository?.trim() || undefined,
    });

    const repository = created.fullName;
    const cloneUrl = authenticatedCloneUrl(githubToken, repository);
    job.repository = repository;
    job.cloneUrl = cloneUrl;
    task.repository = repository;

    this.emit("git.repo", task.id, `Created repository ${repository}`, {
      repository,
      htmlUrl: created.htmlUrl,
      repoName: created.name,
    });

    if (!job.permissions?.canPush) {
      return;
    }

    const plan =
      job.draftPlan ??
      ({
        summary: metadata.description,
        steps: [],
        files: [],
      } satisfies DraftPlan);

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      throw new Error(`invalid repository name: ${repository}`);
    }

    const scaffoldFiles = scaffoldFilesFromDraft(plan, {
      title: task.title ?? metadata.title,
      prompt: task.prompt,
    });

    for (const [index, file] of scaffoldFiles.entries()) {
      this.emit("draft.diff", task.id, `Writing ${file.path}`, {
        phase: "draft_ready",
        path: file.path,
        changeType: "create",
        summary: `Scaffold file prepared for GitHub`,
        fileIndex: index + 1,
        totalFiles: scaffoldFiles.length,
        controlPlane: true,
      });
    }

    const commitMessage = buildCommitMessage(
      `devin: scaffold ${task.title ?? metadata.title}`,
    );

    this.emit("git.commit", task.id, "Pushing scaffold to GitHub", {
      repository,
      files: scaffoldFiles.map((file) => file.path),
      controlPlane: true,
    });

    await createGitHubInitialCommit(
      githubToken,
      owner,
      repo,
      scaffoldFiles,
      commitMessage,
      created.defaultBranch,
    );

    job.greenfieldPushed = true;
    this.pendingJobs.set(task.id, job);

    this.emit("git.push", task.id, "Pushed scaffold to GitHub", {
      repository,
      branch: created.defaultBranch,
      controlPlane: true,
      files: scaffoldFiles.map((file) => file.path),
    });

    this.emit("task.phase_changed", task.id, "Scaffold live on GitHub", {
      phase: "draft_ready",
      repository,
      scaffoldPushed: true,
    });
  }

  private async provisionGreenfieldRepositoryShell(
    task: Task,
    job: ScheduleJob,
  ): Promise<void> {
    if (job.repository && job.cloneUrl) {
      return;
    }

    if (!job.createRepository && !job.autoCreateRepository) {
      return;
    }

    const githubToken = job.githubToken;
    if (!githubToken) {
      throw new Error("GitHub token is required for repository creation");
    }
    if (!job.permissions?.canCreateRepo) {
      throw new Error("repository creation is not permitted");
    }

    const metadata = generateProjectMetadata(task.prompt);
    task.title = metadata.title;

    const created = await createGitHubRepositoryUnique(githubToken, {
      description: metadata.description,
      preferredName: job.createRepository?.trim() || undefined,
    });

    const repository = created.fullName;
    const cloneUrl = authenticatedCloneUrl(githubToken, repository);
    job.repository = repository;
    job.cloneUrl = cloneUrl;
    task.repository = repository;

    this.emit("git.repo", task.id, `Created repository ${repository}`, {
      repository,
      htmlUrl: created.htmlUrl,
      repoName: created.name,
      runtimeAgent: true,
    });

    if (!job.permissions?.canPush) {
      return;
    }

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      throw new Error(`invalid repository name: ${repository}`);
    }

    const stackRuntime = resolveStackRuntime(task, job);
    const scaffoldFiles = greenfieldShellScaffoldFiles({
      title: task.title ?? metadata.title,
      prompt: task.prompt,
      stackRuntime,
    });
    const commitMessage = buildCommitMessage(
      `devin: initialize ${task.title ?? metadata.title}`,
    );

    this.emit(
      "git.commit",
      task.id,
      "Creating greenfield repository scaffold on GitHub",
      {
        repository,
        controlPlane: true,
        runtimeAgent: true,
        files: scaffoldFiles.map((file) => file.path),
      },
    );

    await createGitHubInitialCommit(
      githubToken,
      owner,
      repo,
      scaffoldFiles,
      commitMessage,
      created.defaultBranch,
    );

    job.greenfieldPushed = true;
    this.pendingJobs.set(task.id, job);

    this.emit("git.push", task.id, "Repository scaffold pushed to GitHub", {
      repository,
      branch: created.defaultBranch,
      controlPlane: true,
      runtimeAgent: true,
      files: scaffoldFiles.map((file) => file.path),
    });
  }

  private async assertGreenfieldDeliverable(
    runtime: RuntimeClient,
    task: Task,
    repoCwd: string,
    stackRuntime: StackRuntime,
  ): Promise<void> {
    const marker =
      stackRuntime === "go"
        ? "go.mod"
        : stackRuntime === "rust"
          ? "Cargo.toml"
          : stackRuntime === "python"
            ? "requirements.txt"
            : "package.json";

    const check = await runtime.terminal({
      taskId: task.id,
      cwd: repoCwd,
      command: `test -f '${escapeShell(marker)}' && echo yes || echo no`,
    });

    if (check.stdout.trim() !== "yes") {
      throw new Error(
        `Greenfield scaffold is missing a runnable ${stackRuntime} project (${marker} missing)`,
      );
    }
  }

  private assertSandboxOnLocalHost(
    sandbox: SandboxRecord,
    taskId: string,
  ): void {
    const sandboxHost = sandbox.status?.host?.trim();
    if (!this.preferredHost || !sandboxHost) {
      return;
    }
    if (sandboxHost === this.preferredHost) {
      return;
    }
    const message =
      `Sandbox landed on execution host "${sandboxHost}" but this scheduler is pinned to "${this.preferredHost}". ` +
      "Route tasks to the matching scheduler or set SCHEDULER_HOST_NAME on each execution host.";
    this.emit("sandbox.failed", taskId, message, {
      sandboxHost,
      schedulerHost: this.preferredHost,
    });
    throw new Error(message);
  }

  private async ensureSandboxDns(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<void> {
    try {
      const viaApi = await runtime.ensureDns();
      if (viaApi) {
        return;
      }

      const result = await runtime.terminalAllowFailure({
        taskId,
        command:
          "printf '%s\\n' 'nameserver 8.8.8.8' 'nameserver 1.1.1.1' 'nameserver 8.8.4.4' > /etc/resolv.conf",
      });
      if (result.exitCode !== 0) {
        this.emit(
          "agent.log",
          taskId,
          "Could not refresh sandbox DNS via runtime terminal",
          {
            exitCode: result.exitCode,
            detail: (result.stderr || result.stdout).trim(),
          },
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "sandbox DNS setup failed";
      this.emit("agent.log", taskId, `Skipped sandbox DNS setup: ${message}`, {
        dnsSetupSkipped: true,
      });
    }
  }

  private async cloneRepositoryInSandbox(
    runtime: RuntimeClient,
    taskId: string,
    cloneUrl: string,
    repoCwd: string,
    repository: string,
  ): Promise<void> {
    this.emit("git.clone", taskId, `Cloning ${repository} from GitHub`, {
      repository,
      fromRemote: true,
    });

    await this.ensureSandboxDns(runtime, taskId);

    const attemptClone = async (): Promise<void> => {
      await runtime.gitClone({
        taskId,
        url: cloneUrl,
        path: repoCwd,
      });
    };

    try {
      await attemptClone();
    } catch (firstError) {
      if (!isNetworkCloneFailure(firstError)) {
        throw firstError;
      }
      this.emit(
        "agent.log",
        taskId,
        "Git clone failed; refreshing sandbox DNS and retrying",
        { repository, retry: true },
      );
      await this.ensureSandboxDns(runtime, taskId);
      await sleep(2_000);
      await attemptClone();
    }
  }

  private buildGreenfieldShellReadme(task: Task): string {
    const metadata = generateProjectMetadata(task.prompt);
    const title = task.title ?? metadata.title;
    return `# ${title}\n\n${metadata.description}\n\n_Implementation will be generated by the runtime agent in the sandbox._\n`;
  }

  private async hydrateRepositoryShellInSandbox(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    gitOwner: GitHubUserIdentity | undefined,
    cloneUrl: string,
    githubToken?: string,
  ): Promise<void> {
    const stackRuntime = resolveStackRuntime(task, job);
    const scaffoldFiles = greenfieldShellScaffoldFiles({
      title: task.title ?? "project",
      prompt: task.prompt,
      stackRuntime,
    });

    this.emit("git.clone", task.id, `Hydrating ${task.repository} in sandbox`, {
      repository: task.repository,
      hydrated: true,
      runtimeAgent: true,
      files: scaffoldFiles.map((file) => file.path),
    });

    const gitEnv = this.gitRuntimeEnv(githubToken);

    await runtime.terminal({
      taskId: task.id,
      command: `rm -rf '${escapeShell(repoCwd)}' && mkdir -p '${escapeShell(repoCwd)}'`,
    });

    for (const file of scaffoldFiles) {
      const fullPath = `${repoCwd}/${file.path}`;
      const parentDir = fullPath.includes("/")
        ? fullPath.slice(0, fullPath.lastIndexOf("/"))
        : repoCwd;
      if (parentDir !== repoCwd) {
        await runtime.terminal({
          taskId: task.id,
          command: `mkdir -p '${escapeShell(parentDir)}'`,
        });
      }
      await runtime.writeFile({
        path: fullPath,
        content: file.content,
      });
    }

    await runtime.terminal({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: `git init -b main && git remote add origin '${escapeShell(cloneUrl)}'`,
    });

    await this.configureSandboxGit(runtime, task.id, gitOwner, {
      repoCwd,
      cloneUrl,
      githubToken,
    });

    const aligned = await this.alignHydratedRepoWithOriginMain(
      runtime,
      task.id,
      repoCwd,
      githubToken,
      { hardReset: true },
    );
    if (!aligned) {
      await runtime.gitCommit({
        taskId: task.id,
        cwd: repoCwd,
        env: gitEnv,
        message: buildCommitMessage(
          `devin: initialize ${task.title ?? "project"}`,
        ),
        paths: ["."],
      });
    }
  }

  /**
   * When local hydrate created an orphan history, fetch origin/main and reset.
   * Hard reset is used for greenfield hydrate (files match control-plane push).
   */
  private async alignHydratedRepoWithOriginMain(
    runtime: RuntimeClient,
    taskId: string,
    repoCwd: string,
    githubToken?: string,
    opts?: { hardReset?: boolean },
  ): Promise<boolean> {
    const gitEnv = this.gitRuntimeEnv(githubToken);
    const alignScript = buildAlignHydratedRepoScript({
      hardReset: opts?.hardReset !== false,
    });
    const result = await runtime.terminalAllowFailure({
      taskId,
      cwd: repoCwd,
      env: gitEnv,
      command: alignScript,
    });
    if (result.exitCode !== 0) {
      this.emit(
        "agent.log",
        taskId,
        "Could not align hydrated repo with origin/main",
        {
          detail: (result.stderr || result.stdout || "").trim().slice(0, 400),
        },
      );
      return false;
    }
    this.emit("agent.log", taskId, "Aligned hydrated repo with origin/main", {
      hardReset: opts?.hardReset !== false,
    });
    return true;
  }

  /** @deprecated Use alignHydratedRepoWithOriginMain */
  private async rebaseHydratedRepoOntoOriginMain(
    runtime: RuntimeClient,
    taskId: string,
    repoCwd: string,
    githubToken?: string,
  ): Promise<void> {
    await this.alignHydratedRepoWithOriginMain(
      runtime,
      taskId,
      repoCwd,
      githubToken,
      { hardReset: false },
    );
  }

  private async hydrateGreenfieldInSandbox(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    gitOwner: GitHubUserIdentity | undefined,
    cloneUrl: string,
    githubToken?: string,
  ): Promise<void> {
    const plan = job.draftPlan;
    if (!plan) {
      throw new Error("missing draft plan for greenfield hydration");
    }

    const scaffoldFiles = scaffoldFilesFromDraft(plan, {
      title: task.title ?? "project",
      prompt: task.prompt,
    });

    this.emit("git.clone", task.id, `Hydrating ${task.repository} in sandbox`, {
      repository: task.repository,
      hydrated: true,
      files: scaffoldFiles.map((file) => file.path),
    });

    const gitEnv = this.gitRuntimeEnv(githubToken);

    await runtime.terminal({
      taskId: task.id,
      command: `rm -rf '${escapeShell(repoCwd)}' && mkdir -p '${escapeShell(repoCwd)}'`,
    });

    for (const file of scaffoldFiles) {
      const fullPath = `${repoCwd}/${file.path}`;
      const parentDir = fullPath.includes("/")
        ? fullPath.slice(0, fullPath.lastIndexOf("/"))
        : repoCwd;
      if (parentDir !== repoCwd) {
        await runtime.terminal({
          taskId: task.id,
          command: `mkdir -p '${escapeShell(parentDir)}'`,
        });
      }
      await runtime.writeFile({
        path: fullPath,
        content: file.content,
      });
    }

    await runtime.terminal({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: `git init -b main && git remote add origin '${escapeShell(cloneUrl)}'`,
    });

    await this.configureSandboxGit(runtime, task.id, gitOwner, {
      repoCwd,
      cloneUrl,
      githubToken,
    });

    if (job.greenfieldPushed) {
      const aligned = await this.alignHydratedRepoWithOriginMain(
        runtime,
        task.id,
        repoCwd,
        githubToken,
        { hardReset: true },
      );
      if (!aligned) {
        await runtime.gitCommit({
          taskId: task.id,
          cwd: repoCwd,
          env: gitEnv,
          message: buildCommitMessage(
            `devin: scaffold ${task.title ?? "project"}`,
          ),
          paths: ["."],
        });
      }
      return;
    }

    await runtime.gitCommit({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      message: buildCommitMessage(`devin: scaffold ${task.title ?? "project"}`),
      paths: ["."],
    });

    if (githubToken) {
      await this.ensureSandboxDns(runtime, task.id);
      const syncResult = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        env: gitEnv,
        command: buildAlignHydratedRepoScript({ hardReset: false }),
      });
      if (syncResult.exitCode === 0) {
        this.emit(
          "agent.log",
          task.id,
          "Synced hydrated repo with GitHub main",
          {
            repository: task.repository,
            synced: true,
          },
        );
      } else {
        this.emit(
          "agent.log",
          task.id,
          "Skipped GitHub sync during hydration (sandbox offline)",
          {
            repository: task.repository,
            synced: false,
            detail: (syncResult.stderr || syncResult.stdout).trim(),
          },
        );
      }
    }
  }

  private async ensureSandboxConnectivity(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.ensureSandboxDns(runtime, taskId);
      if (attempt > 0) {
        await sleep(2_000);
      }

      const dnsCheck = await this.probeSandboxDns(
        runtime,
        taskId,
        "api2.cursor.sh",
      );
      const cursorCheck = await this.probeSandboxHttps(
        runtime,
        taskId,
        "https://api2.cursor.sh/",
      );
      const installCheck = await this.probeSandboxHttps(
        runtime,
        taskId,
        "https://cursor.com/",
      );

      if (dnsCheck.ok && cursorCheck.ok) {
        this.emit(
          "agent.log",
          taskId,
          "Sandbox outbound connectivity verified",
          {
            cursorApi: cursorCheck.detail,
            cursorCom: installCheck.ok
              ? installCheck.detail
              : `unreachable (${installCheck.detail})`,
            githubPending: true,
          },
        );
        break;
      }

      this.emit(
        "agent.log",
        taskId,
        `Sandbox egress probe attempt ${attempt + 1}/3`,
        {
          dns: dnsCheck,
          cursor: cursorCheck,
          cursorCom: installCheck,
          attempt: attempt + 1,
        },
      );

      if (attempt === 2) {
        const corrupt =
          /guest filesystem corrupt|Structure needs cleaning/i.test(
            `${dnsCheck.detail} ${cursorCheck.detail} ${installCheck.detail}`,
          );
        const message = corrupt
          ? "Sandbox guest filesystem is corrupt (rootfs/mem snapshot mismatch). " +
            "On the execution host rebuild snapshots: " +
            "DEVIN_FORCE_SNAPSHOT_REBUILD=true DEVIN_RUNTIMES='agent nextjs' " +
            "./infra/scripts/run-ssm-bootstrap-snapshots.sh <instance-id>."
          : "Sandbox has no outbound DNS/HTTPS to the Cursor API (api2.cursor.sh). " +
            "On the execution host run fix-sandbox-dns.sh and fix-cni-and-redeploy-firecracker.sh, then rebuild the agent snapshot.";
        this.emit("agent.log", taskId, message, {
          cursorReachable: false,
          dns: dnsCheck,
          cursor: cursorCheck,
          cursorCom: installCheck,
          guestFsCorrupt: corrupt,
        });
        throw new Error(message);
      }
    }

    const githubCheck = await this.probeSandboxHttps(
      runtime,
      taskId,
      "https://github.com/",
    );

    if (!githubCheck.ok) {
      this.emit(
        "agent.log",
        taskId,
        "GitHub unreachable from sandbox; agent will work locally and push at end may fail",
        {
          githubReachable: false,
          github: githubCheck,
        },
      );
      return;
    }

    this.emit("agent.log", taskId, "Sandbox outbound connectivity verified", {
      cursorReachable: true,
      githubReachable: true,
    });
  }

  private async probeSandboxDns(
    runtime: RuntimeClient,
    taskId: string,
    host: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const result = await runtime.terminalAllowFailure({
      taskId,
      command: `getent ahostsv4 '${escapeShell(host)}' 2>/dev/null | awk 'NR==1{print $1; exit}' || getent ahosts '${escapeShell(host)}' 2>/dev/null | awk '/STREAM/{print $1; exit}'`,
    });
    const address = result.stdout.trim();
    if (result.exitCode === 0 && address) {
      return { ok: true, detail: address };
    }
    return {
      ok: false,
      detail: (result.stderr || result.stdout || "DNS lookup failed").trim(),
    };
  }

  private async probeSandboxHttps(
    runtime: RuntimeClient,
    taskId: string,
    url: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const result = await runtime.terminalAllowFailure({
      taskId,
      command: [
        "set +e",
        `url='${escapeShell(url)}'`,
        "if command -v curl >/dev/null 2>&1; then",
        "  out=$(curl -4sS --connect-timeout 10 --max-time 15 -o /dev/null -w '%{http_code}' \"$url\" 2>&1)",
        "  code=$?",
        '  echo "$out"',
        "  if echo \"$out\" | grep -qi 'Structure needs cleaning'; then",
        "    echo 'guest-fs-corrupt'",
        "  fi",
        "  exit $code",
        "fi",
        "if command -v node >/dev/null 2>&1; then",
        '  node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(15000)}).then(r=>{console.log(r.status); process.exit(0)}).catch(e=>{console.error(String(e)); process.exit(1)})" "$url"',
        "  exit $?",
        "fi",
        "echo 'no-https-client'",
        "exit 127",
      ].join("\n"),
    });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    if (/guest-fs-corrupt|Structure needs cleaning/i.test(combined)) {
      return {
        ok: false,
        detail:
          "guest filesystem corrupt (Structure needs cleaning) — rebuild agent/nextjs snapshots",
      };
    }
    const httpCode =
      combined
        .split(/\s+/)
        .reverse()
        .find((token) => /^[0-9]{3}$/.test(token)) ?? "";
    if (httpCode && httpCode !== "000") {
      return { ok: true, detail: `HTTP ${httpCode}` };
    }
    return {
      ok: false,
      detail: combined || `exit ${result.exitCode}`,
    };
  }

  private async emergencyPushAgentWork(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    githubToken?: string,
    opts?: { greenfield?: boolean },
  ): Promise<void> {
    const gitEnv = this.gitRuntimeEnv(githubToken);
    const status = await runtime.terminal({
      taskId: task.id,
      command: "git status --porcelain",
      cwd: repoCwd,
      env: gitEnv,
    });

    if (!status.stdout.trim()) {
      return;
    }

    await runtime.gitCommit({
      taskId: task.id,
      message: buildCommitMessage(
        `devin: partial work — ${task.title ?? "task incomplete"}`,
      ),
      paths: ["."],
      cwd: repoCwd,
      env: gitEnv,
    });

    if (opts?.greenfield) {
      const pushed = await this.pushGreenfieldMain(
        runtime,
        task.id,
        repoCwd,
        githubToken,
        job.cloneUrl,
      );
      if (pushed) {
        this.emit(
          "git.push",
          task.id,
          "Pushed partial agent work after failure",
          {
            branch: "main",
            recovery: true,
          },
        );
      }
      return;
    }

    await this.ensureGitPushAuth(
      runtime,
      task.id,
      repoCwd,
      githubToken,
      job.cloneUrl,
    );

    const pushResult = await runtime.gitPush({
      taskId: task.id,
      branch: "main",
      cwd: repoCwd,
      env: gitEnv,
    });

    if (pushResult.status === "completed") {
      this.emit(
        "git.push",
        task.id,
        "Pushed partial agent work after failure",
        {
          branch: "main",
          recovery: true,
        },
      );
    }
  }

  /**
   * When a runtime agent times out, commit dirty work and push to main with
   * fetch + force-with-lease so divergent hydrate/checkpoint history still lands.
   */
  private async recoverGreenfieldAfterAgentInterruption(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    githubToken?: string,
    preAgentHead?: string,
  ): Promise<boolean> {
    try {
      const gitEnv = this.gitRuntimeEnv(githubToken);
      const status = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        env: gitEnv,
        command: "git status --porcelain",
      });
      const dirty = status.stdout.trim();
      const head = await this.readGitHead(
        runtime,
        task.id,
        repoCwd,
        githubToken,
      );
      const movedHead =
        Boolean(preAgentHead) && Boolean(head) && head !== preAgentHead;

      if (!dirty && !movedHead) {
        this.emit(
          "agent.log",
          task.id,
          "Agent timeout with no recoverable git work",
        );
        return false;
      }

      if (dirty && job.permissions?.canCommit) {
        await runtime.gitCommit({
          taskId: task.id,
          message: buildCommitMessage(
            `devin: agent timeout recovery — ${task.title ?? "partial work"}`,
          ),
          paths: ["."],
          cwd: repoCwd,
          env: gitEnv,
        });
      }

      if (!job.permissions?.canPush) {
        return Boolean(dirty || movedHead);
      }

      const pushed = await this.pushGreenfieldMain(
        runtime,
        task.id,
        repoCwd,
        githubToken,
        job.cloneUrl,
      );
      if (!pushed) {
        this.emit("git.push", task.id, "Timeout recovery push failed", {
          branch: "main",
          recovery: true,
          timeout: true,
        });
        return false;
      }

      this.emit("git.push", task.id, "Pushed agent work after timeout", {
        branch: "main",
        recovery: true,
        timeout: true,
      });
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Recovery failed";
      this.emit(
        "agent.log",
        task.id,
        `Greenfield timeout recovery failed: ${message}`,
      );
      return false;
    }
  }

  private async pushGreenfieldMain(
    runtime: RuntimeClient,
    taskId: string,
    repoCwd: string,
    githubToken?: string,
    cloneUrl?: string,
  ): Promise<boolean> {
    await this.ensureGitPushAuth(
      runtime,
      taskId,
      repoCwd,
      githubToken,
      cloneUrl,
    );
    const result = await runtime.terminalAllowFailure({
      taskId,
      cwd: repoCwd,
      env: this.gitRuntimeEnv(githubToken),
      command: buildPushGreenfieldMainScript(),
    });
    return result.exitCode === 0;
  }

  private forwardRuntimeEvents(
    runtimeBaseUrl: string,
    taskId: string,
  ): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `${runtimeBaseUrl}/events?taskId=${encodeURIComponent(taskId)}`,
          { signal: controller.signal },
        );
        if (!response.ok || !response.body) {
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          let splitIndex = buffer.indexOf("\n\n");
          while (splitIndex >= 0) {
            const chunk = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);
            this.relayRuntimeChunk(taskId, chunk);
            splitIndex = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // stream closed when task finishes
      }
    })();

    return () => controller.abort();
  }

  private relayRuntimeChunk(taskId: string, chunk: string): void {
    const dataLine = chunk
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!dataLine) {
      return;
    }

    try {
      const payload = JSON.parse(dataLine.slice(6)) as {
        type?: string;
        message?: string;
        data?: Record<string, unknown>;
      };
      if (!payload.type || !payload.message) {
        return;
      }
      this.emitRuntime(
        taskId,
        payload.type as TaskEventType,
        payload.message,
        payload.data,
      );
    } catch {
      // ignore malformed chunks
    }
  }

  private async finalizeGitWork(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    githubToken?: string,
    opts?: { greenfield?: boolean; createPullRequest?: boolean },
  ): Promise<void> {
    const permissions = job.permissions;
    if (!permissions || !job.repository) {
      return;
    }

    const createPullRequest = opts?.createPullRequest ?? true;
    const gitEnv = this.gitRuntimeEnv(githubToken);

    const status = await runtime.terminal({
      taskId: task.id,
      command: "git status --porcelain",
      cwd: repoCwd,
      env: gitEnv,
    });

    const useMainBranch =
      opts?.greenfield === true && createPullRequest === false;
    const branchName = useMainBranch ? "main" : `devin/${task.id.slice(0, 8)}`;
    task.branch = branchName;

    if (!status.stdout.trim()) {
      return;
    }

    if (!useMainBranch && permissions.canPush) {
      await runtime.terminalAllowFailure({
        taskId: task.id,
        command: `git checkout -b ${branchName}`,
        cwd: repoCwd,
        env: gitEnv,
      });
    }

    if (permissions.canCommit) {
      await runtime.gitCommit({
        taskId: task.id,
        message: buildCommitMessage(`devin: ${task.title ?? "agent changes"}`),
        paths: ["."],
        cwd: repoCwd,
        env: gitEnv,
      });
      this.emit("git.commit", task.id, "Committed agent changes", {
        auto: !createPullRequest,
        userApproved: true,
      });
    }

    if (!permissions.canPush) {
      return;
    }

    await this.ensureGitPushAuth(
      runtime,
      task.id,
      repoCwd,
      githubToken,
      job.cloneUrl,
    );

    if (useMainBranch) {
      const pushed = await this.pushGreenfieldMain(
        runtime,
        task.id,
        repoCwd,
        githubToken,
        job.cloneUrl,
      );
      if (!pushed) {
        this.emit("git.push", task.id, "Push skipped or failed", {
          branch: branchName,
        });
        return;
      }
    } else {
      const pushResult = await runtime.gitPush({
        taskId: task.id,
        branch: branchName,
        cwd: repoCwd,
        env: gitEnv,
      });

      if (pushResult.status !== "completed") {
        this.emit("git.push", task.id, "Push skipped or failed", {
          branch: branchName,
        });
        return;
      }
    }

    this.emit("git.push", task.id, `Pushed branch ${branchName}`, {
      branch: branchName,
      userApproved: true,
    });

    if (!createPullRequest || !permissions.canCreatePr || !job.githubToken) {
      return;
    }

    const [owner, repo] = job.repository.split("/");
    if (!owner || !repo) {
      return;
    }

    try {
      const defaultBranch = await fetchDefaultBranch(
        job.githubToken,
        owner,
        repo,
      );
      const pr = await createGitHubPullRequest(job.githubToken, owner, repo, {
        title: task.title ?? `Devin: ${task.prompt.slice(0, 60)}`,
        body: `Automated changes by Devin.\n\n**Prompt:** ${task.prompt}`,
        head: branchName,
        base: defaultBranch,
      });
      task.prUrl = pr.html_url;
      this.emit("git.pr", task.id, `Opened pull request #${pr.number}`, {
        prUrl: pr.html_url,
        number: pr.number,
        userApproved: true,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create pull request";
      this.emit("git.pr", task.id, message, { error: message });
    }
  }

  private async initializeEmptyRepository(
    runtime: RuntimeClient,
    taskId: string,
    cloneUrl: string,
    repoCwd: string,
  ): Promise<void> {
    await runtime.terminal({
      taskId,
      command: `mkdir -p ${repoCwd} && git -C ${repoCwd} init -b main && git -C ${repoCwd} remote add origin '${escapeShell(cloneUrl)}'`,
    });
  }

  private async configureSandboxGit(
    runtime: RuntimeClient,
    taskId: string,
    owner: GitHubUserIdentity | undefined,
    opts?: {
      repoCwd?: string;
      cloneUrl?: string;
      githubToken?: string;
    },
  ): Promise<void> {
    const fallback = resolveBotAuthor();
    const name = owner?.name || owner?.login || fallback.name;
    const email =
      owner?.email || `${owner?.login ?? "devin"}@users.noreply.github.com`;

    const commands = [
      `git config --global user.name '${escapeShell(name)}'`,
      `git config --global user.email '${escapeShell(email)}'`,
    ];

    if (opts?.repoCwd && opts.cloneUrl) {
      commands.push(
        `git -C ${opts.repoCwd} remote set-url origin '${escapeShell(opts.cloneUrl)}'`,
      );
    }

    if (opts?.githubToken) {
      commands.push(
        "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
      );
    }

    await runtime.terminal({
      taskId,
      env: this.gitRuntimeEnv(opts?.githubToken),
      command: commands.join(" && "),
    });
  }

  private async ensureGitPushAuth(
    runtime: RuntimeClient,
    taskId: string,
    repoCwd: string,
    githubToken?: string,
    cloneUrl?: string,
  ): Promise<void> {
    if (!githubToken || !cloneUrl) {
      return;
    }

    await runtime.terminal({
      taskId,
      cwd: repoCwd,
      env: this.gitRuntimeEnv(githubToken),
      command: [
        `git remote set-url origin '${escapeShell(cloneUrl)}'`,
        "git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'",
      ].join(" && "),
    });
  }

  private gitRuntimeEnv(
    githubToken?: string,
  ): Record<string, string> | undefined {
    if (!githubToken) {
      return undefined;
    }
    return { GITHUB_TOKEN: githubToken };
  }

  private startAutoCommitWatcher(
    runtime: RuntimeClient,
    task: Task,
    job: ScheduleJob,
    repoCwd: string,
    gitOwner?: GitHubUserIdentity,
    greenfield = false,
    githubToken?: string,
  ): () => void {
    if (!job.permissions?.canCommit) {
      return () => undefined;
    }

    let stopped = false;
    let lastDirtyFingerprint = "";

    const tick = async () => {
      if (stopped) {
        return;
      }

      const gitEnv = this.gitRuntimeEnv(githubToken);

      try {
        const status = await runtime.terminal({
          taskId: task.id,
          command: "git status --porcelain",
          cwd: repoCwd,
          env: gitEnv,
        });
        const dirty = status.stdout.trim();
        if (!dirty || dirty === lastDirtyFingerprint) {
          return;
        }

        const diff = await runtime.terminal({
          taskId: task.id,
          command: "git diff --stat && git diff --cached --stat",
          cwd: repoCwd,
          env: gitEnv,
        });

        await runtime.gitCommit({
          taskId: task.id,
          message: buildCommitMessage(
            `devin: checkpoint — ${task.title ?? "work in progress"}`,
          ),
          paths: ["."],
          cwd: repoCwd,
          env: gitEnv,
        });

        lastDirtyFingerprint = "";

        this.emit("git.commit", task.id, "Auto-committed checkpoint", {
          auto: true,
          author: gitOwner?.login,
          coAuthor: resolveBotAuthor().name,
          diff: diff.stdout.trim(),
        });

        if (job.permissions?.canPush && greenfield) {
          const pushed = await this.pushGreenfieldMain(
            runtime,
            task.id,
            repoCwd,
            githubToken,
            job.cloneUrl,
          );
          if (pushed) {
            this.emit("git.push", task.id, "Pushed checkpoint to main", {
              branch: "main",
              auto: true,
            });
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Auto-commit failed";
        this.emit("git.commit", task.id, `Checkpoint skipped: ${message}`, {
          auto: true,
          error: message,
        });
      }
    };

    const interval = setInterval(() => {
      void tick();
    }, 60_000);
    const initial = setTimeout(() => {
      void tick();
    }, 45_000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(initial);
    };
  }

  private async readGitHead(
    runtime: RuntimeClient,
    taskId: string,
    repoCwd: string,
    githubToken?: string,
  ): Promise<string> {
    const result = await runtime.terminalAllowFailure({
      taskId,
      cwd: repoCwd,
      env: this.gitRuntimeEnv(githubToken),
      command: "git rev-parse HEAD 2>/dev/null || true",
    });
    return result.stdout.trim();
  }

  /**
   * Cursor agent CLI shebang is `#!/usr/bin/env bash`. Guests often boot with a
   * PATH that omits /bin:/usr/bin, so env cannot find bash even when /bin/bash
   * exists. Old runtime snapshots also prepend only /usr/local/bin — put bash
   * there and rewrite agent shebangs so launches work before snapshot rebuild.
   */
  private async ensureBashInSandbox(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<void> {
    const probe = await runtime.terminalAllowFailure({
      taskId,
      command: [
        "set +e",
        'export PATH="/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
        "bash_bin=''",
        "if command -v bash >/dev/null 2>&1; then bash_bin=$(command -v bash); fi",
        'if [ -z "$bash_bin" ] && [ -x /bin/bash ]; then bash_bin=/bin/bash; fi',
        'if [ -z "$bash_bin" ] && [ -x /usr/bin/bash ]; then bash_bin=/usr/bin/bash; fi',
        'if [ -z "$bash_bin" ] && command -v apt-get >/dev/null 2>&1; then',
        "  apt-get update -qq >/tmp/devin-bash-apt.log 2>&1",
        "  apt-get install -y -qq bash >/tmp/devin-bash-apt.log 2>&1",
        '  export PATH="/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
        "  bash_bin=$(command -v bash)",
        "fi",
        'if [ -z "$bash_bin" ] || [ ! -x "$bash_bin" ]; then',
        "  echo 'bash-not-found'",
        "  exit 1",
        "fi",
        "mkdir -p /usr/local/bin /bin",
        // Old guest PATH is often just /usr/local/bin:/root/.local/bin — env bash
        // must resolve from those dirs without relying on /bin being present.
        'ln -sfn "$bash_bin" /usr/local/bin/bash',
        'if [ ! -x /bin/bash ]; then ln -sfn "$bash_bin" /bin/bash; fi',
        'if [ ! -x /usr/bin/bash ]; then mkdir -p /usr/bin && ln -sfn "$bash_bin" /usr/bin/bash; fi',
        // Simulate legacy agent launch PATH (no /bin) — must succeed.
        'PATH="/usr/local/bin:/root/.local/bin" /usr/bin/env bash -c "echo ok" >/tmp/devin-bash-env-ok 2>/tmp/devin-bash-env-err',
        "ec=$?",
        'if [ "$ec" -ne 0 ]; then',
        '  echo "env-bash-failed:$(cat /tmp/devin-bash-env-err 2>/dev/null)"',
        "  exit 1",
        "fi",
        'printf "%s\\n" "$bash_bin"',
      ].join("\n"),
    });
    if (probe.exitCode !== 0) {
      throw new Error(
        "Sandbox has no usable bash for Cursor agent (#/usr/bin/env bash). " +
          `detail=${(probe.stderr || probe.stdout || "").trim().slice(0, 240)}. ` +
          "Rebuild the agent Firecracker snapshot (runtime/agent/Dockerfile).",
      );
    }
    this.emit("agent.log", taskId, "bash available in sandbox", {
      detail: probe.stdout.trim().slice(0, 120),
      linkedAt: "/usr/local/bin/bash",
    });
  }

  /**
   * Guests sometimes boot from snapshots where `agent` is missing or off PATH.
   * Prefer locating a baked-in binary. Online install is a short fallback — the
   * installer often succeeds while a naive `test -x /root/...` check still fails
   * (HOME mismatch, progress bars on stderr, --version quirks).
   */
  private async ensureCursorAgentInSandbox(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<void> {
    const located = await this.findCursorAgentBinary(runtime, taskId);
    if (located) {
      this.emit("agent.log", taskId, "cursor agent CLI ready in sandbox", {
        detail: located.slice(0, 240),
      });
      await this.linkCursorAgentBinary(runtime, taskId, located);
      return;
    }

    const installHost = await this.probeSandboxHttps(
      runtime,
      taskId,
      "https://cursor.com/",
    );
    if (!installHost.ok) {
      throw new Error(
        "cursor agent CLI is missing from the agent Firecracker snapshot, and the sandbox cannot reach cursor.com to install it" +
          ` (${installHost.detail}). Rebuild the agent snapshot on the execution host` +
          " (./infra/scripts/rebuild-agent-snapshot.sh <instance-id>).",
      );
    }

    this.emit(
      "agent.log",
      taskId,
      "cursor agent CLI missing — attempting short online install",
      {
        cursorCom: installHost.detail,
      },
    );

    // Official installer. Do not use `set -e` across the pipe — curl progress
    // noise on stderr previously masked a successful install, and HOME may not
    // be /root inside the guest.
    const install = await runtime.terminalAllowFailure({
      taskId,
      command: [
        "set +e",
        'export HOME="${HOME:-/root}"',
        'export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
        "curl https://cursor.com/install -fsS | bash",
        "ec=$?",
        'echo "cursor_install_exit=$ec home=$HOME"',
        'ls -la /usr/local/bin/agent /root/.local/bin/agent "$HOME/.local/bin/agent" 2>&1 | head -20',
        "ls -la /root/.local/share/cursor-agent/versions 2>&1 | tail -5",
        'ls -la "$HOME/.local/share/cursor-agent/versions" 2>&1 | tail -5',
        "exit 0",
      ].join("\n"),
    });

    const afterInstall = await this.findCursorAgentBinary(runtime, taskId);
    if (afterInstall) {
      await this.linkCursorAgentBinary(runtime, taskId, afterInstall);
      this.emit("agent.log", taskId, "cursor agent CLI installed in sandbox", {
        detail: afterInstall.slice(0, 240),
        installLog: (install.stdout || "").trim().slice(0, 300),
      });
      return;
    }

    const stdout = (install.stdout || "").trim();
    const stderr = (install.stderr || "").trim();
    // Prefer installer text over curl progress-bar spam on stderr.
    const detail =
      stdout
        .split("\n")
        .filter((line) => !/^#/.test(line.trim()) && !/^\s*[\d.]+%$/.test(line))
        .join("\n")
        .trim()
        .slice(0, 500) ||
      stderr
        .split("\n")
        .filter((line) => !line.includes("#") && !/\d+\.\d+%/.test(line))
        .join("\n")
        .trim()
        .slice(0, 400) ||
      "agent binary not found after install";

    throw new Error(
      "cursor agent CLI is not available in the sandbox after install" +
        (detail ? `: ${detail}` : "") +
        ". Rebuild the agent Firecracker snapshot" +
        " (./infra/scripts/rebuild-agent-snapshot.sh <instance-id>).",
    );
  }

  private async findCursorAgentBinary(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<string | null> {
    const findCmd = [
      "set +e",
      'export HOME="${HOME:-/root}"',
      'export PATH="/usr/local/bin:/root/.local/bin:$HOME/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
      "for candidate in \\",
      "  /usr/local/bin/agent \\",
      "  /root/.local/bin/agent \\",
      '  "$HOME/.local/bin/agent" \\',
      "  $(command -v agent 2>/dev/null) \\",
      "  $(command -v cursor-agent 2>/dev/null) \\",
      "  $(ls -1 /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | sort | tail -1) \\",
      '  $(ls -1 "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent 2>/dev/null | sort | tail -1)',
      "do",
      '  [ -n "$candidate" ] || continue',
      '  [ -e "$candidate" ] || continue',
      // Accept a present executable even if --version is flaky in the guest.
      '  if [ -x "$candidate" ] || [ -L "$candidate" ]; then',
      '    if "$candidate" --version >/dev/null 2>&1 || [ -x "$candidate" ]; then',
      '      printf "%s\\n" "$candidate"',
      "      exit 0",
      "    fi",
      "  fi",
      "done",
      "exit 1",
    ].join("\n");

    const probe = await runtime.terminalAllowFailure({
      taskId,
      command: findCmd,
    });
    if (probe.exitCode !== 0) {
      return null;
    }
    const bin = probe.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("/") || line.includes("agent"));
    return bin || null;
  }

  private async linkCursorAgentBinary(
    runtime: RuntimeClient,
    taskId: string,
    bin: string,
  ): Promise<void> {
    await runtime.terminalAllowFailure({
      taskId,
      command: [
        "set +e",
        'export PATH="/usr/local/bin:/root/.local/bin:/usr/bin:/bin:$PATH"',
        "mkdir -p /usr/local/bin /root/.local/bin",
        `target='${escapeShell(bin)}'`,
        'if [ -z "$target" ] || [ ! -e "$target" ]; then target=$(command -v agent 2>/dev/null); fi',
        'if [ -z "$target" ] || [ ! -e "$target" ]; then exit 0; fi',
        // Prefer a previously saved real binary so re-linking does not wrap our
        // own PATH wrapper (which would recurse on exec).
        "real=''",
        "if [ -e /root/.local/bin/agent.real ]; then",
        "  real=$(readlink -f /root/.local/bin/agent.real 2>/dev/null || printf '%s' /root/.local/bin/agent.real)",
        "fi",
        'if [ -z "$real" ] || [ ! -e "$real" ]; then',
        '  real=$(readlink -f "$target" 2>/dev/null || printf "%s" "$target")',
        "fi",
        // If target already is our wrapper, dig out the exec line fallback.
        'if [ -f "$real" ] && head -n 1 "$real" 2>/dev/null | grep -q "^#!/bin/sh$" \\',
        '   && grep -q "agent.real" "$real" 2>/dev/null; then',
        "  if [ -e /root/.local/bin/agent.real ]; then",
        "    real=$(readlink -f /root/.local/bin/agent.real 2>/dev/null || printf '%s' /root/.local/bin/agent.real)",
        "  fi",
        "fi",
        'if [ -z "$real" ] || [ ! -e "$real" ]; then exit 0; fi',
        'ln -sfn "$real" /root/.local/bin/agent.real',
        "bash_abs=/usr/local/bin/bash",
        "[ -x /bin/bash ] && bash_abs=/bin/bash",
        "[ -x /usr/bin/bash ] && bash_abs=/usr/bin/bash",
        // Wrapper forces a full PATH before exec so nested #!/usr/bin/env bash
        // shebangs resolve even on old snapshots with stripped guest PATH.
        "cat > /usr/local/bin/agent <<'WRAP'",
        "#!/bin/sh",
        'export PATH="/usr/local/bin:/root/.local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"',
        'exec /root/.local/bin/agent.real "$@"',
        "WRAP",
        "chmod +x /usr/local/bin/agent",
        "ln -sfn /usr/local/bin/agent /root/.local/bin/agent",
        'if [ -f "$real" ] && [ ! -L "$real" ]; then',
        '  first=$(head -n 1 "$real" 2>/dev/null || true)',
        '  case "$first" in',
        "  '#!/usr/bin/env bash'*)",
        '    sed -i "1s|^#!/usr/bin/env bash.*|#!${bash_abs}|" "$real" 2>/dev/null || true',
        '    chmod +x "$real" 2>/dev/null || true',
        "    ;;",
        "  esac",
        "fi",
        'PATH="/usr/local/bin:/root/.local/bin" /usr/bin/env bash -c "true" || exit 1',
        "exit 0",
      ].join("\n"),
    });
  }

  /**
   * Greenfield agents must leave commits or a dirty tree. Completing with only
   * the control-plane scaffold made chat apps look "done" while still stubs.
   * Compare against the pre-agent HEAD so pushes to origin/main mid-run do not
   * look like "zero progress".
   */
  private async assertGreenfieldAgentProgress(
    runtime: RuntimeClient,
    task: Task,
    repoCwd: string,
    githubToken: string | undefined,
    preAgentHead: string,
  ): Promise<void> {
    const gitEnv = this.gitRuntimeEnv(githubToken);
    const probe = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      env: gitEnv,
      command: [
        "set +e",
        "head=$(git rev-parse HEAD 2>/dev/null || true)",
        "dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')",
        "new_commits=0",
        `base='${preAgentHead.replace(/'/g, "")}'`,
        'if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then',
        '  new_commits=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)',
        "fi",
        'echo "head=$head dirty=$dirty new_commits=$new_commits base=$base"',
        "grep -RIl -E 'Scaffold ready|Scaffold is running|Implement the full app' --include='*.js' --include='*.ts' --include='*.html' --include='*.tsx' --include='*.jsx' . 2>/dev/null | head -8",
      ].join("\n"),
    });

    const output = `${probe.stdout}\n${probe.stderr}`.trim();
    const headMatch = output.match(/^head=(\S+)/m);
    const dirtyMatch = output.match(/dirty=(\d+)/);
    const newCommitsMatch = output.match(/new_commits=(\d+)/);
    const head = headMatch?.[1] ?? "";
    const dirty = Number(dirtyMatch?.[1] ?? 0);
    const newCommits = Number(newCommitsMatch?.[1] ?? 0);
    const movedHead =
      Boolean(preAgentHead) && Boolean(head) && head !== preAgentHead;
    const leakLines = output
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !line.startsWith("head=") &&
          (line.endsWith(".js") ||
            line.endsWith(".ts") ||
            line.endsWith(".tsx") ||
            line.endsWith(".jsx") ||
            line.endsWith(".html")),
      );

    this.emit("agent.log", task.id, "Checking greenfield agent progress", {
      preAgentHead: preAgentHead || null,
      head: head || null,
      dirty,
      newCommits,
      movedHead,
      scaffoldLeakFiles: leakLines,
    });

    if (!movedHead && newCommits < 1 && dirty < 1) {
      throw new Error(
        "Agent finished without product commits — scaffold was left unchanged. " +
          "The cursor agent must edit files and commit (CLI missing, sandbox, or no-op run).",
      );
    }

    if (leakLines.length > 0 && newCommits < 2 && dirty < 1) {
      throw new Error(
        `Agent left scaffold placeholders in place (${leakLines.slice(0, 3).join(", ")}). Implement the full product with multiple focused commits.`,
      );
    }
  }

  private async runTemplateGreenfieldVerify(
    runtime: RuntimeClient,
    task: Task,
    repoCwd: string,
    stackRuntime: StackRuntime,
  ): Promise<RunResponse> {
    this.emit("agent.log", task.id, "Running template verify pipeline", {
      agent: "mock",
      phase: "template_verify",
      runtime: stackRuntime,
    });

    const hasPackageJson = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command: "test -f package.json && echo yes || echo no",
    });

    const hasGoMod = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command: "test -f go.mod && echo yes || echo no",
    });

    const hasCargoToml = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command: "test -f Cargo.toml && echo yes || echo no",
    });

    const hasPythonProject = await runtime.terminalAllowFailure({
      taskId: task.id,
      cwd: repoCwd,
      command:
        "test -f requirements.txt -o -f pyproject.toml -o -f setup.py && echo yes || echo no",
    });

    if (stackRuntime === "go" || hasGoMod.stdout.trim() === "yes") {
      this.emit("agent.log", task.id, "Verifying Go module", { cwd: repoCwd });
      const tidy = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        command: "timeout 120 go mod tidy 2>&1",
      });
      if (tidy.exitCode !== 0 && tidy.exitCode !== 124) {
        throw new Error(
          `go mod tidy failed: ${tidy.stderr || tidy.stdout}`.trim(),
        );
      }
    } else if (
      stackRuntime === "rust" ||
      hasCargoToml.stdout.trim() === "yes"
    ) {
      this.emit("agent.log", task.id, "Verifying Rust crate", { cwd: repoCwd });
      const check = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        command: "timeout 180 cargo check 2>&1",
      });
      if (check.exitCode !== 0 && check.exitCode !== 124) {
        throw new Error(
          `cargo check failed: ${check.stderr || check.stdout}`.trim(),
        );
      }
    } else if (
      stackRuntime === "python" ||
      hasPythonProject.stdout.trim() === "yes"
    ) {
      this.emit("agent.log", task.id, "Installing Python dependencies", {
        cwd: repoCwd,
      });
      const install = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        command:
          "timeout 180 bash -lc 'if [ -f requirements.txt ]; then pip install -r requirements.txt; elif [ -f pyproject.toml ]; then pip install .; else pip install flask fastapi; fi' 2>&1",
      });
      if (install.exitCode === 124) {
        throw new Error("Python dependency install timed out after 180s");
      }
    } else if (hasPackageJson.stdout.trim() === "yes") {
      this.emit("agent.log", task.id, "Installing dependencies (npm install)", {
        cwd: repoCwd,
      });

      const install = await runtime.terminal({
        taskId: task.id,
        cwd: repoCwd,
        command: "timeout 180 npm install --no-audit --progress=false 2>&1",
      });

      if (install.exitCode === 124) {
        throw new Error(
          "npm install timed out after 180s — check sandbox outbound network, DNS, and npm registry access",
        );
      }

      if (install.exitCode !== 0) {
        throw new Error(
          `npm install failed with exit code ${install.exitCode}: ${install.stderr || install.stdout}`,
        );
      }

      this.emit("agent.log", task.id, "Dependencies installed", {
        exitCode: install.exitCode,
      });

      const smoke = await runtime.terminalAllowFailure({
        taskId: task.id,
        cwd: repoCwd,
        command:
          'bash -lc \'if ! grep -q "\\"start\\"" package.json 2>/dev/null; then exit 0; fi; npm start >/tmp/devin-smoke.log 2>&1 & pid=$!; ok=0; for i in $(seq 1 30); do if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi; if curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1; then ok=1; break; fi; if ! kill -0 $pid 2>/dev/null; then break; fi; sleep 1; done; kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true; test $ok -eq 1\'',
      });

      if (smoke.exitCode === 0) {
        this.emit("agent.log", task.id, "Smoke check passed (HTTP 200)", {
          endpoint: "http://127.0.0.1:3000",
        });
      } else {
        this.emit(
          "agent.log",
          task.id,
          "Smoke check skipped or failed — continuing with scaffold push",
          {
            detail: (smoke.stderr || smoke.stdout).trim(),
          },
        );
      }
    } else {
      this.emit(
        "agent.log",
        task.id,
        "No package.json — skipping npm install and smoke check",
        { cwd: repoCwd },
      );
    }

    const message = "Template scaffold verified in sandbox";
    this.emit("agent.log", task.id, message, {
      agent: "mock",
      completed: true,
    });

    return {
      taskId: task.id,
      status: "completed",
      message,
      output: message,
      agent: "mock",
    };
  }

  private async runTests(
    runtime: RuntimeClient,
    task: Task,
    testCommand: string,
    repoCwd: string,
  ): Promise<void> {
    this.emit("tests.running", task.id, `Running tests: ${testCommand}`, {
      command: testCommand,
    });

    const result = await runtime.terminal({
      taskId: task.id,
      command: testCommand,
      cwd: repoCwd,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `tests failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
      );
    }

    this.emit("tests.running", task.id, "Tests passed", {
      command: testCommand,
      exitCode: result.exitCode,
    });
  }

  private async attachPreviewHomepage(
    taskId: string,
    repository: string,
    previewUrl: string,
    token: string,
  ): Promise<void> {
    try {
      await setRepositoryHomepage(token, repository, previewUrl);
      this.emit(
        "deploy.ready",
        taskId,
        "Attached preview URL to GitHub repository website",
        { repository, previewUrl, homepage: previewUrl },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to set repository homepage";
      this.emit("deploy.ready", taskId, message, {
        repository,
        previewUrl,
        error: message,
      });
    }
  }

  private async createTaskIssue(
    task: Task,
    repository: string,
    token: string,
    job: ScheduleJob,
  ): Promise<void> {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo || !job.issueTitle) {
      return;
    }

    try {
      const issue = await createGitHubIssue(token, owner, repo, {
        title: job.issueTitle,
        body:
          job.issueBody ??
          `Created by Devin for task ${task.id}.\n\n**Prompt:** ${task.prompt}`,
      });
      this.emit("git.issue", task.id, `Opened issue #${issue.number}`, {
        issueUrl: issue.htmlUrl,
        number: issue.number,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create issue";
      this.emit("git.issue", task.id, message, { error: message });
    }
  }

  private runtimeSecrets(githubToken?: string): Record<string, string> {
    const secrets: Record<string, string> = {};
    for (const key of ["CURSOR_API_KEY", "ANTHROPIC_API_KEY"] as const) {
      const value = process.env[key]?.trim();
      if (value) {
        secrets[key] = value;
      }
    }
    const agentTimeout = String(resolveAgentTimeoutMinutes());
    secrets.AGENT_RUN_TIMEOUT_MIN = agentTimeout;
    const model = process.env.AGENT_MODEL?.trim() || "composer-2-fast";
    secrets.AGENT_MODEL = model;
    if (githubToken) {
      secrets.GITHUB_TOKEN = githubToken;
    }
    return secrets;
  }

  private async ensureSandbox(
    sandboxName: string,
    taskId: string,
    spec: Record<string, unknown>,
  ): Promise<void> {
    const create = async (): Promise<number> => {
      const response = await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: sandboxName, spec }),
        },
      );
      return response.status;
    };

    let status = await create();
    if (status === 409) {
      const existing = await this.fetchSandbox(sandboxName);
      const phase = existing?.status?.phase;

      if (phase === "Running") {
        this.emit(
          "task.scheduled",
          taskId,
          "Reusing running sandbox from prior attempt",
          { sandboxName, phase },
        );
        return;
      }

      this.emit(
        "task.scheduled",
        taskId,
        "Removing stale sandbox before retry",
        { sandboxName, phase: phase ?? "unknown" },
      );
      await this.deleteSandbox(sandboxName);
      await this.waitForSandboxDeleted(sandboxName);

      status = await create();
    }

    if (status !== 202 && status !== 200 && status !== 409) {
      const message = `orchestrator rejected sandbox: HTTP ${status}`;
      this.emit("sandbox.failed", taskId, message, {
        sandboxName,
        status,
      });
      throw new Error(message);
    }
  }

  private async fetchSandbox(
    sandboxName: string,
  ): Promise<SandboxRecord | undefined> {
    try {
      const response = await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
      );
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as SandboxRecord;
    } catch {
      return undefined;
    }
  }

  private async provisionSandboxWithCapacityRetry(
    sandboxName: string,
    taskId: string,
    spec: Record<string, unknown>,
    _requiredCpu: number,
  ): Promise<void> {
    await this.ensureSandbox(sandboxName, taskId, spec);
  }

  private async reclaimDevboxCapacity(
    taskId: string,
    requiredCpu: number,
  ): Promise<number> {
    const sandboxes = await listSandboxes(this.orchestratorUrl);
    let reclaimed = 0;
    const protectedTaskIds = new Set<string>([
      taskId,
      ...this.activeSessions.keys(),
      ...this.reviewSessions.keys(),
      ...this.processingTasks,
    ]);

    for (const sandbox of sandboxes) {
      if (sandbox.phase === "Failed") {
        await this.deleteSandbox(sandbox.name);
        reclaimed += 1;
        this.emit(
          "agent.log",
          taskId,
          `Reclaimed failed sandbox ${sandbox.name}`,
          { sandboxName: sandbox.name, reclaimed: true },
        );
      }
    }

    for (const sandbox of sandboxes) {
      const ownerTaskId = sandbox.taskId?.trim();
      if (!ownerTaskId || protectedTaskIds.has(ownerTaskId)) {
        continue;
      }
      if (sandbox.phase !== "Running" && sandbox.phase !== "Provisioning") {
        continue;
      }

      const owner =
        this.tasks.get(ownerTaskId) ??
        (await this.taskStore.getTask(ownerTaskId));
      const abandoned =
        !owner ||
        owner.status === "failed" ||
        owner.status === "cancelled" ||
        owner.status === "completed";
      if (!abandoned) {
        continue;
      }

      await this.forceTerminateDevbox(ownerTaskId, sandbox.name, taskId);
      reclaimed += 1;
      protectedTaskIds.add(ownerTaskId);
    }

    if (reclaimed === 0 && requiredCpu > 0) {
      // Last resort: delete an unprotected Running sandbox so a new task can
      // start even when completed-session tracking is incomplete.
      const candidate = sandboxes.find((entry) => {
        const ownerTaskId = entry.taskId?.trim();
        return (
          !!ownerTaskId &&
          !protectedTaskIds.has(ownerTaskId) &&
          (entry.phase === "Running" || entry.phase === "Provisioning")
        );
      });
      if (candidate?.taskId) {
        await this.forceTerminateDevbox(
          candidate.taskId,
          candidate.name,
          taskId,
        );
        reclaimed += 1;
        protectedTaskIds.add(candidate.taskId);
      }
    }

    if (reclaimed === 0 && requiredCpu > 0) {
      const staleTaskId = await this.findStaleDevboxSessionTaskId();
      if (staleTaskId && !protectedTaskIds.has(staleTaskId)) {
        const staleSandbox = sandboxes.find(
          (entry) => entry.taskId === staleTaskId,
        );
        if (staleSandbox) {
          await this.forceTerminateDevbox(
            staleTaskId,
            staleSandbox.name,
            taskId,
          );
          reclaimed += 1;
        }
      }
    }

    if (reclaimed > 0) {
      this.emit("agent.log", taskId, `Reclaimed ${reclaimed} devbox(es)`, {
        reclaimed,
        requiredCpu,
      });
    }

    return reclaimed;
  }

  private async findStaleDevboxSessionTaskId(): Promise<string | undefined> {
    const cutoff = Date.now() - 20 * 60 * 1000;
    let oldestTaskId: string | undefined;
    let oldestActiveAt = Number.POSITIVE_INFINITY;

    for (const [taskId] of this.activeSessions) {
      const persisted = await this.taskStore.getSession(taskId);
      const task =
        this.tasks.get(taskId) ?? (await this.taskStore.getTask(taskId));
      if (!task || task.status !== "completed") {
        continue;
      }
      const lastActive = persisted
        ? new Date(persisted.lastActiveAt).getTime()
        : new Date(task.updatedAt ?? task.createdAt).getTime();
      if (lastActive < cutoff && lastActive < oldestActiveAt) {
        oldestActiveAt = lastActive;
        oldestTaskId = taskId;
      }
    }

    return oldestTaskId;
  }

  private async forceTerminateDevbox(
    ownerTaskId: string,
    sandboxName: string,
    requestingTaskId: string,
  ): Promise<void> {
    await this.deleteSandbox(sandboxName);
    this.activeSessions.delete(ownerTaskId);
    this.reviewSessions.delete(ownerTaskId);
    await this.taskStore.deleteSession(ownerTaskId);

    const owner = this.tasks.get(ownerTaskId);
    if (owner) {
      owner.sessionActive = false;
      owner.sessionSleeping = false;
      owner.sandboxName = undefined;
      await this.taskStore.upsertTask(owner);
    }

    this.emit(
      "agent.log",
      requestingTaskId,
      `Reclaimed devbox ${sandboxName} from task ${ownerTaskId}`,
      {
        reclaimedFrom: ownerTaskId,
        sandboxName,
        reason: "capacity",
      },
    );
  }

  private async reclaimFailedSandboxes(taskId: string): Promise<number> {
    return this.reclaimDevboxCapacity(taskId, 1);
  }

  private async deleteSandbox(sandboxName: string): Promise<void> {
    try {
      await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
        { method: "DELETE" },
      );
    } catch {
      // best-effort cleanup
    }
  }

  private async waitForSandboxDeleted(sandboxName: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const sandbox = await this.fetchSandbox(sandboxName);
      if (!sandbox) {
        return;
      }
      await sleep(500);
    }
    throw new Error(`sandbox ${sandboxName} was not deleted before retry`);
  }

  private async waitForSandbox(
    sandboxName: string,
    taskId: string,
  ): Promise<SandboxRecord> {
    const deadline = Date.now() + this.sandboxReadyTimeoutMs;
    let lastPhase = "unknown";
    let lastMessage = "";
    let lastProgressAt = 0;
    let pendingSince: number | null = null;

    while (Date.now() < deadline) {
      const sandbox = await this.fetchSandbox(sandboxName);
      if (sandbox) {
        const phase = sandbox.status?.phase ?? "Pending";
        const message = sandbox.status?.message?.trim() ?? "";
        const phaseChanged = phase !== lastPhase;
        const messageChanged = message !== lastMessage;
        lastPhase = phase;
        lastMessage = message;

        if (phase === "Pending" || phase === "Provisioning") {
          pendingSince ??= Date.now();
          const pendingMs = Date.now() - pendingSince;
          if (
            phase === "Pending" &&
            pendingMs > 90_000 &&
            !message &&
            !sandbox.status?.vmId
          ) {
            const stuckMessage =
              `sandbox ${sandboxName} is stuck in Pending — the orchestrator sandbox controller may not be running, ` +
              "or spec.preferredHost does not match any FirecrackerHost CR. " +
              "Verify FirecrackerHost CRs in devin-firecracker and SCHEDULER_HOST_NAME on the execution host.";
            this.emit("sandbox.failed", taskId, stuckMessage, {
              sandboxName,
              phase,
              pendingMs,
            });
            throw new Error(stuckMessage);
          }
        } else {
          pendingSince = null;
        }

        if (
          (phaseChanged || messageChanged) &&
          Date.now() - lastProgressAt >= 1_000
        ) {
          lastProgressAt = Date.now();
          this.emit(
            "sandbox.provisioning",
            taskId,
            message
              ? `Sandbox ${phase}: ${message}`
              : `Sandbox phase is ${phase}`,
            {
              sandboxName,
              phase,
              message: message || undefined,
              vmId: sandbox.status?.vmId,
              host: sandbox.status?.host,
              runtimeURL: sandbox.status?.runtimeURL,
              elapsedMs: this.sandboxReadyTimeoutMs - (deadline - Date.now()),
            },
          );
        }

        if (phase === "Running") {
          return sandbox;
        }
        if (phase === "Suspended") {
          await sleep(500);
          continue;
        }
        if (phase === "Waking") {
          lastPhase = phase;
          await sleep(500);
          continue;
        }
        if (phase === "Failed") {
          const failureMessage = lastMessage
            ? `sandbox ${sandboxName} failed: ${lastMessage}`
            : `sandbox ${sandboxName} failed for task ${taskId}`;
          const retryableCapacity =
            /lacks capacity/i.test(lastMessage) ||
            (/not found/i.test(lastMessage) &&
              /firecracker\s*host/i.test(lastMessage));
          if (retryableCapacity && Date.now() < deadline - 30_000) {
            const reclaimed = await this.reclaimDevboxCapacity(taskId, 1);
            if (reclaimed > 0) {
              await this.deleteSandbox(sandboxName);
              await this.waitForSandboxDeleted(sandboxName);
              await sleep(3_000);
              lastPhase = "unknown";
              lastMessage = "";
              pendingSince = null;
              continue;
            }
            this.emit(
              "sandbox.provisioning",
              taskId,
              `Waiting for execution host capacity (${lastMessage})`,
              {
                sandboxName,
                phase,
                message: lastMessage,
                waitingForCapacity: true,
              },
            );
            await sleep(5_000);
            continue;
          }
          const hostRegistryHint =
            /firecracker\s*host/i.test(lastMessage) &&
            /not found|lacks capacity/i.test(lastMessage) &&
            this.preferredHost
              ? ` Re-register with: curl -X PUT -H 'Content-Type: application/json' -d '{"spec":{"address":"http://<host-ip>:9092","schedulerAddress":"http://<host-ip>:9091","capacity":{"cpu":2,"memory":"16Gi"}}}' ${this.orchestratorUrl}/internal/v1/firecracker-hosts/${this.preferredHost}`
              : undefined;
          this.emit("sandbox.failed", taskId, failureMessage, {
            sandboxName,
            phase,
            message: lastMessage || undefined,
            preferredHost: this.preferredHost,
            remediation: hostRegistryHint,
          });
          throw new Error(
            /lacks capacity/i.test(lastMessage)
              ? `${failureMessage}. End idle devbox sessions on this host or wait for capacity to free up.`
              : /firecracker\s*host/i.test(lastMessage) &&
                  /not found/i.test(lastMessage)
                ? `${failureMessage}. Ensure FirecrackerHost ${this.preferredHost ?? "registration"} is registered with the orchestrator.`
                : failureMessage,
          );
        }
      } else if (Date.now() - lastProgressAt >= 3_000) {
        lastProgressAt = Date.now();
        this.emit(
          "sandbox.provisioning",
          taskId,
          "Sandbox not found in orchestrator yet — still waiting",
          {
            sandboxName,
            phase: "unknown",
            orchestratorUrl: this.orchestratorUrl,
          },
        );
      }
      await sleep(500);
    }

    const detail = lastMessage
      ? ` (phase=${lastPhase}, ${lastMessage})`
      : ` (phase=${lastPhase})`;
    const timeoutMessage = `sandbox ${sandboxName} did not become ready for task ${taskId} within ${this.sandboxReadyTimeoutMs / 1000}s${detail}`;
    this.emit("sandbox.failed", taskId, timeoutMessage, {
      sandboxName,
      phase: lastPhase,
      message: lastMessage || undefined,
      timeoutSeconds: this.sandboxReadyTimeoutMs / 1000,
    });
    throw new Error(timeoutMessage);
  }

  private async waitForRuntime(
    runtime: RuntimeClient,
    taskId: string,
    runtimeBaseUrl: string,
  ): Promise<void> {
    const deadline = Date.now() + this.runtimeReadyTimeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const health = await runtime.health();
        if (health.status === "ok") {
          return;
        }
        lastError = `unexpected health status: ${health.status ?? "unknown"}`;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : "runtime health probe failed";
      }
      await sleep(500);
    }
    const detail = lastError ? ` Last error: ${lastError}` : "";
    throw new Error(
      `Runtime supervisor at ${runtimeBaseUrl} did not become ready for task ${taskId} within ${this.runtimeReadyTimeoutMs / 1000}s.${detail}`,
    );
  }

  private updateTask(
    taskId: string,
    status: TaskStatus,
    message: string,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.status = status;
    task.message = message;
    task.updatedAt = new Date().toISOString();
    void this.taskStore.upsertTask(task);
  }

  private patchTask(
    taskId: string,
    patch: Partial<
      Pick<
        Task,
        | "previewUrl"
        | "deployStatus"
        | "branch"
        | "prUrl"
        | "sessionActive"
        | "sessionSleeping"
        | "sandboxName"
      >
    >,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();
    void this.taskStore.upsertTask(task);
  }

  private emit(
    type:
      | "task.created"
      | "task.scheduled"
      | "task.phase_changed"
      | "draft.started"
      | "draft.updated"
      | "draft.diff"
      | "draft.completed"
      | "draft.failed"
      | "execution.started"
      | "sandbox.requested"
      | "sandbox.provisioning"
      | "sandbox.started"
      | "sandbox.failed"
      | "runtime.waiting"
      | "runtime.ready"
      | "agent.running"
      | "git.clone"
      | "git.commit"
      | "git.push"
      | "git.pr"
      | "git.repo"
      | "git.issue"
      | "tests.running"
      | "deploy.building"
      | "deploy.ready"
      | "deploy.failed"
      | "task.completed"
      | "task.failed",
    taskId: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const sequence = this.nextEventSequence(taskId);
    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data: {
        source: "scheduler",
        sequence,
        ...(data ?? {}),
      },
    };
    this.eventBus.publish(event);
    void this.taskStore.appendEvent(event, sequence);
  }

  private emitRuntime(
    taskId: string,
    type: TaskEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const sequence = this.nextEventSequence(taskId);
    const event: TaskEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data: {
        source: "runtime",
        sequence,
        ...(data ?? {}),
      },
    };
    this.eventBus.publish(event);
    void this.taskStore.appendEvent(event, sequence);
  }

  private nextEventSequence(taskId: string): number {
    const next = (this.eventSequences.get(taskId) ?? 0) + 1;
    this.eventSequences.set(taskId, next);
    return next;
  }

  private async restoreFromStore(): Promise<void> {
    const sequences = await this.taskStore.restoreEventSequences();
    for (const [taskId, seq] of sequences) {
      this.eventSequences.set(taskId, seq);
    }

    const tasks = await this.taskStore.listTasks();
    for (const task of tasks) {
      this.tasks.set(task.id, task);
      const events = await this.taskStore.loadEvents(task.id);
      for (const event of events) {
        this.eventBus.publish(event);
      }
    }

    const sessions = await this.taskStore.loadActiveSessions();
    for (const persisted of sessions) {
      if (persisted.state === "sleeping") {
        continue;
      }
      const task = this.tasks.get(persisted.taskId);
      if (!task) {
        continue;
      }
      const runtime = new RuntimeClient(persisted.runtimeBaseUrl);
      try {
        const health = await runtime.health();
        if (health.status !== "ok") {
          task.sessionActive = false;
          continue;
        }
      } catch {
        task.sessionActive = false;
        continue;
      }

      const session: ReviewSession = {
        runtime,
        sandboxName: persisted.sandboxName,
        runtimeBaseUrl: persisted.runtimeBaseUrl,
        repoCwd: persisted.repoCwd,
        job: persisted.job,
        githubToken: persisted.githubToken,
        createdNewRepo: persisted.createdNewRepo,
        guestHost: persisted.guestHost,
      };

      if (persisted.state === "review") {
        this.reviewSessions.set(persisted.taskId, session);
      } else {
        this.activeSessions.set(persisted.taskId, session);
      }
      this.pendingJobs.set(persisted.taskId, persisted.job);
      task.sessionActive = true;
      task.sandboxName = persisted.sandboxName;
    }
  }

  private async persistSession(
    taskId: string,
    session: ReviewSession,
    state: PersistedSession["state"],
  ): Promise<void> {
    await this.taskStore.upsertSession({
      taskId,
      sandboxName: session.sandboxName,
      runtimeBaseUrl: session.runtimeBaseUrl,
      repoCwd: session.repoCwd,
      state,
      job: session.job,
      githubToken: session.githubToken,
      createdNewRepo: session.createdNewRepo,
      guestHost: session.guestHost,
      lastActiveAt: new Date().toISOString(),
    });
  }

  private startIdleWatchdog(): void {
    if (this.idleWatchdog || this.mode === "brain") {
      return;
    }

    this.idleWatchdog = setInterval(() => {
      void this.runIdleWatchdog();
    }, 60_000);
  }

  private async runIdleWatchdog(): Promise<void> {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [taskId, session] of this.activeSessions) {
      const persisted = await this.taskStore.getSession(taskId);
      const lastActive = persisted
        ? new Date(persisted.lastActiveAt).getTime()
        : Date.now();
      if (lastActive >= cutoff) {
        continue;
      }
      await this.sleepIdleSession(taskId, session);
    }
  }

  private async sleepIdleSession(
    taskId: string,
    session: ReviewSession,
  ): Promise<void> {
    if (this.processingTasks.has(taskId)) {
      return;
    }

    await this.suspendSandbox(session.sandboxName);
    this.activeSessions.delete(taskId);
    await this.taskStore.markSessionSleeping(taskId);

    const task = this.tasks.get(taskId);
    if (task) {
      task.sessionActive = false;
      task.sessionSleeping = true;
      await this.taskStore.upsertTask(task);
    }

    this.emit("task.phase_changed", taskId, "Devbox idle — session sleeping", {
      phase: "sleeping",
      sessionActive: false,
      sessionSleeping: true,
      sandboxName: session.sandboxName,
    });
  }

  private async suspendSandbox(sandboxName: string): Promise<void> {
    try {
      await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}/suspend`,
        { method: "POST" },
      );
    } catch {
      // best-effort soft sleep
    }
  }

  private async wakeSandbox(sandboxName: string): Promise<void> {
    const response = await fetch(
      `${this.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}/wake`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new Error(`failed to wake sandbox ${sandboxName}`);
    }
  }

  private async resolveRuntimeUrl(sandboxName: string): Promise<string> {
    const sandbox = await this.waitForSandbox(sandboxName, "wake");
    const runtimeURL = sandbox.status?.runtimeURL?.trim();
    if (!runtimeURL) {
      throw new Error(`sandbox ${sandboxName} has no runtime URL after wake`);
    }
    return runtimeURL.replace(/\/$/, "");
  }

  private async delegateJobToWorker(job: ScheduleJob): Promise<void> {
    if (!this.executionWorkerUrl) {
      throw new Error(
        "EXECUTION_WORKER_URL is required when SERVICE_MODE=brain",
      );
    }

    const response = await fetch(
      `${this.executionWorkerUrl.replace(/\/$/, "")}/internal/v1/jobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        body.error ?? `worker rejected job: HTTP ${response.status}`,
      );
    }
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
        return this.delegateRequestToWorker(workerPath, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(init?.headers ?? {}),
          },
          body: init?.body,
        });
      }
      if (path.startsWith("/files/list") || path.startsWith("/files/read")) {
        return this.delegateRequestToWorker(workerPath, { method: "GET" });
      }
    }

    const session =
      this.activeSessions.get(taskId) ??
      this.reviewSessions.get(taskId) ??
      (await this.wakeSession(taskId));

    if (!session) {
      const persisted = await this.taskStore.getSession(taskId);
      if (!persisted) {
        throw new Error("no devbox session for task");
      }
      const runtimeBaseUrl = persisted.runtimeBaseUrl;
      return fetch(`${runtimeBaseUrl}${path}`, init);
    }

    return fetch(`${session.runtimeBaseUrl}${path}`, init);
  }

  private async delegateRequestToWorker(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    if (!this.executionWorkerUrl) {
      throw new Error(
        "EXECUTION_WORKER_URL is required when SERVICE_MODE=brain",
      );
    }
    return fetch(`${this.executionWorkerUrl.replace(/\/$/, "")}${path}`, init);
  }
}

function resolveServiceMode(): ServiceMode {
  const raw = process.env.SERVICE_MODE?.trim().toLowerCase();
  if (raw === "brain" || raw === "worker" || raw === "standalone") {
    return raw;
  }
  return "standalone";
}

function hydrateTaskRuntime(task: Task): Task {
  if (!task.runtime) {
    task.runtime = resolveRuntimeForTask(task.agent, task.prompt);
  }
  return task;
}

function resolveStackRuntime(task: Task, job?: ScheduleJob): StackRuntime {
  const candidate = task.runtime ?? job?.runtime;
  if (candidate && candidate !== "agent") {
    return candidate;
  }
  return inferStackFromPrompt(task.prompt);
}

function resolveBotToken(): string | undefined {
  return process.env.GITHUB_BOT_TOKEN?.trim() || undefined;
}

function resolveBotAuthor(): { name: string; email: string } {
  const defaultName = "baby-devin-bot";
  const defaultEmail = "baby-devin-bot@users.noreply.github.com";
  const rawName = process.env.GITHUB_BOT_NAME?.trim() || defaultName;
  const rawEmail = process.env.GITHUB_BOT_EMAIL?.trim() || defaultEmail;

  return {
    name: sanitizeBotEnvValue(rawName, defaultName),
    email: sanitizeBotEnvValue(rawEmail, defaultEmail),
  };
}

function sanitizeBotEnvValue(value: string, fallback: string): string {
  if (!value || value.includes("${") || value.includes(":-")) {
    return fallback;
  }
  return value;
}

function coAuthorTrailer(): string {
  const bot = resolveBotAuthor();
  return `Co-authored-by: ${bot.name} <${bot.email}>`;
}

function buildCommitMessage(subject: string): string {
  return `${subject}\n\n${coAuthorTrailer()}`;
}

function nextjsPromptGuidance(stackRuntime?: StackRuntime): string[] {
  if (stackRuntime !== "nextjs") {
    return [];
  }
  return [
    "",
    "Next.js UI requirements:",
    "- Build the app with Next.js (App Router) and TypeScript",
    "- Use shadcn/ui for all component styling — initialize it with " +
      "`npx --yes shadcn@latest init -d`, then add components with " +
      "`npx --yes shadcn@latest add <component>` as needed (Tailwind CSS is required)",
    "- Install required agent skills before building (run each once, then follow them):",
    "  - `npx --yes skills add https://github.com/anthropics/skills --skill frontend-design`",
    "  - `npx --yes skills add https://github.com/vercel-labs/agent-skills --skill vercel-react-best-practices`",
    "  - `npx --yes skills add https://github.com/mattpocock/skills --skill improve-codebase-architecture`",
    "  - `npx --yes skills add https://github.com/shadcn/ui --skill shadcn`",
    "  - `npx --yes skills add https://github.com/supabase/agent-skills --skill supabase`",
    "  - `npx --yes skills add https://github.com/101-skills/skills --skill landing-page-design`",
    "- Apply frontend-design and landing-page-design for layout/visual polish, " +
      "shadcn for component patterns, vercel-react-best-practices for React/Next.js, " +
      "improve-codebase-architecture for module boundaries, and supabase when backend/auth/data is needed",
    "- Compose the interface from shadcn/ui primitives — do not hand-roll " +
      "unstyled elements when a shadcn component exists",
    "- Verify `npm run build` succeeds before finishing",
  ];
}

function buildAgentPrompt(
  prompt: string,
  repository: string,
  repoCwd: string,
  owner?: GitHubUserIdentity,
  stackRuntime?: StackRuntime,
): string {
  const bot = resolveBotAuthor();
  const ownerLine = owner
    ? `Repository owner: ${owner.login}. You are committing on their behalf.`
    : "Repository owner: connected GitHub user.";

  return [
    `Repository ${repository} is cloned at /workspace/${repoCwd}. Work in that directory.`,
    ownerLine,
    "",
    "The repository only has a thin runnable scaffold (health + placeholder UI).",
    "You are the implementer — build the full product the user asked for. Do not leave the scaffold untouched.",
    "Requirements:",
    "- Replace the placeholder with a real UI + API for the user's request",
    "- GET / must be user-facing — never leave Express 'Cannot GET /' or a scaffold-only page",
    "- Keep /health returning JSON { ok: true }",
    "- Do not finish while the page still says 'Scaffold is running'",
    "- Add dependencies only when needed; if you do, run npm install and verify start still works",
    "- Smoke-check GET / and /health before finishing",
    ...nextjsPromptGuidance(stackRuntime),
    "",
    "Git / commits:",
    "- Commit incrementally after meaningful steps (API, UI, features, polish)",
    "- Make at least 3 focused commits beyond the scaffold — multiple commits are required",
    "- Push to the working branch as you go when possible",
    `- Every commit MUST include this trailer on a new line in the commit message body: Co-authored-by: ${bot.name} <${bot.email}>`,
    "- If git push is rejected, stop retrying — the control plane finalizes and pushes on completion or timeout",
    "",
    "Sandbox resilience:",
    "- If shell/npm commands fail (ENOMEM, spawn errors), keep writing files with edit tools",
    "- Do not launch subagents or long retry loops for shell — finish the product on disk",
    "- Prefer zero-dependency Node.js (built-in http + SSE) when npm install cannot run",
    "- The control plane runs tests, commits, and push after you finish or on timeout",
    "",
    "Sandbox tooling:",
    "- GITHUB_TOKEN is available for gh and git",
    "- Run tests before finishing when applicable",
    "- You may commit, push, open pull requests, and create issues with gh",
    "",
    prompt,
  ].join("\n");
}

function isNetworkCloneFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("could not resolve host") ||
    message.includes("name or service not known") ||
    message.includes("temporary failure in name resolution") ||
    message.includes("network is unreachable") ||
    message.includes("connection timed out") ||
    message.includes("failed to connect") ||
    message.includes("couldn't connect") ||
    message.includes("unable to access") ||
    message.includes("operation timed out") ||
    message.includes("no route to host") ||
    message.includes("git clone timed out") ||
    message.includes("cloning into '/workspace/")
  );
}

function escapeShell(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function resolveAgentTimeoutMinutes(): number {
  const raw = process.env.AGENT_RUN_TIMEOUT_MIN?.trim();
  // Greenfield cursor runs commonly need >30m (install + implement + verify).
  const defaultMinutes = 60;
  if (!raw) {
    return defaultMinutes;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return defaultMinutes;
  }
  return minutes;
}

function resolveAgentMaxWaitMs(): number {
  return resolveAgentTimeoutMinutes() * 60 * 1000;
}

function resolveTimeoutMs(envKey: string, defaultSeconds: number): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) {
    return defaultSeconds * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return defaultSeconds * 1000;
  }
  return seconds * 1000;
}

function resolveSandboxCpu(_task: Task): number {
  const fromEnv = Number(process.env.SANDBOX_CPU?.trim());
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  // Match FIRECRACKER_WARM_VCPU — warm restores charge snapshot vCPUs.
  return 2;
}

function resolveSandboxMemory(_task: Task): string {
  const fromEnv = process.env.SANDBOX_MEMORY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  // Must match FIRECRACKER_WARM_MEMORY_MIB / snapshot memSizeMib. Firecracker
  // restores cannot resize RAM, so requesting more than the snapshot is a no-op.
  return "8Gi";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
