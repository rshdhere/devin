import { RuntimeClient } from "@devin/agent-sdk";
import { EventBus } from "@devin/events";
import type { TaskEventType } from "@devin/events";
import { createQueue, type TaskQueue } from "@devin/queue";
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
  defaultAgent?: AgentProvider;
  eventBus?: EventBus;
  queue?: TaskQueue<ScheduleJob>;
}

type SandboxRecord = {
  status?: {
    phase?: string;
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
  private readonly defaultAgent: AgentProvider;
  private workerStarted = false;

  constructor(options: TaskServiceOptions) {
    this.orchestratorUrl = options.orchestratorUrl.replace(/\/$/, "");
    this.runtimeUrl = options.runtimeUrl.replace(/\/$/, "");
    this.defaultAgent = options.defaultAgent ?? resolveDefaultAgent();
    this.eventBus = options.eventBus ?? new EventBus();
    this.queue = options.queue ?? createQueue<ScheduleJob>();
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const agent = input.agent ?? this.defaultAgent;
    const task: Task = {
      id: crypto.randomUUID(),
      prompt: input.prompt.trim(),
      agent,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    if (!task.prompt) {
      throw new Error("prompt is required");
    }

    this.tasks.set(task.id, task);
    this.emit("task.created", task.id, "Task accepted", { agent: task.agent });

    void this.queue
      .enqueue({
        taskId: task.id,
        prompt: task.prompt,
        agent: task.agent,
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
      const createResponse = await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: sandboxName,
            spec: {
              taskId: task.id,
              runtime: runtimeImage,
              cpu: 2,
              memory: "4Gi",
            },
          }),
        },
      );

      if (!createResponse.ok) {
        throw new Error(
          `orchestrator rejected sandbox: ${createResponse.status}`,
        );
      }

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
      await this.waitForRuntime(runtime, task.id);
      this.emit("runtime.ready", task.id, "Runtime supervisor is ready", {
        runtimeURL: runtimeBaseUrl,
      });

      const stopEvents = this.forwardRuntimeEvents(runtimeBaseUrl, task.id);

      this.updateTask(task.id, "running", `${task.agent} agent executing task`);
      this.emit("agent.running", task.id, `${task.agent} agent started`, {
        prompt: task.prompt,
        agent: task.agent,
      });

      const runResult = await runtime.run({
        taskId: task.id,
        prompt: task.prompt,
        agent: task.agent,
      });

      stopEvents();

      if (runResult.status === "failed") {
        throw new Error(runResult.message);
      }

      this.updateTask(
        task.id,
        "completed",
        runResult.message || "Task completed",
      );
      this.emit("task.completed", task.id, "Task completed", {
        output: runResult.output,
        agent: runResult.agent ?? task.agent,
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

  private async waitForSandbox(
    sandboxName: string,
    taskId: string,
  ): Promise<SandboxRecord> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(
        `${this.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
      );
      if (response.ok) {
        const sandbox = (await response.json()) as SandboxRecord;
        if (sandbox.status?.phase === "Running") {
          return sandbox;
        }
      }
      await sleep(500);
    }
    throw new Error(
      `sandbox ${sandboxName} did not become ready for task ${taskId}`,
    );
  }

  private async waitForRuntime(
    runtime: RuntimeClient,
    taskId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
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
    throw new Error(`runtime not ready for task ${taskId}`);
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
      | "sandbox.started"
      | "runtime.ready"
      | "agent.running"
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
