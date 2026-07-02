import type { DraftPlan } from "./draft-planner.js";

export type AgentProvider = "cursor" | "claude" | "mock";

export type TaskStatus =
  | "queued"
  | "scheduling"
  | "drafting"
  | "draft_ready"
  | "sandbox_starting"
  | "runtime_ready"
  | "running"
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
  sandboxName?: string;
  message?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  prompt: string;
  agent?: AgentProvider;
  userId?: string;
  repository?: string;
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  cloneUrl?: string;
  githubToken?: string;
  permissions?: GitHubPermissions;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
}

export interface ScheduleJob {
  taskId: string;
  prompt: string;
  agent: AgentProvider;
  userId?: string;
  repository?: string;
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  skipDraft?: boolean;
  cloneUrl?: string;
  githubToken?: string;
  permissions?: GitHubPermissions;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
  draftPlan?: DraftPlan;
  greenfieldPushed?: boolean;
  enqueuedAt: string;
}
