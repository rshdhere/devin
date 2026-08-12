"use client";

import { AlertTriangle } from "lucide-react";
import type { InfraDiagnostics, Task, TaskDiagnostics } from "@devin/types";
import { cn } from "@/lib/utils";
import { formatAgentFailureMessage } from "@/lib/sessions/agent-activity";
import { CollapsiblePanel } from "./session-detail-panels";

export function DiagnosticsPanel({
  task,
  taskDiagnostics,
  infraDiagnostics,
  loading,
  error,
  onRefresh,
  defaultExpanded = false,
}: {
  task: Task;
  taskDiagnostics: TaskDiagnostics | null;
  infraDiagnostics: InfraDiagnostics | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  defaultExpanded?: boolean;
}) {
  const sandbox = taskDiagnostics?.sandbox;
  const host = infraDiagnostics?.firecrackerHost;

  return (
    <CollapsiblePanel
      title="Sandbox diagnostics"
      icon={AlertTriangle}
      iconClassName="text-amber-400"
      defaultExpanded={defaultExpanded}
      className="border-[#3a2a2a] bg-[#1a1212]"
      headerRight={
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          disabled={loading}
          className="cursor-pointer rounded-md border border-[#3a2a2a] px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:bg-[#241818] hover:text-gray-200 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      {task.message ? (
        <div className="mb-3 space-y-2">
          <p className="rounded-lg bg-[#120d0d] px-3 py-2 text-[12px] leading-relaxed text-red-300">
            {formatAgentFailureMessage(task.message)}
          </p>
          {/database or disk is full/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The Cursor CLI could not write its session database inside the
              sandbox (disk full). On the execution host free space under{" "}
              <span className="font-mono text-amber-100">/var/lib/devin</span>,
              remove stale sandboxes, and retry. This is not a web or API bug.
            </p>
          ) : null}
          {/enospc|no space left on device/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The sandbox workspace tmpfs filled up (pip/npm caches, build
              artifacts). Retry the session — redeploy the runtime worker so
              tmpfs grows to 8G and automatic cache pruning is active. If it
              persists, free host disk under{" "}
              <span className="font-mono text-amber-100">/var/lib/devin</span>.
            </p>
          ) : null}
          {/resource_exhausted/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The Cursor cloud agent ran out of temporary capacity mid-run. The
              control plane finalizes commits already on disk when possible;
              retry the session if the product is incomplete.
            </p>
          ) : null}
          {/agent credentials are not configured/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              Agent credentials are managed on the execution host, not in the
              browser. Ask your platform admin to configure secrets, then open{" "}
              <span className="text-white">Platform status</span> on the
              dashboard to verify the brain and worker are connected.
            </p>
          ) : null}
          {/EXECUTION_WORKER_URL|worker rejected job|worker unavailable/i.test(
            task.message,
          ) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The brain control plane could not reach the execution worker.
              Check Platform status on the dashboard and confirm the worker
              scheduler is running on the execution host.
            </p>
          ) : null}
          {/timed out/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              {/npm install timed out/i.test(task.message) ? (
                <>
                  Dependency install in the sandbox timed out. On the execution
                  host run{" "}
                  <span className="font-mono text-amber-100">
                    sudo devin-infra fix-sandbox-dns
                  </span>{" "}
                  and confirm the microVM has outbound HTTPS (443) to the npm
                  registry.
                </>
              ) : /sandbox.*did not become ready/i.test(task.message) ? (
                <>
                  The sandbox never reached Running. Confirm{" "}
                  <span className="font-mono text-amber-100">
                    SCHEDULER_HOST_NAME
                  </span>{" "}
                  matches your FirecrackerHost CR name, the orchestrator sandbox
                  controller is running, and the nextjs snapshot is built on the
                  execution host.
                </>
              ) : (
                <>
                  The task hit a timeout before finishing. For greenfield runs,
                  confirm{" "}
                  <span className="font-mono text-amber-100">
                    SCHEDULER_HOST_NAME
                  </span>{" "}
                  matches your FirecrackerHost CR name, the orchestrator sandbox
                  controller is running, and the nextjs snapshot is built on the
                  execution host.
                </>
              )}
            </p>
          ) : null}
          {/cannot reach Cursor or GitHub/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The microVM sandbox has no outbound internet. Check Firecracker
              CNI NAT, DNS, and security group egress rules for HTTPS (443).
            </p>
          ) : null}
          {/Runtime request failed/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The scheduler could not talk to the runtime supervisor inside the
              microVM. Rebuild the agent snapshot, restart firecracker and
              scheduler, and confirm SCHEDULER_HOST_NAME matches the
              FirecrackerHost CR on this execution host.
            </p>
          ) : null}
          {/cannot reach the Cursor API/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The sandbox could not reach api2.cursor.sh. On the execution host
              run{" "}
              <span className="font-mono text-amber-100">
                sudo devin-infra fix-sandbox-dns
              </span>{" "}
              (enables ip_forward + CNI DNS), restart firecracker and scheduler,
              then rebuild the agent snapshot.
            </p>
          ) : null}
          {/not available in range|failed to allocate|failed to create CNI network/i.test(
            task.message,
          ) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              Sandbox networking failed while allocating the microVM IP. On the
              execution host run{" "}
              <span className="font-mono text-amber-100">
                sudo devin-infra fix-sandbox-dns
              </span>
              , then restart firecracker and scheduler. If the error persists,
              redeploy the latest{" "}
              <span className="font-mono text-amber-100">
                devin-firecracker
              </span>{" "}
              image on the host.
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="mb-3 text-[12px] text-red-400">{error}</p> : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-[#2a2020] bg-[#141010] p-3">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-gray-500 uppercase">
            Task sandbox
          </p>
          <dl className="space-y-1.5 text-[12px]">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Name</dt>
              <dd className="font-mono text-gray-300">
                {taskDiagnostics?.sandboxName ?? task.sandboxName ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Phase</dt>
              <dd
                className={cn(
                  "font-medium",
                  sandbox?.phase === "Running"
                    ? "text-emerald-400"
                    : "text-amber-300",
                )}
              >
                {sandbox?.phase ??
                  (task.sandboxName ? "Ended or not tracked" : "Not found")}
              </dd>
            </div>
            {!sandbox?.phase && task.sandboxName ? (
              <p className="text-[11px] leading-relaxed text-gray-500">
                The orchestrator no longer lists this sandbox (common after
                failure or when the microVM was torn down). Infra below may
                still show snapshot availability for the next run.
              </p>
            ) : null}
            {sandbox?.message ? (
              <div>
                <dt className="mb-0.5 text-gray-500">Orchestrator message</dt>
                <dd className="font-mono text-[11px] leading-relaxed text-gray-300">
                  {sandbox.message}
                </dd>
              </div>
            ) : null}
            {sandbox?.runtime ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Runtime image</dt>
                <dd className="text-gray-300">{sandbox.runtime}</dd>
              </div>
            ) : null}
            {sandbox?.vmId ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">VM ID</dt>
                <dd className="truncate font-mono text-gray-300">
                  {sandbox.vmId}
                </dd>
              </div>
            ) : null}
            {sandbox?.host ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Host</dt>
                <dd className="text-gray-300">{sandbox.host}</dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div className="rounded-lg border border-[#2a2020] bg-[#141010] p-3">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-gray-500 uppercase">
            Execution plane
          </p>
          <dl className="space-y-1.5 text-[12px]">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Orchestrator</dt>
              <dd
                className={cn(
                  infraDiagnostics?.orchestrator.reachable
                    ? "text-emerald-400"
                    : "text-red-400",
                )}
              >
                {infraDiagnostics?.orchestrator.reachable
                  ? "Reachable"
                  : "Unreachable"}
              </dd>
            </div>
            {infraDiagnostics?.orchestrator.error ? (
              <div>
                <dt className="mb-0.5 text-gray-500">Orchestrator error</dt>
                <dd className="font-mono text-[11px] text-red-300">
                  {infraDiagnostics.orchestrator.error}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Firecracker host</dt>
              <dd
                className={cn(
                  host?.reachable ? "text-emerald-400" : "text-red-400",
                )}
              >
                {host
                  ? host.reachable
                    ? "Reachable"
                    : "Unreachable"
                  : "Not configured"}
              </dd>
            </div>
            {host?.readyVMs !== undefined ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Warm microVMs</dt>
                <dd
                  className={cn(
                    host.readyVMs > 0 ? "text-emerald-400" : "text-amber-300",
                  )}
                >
                  {host.readyVMs}
                </dd>
              </div>
            ) : null}
            {host?.availableRuntimes && host.availableRuntimes.length > 0 ? (
              <div>
                <dt className="mb-0.5 text-gray-500">Snapshot runtimes</dt>
                <dd className="font-mono text-[11px] text-gray-300">
                  {host.availableRuntimes.join(", ")}
                </dd>
              </div>
            ) : null}
            {host?.lastWarmError ? (
              <div>
                <dt className="mb-0.5 text-gray-500">Warm pool error</dt>
                <dd className="font-mono text-[11px] text-amber-300">
                  {host.lastWarmError}
                </dd>
              </div>
            ) : null}
            {host?.activeVMs !== undefined ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Active microVMs</dt>
                <dd className="text-gray-300">{host.activeVMs}</dd>
              </div>
            ) : null}
            {host?.error ? (
              <div>
                <dt className="mb-0.5 text-gray-500">Host error</dt>
                <dd className="font-mono text-[11px] text-red-300">
                  {host.error}
                </dd>
              </div>
            ) : null}
            {infraDiagnostics ? (
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Tracked sandboxes</dt>
                <dd className="text-gray-300">
                  {infraDiagnostics.sandboxes.total}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </div>

      {task.status === "failed" && host?.lastWarmError ? (
        <p className="mt-3 text-[12px] leading-relaxed text-amber-200/90">
          Firecracker snapshot warm-up failed on the execution host:{" "}
          {host.lastWarmError}. Rebuild snapshots on the host or check{" "}
          <span className="font-mono">docker logs firecracker</span>.
        </p>
      ) : task.status === "failed" && host?.readyVMs === 0 ? (
        <p className="mt-3 text-[12px] leading-relaxed text-amber-200/90">
          No warm microVMs are available. The firecracker service may still be
          warming snapshots, snapshots may be missing for the requested runtime,
          or the host process may not be running.
        </p>
      ) : null}

      {task.status === "failed" &&
      infraDiagnostics &&
      !infraDiagnostics.orchestrator.reachable ? (
        <p className="mt-3 text-[12px] leading-relaxed text-amber-200/90">
          The scheduler cannot reach the orchestrator. Sandbox phase will never
          advance to Running until orchestrator connectivity is restored.
        </p>
      ) : null}
    </CollapsiblePanel>
  );
}
