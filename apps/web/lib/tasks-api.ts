import { authConfig } from "@/lib/auth-config";

export type AgentProvider = "cursor" | "claude" | "mock";

export type TaskStatus =
  | "queued"
  | "scheduling"
  | "drafting"
  | "draft_ready"
  | "sandbox_starting"
  | "runtime_ready"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  prompt: string;
  agent: AgentProvider;
  status: TaskStatus;
  userId?: string;
  repository?: string;
  branch?: string;
  prUrl?: string;
  previewUrl?: string;
  deployStatus?: "building" | "live" | "failed" | "skipped";
  sessionActive?: boolean;
  sessionSleeping?: boolean;
  title?: string;
  message?: string;
  sandboxName?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskEventType =
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
  | "agent.started"
  | "agent.log"
  | "agent.output"
  | "agent.tool"
  | "agent.completed"
  | "agent.failed"
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
  | "task.failed";

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface ServiceProbe {
  url: string;
  reachable: boolean;
  status?: string;
  error?: string;
  latencyMs?: number;
}

export interface WarmRuntimeStatus {
  runtime: string;
  readyVMs: number;
  lastWarmError?: string;
}

export interface FirecrackerHostStatus {
  host?: string;
  readyVMs?: number;
  activeVMs?: number;
  capacityCPU?: number;
  usedCPU?: number;
  defaultRuntime?: string;
  availableRuntimes?: string[];
  warmRuntimes?: WarmRuntimeStatus[];
  lastWarmError?: string;
}

export interface SandboxSummary {
  name: string;
  phase: string;
  message?: string;
  taskId?: string;
  runtime?: string;
  vmId?: string;
  host?: string;
}

export interface InfraDiagnostics {
  checkedAt: string;
  orchestrator: ServiceProbe;
  firecrackerHost?: ServiceProbe & FirecrackerHostStatus;
  agent?: {
    defaultAgent: string;
    cursorApiKeyConfigured: boolean;
    anthropicApiKeyConfigured: boolean;
    openaiApiKeyConfigured?: boolean;
  };
  sandboxes: {
    total: number;
    byPhase: Record<string, number>;
    items: SandboxSummary[];
  };
}

export interface TaskDiagnostics {
  taskId: string;
  sandboxName?: string;
  sandbox?: SandboxSummary;
}

const tasksUrl = `${authConfig.baseURL}/api/v1/tasks`;

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" ? body.error : "Request failed",
    );
  }
  return response.json() as Promise<T>;
}

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(tasksUrl, { credentials: "include" });
  return parseResponse<Task[]>(response);
}

export async function createTask(input: {
  prompt: string;
  agent?: AgentProvider;
  repository?: string;
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
}): Promise<Task> {
  const response = await fetch(tasksUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseResponse<Task>(response);
}

export async function fetchTask(id: string): Promise<Task> {
  const response = await fetch(`${tasksUrl}/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  return parseResponse<Task>(response);
}

export async function executeTask(id: string): Promise<Task> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/execute`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  return parseResponse<Task>(response);
}

export async function retryTask(id: string): Promise<Task> {
  const response = await fetch(`${tasksUrl}/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    credentials: "include",
  });
  return parseResponse<Task>(response);
}

export async function commitTaskWork(id: string): Promise<Task> {
  const response = await fetch(`${tasksUrl}/${encodeURIComponent(id)}/commit`, {
    method: "POST",
    credentials: "include",
  });
  return parseResponse<Task>(response);
}

export async function raiseTaskPullRequest(id: string): Promise<Task> {
  const response = await fetch(`${tasksUrl}/${encodeURIComponent(id)}/pr`, {
    method: "POST",
    credentials: "include",
  });
  return parseResponse<Task>(response);
}

export async function continueTask(id: string, prompt: string): Promise<Task> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/continue`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    },
  );
  return parseResponse<Task>(response);
}

export async function terminateSession(id: string): Promise<Task> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/terminate`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  return parseResponse<Task>(response);
}

export async function wakeSession(id: string): Promise<Task> {
  const response = await fetch(`${tasksUrl}/${encodeURIComponent(id)}/wake`, {
    method: "POST",
    credentials: "include",
  });
  return parseResponse<Task>(response);
}

export async function listTaskFiles(
  id: string,
  path = ".",
): Promise<{
  path: string;
  items: Array<{ name: string; path: string; isDir: boolean; size: number }>;
}> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`,
    { credentials: "include" },
  );
  return parseResponse(response);
}

export async function readTaskFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/files/read?path=${encodeURIComponent(path)}`,
    { credentials: "include" },
  );
  return parseResponse(response);
}

export async function runTaskTerminalStream(
  id: string,
  command: string,
  onEvent: (event: {
    type: "terminal.output" | "terminal.done" | "terminal.error";
    data: Record<string, unknown>;
  }) => void,
): Promise<void> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/terminal`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, stream: true }),
    },
  );

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" ? body.error : "Terminal request failed",
    );
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

      const eventLine = chunk
        .split("\n")
        .find((line) => line.startsWith("event: "));
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));

      if (eventLine && dataLine) {
        const type = eventLine.slice(7).trim() as
          | "terminal.output"
          | "terminal.done"
          | "terminal.error";
        try {
          const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          onEvent({ type, data });
        } catch {
          // ignore malformed chunks
        }
      }

      splitIndex = buffer.indexOf("\n\n");
    }
  }
}

export async function fetchTaskEventHistory(id: string): Promise<TaskEvent[]> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/events/history`,
    { credentials: "include" },
  );
  return parseResponse<TaskEvent[]>(response);
}

export async function fetchInfraDiagnostics(): Promise<InfraDiagnostics> {
  const response = await fetch(`${tasksUrl}/diagnostics/infra`, {
    credentials: "include",
  });
  return parseResponse<InfraDiagnostics>(response);
}

export async function fetchTaskDiagnostics(
  id: string,
): Promise<TaskDiagnostics> {
  const response = await fetch(
    `${tasksUrl}/${encodeURIComponent(id)}/diagnostics`,
    { credentials: "include" },
  );
  return parseResponse<TaskDiagnostics>(response);
}

export function subscribeToTaskEvents(
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  onError?: (error: Error) => void,
  options?: { reconnect?: boolean },
): () => void {
  const controller = new AbortController();
  let reconnectAttempts = 0;
  let shouldReconnect = options?.reconnect ?? true;
  const seenEventIds = new Set<string>();

  const connect = async () => {
    while (!controller.signal.aborted && shouldReconnect) {
      try {
        const response = await fetch(
          `${tasksUrl}/${encodeURIComponent(taskId)}/events`,
          {
            credentials: "include",
            signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error("Failed to connect to event stream");
        }

        reconnectAttempts = 0;
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

            if (chunk.startsWith(":")) {
              splitIndex = buffer.indexOf("\n\n");
              continue;
            }

            const dataLine = chunk
              .split("\n")
              .find((line) => line.startsWith("data: "));

            if (dataLine) {
              try {
                const event = JSON.parse(dataLine.slice(6)) as TaskEvent;
                if (!seenEventIds.has(event.id)) {
                  seenEventIds.add(event.id);
                  onEvent(event);
                  if (
                    event.type === "task.completed" ||
                    event.type === "task.failed"
                  ) {
                    shouldReconnect = false;
                  }
                }
              } catch {
                // ignore malformed events
              }
            }

            splitIndex = buffer.indexOf("\n\n");
          }
        }

        if (!shouldReconnect || controller.signal.aborted) {
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        reconnectAttempts += 1;
        if (!shouldReconnect || reconnectAttempts > 8) {
          onError?.(
            error instanceof Error ? error : new Error("Event stream error"),
          );
          return;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000 * reconnectAttempts, 8000)),
        );
      }
    }
  };

  void connect();

  return () => controller.abort();
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "scheduling":
      return "Scheduling";
    case "drafting":
      return "Drafting plan";
    case "draft_ready":
      return "Draft ready";
    case "sandbox_starting":
      return "Starting sandbox";
    case "runtime_ready":
      return "Runtime ready";
    case "running":
      return "Running";
    case "awaiting_review":
      return "Review changes";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export function eventTypeLabel(type: TaskEventType): string {
  switch (type) {
    case "task.phase_changed":
      return "Phase";
    case "draft.started":
      return "Draft start";
    case "draft.updated":
      return "Draft update";
    case "draft.diff":
      return "Draft diff";
    case "draft.completed":
      return "Draft ready";
    case "draft.failed":
      return "Draft failed";
    case "execution.started":
      return "Execution";
    case "sandbox.requested":
      return "Sandbox request";
    case "sandbox.provisioning":
      return "Sandbox provisioning";
    case "sandbox.started":
      return "Sandbox ready";
    case "sandbox.failed":
      return "Sandbox error";
    case "runtime.waiting":
      return "Runtime health";
    case "runtime.ready":
      return "Runtime ready";
    case "agent.running":
      return "Agent";
    case "agent.log":
      return "Agent log";
    case "agent.output":
      return "Output";
    case "agent.tool":
      return "Tool";
    case "git.repo":
      return "Repo created";
    case "git.clone":
      return "Git clone";
    case "git.commit":
      return "Git commit";
    case "git.push":
      return "Git push";
    case "git.pr":
      return "Pull request";
    case "git.issue":
      return "Issue created";
    case "deploy.building":
      return "Production build";
    case "deploy.ready":
      return "Preview live";
    case "deploy.failed":
      return "Deploy failed";
    default:
      return type.replace(/\./g, " ");
  }
}

export function formatEventData(data?: Record<string, unknown>): string[] {
  if (!data) {
    return [];
  }

  const lines: string[] = [];
  const orderedKeys = [
    "sequence",
    "source",
    "phase",
    "message",
    "sandboxName",
    "runtime",
    "runtimeURL",
    "previewUrl",
    "slug",
    "upstreamHost",
    "upstreamPort",
    "pushedToGitHub",
    "vmId",
    "host",
    "orchestratorUrl",
    "timeoutSeconds",
    "status",
    "error",
  ];

  for (const key of orderedKeys) {
    const value = data[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }

  for (const [key, value] of Object.entries(data)) {
    if (orderedKeys.includes(key)) {
      continue;
    }
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return lines;
}
