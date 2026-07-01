export type TaskEventType =
  | "task.created"
  | "task.scheduled"
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

export type TaskEventListener = (event: TaskEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<TaskEventListener>>();
  private history = new Map<string, TaskEvent[]>();

  publish(event: TaskEvent): void {
    const events = this.history.get(event.taskId) ?? [];
    events.push(event);
    this.history.set(event.taskId, events);

    for (const listener of this.listeners.get(event.taskId) ?? []) {
      listener(event);
    }
    for (const listener of this.listeners.get("*") ?? []) {
      listener(event);
    }
  }

  subscribe(taskId: string, listener: TaskEventListener): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);

    return () => {
      set.delete(listener);
    };
  }

  historyFor(taskId: string): TaskEvent[] {
    return [...(this.history.get(taskId) ?? [])];
  }
}

export function formatSSE(event: TaskEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
