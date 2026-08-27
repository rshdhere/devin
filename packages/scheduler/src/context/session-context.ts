import type { TaskEvent } from "@devin/events";
import { buildFollowUpSessionContext } from "../task/service/agent-prompt.js";
import type { Task } from "../task/types.js";
import {
  ingestSessionMemory,
  isHydraDbEnabled,
  mergeSessionContexts,
  recallSessionMemory,
} from "./hydradb.js";

/** Default: keep follow-up / session recovery available for 30 days. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;

export function resolveSessionRetentionMs(): number {
  const raw = process.env.SESSION_RETENTION_DAYS?.trim();
  const days = raw ? Number(raw) : DEFAULT_SESSION_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return DEFAULT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }
  return Math.floor(days) * 24 * 60 * 60 * 1000;
}

export function isSessionWithinRetention(
  lastActiveAt: string | Date | undefined,
  now = Date.now(),
): boolean {
  if (!lastActiveAt) {
    return true;
  }
  const ts =
    typeof lastActiveAt === "string"
      ? Date.parse(lastActiveAt)
      : lastActiveAt.getTime();
  if (!Number.isFinite(ts)) {
    return true;
  }
  return now - ts <= resolveSessionRetentionMs();
}

export async function buildDurableSessionContext(input: {
  task: Task;
  events: TaskEvent[];
  followUpPrompt: string;
}): Promise<string> {
  const eventContext = buildFollowUpSessionContext(
    input.task.prompt,
    input.events,
  );

  if (!isHydraDbEnabled()) {
    return eventContext;
  }

  const hydraContext = await recallSessionMemory({
    taskId: input.task.id,
    userId: input.task.userId,
    query: [
      input.followUpPrompt,
      input.task.prompt,
      input.task.repository ?? "",
      input.task.title ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return mergeSessionContexts(eventContext, hydraContext);
}

export async function persistTaskContextMemory(
  task: Task,
  events: TaskEvent[],
  note?: string,
): Promise<boolean> {
  if (!isHydraDbEnabled()) {
    return false;
  }

  const summary = buildFollowUpSessionContext(task.prompt, events, 8_000);
  const parts = [
    `Task ${task.id}`,
    task.repository ? `Repository: ${task.repository}` : "",
    `Status: ${task.status}`,
    task.message ? `Message: ${task.message}` : "",
    note ? `Note: ${note}` : "",
    "",
    summary,
  ].filter((line) => line !== undefined);

  return ingestSessionMemory({
    taskId: task.id,
    userId: task.userId,
    title: task.title ?? task.prompt.slice(0, 80),
    sourceId: `devin-task-${task.id}-snapshot`,
    text: parts.join("\n"),
  });
}
