import type { RuntimeClient } from "@devin/agent-sdk";
import type { EventBus } from "@devin/events";
import type { TaskEventType } from "@devin/events";
import type { TaskQueue } from "@devin/queue";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AgentProvider,
  CreateTaskInput,
  ScheduleJob,
  ServiceMode,
  Task,
  TaskStatus,
} from "../types.js";
import type { TaskStore } from "../store.js";

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

export type SandboxRecord = {
  status?: {
    phase?: string;
    message?: string;
    runtimeURL?: string;
    vmId?: string;
    host?: string;
  };
};

export type ReviewSession = {
  runtime: RuntimeClient;
  sandboxName: string;
  runtimeBaseUrl: string;
  repoCwd: string;
  job: ScheduleJob;
  githubToken?: string;
  createdNewRepo: boolean;
  guestHost?: string;
  devboxPreviewPort?: number;
  /** Last successful headless capture while the devbox session is alive. */
  lastDesktopScreenshot?: Buffer;
};

export interface TaskServiceHost {
  readonly tasks: Map<string, Task>;
  readonly pendingJobs: Map<string, ScheduleJob>;
  readonly activeSessions: Map<string, ReviewSession>;
  readonly reviewSessions: Map<string, ReviewSession>;
  readonly eventSequences: Map<string, number>;
  readonly eventBus: EventBus;
  readonly queue: TaskQueue<ScheduleJob>;
  readonly orchestratorUrl: string;
  readonly runtimeUrl: string;
  readonly firecrackerHostUrl?: string;
  readonly preferredHost?: string;
  readonly defaultAgent: AgentProvider;
  readonly sandboxReadyTimeoutMs: number;
  readonly runtimeReadyTimeoutMs: number;
  readonly taskStore: TaskStore;
  readonly mode: ServiceMode;
  readonly executionWorkerUrl?: string;
  readonly idleTimeoutMs: number;
  idleWatchdog?: ReturnType<typeof setInterval>;
  workerStarted: boolean;
  readonly processingTasks: Set<string>;
  restored: boolean;
  readonly snapshotSpinCooldownMs: number;
  readonly lastSnapshotSpinAt: Map<string, number>;
  readonly lastSnapshotTriggerAt: Map<string, number>;
  readonly desktopCaptureInFlight: Map<string, Promise<Buffer | undefined>>;

  updateTask(taskId: string, status: TaskStatus, message: string): void;
  patchTask(
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
  ): void;
  emit(
    type: TaskEventType,
    taskId: string,
    message: string,
    data?: Record<string, unknown>,
  ): void;
  emitRuntime(
    taskId: string,
    type: TaskEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void;
  nextEventSequence(taskId: string): number;
  proxyRuntimeRequest(
    taskId: string,
    path: string,
    init?: RequestInit,
  ): Promise<Response>;
  proxyDevboxPreview(
    taskId: string,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void>;
  fetchDesktopScreenshot(
    taskId: string,
    opts?: { fresh?: boolean },
  ): Promise<Response>;
  wakeSession(taskId: string): Promise<ReviewSession | undefined>;
  processJob(job: ScheduleJob): Promise<void>;
}

export type { CreateTaskInput };
