import { runBrainHarness } from "@devin/brain-harness";
import { resolveBrainAgentModel } from "@devin/types";
import {
  ingestSessionMemory,
  isHydraDbEnabled,
  recallSessionMemory,
} from "../../context/hydradb.js";
import { persistTaskContextMemory } from "../../context/session-context.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import { buildAgentPrompt } from "./agent-prompt.js";
import { resolveAgentMaxWaitMs, resolveStackRuntime } from "./config.js";
import { ensurePendingJob, ensureTaskLoaded } from "./resolve-task.js";
import { emit, updateTask } from "./task-state.js";
import type { SandboxReadyPayload } from "./publish-sandbox-ready.js";
import { delegateRequestToWorker } from "./session-lifecycle.js";

const harnessInFlight = new Set<string>();

/**
 * Brain-side entry: run OpenAI harness after the worker reports sandbox-ready.
 * Tools are proxied to the execution worker — never dial guest CNI from EKS.
 */
export async function handleSandboxReady(
  svc: TaskService,
  payload: SandboxReadyPayload,
): Promise<{ accepted: boolean; reason?: string }> {
  if (svc.mode !== "brain") {
    return { accepted: false, reason: "not brain mode" };
  }

  const taskId = payload.taskId?.trim();
  if (!taskId) {
    return { accepted: false, reason: "taskId required" };
  }

  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    return { accepted: false, reason: "task not found" };
  }

  if (payload.sandboxName) {
    task.sandboxName = payload.sandboxName;
    task.sessionActive = true;
    task.sessionSleeping = false;
    await svc.taskStore.upsertTask(task);
  }

  if (harnessInFlight.has(taskId) || svc.processingTasks.has(taskId)) {
    return { accepted: true, reason: "harness already running" };
  }

  // Fire-and-forget so the worker HTTP call returns quickly.
  void runBrainHarnessOnBrain(svc, taskId).catch((error) => {
    const message =
      error instanceof Error ? error.message : "Brain harness failed";
    console.error(`[brain-harness] ${taskId}: ${message}`);
  });

  return { accepted: true };
}

export async function runBrainHarnessOnBrain(
  svc: TaskService,
  taskId: string,
): Promise<void> {
  if (svc.mode !== "brain") {
    throw new Error("runBrainHarnessOnBrain requires SERVICE_MODE=brain");
  }
  if (harnessInFlight.has(taskId)) {
    return;
  }

  const task = await ensureTaskLoaded(svc, taskId);
  if (!task) {
    throw new Error("task not found");
  }
  if (task.agent !== "brain") {
    throw new Error(`unexpected agent ${task.agent} for Brain harness`);
  }

  const job =
    (await ensurePendingJob(svc, taskId)) ?? svc.pendingJobs.get(taskId);
  if (!job) {
    throw new Error("no pending job for Brain harness");
  }

  const workerUrl = svc.executionWorkerUrl?.trim();
  if (!workerUrl) {
    throw new Error("EXECUTION_WORKER_URL is required for Brain harness tools");
  }

  harnessInFlight.add(taskId);
  svc.processingTasks.add(taskId);

  const persisted = await svc.taskStore.getSession(taskId);
  const repoCwd = persisted?.repoCwd ?? "repo";
  const createdNewRepo = persisted?.createdNewRepo ?? false;
  const repository =
    persisted?.job.repository ?? job.repository ?? task.repository;

  try {
    updateTask(svc, taskId, "running", "Brain harness executing task");
    emit(svc, "task.phase_changed", taskId, "Brain harness executing", {
      phase: "running",
      sessionActive: true,
      agent: "brain",
      harnessOnBrain: true,
    });
    emit(
      svc,
      "agent.running",
      taskId,
      "Brain harness starting on control plane",
      {
        prompt: task.prompt,
        agent: "brain",
        repository,
        sessionActive: true,
        harness: true,
        harnessOnBrain: true,
      },
    );

    const agentPrompt = buildAgentPrompt(
      job.prompt,
      repository ?? "workspace repository",
      repoCwd,
      undefined,
      resolveStackRuntime(task, job),
      {
        followUp: job.resumeSession === true,
        greenfieldRepo: createdNewRepo,
        sessionContext: job.sessionContext,
        sessionRecovery: job.recoverSession === true,
      },
    );

    const recalled = await recallSessionMemory({
      taskId: task.id,
      userId: task.userId,
      query: job.prompt,
      topK: 8,
    });
    if (!isHydraDbEnabled()) {
      emit(
        svc,
        "agent.log",
        taskId,
        "HydraDB context disabled — Brain missing HYDRADB_API_KEY / HYDRADB_DATABASE",
        { hydradb: false },
      );
    } else if (recalled.trim()) {
      emit(svc, "agent.log", taskId, "HydraDB recall attached to harness", {
        hydradb: true,
        recallChars: recalled.length,
      });
    } else {
      emit(svc, "agent.log", taskId, "HydraDB recall empty for this session", {
        hydradb: true,
        recallChars: 0,
      });
    }

    const harnessResult = await runBrainHarness({
      taskId: task.id,
      prompt: agentPrompt,
      workDir: repoCwd,
      followUp: job.resumeSession === true,
      stackRuntime: resolveStackRuntime(task, job),
      requireProductImplementation: createdNewRepo === true,
      sessionContext: job.sessionContext,
      recalledMemory: recalled || undefined,
      maxSteps: createdNewRepo ? 120 : undefined,
      maxWaitMs: resolveAgentMaxWaitMs({
        followUp: job.resumeSession === true,
      }),
      model: resolveBrainAgentModel(job.agentModel, process.env.OPENAI_MODEL),
      executionWorkerUrl: workerUrl,
      onEvent: (event) => {
        emit(svc, event.type, task.id, event.message, event.data);
      },
      onSaveMemory: async (facts) => {
        const ok = await ingestSessionMemory({
          taskId: task.id,
          userId: task.userId,
          text: facts.join("\n"),
          title: `Brain memory ${task.id.slice(0, 8)}`,
        });
        emit(
          svc,
          "agent.log",
          task.id,
          ok
            ? "HydraDB save_memory ingest ok"
            : "HydraDB save_memory ingest skipped or failed",
          { hydradb: ok, facts: facts.length },
        );
      },
    });

    // Persist on Brain (where HYDRADB_* lives). Worker agent-complete may no-op.
    await persistHarnessContextMemory(
      svc,
      task,
      harnessResult.message || harnessResult.status,
    );

    await notifyWorkerAgentComplete(svc, task, job, {
      status: harnessResult.status,
      message: harnessResult.message,
      output: harnessResult.output,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Brain harness failed";
    emit(svc, "agent.failed", taskId, message, { harnessOnBrain: true });
    try {
      await notifyWorkerAgentComplete(svc, task, job, {
        status: "failed",
        message,
      });
    } catch {
      updateTask(svc, taskId, "failed", message);
      emit(svc, "task.failed", taskId, message);
    }
    throw error;
  } finally {
    harnessInFlight.delete(taskId);
    svc.processingTasks.delete(taskId);
  }
}

async function persistHarnessContextMemory(
  svc: TaskService,
  task: Task,
  note: string,
): Promise<void> {
  if (!isHydraDbEnabled()) {
    emit(
      svc,
      "agent.log",
      task.id,
      "HydraDB context disabled — skipping post-harness ingest",
      { hydradb: false },
    );
    return;
  }
  try {
    const stored = await svc.taskStore.loadEvents(task.id);
    const events = stored.length > 0 ? stored : svc.getEventHistory(task.id);
    const ok = await persistTaskContextMemory(task, events, note);
    emit(
      svc,
      "agent.log",
      task.id,
      ok
        ? "HydraDB session memory ingested after harness"
        : "HydraDB session memory ingest failed after harness",
      { hydradb: ok, collection: task.id },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    emit(svc, "agent.log", task.id, "HydraDB session memory ingest error", {
      hydradb: false,
      detail: detail.slice(0, 240),
    });
  }
}

async function notifyWorkerAgentComplete(
  svc: TaskService,
  task: Task,
  job: ScheduleJob,
  result: { status: "completed" | "failed"; message: string; output?: string },
): Promise<void> {
  const response = await delegateRequestToWorker(
    svc,
    `/internal/v1/tasks/${encodeURIComponent(task.id)}/agent-complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: result.status,
        message: result.message,
        output: result.output,
        requireReviewBeforePush: job.requireReviewBeforePush === true,
      }),
    },
    { timeoutMs: 300_000 },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `worker agent-complete failed HTTP ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  // Refresh Brain's view of task status after worker finalize.
  const refreshed = await svc.taskStore.getTask(task.id);
  if (refreshed) {
    svc.tasks.set(task.id, refreshed);
  }
}
