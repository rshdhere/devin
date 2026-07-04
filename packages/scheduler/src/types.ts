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
  | "awaiting_review"
  | "completed"
  | "failed"
  | "cancelled";

export type ServiceMode = "standalone" | "brain" | "worker";

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
  /** Sandbox kept alive for follow-up prompts (Devin session model). */
  sessionActive?: boolean;
  /** Devbox is idle-sleeping; wake on continue or explicit wake. */
  sessionSleeping?: boolean;
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
  /** When true, pause after agent run for manual Commit / PR (Devin default is auto-PR). */
  requireReviewBeforePush?: boolean;
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
  /** Resume agent work in an existing sandbox (session follow-up). */
  resumeSession?: boolean;
  runtimeBaseUrl?: string;
  sandboxName?: string;
  requireReviewBeforePush?: boolean;
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
