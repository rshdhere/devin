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
