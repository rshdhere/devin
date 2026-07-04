import { db } from "@devin/drizzle";
import {
  agentSessions,
  agentTaskEvents,
  agentTasks,
} from "@devin/drizzle/schema";
import type { TaskEvent } from "@devin/events";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { ScheduleJob, Task, TaskStatus } from "./types.js";

export type AgentSessionState = "active" | "review" | "sleeping";

export interface PersistedSession {
  taskId: string;
  sandboxName: string;
  runtimeBaseUrl: string;
  repoCwd: string;
  state: AgentSessionState;
  job: ScheduleJob;
  githubToken?: string;
  createdNewRepo: boolean;
  guestHost?: string;
  lastActiveAt: string;
  sleepingAt?: string;
}

export class TaskStore {
  private readonly enabled: boolean;

  constructor(databaseUrl?: string) {
    this.enabled = Boolean(
      databaseUrl?.trim() || process.env.DATABASE_URL?.trim(),
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async upsertTask(task: Task): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await db
      .insert(agentTasks)
      .values({
        id: task.id,
        userId: task.userId,
        prompt: task.prompt,
        agent: task.agent,
        status: task.status,
        title: task.title,
        message: task.message,
        repository: task.repository,
        branch: task.branch,
        prUrl: task.prUrl,
        previewUrl: task.previewUrl,
        deployStatus: task.deployStatus,
        sessionActive: task.sessionActive ?? false,
        sessionSleeping: task.sessionSleeping ?? false,
        sandboxName: task.sandboxName,
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
      })
      .onConflictDoUpdate({
        target: agentTasks.id,
        set: {
          prompt: task.prompt,
          agent: task.agent,
          status: task.status,
          title: task.title,
          message: task.message,
          repository: task.repository,
          branch: task.branch,
          prUrl: task.prUrl,
          previewUrl: task.previewUrl,
          deployStatus: task.deployStatus,
          sessionActive: task.sessionActive ?? false,
          sessionSleeping: task.sessionSleeping ?? false,
          sandboxName: task.sandboxName,
          updatedAt: new Date(task.updatedAt),
        },
      });
  }

  async appendEvent(event: TaskEvent, sequence: number): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await db.insert(agentTaskEvents).values({
      id: event.id,
      taskId: event.taskId,
      type: event.type,
      message: event.message,
      data: event.data ?? null,
      sequence,
      timestamp: new Date(event.timestamp),
    });
  }

  async upsertSession(session: PersistedSession): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await db
      .insert(agentSessions)
      .values({
        taskId: session.taskId,
        sandboxName: session.sandboxName,
        runtimeBaseUrl: session.runtimeBaseUrl,
        repoCwd: session.repoCwd,
        state: session.state,
        jobJson: JSON.stringify(session.job),
        githubToken: session.githubToken,
        createdNewRepo: session.createdNewRepo,
        guestHost: session.guestHost,
        lastActiveAt: new Date(session.lastActiveAt),
        sleepingAt: session.sleepingAt ? new Date(session.sleepingAt) : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentSessions.taskId,
        set: {
          sandboxName: session.sandboxName,
          runtimeBaseUrl: session.runtimeBaseUrl,
          repoCwd: session.repoCwd,
          state: session.state,
          jobJson: JSON.stringify(session.job),
          githubToken: session.githubToken,
          createdNewRepo: session.createdNewRepo,
          guestHost: session.guestHost,
          lastActiveAt: new Date(session.lastActiveAt),
          sleepingAt: session.sleepingAt ? new Date(session.sleepingAt) : null,
          updatedAt: new Date(),
        },
      });
  }

  async deleteSession(taskId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await db.delete(agentSessions).where(eq(agentSessions.taskId, taskId));
  }

  async touchSession(taskId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await db
      .update(agentSessions)
      .set({
        lastActiveAt: new Date(),
        state: "active",
        sleepingAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.taskId, taskId));
  }

  async markSessionSleeping(taskId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const now = new Date();
    await db
      .update(agentSessions)
      .set({
        state: "sleeping",
        sleepingAt: now,
        updatedAt: now,
      })
      .where(eq(agentSessions.taskId, taskId));

    await db
      .update(agentTasks)
      .set({
        sessionSleeping: true,
        sessionActive: false,
        updatedAt: now,
      })
      .where(eq(agentTasks.id, taskId));
  }

  async listTasks(userId?: string): Promise<Task[]> {
    if (!this.enabled) {
      return [];
    }

    const rows = userId
      ? await db
          .select()
          .from(agentTasks)
          .where(eq(agentTasks.userId, userId))
          .orderBy(desc(agentTasks.updatedAt))
      : await db.select().from(agentTasks).orderBy(desc(agentTasks.updatedAt));

    return rows.map(rowToTask);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const rows = await db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    const row = rows[0];
    return row ? rowToTask(row) : undefined;
  }

  async loadActiveSessions(): Promise<PersistedSession[]> {
    if (!this.enabled) {
      return [];
    }

    const rows = await db
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.state, ["active", "review", "sleeping"]));

    return rows.map(rowToSession);
  }

  async getSession(taskId: string): Promise<PersistedSession | undefined> {
    if (!this.enabled) {
      return undefined;
    }

    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId))
      .limit(1);

    const row = rows[0];
    return row ? rowToSession(row) : undefined;
  }

  async listIdleSessions(idleMs: number): Promise<PersistedSession[]> {
    if (!this.enabled) {
      return [];
    }

    const cutoff = new Date(Date.now() - idleMs);
    const rows = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.state, "active"),
          sql`${agentSessions.lastActiveAt} < ${cutoff}`,
        ),
      );

    return rows.map(rowToSession);
  }

  async loadEvents(taskId: string): Promise<TaskEvent[]> {
    if (!this.enabled) {
      return [];
    }

    const rows = await db
      .select()
      .from(agentTaskEvents)
      .where(eq(agentTaskEvents.taskId, taskId))
      .orderBy(agentTaskEvents.sequence);

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      type: row.type as TaskEvent["type"],
      message: row.message,
      timestamp: row.timestamp.toISOString(),
      data: (row.data as Record<string, unknown> | null) ?? undefined,
    }));
  }

  async loadEventsSince(
    taskId: string,
    afterSequence: number,
  ): Promise<TaskEvent[]> {
    if (!this.enabled) {
      return [];
    }

    const rows = await db
      .select()
      .from(agentTaskEvents)
      .where(
        and(
          eq(agentTaskEvents.taskId, taskId),
          gt(agentTaskEvents.sequence, afterSequence),
        ),
      )
      .orderBy(agentTaskEvents.sequence);

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      type: row.type as TaskEvent["type"],
      message: row.message,
      timestamp: row.timestamp.toISOString(),
      data: (row.data as Record<string, unknown> | null) ?? undefined,
    }));
  }

  async maxEventSequence(taskId: string): Promise<number> {
    if (!this.enabled) {
      return 0;
    }

    const rows = await db
      .select({
        maxSeq: sql<number>`coalesce(max(${agentTaskEvents.sequence}), 0)`,
      })
      .from(agentTaskEvents)
      .where(eq(agentTaskEvents.taskId, taskId));

    return Number(rows[0]?.maxSeq ?? 0);
  }

  async restoreEventSequences(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!this.enabled) {
      return map;
    }

    const rows = await db
      .select({
        taskId: agentTaskEvents.taskId,
        maxSeq: sql<number>`max(${agentTaskEvents.sequence})`,
      })
      .from(agentTaskEvents)
      .groupBy(agentTaskEvents.taskId);

    for (const row of rows) {
      map.set(row.taskId, Number(row.maxSeq));
    }
    return map;
  }
}

function rowToTask(row: typeof agentTasks.$inferSelect): Task {
  return {
    id: row.id,
    userId: row.userId ?? undefined,
    prompt: row.prompt,
    agent: row.agent as Task["agent"],
    status: row.status as TaskStatus,
    title: row.title ?? undefined,
    message: row.message ?? undefined,
    repository: row.repository ?? undefined,
    branch: row.branch ?? undefined,
    prUrl: row.prUrl ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    deployStatus: row.deployStatus as Task["deployStatus"],
    sessionActive: row.sessionActive,
    sessionSleeping: row.sessionSleeping,
    sandboxName: row.sandboxName ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rowToSession(
  row: typeof agentSessions.$inferSelect,
): PersistedSession {
  return {
    taskId: row.taskId,
    sandboxName: row.sandboxName,
    runtimeBaseUrl: row.runtimeBaseUrl,
    repoCwd: row.repoCwd,
    state: row.state as AgentSessionState,
    job: JSON.parse(row.jobJson) as ScheduleJob,
    githubToken: row.githubToken ?? undefined,
    createdNewRepo: row.createdNewRepo,
    guestHost: row.guestHost ?? undefined,
    lastActiveAt: row.lastActiveAt.toISOString(),
    sleepingAt: row.sleepingAt?.toISOString(),
  };
}
