import type { AgentProvider } from "./agents";
import type { SandboxRuntime } from "./runtime";

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

export interface GitHubPermissions {
  canCommit: boolean;
  canCreatePr: boolean;
  canCreateRepo: boolean;
  canCreateIssue: boolean;
  canPush: boolean;
}

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
  sandboxName?: string;
  message?: string;
  title?: string;
  /** Firecracker snapshot runtime (agent, nextjs, node, go, rust, python). */
  runtime?: SandboxRuntime;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskRequest {
  prompt: string;
  agent?: AgentProvider;
  /** Override prompt-based stack detection (template agent only). */
  runtime?: SandboxRuntime;
  repository?: string;
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
}
