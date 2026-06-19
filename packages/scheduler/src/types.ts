export type AgentProvider = "cursor" | "claude" | "mock";

export type TaskStatus =
  | "queued"
  | "scheduling"
  | "sandbox_starting"
  | "runtime_ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  prompt: string;
  agent: AgentProvider;
  status: TaskStatus;
  sandboxName?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  prompt: string;
  agent?: AgentProvider;
}

export interface ScheduleJob {
  taskId: string;
  prompt: string;
  agent: AgentProvider;
  enqueuedAt: string;
}
