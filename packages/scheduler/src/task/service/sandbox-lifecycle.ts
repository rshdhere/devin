import { RuntimeClient } from "@devin/agent-sdk";
import {
  listSandboxes,
  validateFirecrackerHostForRuntime,
} from "../../diagnostics/collect.js";
import { formatOrchestratorConnectionError } from "../../config/orchestrator-url.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import type { SandboxRecord } from "./types.js";
import { sleep } from "./config.js";
import { emit } from "./task-state.js";
import {
  deleteSandbox,
  waitForSandboxDeleted,
} from "./sandbox-lifecycle-cleanup.js";

export function assertSandboxOnLocalHost(
  svc: TaskService,
  sandbox: SandboxRecord,
  taskId: string,
): void {
  const sandboxHost = sandbox.status?.host?.trim();
  if (!svc.preferredHost || !sandboxHost) {
    return;
  }
  if (sandboxHost === svc.preferredHost) {
    return;
  }
  const message =
    `Sandbox landed on execution host "${sandboxHost}" but this scheduler is pinned to "${svc.preferredHost}". ` +
    "Route tasks to the matching scheduler or set SCHEDULER_HOST_NAME on each execution host.";
  emit(svc, "sandbox.failed", taskId, message, {
    sandboxHost,
    schedulerHost: svc.preferredHost,
  });
  throw new Error(message);
}

export async function ensureSandboxDns(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  try {
    const viaApi = await runtime.ensureDns();
    if (viaApi) {
      // Older guest runtimes only refresh resolv.conf; always seed entropy
      // for snapshots that resume with an uninitialized CRNG.
      await ensureSandboxEntropy(svc, runtime, taskId);
      return;
    }

    const result = await runtime.terminalAllowFailure({
      taskId,
      command:
        "printf '%s\\n' 'nameserver 8.8.8.8' 'nameserver 1.1.1.1' 'nameserver 8.8.4.4' > /etc/resolv.conf",
    });
    if (result.exitCode !== 0) {
      emit(
        svc,
        "agent.log",
        taskId,
        "Could not refresh sandbox DNS via runtime terminal",
        {
          exitCode: result.exitCode,
          detail: (result.stderr || result.stdout).trim(),
        },
      );
    }
    await ensureSandboxEntropy(svc, runtime, taskId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "sandbox DNS setup failed";
    emit(svc, "agent.log", taskId, `Skipped sandbox DNS setup: ${message}`, {
      dnsSetupSkipped: true,
    });
    await ensureSandboxEntropy(svc, runtime, taskId);
  }
}

/**
 * Credit the guest kernel RNG so OpenSSL/Node getrandom() and HTTPS work.
 * Firecracker golden snapshots often resume with crng_init=0 and no virtio-rng.
 */

export async function ensureSandboxEntropy(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
): Promise<void> {
  const command = [
    "perl - <<'PERL'",
    "open U, '</dev/urandom' or exit 0;",
    "sysread(U, $b, 256) == 256 or exit 0;",
    "close U;",
    "open R, '+<', '/dev/random' or exit 0;",
    'ioctl(R, 0x40085203, pack("iia*", 2048, 256, $b)) or exit 0;',
    "close R;",
    'print "entropy_ok\\n";',
    "PERL",
  ].join("\n");
  try {
    const result = await runtime.terminalAllowFailure({ taskId, command });
    if (result.exitCode === 0 && /entropy_ok/.test(result.stdout)) {
      emit(svc, "agent.log", taskId, "Sandbox guest entropy credited", {
        entropySeeded: true,
      });
      return;
    }
    emit(svc, "agent.log", taskId, "Sandbox guest entropy seed skipped", {
      entropySeeded: false,
      exitCode: result.exitCode,
      detail: (result.stderr || result.stdout).trim(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "sandbox entropy setup failed";
    emit(
      svc,
      "agent.log",
      taskId,
      `Skipped sandbox entropy setup: ${message}`,
      { entropySetupSkipped: true },
    );
  }
}

export async function ensureSandbox(
  svc: TaskService,
  sandboxName: string,
  taskId: string,
  spec: Record<string, unknown>,
  options?: { forceRecreate?: boolean },
): Promise<void> {
  const create = async (): Promise<number> => {
    try {
      const response = await fetch(
        `${svc.orchestratorUrl}/internal/v1/sandboxes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: sandboxName, spec }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      return response.status;
    } catch (error) {
      throw new Error(
        formatOrchestratorConnectionError(svc.orchestratorUrl, error),
      );
    }
  };

  let status = await create();
  if (status === 409) {
    const existing = await fetchSandbox(svc, sandboxName);
    const phase = existing?.status?.phase;

    if (phase === "Running" && !options?.forceRecreate) {
      emit(
        svc,
        "task.scheduled",
        taskId,
        "Reusing running sandbox from prior attempt",
        { sandboxName, phase },
      );
      return;
    }

    if (phase === "Running" && options?.forceRecreate) {
      emit(svc, "task.scheduled", taskId, "Recreating sandbox after retry", {
        sandboxName,
        phase,
        forceRecreate: true,
      });
    } else {
      emit(
        svc,
        "task.scheduled",
        taskId,
        "Removing stale sandbox before retry",
        {
          sandboxName,
          phase: phase ?? "unknown",
        },
      );
    }
    await deleteSandbox(svc, sandboxName);
    await waitForSandboxDeleted(svc, sandboxName);

    status = await create();
  }

  if (status !== 202 && status !== 200 && status !== 409) {
    const message = `orchestrator rejected sandbox: HTTP ${status}`;
    emit(svc, "sandbox.failed", taskId, message, {
      sandboxName,
      status,
    });
    throw new Error(message);
  }
}

export async function fetchSandbox(
  svc: TaskService,
  sandboxName: string,
): Promise<SandboxRecord | undefined> {
  try {
    const response = await fetch(
      `${svc.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
    );
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as SandboxRecord;
  } catch {
    return undefined;
  }
}

export async function provisionSandboxWithCapacityRetry(
  svc: TaskService,
  sandboxName: string,
  taskId: string,
  spec: Record<string, unknown>,
  _requiredCpu: number,
  options?: { forceRecreate?: boolean },
): Promise<void> {
  await ensureSandbox(svc, sandboxName, taskId, spec, options);
}

export async function reclaimDevboxCapacity(
  svc: TaskService,
  taskId: string,
  requiredCpu: number,
): Promise<number> {
  const sandboxes = await listSandboxes(svc.orchestratorUrl);
  let reclaimed = 0;
  const protectedTaskIds = new Set<string>([
    taskId,
    ...svc.activeSessions.keys(),
    ...svc.reviewSessions.keys(),
    ...svc.processingTasks,
  ]);

  for (const sandbox of sandboxes) {
    if (sandbox.phase !== "Failed") {
      continue;
    }
    // Never delete the in-flight task's own sandbox here. waitForSandbox
    // owns retry/recreate for that record; reclaiming it leaves a ghost
    // name that the poll loop waits on until the ready timeout.
    const ownerTaskId = sandbox.taskId?.trim();
    if (ownerTaskId && protectedTaskIds.has(ownerTaskId)) {
      continue;
    }
    await deleteSandbox(svc, sandbox.name);
    reclaimed += 1;
    emit(svc, "agent.log", taskId, `Reclaimed failed sandbox ${sandbox.name}`, {
      sandboxName: sandbox.name,
      reclaimed: true,
    });
  }

  for (const sandbox of sandboxes) {
    const ownerTaskId = sandbox.taskId?.trim();
    if (!ownerTaskId || protectedTaskIds.has(ownerTaskId)) {
      continue;
    }
    if (sandbox.phase !== "Running" && sandbox.phase !== "Provisioning") {
      continue;
    }

    const owner =
      svc.tasks.get(ownerTaskId) ?? (await svc.taskStore.getTask(ownerTaskId));
    const abandoned =
      !owner ||
      owner.status === "failed" ||
      owner.status === "cancelled" ||
      owner.status === "completed";
    if (!abandoned) {
      continue;
    }

    await forceTerminateDevbox(svc, ownerTaskId, sandbox.name, taskId);
    reclaimed += 1;
    protectedTaskIds.add(ownerTaskId);
  }

  if (reclaimed === 0 && requiredCpu > 0) {
    // Last resort: delete an unprotected Running sandbox so a new task can
    // start even when completed-session tracking is incomplete.
    const candidate = sandboxes.find((entry) => {
      const ownerTaskId = entry.taskId?.trim();
      return (
        !!ownerTaskId &&
        !protectedTaskIds.has(ownerTaskId) &&
        (entry.phase === "Running" || entry.phase === "Provisioning")
      );
    });
    if (candidate?.taskId) {
      await forceTerminateDevbox(svc, candidate.taskId, candidate.name, taskId);
      reclaimed += 1;
      protectedTaskIds.add(candidate.taskId);
    }
  }

  if (reclaimed === 0 && requiredCpu > 0) {
    const staleTaskId = await findStaleDevboxSessionTaskId(svc);
    if (staleTaskId && !protectedTaskIds.has(staleTaskId)) {
      const staleSandbox = sandboxes.find(
        (entry) => entry.taskId === staleTaskId,
      );
      if (staleSandbox) {
        await forceTerminateDevbox(svc, staleTaskId, staleSandbox.name, taskId);
        reclaimed += 1;
      }
    }
  }

  if (reclaimed > 0) {
    emit(svc, "agent.log", taskId, `Reclaimed ${reclaimed} devbox(es)`, {
      reclaimed,
      requiredCpu,
    });
  }

  return reclaimed;
}

export async function findStaleDevboxSessionTaskId(
  svc: TaskService,
): Promise<string | undefined> {
  const cutoff = Date.now() - 20 * 60 * 1000;
  let oldestTaskId: string | undefined;
  let oldestActiveAt = Number.POSITIVE_INFINITY;

  for (const [taskId] of svc.activeSessions) {
    const persisted = await svc.taskStore.getSession(taskId);
    const task = svc.tasks.get(taskId) ?? (await svc.taskStore.getTask(taskId));
    if (!task || task.status !== "completed") {
      continue;
    }
    const lastActive = persisted
      ? new Date(persisted.lastActiveAt).getTime()
      : new Date(task.updatedAt ?? task.createdAt).getTime();
    if (lastActive < cutoff && lastActive < oldestActiveAt) {
      oldestActiveAt = lastActive;
      oldestTaskId = taskId;
    }
  }

  return oldestTaskId;
}

export async function forceTerminateDevbox(
  svc: TaskService,
  ownerTaskId: string,
  sandboxName: string,
  requestingTaskId: string,
): Promise<void> {
  await deleteSandbox(svc, sandboxName);
  svc.activeSessions.delete(ownerTaskId);
  svc.reviewSessions.delete(ownerTaskId);
  await svc.taskStore.deleteSession(ownerTaskId);

  const owner = svc.tasks.get(ownerTaskId);
  if (owner) {
    owner.sessionActive = false;
    owner.sessionSleeping = false;
    owner.sandboxName = undefined;
    await svc.taskStore.upsertTask(owner);
  }

  emit(
    svc,
    "agent.log",
    requestingTaskId,
    `Reclaimed devbox ${sandboxName} from task ${ownerTaskId}`,
    {
      reclaimedFrom: ownerTaskId,
      sandboxName,
      reason: "capacity",
    },
  );
}

export async function reclaimFailedSandboxes(
  svc: TaskService,
  taskId: string,
): Promise<number> {
  return reclaimDevboxCapacity(svc, taskId, 1);
}

export {
  deleteSandbox,
  waitForSandboxDeleted,
  waitForSandbox,
  flushGuestNetworkBeforeRuntimeProbe,
  repairGuestNetworkOnHost,
  waitForRuntime,
  suspendSandbox,
  wakeSandbox,
  resolveRuntimeUrl,
} from "./sandbox-lifecycle-cleanup.js";
