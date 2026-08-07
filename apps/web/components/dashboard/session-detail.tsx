"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { DEVIN_BOT } from "@/lib/devin-bot";
import { useSessions } from "@/components/dashboard/sessions-context";
import type {
  InfraDiagnostics,
  Task,
  TaskDiagnostics,
  TaskEvent,
} from "@devin/types";
import { usesRuntimeAgent } from "@devin/types";
import {
  eventTypeLabel,
  fetchInfraDiagnostics,
  fetchTask,
  fetchTaskDiagnostics,
  fetchTaskEventHistory,
  formatEventData,
  executeTask,
  retryTask,
  commitTaskWork,
  raiseTaskPullRequest,
  continueTask,
  terminateSession,
  subscribeToTaskEvents,
} from "@/lib/tasks-api";
import { cn } from "@/lib/utils";
import {
  SessionChatColumn,
  SessionPhaseStrip,
} from "@/components/dashboard/session-chat-column";
import { SessionCodeColumn } from "@/components/dashboard/session-code-column";
import { sumLineCounts } from "@/lib/sessions/agent-activity";

interface SessionDetailProps {
  task: Task;
  onBack: () => void;
}

function formatElapsedTime(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  const elapsed = Math.floor((now - start) / 1000);

  if (elapsed < 60) {
    return `${elapsed}s`;
  }
  if (elapsed < 3600) {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function useElapsedTime(startTime: string, isActive: boolean): string {
  const [elapsed, setElapsed] = useState(() => formatElapsedTime(startTime));

  useEffect(() => {
    if (!isActive) {
      setElapsed(formatElapsedTime(startTime));
      return;
    }

    const interval = setInterval(() => {
      setElapsed(formatElapsedTime(startTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, isActive]);

  return elapsed;
}

function eventIcon(type: TaskEvent["type"]) {
  if (type.startsWith("draft.") || type === "task.phase_changed") {
    return Terminal;
  }
  if (type.startsWith("sandbox.")) {
    if (type === "sandbox.failed") return XCircle;
    if (type === "sandbox.started") return CheckCircle2;
    return Server;
  }
  if (type.startsWith("runtime.")) {
    return type === "runtime.ready" ? CheckCircle2 : Loader2;
  }
  if (type.startsWith("git.")) {
    if (type === "git.pr") return GitPullRequest;
    if (type === "git.commit") return GitCommit;
    if (type === "git.repo") return FolderPlus;
    return GitBranch;
  }
  if (type === "agent.output") return Terminal;
  if (type === "task.completed") return CheckCircle2;
  if (type === "task.failed") return XCircle;
  return Terminal;
}

function eventColor(type: TaskEvent["type"]) {
  if (
    type === "draft.completed" ||
    type === "execution.started" ||
    type === "task.phase_changed"
  ) {
    return "text-indigo-300";
  }
  if (type === "draft.failed") {
    return "text-red-400";
  }
  if (type.startsWith("draft.")) {
    return "text-indigo-400";
  }
  if (
    type === "task.completed" ||
    type === "sandbox.started" ||
    type === "runtime.ready"
  ) {
    return "text-emerald-400";
  }
  if (type === "task.failed" || type === "sandbox.failed") {
    return "text-red-400";
  }
  if (type.startsWith("sandbox.") || type.startsWith("runtime.")) {
    return "text-amber-300";
  }
  if (type === "git.repo") return "text-emerald-400";
  if (type.startsWith("git.")) return "text-[#5a9fd4]";
  if (type === "agent.output") return "text-green-400";
  return "text-gray-400";
}

function CollapsiblePanel({
  title,
  icon: Icon,
  iconClassName,
  defaultExpanded = true,
  headerRight,
  children,
  className,
}: {
  title: string;
  icon: typeof Terminal;
  iconClassName?: string;
  defaultExpanded?: boolean;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#111]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[#161616]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-4 shrink-0", iconClassName)} />
          <h2 className="text-[13px] font-medium text-gray-300">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerRight}
          {expanded ? (
            <ChevronDown className="size-4 text-gray-500" />
          ) : (
            <ChevronRight className="size-4 text-gray-500" />
          )}
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-[#252525] px-4 py-3">{children}</div>
      ) : null}
    </div>
  );
}

function LiveWorkPanel({ task, events }: { task: Task; events: TaskEvent[] }) {
  const draftEvents = events.filter((event) => event.type.startsWith("draft."));
  const stepEvents = events.filter((event) => event.type === "draft.updated");
  const fileEvents = events.filter((event) => event.type === "draft.diff");
  const agentLogEvents = events.filter(
    (event) =>
      event.type === "agent.log" ||
      event.type === "agent.tool" ||
      event.type === "agent.started" ||
      event.type === "agent.completed",
  );
  const latestDraft = draftEvents[draftEvents.length - 1];
  const draftSummary = events.find((event) => event.type === "draft.completed")
    ?.data?.summary;
  const runtimeAgent = usesRuntimeAgent(task.agent);
  const reviewDiff = events.find((event) => event.data?.awaitingReview === true)
    ?.data?.diff;

  if (
    draftEvents.length === 0 &&
    agentLogEvents.length === 0 &&
    task.status !== "drafting" &&
    task.status !== "draft_ready" &&
    task.status !== "running" &&
    task.status !== "awaiting_review"
  ) {
    return null;
  }

  const defaultExpanded = [
    "drafting",
    "draft_ready",
    "scheduling",
    "running",
    "awaiting_review",
  ].includes(task.status);

  const summaryText = runtimeAgent
    ? task.status === "awaiting_review"
      ? "Agent finished in the sandbox — review output and activity below."
      : String(
          agentLogEvents[agentLogEvents.length - 1]?.message ??
            "Runtime agent working in sandbox…",
        )
    : String(
        draftSummary ?? latestDraft?.message ?? "Generating draft plan...",
      );

  return (
    <CollapsiblePanel
      title="Live Work"
      icon={Terminal}
      iconClassName="text-indigo-300"
      defaultExpanded={defaultExpanded}
      className="border-indigo-500/30 bg-indigo-500/5"
    >
      <p className="text-[12px] text-indigo-100/80">{summaryText}</p>
      {stepEvents.length > 0 ? (
        <div className="mt-2 space-y-1">
          {stepEvents.slice(-4).map((event) => (
            <p key={event.id} className="text-[11px] text-indigo-100/70">
              • {event.message}
            </p>
          ))}
        </div>
      ) : null}
      {fileEvents.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2">
          {fileEvents.slice(-5).map((event) => (
            <p
              key={event.id}
              className="font-mono text-[11px] text-indigo-100/80"
            >
              {String(event.data?.path ?? "file")} —{" "}
              {String(event.data?.summary ?? event.message)}
            </p>
          ))}
        </div>
      ) : null}
      {agentLogEvents.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2">
          {agentLogEvents.slice(-6).map((event) => (
            <p key={event.id} className="text-[11px] text-indigo-100/80">
              • {event.message}
            </p>
          ))}
        </div>
      ) : null}
      {reviewDiff ? (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2 font-mono text-[11px] leading-relaxed text-indigo-100/80">
          {String(reviewDiff)}
        </pre>
      ) : null}
    </CollapsiblePanel>
  );
}

function DiagnosticsPanel({
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
          <p className="rounded-lg bg-[#120d0d] px-3 py-2 font-mono text-[12px] leading-relaxed text-red-300">
            {task.message}
          </p>
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
                {sandbox?.phase ?? "Not found"}
              </dd>
            </div>
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

function BotCoAuthorNote({ compact = false }: { compact?: boolean }) {
  return (
    <p
      className={cn(
        "mt-1 flex flex-wrap items-center gap-1.5 text-emerald-400/80",
        compact ? "text-[11px]" : "text-[12px]",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- bot avatar is a static external URL */}
      <img
        src={DEVIN_BOT.avatarUrl}
        alt=""
        className="size-4 rounded-full border border-[#333]"
      />
      <span>Co-authored by</span>
      <a
        href={DEVIN_BOT.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[#5a9fd4] hover:underline"
      >
        @{DEVIN_BOT.username}
      </a>
    </p>
  );
}

function GitHubProgressBanner({
  repository,
  events,
  branch,
}: {
  repository?: string;
  events: TaskEvent[];
  branch?: string;
}) {
  if (!repository) {
    return null;
  }

  const commitEvents = events.filter((event) => event.type === "git.commit");
  const pushEvents = events.filter((event) => event.type === "git.push");
  const successfulPush = [...pushEvents]
    .reverse()
    .find(
      (event) =>
        event.data?.failed !== true &&
        !/skipped or failed|push failed/i.test(event.message),
    );
  const failedPush = [...pushEvents]
    .reverse()
    .find(
      (event) =>
        event.data?.failed === true ||
        /skipped or failed|push failed/i.test(event.message),
    );
  const pushOk = Boolean(successfulPush);
  const failedBootstrap = commitEvents.some(
    (event) => event.data?.bootstrap && event.data?.error,
  );
  const targetBranch = branch ?? "main";
  const commitsUrl = `https://github.com/${repository}/commits/${targetBranch}`;
  const repoUrl = `https://github.com/${repository}`;

  return (
    <div className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#111] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-200">
            GitHub: {repository}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {pushOk
              ? `Pushed to ${targetBranch} — commits should be visible on GitHub`
              : failedPush
                ? `Push to ${targetBranch} failed — commits may not be on GitHub yet`
                : commitEvents.length > 0
                  ? `${commitEvents.length} commit(s) recorded — waiting for push`
                  : "Waiting for initial commit and push…"}
          </p>
          {failedBootstrap ? (
            <p className="mt-1 text-[12px] text-red-400">
              Bootstrap failed — check activity log for details
            </p>
          ) : pushOk ? (
            <BotCoAuthorNote compact />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-[#5a9fd4] transition-colors hover:bg-[#222]"
          >
            Open repo
            <ExternalLink className="size-3" />
          </a>
          <a
            href={commitsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-emerald-400 transition-colors hover:bg-[#222]"
          >
            View commits
            <GitCommit className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: TaskEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = eventIcon(event.type);
  const details = formatEventData(event.data);
  const hasDetails = details.length > 0;
  const isRepoCreated = event.type === "git.repo";

  return (
    <div className="rounded-lg px-2 py-2 transition-colors hover:bg-[#1a1a1a]/50">
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            eventColor(event.type),
            event.type === "runtime.waiting" ? "animate-spin" : null,
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-[#1f1f1f] px-1.5 py-0.5 text-[10px] tracking-wide text-gray-500 uppercase">
              {eventTypeLabel(event.type)}
            </span>
            <p className="text-[13px] text-gray-300">{event.message}</p>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
            <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
            {event.data?.prUrl ? (
              <a
                href={String(event.data.prUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#5a9fd4] hover:underline"
              >
                Open PR
              </a>
            ) : null}
            {event.data?.htmlUrl ? (
              <a
                href={String(event.data.htmlUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#5a9fd4] hover:underline"
              >
                {isRepoCreated ? "Open repo" : "View"}
              </a>
            ) : null}
            {event.type === "git.push" && event.data?.branch ? (
              <span className="text-emerald-400/80">
                branch {String(event.data.branch)}
              </span>
            ) : null}
            {hasDetails ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="inline-flex cursor-pointer items-center gap-0.5 text-gray-500 hover:text-gray-300"
              >
                {expanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                Details
              </button>
            ) : null}
          </div>
          {isRepoCreated ? <BotCoAuthorNote /> : null}
          {event.type === "git.commit" || event.type === "git.push" ? (
            <BotCoAuthorNote />
          ) : null}
          {expanded && hasDetails ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-[#0d0d0d] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-gray-400">
              {details.join("\n")}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function SessionDetail({
  task: initialTask,
  onBack,
}: SessionDetailProps) {
  const { refreshTasks } = useSessions();
  const [task, setTask] = useState(initialTask);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [taskDiagnostics, setTaskDiagnostics] =
    useState<TaskDiagnostics | null>(null);
  const [infraDiagnostics, setInfraDiagnostics] =
    useState<InfraDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [retryingTask, setRetryingTask] = useState(false);
  const [committingWork, setCommittingWork] = useState(false);
  const [raisingPr, setRaisingPr] = useState(false);
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [continuingSession, setContinuingSession] = useState(false);
  const [terminatingSession, setTerminatingSession] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<
    "progress" | "changes" | "desktop"
  >("changes");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLineCounts, setFileLineCounts] = useState<Record<string, number>>(
    {},
  );

  const isActive =
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled";

  const elapsedTime = useElapsedTime(task.createdAt, isActive);

  const awaitingSandboxApproval =
    task.status === "draft_ready" &&
    (task.message?.toLowerCase().includes("approve") ||
      events.some((event) => event.data?.awaitingApproval === true));

  const awaitingReview =
    task.status === "awaiting_review" ||
    events.some((event) => event.data?.awaitingReview === true);

  const handleRetryTask = useCallback(async () => {
    setRetryingTask(true);
    setStreamError(null);
    try {
      const updated = await retryTask(task.id);
      setTask(updated);
      setEvents([]);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to retry task",
      );
    } finally {
      setRetryingTask(false);
    }
  }, [refreshTasks, task.id]);

  const handleStartSandbox = useCallback(async () => {
    setStartingSandbox(true);
    try {
      const updated = await executeTask(task.id);
      setTask(updated);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to start sandbox",
      );
    } finally {
      setStartingSandbox(false);
    }
  }, [refreshTasks, task.id]);

  const handleCommitNow = useCallback(async () => {
    setCommittingWork(true);
    setStreamError(null);
    try {
      const updated = await commitTaskWork(task.id);
      setTask(updated);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to commit changes",
      );
    } finally {
      setCommittingWork(false);
    }
  }, [refreshTasks, task.id]);

  const handleRaisePr = useCallback(async () => {
    setRaisingPr(true);
    setStreamError(null);
    try {
      const updated = await raiseTaskPullRequest(task.id);
      setTask(updated);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to open pull request",
      );
    } finally {
      setRaisingPr(false);
    }
  }, [refreshTasks, task.id]);

  const sessionActive =
    task.sessionActive === true ||
    task.status === "awaiting_review" ||
    (task.status === "completed" && usesRuntimeAgent(task.agent));

  const handleContinueSession = useCallback(async () => {
    const trimmed = followUpPrompt.trim();
    if (!trimmed) {
      return;
    }
    setContinuingSession(true);
    setStreamError(null);
    try {
      const updated = await continueTask(task.id, trimmed);
      setTask(updated);
      setFollowUpPrompt("");
      setEvents([]);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to continue session",
      );
    } finally {
      setContinuingSession(false);
    }
  }, [followUpPrompt, refreshTasks, task.id]);

  const handleTerminateSession = useCallback(async () => {
    setTerminatingSession(true);
    setStreamError(null);
    try {
      const updated = await terminateSession(task.id);
      setTask(updated);
      await refreshTasks();
    } catch (error) {
      setStreamError(
        error instanceof Error ? error.message : "Failed to end session",
      );
    } finally {
      setTerminatingSession(false);
    }
  }, [refreshTasks, task.id]);

  const loadDiagnostics = useCallback(async (taskId: string) => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const [taskResult, infraResult] = await Promise.all([
        fetchTaskDiagnostics(taskId),
        fetchInfraDiagnostics(),
      ]);
      setTaskDiagnostics(taskResult);
      setInfraDiagnostics(infraResult);
    } catch (error) {
      setDiagnosticsError(
        error instanceof Error ? error.message : "Failed to load diagnostics",
      );
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    setTask(initialTask);
  }, [initialTask]);

  useEffect(() => {
    setStreamError(null);

    const taskId = task.id;
    let cancelled = false;

    void fetchTaskEventHistory(taskId)
      .then((history) => {
        if (!cancelled && history.length > 0) {
          setEvents(
            [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
          );
        }
      })
      .catch(() => {
        // SSE replay remains the fallback.
      });

    const unsubscribe = subscribeToTaskEvents(
      taskId,
      (event) => {
        if (cancelled || event.taskId !== taskId) {
          return;
        }

        setEvents((current) => {
          if (current.some((item) => item.id === event.id)) {
            return current;
          }
          return [...current, event].sort((a, b) =>
            a.timestamp.localeCompare(b.timestamp),
          );
        });

        if (
          event.type === "sandbox.provisioning" ||
          event.type === "sandbox.failed" ||
          event.type === "task.failed"
        ) {
          void loadDiagnostics(taskId);
        }

        // Status lives on the task record; SSE only carries events. Refresh on
        // phase transitions so the header does not stay on "Booting devbox"
        // after the agent has already started.
        if (
          event.type === "task.completed" ||
          event.type === "task.failed" ||
          event.type === "task.phase_changed" ||
          event.type === "agent.running" ||
          event.type === "sandbox.started" ||
          event.type === "runtime.ready" ||
          event.type === "git.push" ||
          event.type === "git.pr"
        ) {
          void fetchTask(taskId).then((updated) => {
            if (!cancelled) {
              setTask(updated);
              if (
                event.type === "task.completed" ||
                event.type === "task.failed"
              ) {
                void refreshTasks();
              }
            }
          });
        }
      },
      (error) => {
        if (!cancelled) {
          setStreamError(error.message);
        }
      },
      {
        reconnect:
          task.status !== "failed" &&
          task.status !== "completed" &&
          task.status !== "cancelled",
      },
    );

    if (
      task.status === "failed" ||
      task.status === "sandbox_starting" ||
      task.status === "scheduling"
    ) {
      void loadDiagnostics(taskId);
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [task.id, task.status, refreshTasks, loadDiagnostics]);

  // Poll task status while non-terminal so a dropped SSE stream cannot leave
  // the header stuck on "Booting devbox".
  useEffect(() => {
    const terminal =
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled";
    if (terminal) {
      return;
    }

    let cancelled = false;
    const tick = () => {
      void fetchTask(task.id)
        .then((updated) => {
          if (!cancelled) {
            setTask(updated);
          }
        })
        .catch(() => {
          // SSE / history remain the primary feed.
        });
    };

    const interval = setInterval(tick, 12_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [task.id, task.status]);

  const showDiagnostics =
    task.status === "failed" ||
    task.status === "sandbox_starting" ||
    task.status === "scheduling" ||
    events.some((event) => event.type === "sandbox.failed");

  const actionBanner = (
    <>
      <SessionPhaseStrip task={task} events={events} />
      {task.status === "failed" ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2.5">
          <p className="text-[12px] text-rose-100">
            {task.message ?? "Task failed — retry or check workspace logs."}
          </p>
          <MotionButton
            type="button"
            onClick={() => void handleRetryTask()}
            disabled={retryingTask}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-rose-500/20 px-2.5 py-1 text-[11px] text-rose-50 hover:bg-rose-500/30 disabled:opacity-60"
          >
            {retryingTask ? <Loader2 className="size-3 animate-spin" /> : null}
            Retry
          </MotionButton>
        </div>
      ) : null}
      {awaitingSandboxApproval ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-violet-500/25 bg-violet-500/10 px-3 py-2.5">
          <p className="text-[12px] text-violet-100">
            Draft ready — run in devbox
          </p>
          <MotionButton
            type="button"
            onClick={() => void handleStartSandbox()}
            disabled={startingSandbox}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] text-white hover:bg-violet-500 disabled:opacity-60"
          >
            {startingSandbox ? (
              <Loader2 className="size-3 animate-spin" />
            ) : null}
            Run
          </MotionButton>
        </div>
      ) : null}
      {awaitingReview ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <MotionButton
            type="button"
            onClick={() => void handleCommitNow()}
            disabled={committingWork || raisingPr}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-100"
          >
            Commit
          </MotionButton>
          <MotionButton
            type="button"
            onClick={() => void handleRaisePr()}
            disabled={committingWork || raisingPr}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/15 px-2.5 py-1 text-[11px] text-violet-100"
          >
            Open PR
          </MotionButton>
        </div>
      ) : null}
      {sessionActive && !awaitingReview ? (
        <div className="mt-3 flex justify-end">
          <MotionButton
            type="button"
            onClick={() => void handleTerminateSession()}
            disabled={terminatingSession}
            className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            End session
          </MotionButton>
        </div>
      ) : null}
      {streamError ? (
        <p className="mt-2 text-[11px] text-rose-400">{streamError}</p>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[#0a0a0a]">
      <div className="flex min-h-0 flex-1 overflow-hidden lg:flex-row">
        <SessionChatColumn
          task={task}
          events={events}
          elapsedTime={elapsedTime}
          isActive={isActive}
          onBack={onBack}
          followUpPrompt={followUpPrompt}
          onFollowUpChange={setFollowUpPrompt}
          onSendFollowUp={() => void handleContinueSession()}
          continuingSession={continuingSession}
          sessionActive={sessionActive}
          banner={actionBanner}
          composerDisabled={
            !sessionActive && !isActive && task.status !== "awaiting_review"
          }
          addedLineCount={sumLineCounts(fileLineCounts)}
          onOpenDesktop={() => setWorkspaceTab("desktop")}
        />
        <SessionCodeColumn
          task={task}
          events={events}
          isActive={isActive}
          onTaskChange={setTask}
          workspaceTab={workspaceTab}
          onWorkspaceTabChange={setWorkspaceTab}
          selectedPath={selectedPath}
          onSelectedPathChange={setSelectedPath}
          onFileLineCount={(path, lineCount) =>
            setFileLineCounts((prev) => ({ ...prev, [path]: lineCount }))
          }
        />
      </div>

      {showDiagnostics && task.status === "failed" ? (
        <details
          className="shrink-0 border-t border-white/[0.06] bg-[#0a0a0a] px-4 py-2"
          open
        >
          <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
            Diagnostics
          </summary>
          <div className="mt-2 max-h-[200px] overflow-y-auto pb-2">
            <DiagnosticsPanel
              task={task}
              taskDiagnostics={taskDiagnostics}
              infraDiagnostics={infraDiagnostics}
              loading={diagnosticsLoading}
              error={diagnosticsError}
              onRefresh={() => void loadDiagnostics(task.id)}
              defaultExpanded
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
