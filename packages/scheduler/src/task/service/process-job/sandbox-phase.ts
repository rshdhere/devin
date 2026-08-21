import { RuntimeClient } from "@devin/agent-sdk";
import { usesRuntimeAgent } from "../../../agent/defaults.js";
import { resolveRuntimeForTask } from "@devin/types";
import { validateFirecrackerHostForRuntime } from "../../../diagnostics/collect.js";
import { ensureExecutionHostRegistered } from "../../../host/register-execution-host.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "../task-service.js";
import {
  hydrateTaskRuntime,
  resolveSandboxCpu,
  resolveSandboxMemory,
  resolveStackRuntime,
  sleep,
} from "../config.js";
import {
  prepareDraft,
  provisionGreenfieldRepository,
  provisionGreenfieldRepositoryShell,
  validateAgentSecrets,
  validateGreenfieldDraftSecrets,
} from "../greenfield-provision.js";
import {
  assertSandboxOnLocalHost,
  ensureSandboxDns,
  flushGuestNetworkBeforeRuntimeProbe,
  provisionSandboxWithCapacityRetry,
  reclaimDevboxCapacity,
  waitForRuntime,
  waitForSandbox,
} from "../sandbox-lifecycle.js";
import { hydrateSessionFromStore, wakeSession } from "../session-lifecycle.js";
import { emit, updateTask } from "../task-state.js";
import type { ProcessJobState } from "./state.js";
import { runSandboxRepoSetupPhase } from "./sandbox-phase-repo.js";

export async function runSandboxSetupPhase(
  svc: TaskService,
  job: ScheduleJob,
  task: Task,
  state: ProcessJobState,
): Promise<void> {
  let resumeSession =
    job.resumeSession === true && job.recoverSession !== true
      ? (svc.activeSessions.get(task.id) ??
        svc.reviewSessions.get(task.id) ??
        (await wakeSession(svc, task.id)))
      : undefined;

  if (
    job.resumeSession === true &&
    job.recoverSession !== true &&
    !resumeSession
  ) {
    const persisted = await svc.taskStore.getSession(task.id);
    if (
      persisted &&
      (persisted.state === "active" || persisted.state === "review")
    ) {
      resumeSession = await hydrateSessionFromStore(svc, task.id, persisted);
    }
  }

  if (
    job.resumeSession === true &&
    job.recoverSession !== true &&
    !resumeSession
  ) {
    throw new Error("no devbox session available to resume follow-up");
  }

  if (resumeSession) {
    svc.reviewSessions.delete(task.id);
    state.sandboxName = resumeSession.sandboxName;
    state.runtimeBaseUrl = resumeSession.runtimeBaseUrl;
    state.runtime = resumeSession.runtime;
    state.guestHost = resumeSession.guestHost;
    state.repoCwd = resumeSession.repoCwd;
    state.repository = resumeSession.job.repository ?? task.repository;
    state.cloneUrl = resumeSession.job.cloneUrl;
    state.githubToken = resumeSession.job.githubToken;
    state.createdNewRepo = resumeSession.createdNewRepo;
    Object.assign(job, resumeSession.job, {
      prompt: job.prompt,
      resumeSession: true,
      sessionContext: job.sessionContext,
    });
    task.sandboxName = state.sandboxName;
    task.sessionActive = true;
    updateTask(svc, task.id, "running", "Follow-up running in devbox session");
    emit(svc, "task.phase_changed", task.id, "Resuming devbox session", {
      phase: "running",
      sessionActive: true,
      followUp: true,
      prompt: job.prompt,
      sandboxName: state.sandboxName,
      runtimeURL: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
    });
    emit(svc, "execution.started", task.id, "Follow-up execution started", {
      phase: "running",
      followUp: true,
      prompt: job.prompt,
      sandboxName: state.sandboxName,
      runtimeURL: state.runtimeBaseUrl,
      repoCwd: state.repoCwd,
    });
  } else if (!job.skipDraft) {
    updateTask(svc, task.id, "scheduling", "Scheduler picked up task");
    emit(svc, "task.scheduled", task.id, "Task scheduled", {
      agent: task.agent,
      prompt: job.prompt,
    });
    emit(svc, "task.phase_changed", task.id, "Entered scheduling phase", {
      phase: "scheduling",
    });

    validateAgentSecrets(svc, task);

    if (usesRuntimeAgent(task.agent)) {
      emit(
        svc,
        "task.phase_changed",
        task.id,
        "Runtime agent will implement changes in the sandbox",
        {
          phase: "scheduling",
          runtimeAgent: true,
        },
      );
    } else {
      validateGreenfieldDraftSecrets(svc, job);

      updateTask(svc, task.id, "drafting", "Preparing draft plan");
      emit(svc, "task.phase_changed", task.id, "Entered draft phase", {
        phase: "drafting",
      });
      await prepareDraft(svc, task, job);

      const autoStartSandbox = job.autoStartSandbox !== false;
      if (!autoStartSandbox) {
        await provisionGreenfieldRepository(svc, task, job);
        updateTask(
          svc,
          task.id,
          "draft_ready",
          "Draft ready — approve sandbox to continue",
        );
        emit(
          svc,
          "task.phase_changed",
          task.id,
          "Draft ready — waiting for sandbox approval",
          {
            phase: "draft_ready",
            awaitingApproval: true,
          },
        );
        return;
      }
    }
  } else {
    validateAgentSecrets(svc, task);
  }

  if (!resumeSession) {
    if (
      usesRuntimeAgent(task.agent) &&
      (job.createRepository || job.autoCreateRepository)
    ) {
      await provisionGreenfieldRepositoryShell(svc, task, job);
    } else {
      await provisionGreenfieldRepository(svc, task, job);
    }

    updateTask(
      svc,
      task.id,
      usesRuntimeAgent(task.agent) ? "sandbox_starting" : "draft_ready",
      usesRuntimeAgent(task.agent)
        ? "Booting devbox from snapshot"
        : "Draft ready; starting sandbox",
    );
    emit(
      svc,
      "task.phase_changed",
      task.id,
      usesRuntimeAgent(task.agent)
        ? "Booting devbox"
        : "Draft ready; moving to sandbox execution",
      {
        phase: usesRuntimeAgent(task.agent)
          ? "sandbox_starting"
          : "draft_ready",
      },
    );
    emit(svc, "execution.started", task.id, "Execution starting in devbox", {
      phase: "sandbox_starting",
      prompt: job.prompt,
    });

    state.sandboxName = `sbx-${task.id.slice(0, 8)}`;
    task.sandboxName = state.sandboxName;
    updateTask(svc, task.id, "sandbox_starting", "Creating devbox");

    const runtimeImage =
      task.runtime ??
      job.runtime ??
      resolveRuntimeForTask(task.agent, task.prompt);
    const sandboxCpu = resolveSandboxCpu(task);

    if (svc.firecrackerHostUrl) {
      const hostIssue = await validateFirecrackerHostForRuntime(
        svc.firecrackerHostUrl,
        runtimeImage,
      );
      if (hostIssue) {
        throw new Error(hostIssue);
      }
    }

    if (svc.preferredHost) {
      emit(
        svc,
        "agent.log",
        task.id,
        `Ensuring FirecrackerHost ${svc.preferredHost} is registered`,
        { preferredHost: svc.preferredHost },
      );
      await ensureExecutionHostRegistered({
        orchestratorUrl: svc.orchestratorUrl,
        hostName: svc.preferredHost,
        firecrackerHostUrl: svc.firecrackerHostUrl,
      });
    }

    const reclaimed = await reclaimDevboxCapacity(svc, task.id, sandboxCpu);
    if (reclaimed > 0) {
      await sleep(3_000);
    }

    emit(
      svc,
      "sandbox.requested",
      task.id,
      "Requesting devbox from orchestrator",
      {
        sandboxName: state.sandboxName,
        runtime: runtimeImage,
        orchestratorUrl: svc.orchestratorUrl,
        cpu: sandboxCpu,
        reclaimedSandboxes: reclaimed,
      },
    );

    const sandboxSpec: Record<string, unknown> = {
      taskId: task.id,
      runtime: runtimeImage,
      cpu: sandboxCpu,
      memory: resolveSandboxMemory(task),
      ...(svc.preferredHost ? { preferredHost: svc.preferredHost } : {}),
    };

    await provisionSandboxWithCapacityRetry(
      svc,
      state.sandboxName,
      task.id,
      sandboxSpec,
      sandboxCpu,
      { forceRecreate: job.forceSandboxRecreate },
    );

    const provisionedSandboxName = state.sandboxName;
    const sandbox = await waitForSandbox(
      svc,
      provisionedSandboxName,
      task.id,
      () =>
        provisionSandboxWithCapacityRetry(
          svc,
          provisionedSandboxName,
          task.id,
          sandboxSpec,
          sandboxCpu,
          { forceRecreate: job.forceSandboxRecreate },
        ),
    );
    assertSandboxOnLocalHost(svc, sandbox, task.id);
    task.sessionActive = true;
    emit(svc, "sandbox.started", task.id, "Devbox microVM is running", {
      sandboxName: state.sandboxName,
      vmId: sandbox.status?.vmId,
      host: sandbox.status?.host,
      runtime: runtimeImage,
      sessionActive: true,
    });

    state.runtimeBaseUrl = sandbox.status?.runtimeURL?.replace(/\/$/, "");
    if (!state.runtimeBaseUrl) {
      throw new Error(
        "Sandbox is running but orchestrator did not publish a runtimeURL. Check firecracker and orchestrator sync.",
      );
    }
    state.guestHost = new URL(state.runtimeBaseUrl).hostname;
    state.runtime = new RuntimeClient({ baseUrl: state.runtimeBaseUrl });
    await flushGuestNetworkBeforeRuntimeProbe(svc, task.id);
    emit(
      svc,
      "runtime.waiting",
      task.id,
      "Waiting for runtime supervisor health check",
      {
        runtimeURL: state.runtimeBaseUrl,
      },
    );
    await waitForRuntime(svc, state.runtime, task.id, state.runtimeBaseUrl);
    await ensureSandboxDns(svc, state.runtime, task.id);
    emit(svc, "runtime.ready", task.id, "Runtime supervisor is ready", {
      runtimeURL: state.runtimeBaseUrl,
    });
  }

  if (!state.runtime || !state.runtimeBaseUrl || !state.sandboxName) {
    throw new Error("devbox session is not available");
  }
  await runSandboxRepoSetupPhase(svc, job, task, state, resumeSession);
}
