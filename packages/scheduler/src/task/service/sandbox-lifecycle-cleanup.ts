import { RuntimeClient } from "@devin/agent-sdk";
import {
  listSandboxes,
  validateFirecrackerHostForRuntime,
} from "../../diagnostics/collect.js";
import type { ScheduleJob, Task } from "../types.js";
import type { TaskService } from "./task-service.js";
import type { SandboxRecord } from "./types.js";
import { sleep } from "./config.js";
import { fetchSandbox, reclaimDevboxCapacity } from "./sandbox-lifecycle.js";
import { emit } from "./task-state.js";

export async function deleteSandbox(
  svc: TaskService,
  sandboxName: string,
): Promise<void> {
  try {
    await fetch(
      `${svc.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
      { method: "DELETE" },
    );
  } catch {
    // best-effort cleanup
  }
}

export async function waitForSandboxDeleted(
  svc: TaskService,
  sandboxName: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sandbox = await fetchSandbox(svc, sandboxName);
    if (!sandbox) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`sandbox ${sandboxName} was not deleted before retry`);
}

export async function waitForSandbox(
  svc: TaskService,
  sandboxName: string,
  taskId: string,
  reprovision?: () => Promise<void>,
): Promise<SandboxRecord> {
  const deadline = Date.now() + svc.sandboxReadyTimeoutMs;
  let lastPhase = "unknown";
  let lastMessage = "";
  let lastProgressAt = 0;
  let pendingSince: number | null = null;
  let missingSince: number | null = null;
  let everObserved = false;
  let reprovisionAttempts = 0;

  while (Date.now() < deadline) {
    const sandbox = await fetchSandbox(svc, sandboxName);
    if (sandbox) {
      everObserved = true;
      missingSince = null;
      const phase = sandbox.status?.phase ?? "Pending";
      const message = sandbox.status?.message?.trim() ?? "";
      const phaseChanged = phase !== lastPhase;
      const messageChanged = message !== lastMessage;
      lastPhase = phase;
      lastMessage = message;

      if (phase === "Pending" || phase === "Provisioning") {
        pendingSince ??= Date.now();
        const pendingMs = Date.now() - pendingSince;
        if (
          phase === "Pending" &&
          pendingMs > 90_000 &&
          !message &&
          !sandbox.status?.vmId
        ) {
          const stuckMessage =
            `sandbox ${sandboxName} is stuck in Pending — the orchestrator sandbox controller may not be running, ` +
            "or spec.preferredHost does not match any FirecrackerHost CR. " +
            "Verify FirecrackerHost CRs in devin-firecracker and SCHEDULER_HOST_NAME on the execution host.";
          emit(svc, "sandbox.failed", taskId, stuckMessage, {
            sandboxName,
            phase,
            pendingMs,
          });
          throw new Error(stuckMessage);
        }
      } else {
        pendingSince = null;
      }

      if (
        (phaseChanged || messageChanged) &&
        Date.now() - lastProgressAt >= 1_000
      ) {
        lastProgressAt = Date.now();
        emit(
          svc,
          "sandbox.provisioning",
          taskId,
          message
            ? `Sandbox ${phase}: ${message}`
            : `Sandbox phase is ${phase}`,
          {
            sandboxName,
            phase,
            message: message || undefined,
            vmId: sandbox.status?.vmId,
            host: sandbox.status?.host,
            runtimeURL: sandbox.status?.runtimeURL,
            elapsedMs: svc.sandboxReadyTimeoutMs - (deadline - Date.now()),
          },
        );
      }

      if (phase === "Running") {
        return sandbox;
      }
      if (phase === "Suspended") {
        await sleep(500);
        continue;
      }
      if (phase === "Waking") {
        lastPhase = phase;
        await sleep(500);
        continue;
      }
      if (phase === "Failed") {
        const failureMessage = lastMessage
          ? `sandbox ${sandboxName} failed: ${lastMessage}`
          : `sandbox ${sandboxName} failed for task ${taskId}`;
        const retryableCapacity =
          /lacks capacity/i.test(lastMessage) ||
          (/not found/i.test(lastMessage) &&
            /firecracker\s*host/i.test(lastMessage));
        if (
          retryableCapacity &&
          reprovision &&
          Date.now() < deadline - 30_000
        ) {
          const reclaimed = await reclaimDevboxCapacity(svc, taskId, 1);
          emit(
            svc,
            "sandbox.provisioning",
            taskId,
            reclaimed > 0
              ? `Reclaimed ${reclaimed} devbox(es); re-creating sandbox`
              : `Waiting for execution host capacity (${lastMessage})`,
            {
              sandboxName,
              phase,
              message: lastMessage || undefined,
              waitingForCapacity: reclaimed === 0,
              reclaimedSandboxes: reclaimed,
            },
          );
          // The failed sandbox must be removed and re-created; otherwise the
          // orchestrator holds no record and the poll loop below would wait
          // forever on a sandbox that will never exist again.
          await deleteSandbox(svc, sandboxName);
          await waitForSandboxDeleted(svc, sandboxName);
          await sleep(reclaimed > 0 ? 3_000 : 5_000);
          await reprovision();
          lastPhase = "unknown";
          lastMessage = "";
          pendingSince = null;
          continue;
        }
        const hostRegistryHint =
          /firecracker\s*host/i.test(lastMessage) &&
          /not found|lacks capacity/i.test(lastMessage) &&
          svc.preferredHost
            ? ` Re-register with: curl -X PUT -H 'Content-Type: application/json' -d '{"spec":{"address":"http://<host-ip>:9092","schedulerAddress":"http://<host-ip>:9091","capacity":{"cpu":2,"memory":"16Gi"}}}' ${svc.orchestratorUrl}/internal/v1/firecracker-hosts/${svc.preferredHost}`
            : undefined;
        emit(svc, "sandbox.failed", taskId, failureMessage, {
          sandboxName,
          phase,
          message: lastMessage || undefined,
          preferredHost: svc.preferredHost,
          remediation: hostRegistryHint,
        });
        throw new Error(
          /lacks capacity/i.test(lastMessage)
            ? `${failureMessage}. End idle devbox sessions on this host or wait for capacity to free up.`
            : /firecracker\s*host/i.test(lastMessage) &&
                /not found/i.test(lastMessage)
              ? `${failureMessage}. Ensure FirecrackerHost ${svc.preferredHost ?? "registration"} is registered with the orchestrator.`
              : failureMessage,
        );
      }
    } else {
      missingSince ??= Date.now();
      const missingMs = Date.now() - missingSince;

      // A create/delete race (e.g. reclaiming a stale same-named sandbox)
      // can leave the orchestrator with no record. Rather than polling a
      // ghost until timeout, re-issue the create request once it has been
      // missing long enough.
      if (
        reprovision &&
        missingMs > 15_000 &&
        reprovisionAttempts < 3 &&
        Date.now() < deadline - 30_000
      ) {
        reprovisionAttempts += 1;
        emit(
          svc,
          "sandbox.provisioning",
          taskId,
          everObserved
            ? "Sandbox disappeared from orchestrator — re-creating"
            : "Sandbox was never registered — re-creating",
          {
            sandboxName,
            phase: "unknown",
            orchestratorUrl: svc.orchestratorUrl,
            reprovisionAttempt: reprovisionAttempts,
          },
        );
        await reprovision();
        missingSince = null;
        await sleep(1_000);
        continue;
      }

      // After re-create attempts are exhausted, fail fast instead of
      // burning the full ready timeout on a sandbox that will never appear.
      if (missingMs > 45_000 && (!reprovision || reprovisionAttempts >= 3)) {
        const missingMessage = everObserved
          ? `sandbox ${sandboxName} disappeared from the orchestrator and could not be re-created for task ${taskId}`
          : `sandbox ${sandboxName} was never registered with the orchestrator for task ${taskId}`;
        emit(svc, "sandbox.failed", taskId, missingMessage, {
          sandboxName,
          phase: "unknown",
          orchestratorUrl: svc.orchestratorUrl,
          reprovisionAttempts,
          missingMs,
        });
        throw new Error(missingMessage);
      }

      if (Date.now() - lastProgressAt >= 3_000) {
        lastProgressAt = Date.now();
        emit(
          svc,
          "sandbox.provisioning",
          taskId,
          "Sandbox not found in orchestrator yet — still waiting",
          {
            sandboxName,
            phase: "unknown",
            orchestratorUrl: svc.orchestratorUrl,
          },
        );
      }
    }
    await sleep(500);
  }

  const detail = !everObserved
    ? " (sandbox was never found in orchestrator)"
    : lastMessage
      ? ` (phase=${lastPhase}, ${lastMessage})`
      : lastPhase === "unknown"
        ? " (sandbox disappeared from orchestrator)"
        : ` (phase=${lastPhase})`;
  const timeoutMessage = `sandbox ${sandboxName} did not become ready for task ${taskId} within ${svc.sandboxReadyTimeoutMs / 1000}s${detail}`;
  emit(svc, "sandbox.failed", taskId, timeoutMessage, {
    sandboxName,
    phase: lastPhase,
    message: lastMessage || undefined,
    timeoutSeconds: svc.sandboxReadyTimeoutMs / 1000,
    everObserved,
    reprovisionAttempts,
  });
  throw new Error(timeoutMessage);
}

export async function flushGuestNetworkBeforeRuntimeProbe(
  svc: TaskService,
  taskId: string,
): Promise<void> {
  const base = svc.firecrackerHostUrl?.trim().replace(/\/$/, "");
  if (!base) {
    return;
  }
  try {
    await fetch(`${base}/v1/network/flush`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(svc, "agent.log", taskId, `Guest network flush skipped (${message})`, {
      firecrackerHostUrl: base,
    });
  }
}

export async function waitForRuntime(
  svc: TaskService,
  runtime: RuntimeClient,
  taskId: string,
  runtimeBaseUrl: string,
): Promise<void> {
  const deadline = Date.now() + svc.runtimeReadyTimeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const health = await runtime.health();
      if (health.status === "ok") {
        return;
      }
      lastError = `unexpected health status: ${health.status ?? "unknown"}`;
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "runtime health probe failed";
    }
    await sleep(500);
  }
  const detail = lastError ? ` Last error: ${lastError}` : "";
  throw new Error(
    `Runtime supervisor at ${runtimeBaseUrl} did not become ready for task ${taskId} within ${svc.runtimeReadyTimeoutMs / 1000}s.${detail}`,
  );
}

export async function suspendSandbox(
  svc: TaskService,
  sandboxName: string,
): Promise<void> {
  try {
    await fetch(
      `${svc.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}/suspend`,
      { method: "POST" },
    );
  } catch {
    // best-effort soft sleep
  }
}

export async function wakeSandbox(
  svc: TaskService,
  sandboxName: string,
): Promise<void> {
  const response = await fetch(
    `${svc.orchestratorUrl}/internal/v1/sandboxes/${encodeURIComponent(sandboxName)}/wake`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`failed to wake sandbox ${sandboxName}`);
  }
}

export async function resolveRuntimeUrl(
  svc: TaskService,
  sandboxName: string,
): Promise<string> {
  const sandbox = await waitForSandbox(svc, sandboxName, "wake");
  const runtimeURL = sandbox.status?.runtimeURL?.trim();
  if (!runtimeURL) {
    throw new Error(`sandbox ${sandboxName} has no runtime URL after wake`);
  }
  return runtimeURL.replace(/\/$/, "");
}
