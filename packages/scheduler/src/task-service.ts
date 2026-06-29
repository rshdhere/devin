import { RuntimeClient } from "@devin/agent-sdk";
import { EventBus } from "@devin/events";
import type { TaskEventType } from "@devin/events";
import { createQueue, type TaskQueue } from "@devin/queue";
import {
  collectInfraDiagnostics,
  fetchSandboxByName,
  validateFirecrackerHostForRuntime,
  type InfraDiagnostics,
  type TaskDiagnostics,
} from "./diagnostics.js";
import type {
  AgentProvider,
  CreateTaskInput,
  ScheduleJob,
  Task,
  TaskStatus,
} from "./types.js";

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

export class TaskService {
  private readonly tasks = new Map<string, Task>();
  private readonly eventBus: EventBus;
  private readonly queue: TaskQueue<ScheduleJob>;
  private readonly orchestratorUrl: string;
  private readonly runtimeUrl: string;
  private readonly firecrackerHostUrl?: string;
  private readonly preferredHost?: string;
  private readonly defaultAgent: AgentProvider;
  private readonly sandboxReadyTimeoutMs: number;
  private readonly runtimeReadyTimeoutMs: number;
  private workerStarted = false;

  constructor(options: TaskServiceOptions) {
    this.orchestratorUrl = options.orchestratorUrl.replace(/\/$/, "");
    this.runtimeUrl = options.runtimeUrl.replace(/\/$/, "");
    this.firecrackerHostUrl =
      options.firecrackerHostUrl?.trim() ||
      process.env.FIRECRACKER_HOST_URL?.trim() ||
      undefined;
    this.preferredHost = options.preferredHost?.trim() || undefined;
    this.defaultAgent = options.defaultAgent ?? resolveDefaultAgent();
    this.sandboxReadyTimeoutMs =
      options.sandboxReadyTimeoutMs ??
      resolveTimeoutMs("SANDBOX_READY_TIMEOUT_SECONDS", 300);
    this.runtimeReadyTimeoutMs =
      options.runtimeReadyTimeoutMs ??
      resolveTimeoutMs("RUNTIME_READY_TIMEOUT_SECONDS", 60);
    this.eventBus = options.eventBus ?? new EventBus();
    this.queue = options.queue ?? createQueue<ScheduleJob>();
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const agent = input.agent ?? this.defaultAgent;
    const title =
      input.prompt.trim().slice(0, 80) +
      (input.prompt.trim().length > 80 ? "…" : "");
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: input.prompt.trim(),
      agent,
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
    this.emit("task.created", task.id, "Task accepted", {
      agent: task.agent,
      repository: task.repository,
    });

    void this.queue
      .enqueue({
        taskId: task.id,
        prompt: task.prompt,
        agent: task.agent,
        userId: input.userId,
        repository: input.repository,
        cloneUrl: input.cloneUrl,
        githubToken: input.githubToken,
        permissions: input.permissions,
        enqueuedAt: now,
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Failed to enqueue task";
        this.updateTask(task.id, "failed", message);
        this.emit("task.failed", task.id, message);
      });

    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async getInfraDiagnostics(): Promise<InfraDiagnostics> {
    return collectInfraDiagnostics({
      orchestratorUrl: this.orchestratorUrl,
      firecrackerHostUrl: this.firecrackerHostUrl,
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
    if (this.workerStarted) {
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
    const task = this.tasks.get(job.taskId);
    if (!task) {
      return;
    }

    let sandboxName: string | undefined;

    try {
      this.updateTask(task.id, "scheduling", "Scheduler picked up task");
      this.emit("task.scheduled", task.id, "Task scheduled", {
        agent: task.agent,
      });

      sandboxName = `sbx-${task.id.slice(0, 8)}`;
      task.sandboxName = sandboxName;
      this.updateTask(task.id, "sandbox_starting", "Creating sandbox");

      const runtimeImage = runtimeForAgent(task.agent);

      if (this.firecrackerHostUrl) {
        const hostIssue = await validateFirecrackerHostForRuntime(
          this.firecrackerHostUrl,
          runtimeImage,
        );
        if (hostIssue) {
          throw new Error(hostIssue);
        }
      }

      this.emit(
        "sandbox.requested",
        task.id,
        "Requesting sandbox from orchestrator",
        {
          sandboxName,
          runtime: runtimeImage,
          orchestratorUrl: this.orchestratorUrl,
        },
      );

      await this.ensureSandbox(sandboxName, task.id, {
        taskId: task.id,
        runtime: runtimeImage,
        cpu: 2,
        memory: "4Gi",
        ...(this.preferredHost ? { preferredHost: this.preferredHost } : {}),
      });

      const sandbox = await this.waitForSandbox(sandboxName, task.id);
      this.emit("sandbox.started", task.id, "Sandbox microVM is running", {
        sandboxName,
        vmId: sandbox.status?.vmId,
        host: sandbox.status?.host,
        runtime: runtimeImage,
      });

      const runtimeBaseUrl =
        sandbox.status?.runtimeURL?.replace(/\/$/, "") || this.runtimeUrl;
      const runtime = new RuntimeClient({ baseUrl: runtimeBaseUrl });
      this.emit(
        "runtime.waiting",
        task.id,
        "Waiting for runtime supervisor health check",
        {
          runtimeURL: runtimeBaseUrl,
        },
      );
      await this.waitForRuntime(runtime, task.id);
      this.emit("runtime.ready", task.id, "Runtime supervisor is ready", {
        runtimeURL: runtimeBaseUrl,
      });

      const repoCwd = "repo";
      let agentPrompt = task.prompt;

      if (job.cloneUrl && job.repository) {
        this.emit("git.clone", task.id, `Cloning ${job.repository}`, {
          repository: job.repository,
        });
        await runtime.gitClone({
          taskId: task.id,
          url: job.cloneUrl,
          path: repoCwd,
        });
        agentPrompt = `Repository ${job.repository} is cloned at /workspace/${repoCwd}. Work in that directory.\n\n${task.prompt}`;
      }

      const stopEvents = this.forwardRuntimeEvents(runtimeBaseUrl, task.id);

      this.updateTask(task.id, "running", `${task.agent} agent executing task`);
      this.emit("agent.running", task.id, `${task.agent} agent started`, {
        prompt: task.prompt,
        agent: task.agent,
        repository: job.repository,
      });

      const runResult = await runtime.run({
        taskId: task.id,
        prompt: agentPrompt,
        agent: task.agent,
      });

      stopEvents();

      if (runResult.status === "failed") {
        throw new Error(runResult.message);
      }

      if (job.repository && job.permissions) {
        await this.finalizeGitWork(runtime, task, job, repoCwd);
      }

      this.updateTask(
        task.id,
        "completed",
        runResult.message || "Task completed",
      );
      this.emit("task.completed", task.id, "Task completed", {
        output: runResult.output,
        agent: runResult.agent ?? task.agent,
        prUrl: task.prUrl,
        branch: task.branch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed";
      this.updateTask(task.id, "failed", message);
      this.emit("task.failed", task.id, message);
      throw error;
    } finally {
      if (sandboxName) {
        await this.deleteSandbox(sandboxName);
      }
    }
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
  ): Promise<void> {
    const permissions = job.permissions;
    if (!permissions || !job.repository) {
      return;
    }

    const branchName = `devin/${task.id.slice(0, 8)}`;
    task.branch = branchName;

    const status = await runtime.terminal({
      taskId: task.id,
      command: "git status --porcelain",
      cwd: repoCwd,
    });

    if (!status.stdout.trim()) {
      return;
    }

    if (permissions.canPush) {
      await runtime.terminal({
        taskId: task.id,
        command: `git checkout -b ${branchName}`,
        cwd: repoCwd,
      });
    }

    if (permissions.canCommit) {
      await runtime.gitCommit({
        taskId: task.id,
        message: `devin: ${task.title ?? "agent changes"}`,
        paths: ["."],
        cwd: repoCwd,
      });
    }

    if (!permissions.canPush) {
      return;
    }

    const pushResult = await runtime.gitPush({
      taskId: task.id,
      branch: branchName,
      cwd: repoCwd,
    });

    if (pushResult.status !== "completed") {
      this.emit("git.push", task.id, "Push skipped or failed", {
        branch: branchName,
      });
      return;
    }

    this.emit("git.push", task.id, `Pushed branch ${branchName}`, {
      branch: branchName,
    });

    if (!permissions.canCreatePr || !job.githubToken) {
      return;
    }

    const [owner, repo] = job.repository.split("/");
    if (!owner || !repo) {
      return;
    }

    try {
      const defaultBranch = await this.fetchDefaultBranch(
        job.githubToken,
        owner,
        repo,
      );
      const pr = await this.createGitHubPullRequest(
        job.githubToken,
        owner,
        repo,
        {
          title: task.title ?? `Devin: ${task.prompt.slice(0, 60)}`,
          body: `Automated changes by Devin.\n\n**Prompt:** ${task.prompt}`,
          head: branchName,
          base: defaultBranch,
        },
      );
      task.prUrl = pr.html_url;
      this.emit("git.pr", task.id, `Opened pull request #${pr.number}`, {
        prUrl: pr.html_url,
        number: pr.number,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create pull request";
      this.emit("git.pr", task.id, message, { error: message });
    }
  }

  private async fetchDefaultBranch(
    token: string,
    owner: string,
    repo: string,
  ): Promise<string> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      return "main";
    }
    const data = (await response.json()) as { default_branch?: string };
    return data.default_branch ?? "main";
  }

  private async createGitHubPullRequest(
    token: string,
    owner: string,
    repo: string,
    opts: { title: string; body: string; head: string; base: string },
  ): Promise<{ html_url: string; number: number }> {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(opts),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub PR error ${response.status}: ${body}`);
    }
    return response.json() as Promise<{ html_url: string; number: number }>;
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

    while (Date.now() < deadline) {
      const sandbox = await this.fetchSandbox(sandboxName);
      if (sandbox) {
        const phase = sandbox.status?.phase ?? "Pending";
        const message = sandbox.status?.message?.trim() ?? "";
        const phaseChanged = phase !== lastPhase;
        const messageChanged = message !== lastMessage;
        lastPhase = phase;
        lastMessage = message;

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
        if (phase === "Failed") {
          const failureMessage = lastMessage
            ? `sandbox ${sandboxName} failed: ${lastMessage}`
            : `sandbox ${sandboxName} failed for task ${taskId}`;
          this.emit("sandbox.failed", taskId, failureMessage, {
            sandboxName,
            phase,
            message: lastMessage || undefined,
          });
          throw new Error(failureMessage);
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
  ): Promise<void> {
    const deadline = Date.now() + this.runtimeReadyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const health = await runtime.health();
        if (health.status === "ok") {
          return;
        }
      } catch {
        // runtime still booting
      }
      await sleep(500);
    }
    throw new Error(
      `runtime not ready for task ${taskId} within ${this.runtimeReadyTimeoutMs / 1000}s`,
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
  }

  private emit(
    type:
      | "task.created"
      | "task.scheduled"
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
      | "task.completed"
      | "task.failed",
    taskId: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.eventBus.publish({
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private emitRuntime(
    taskId: string,
    type: TaskEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.eventBus.publish({
      id: crypto.randomUUID(),
      taskId,
      type,
      message,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

function runtimeForAgent(agent: AgentProvider): string {
  if (agent === "mock") {
    return "nextjs";
  }
  return "agent";
}

function resolveDefaultAgent(): AgentProvider {
  const raw = (process.env.DEFAULT_AGENT ?? "mock").trim();
  if (raw === "cursor" || raw === "claude" || raw === "mock") {
    return raw;
  }
  return "mock";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
