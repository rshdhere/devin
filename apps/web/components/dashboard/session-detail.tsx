"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
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
import {
  resolveRuntimeForTask,
  runtimeLabel,
  usesRuntimeAgent,
} from "@devin/types";
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
  taskStatusLabel,
} from "@/lib/tasks-api";
import { cn } from "@/lib/utils";
import { DevboxWorkspace } from "@/components/dashboard/devbox-workspace";

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
          {task.message.includes("OPENAI_API_KEY") ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The platform OpenAI key is missing on the scheduler. An admin
              should store it in AWS SSM at{" "}
              <span className="font-mono text-amber-100">
                /devin-production/platform/openai_api_key
              </span>{" "}
              (SecureString), then run{" "}
              <span className="font-mono text-amber-100">
                devin-sync-platform-config
              </span>{" "}
              on the execution host. Open{" "}
              <span className="text-white">Advanced capabilities</span> on the
              dashboard for the full checklist.
            </p>
          ) : null}
          {task.message.includes("CURSOR_API_KEY") ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              The platform Cursor key is missing on the scheduler. An admin
              should store it in AWS SSM at{" "}
              <span className="font-mono text-amber-100">
                /devin-production/platform/cursor_api_key
              </span>{" "}
              (SecureString), then run{" "}
              <span className="font-mono text-amber-100">
                devin-sync-platform-config
              </span>{" "}
              on the execution host. Open{" "}
              <span className="text-white">Advanced capabilities</span> on the
              dashboard for the full checklist.
            </p>
          ) : null}
          {/timed out/i.test(task.message) ? (
            <p className="text-[12px] leading-relaxed text-amber-200/90">
              {/npm install timed out/i.test(task.message) ? (
                <>
                  Dependency install in the sandbox timed out. On the execution
                  host run{" "}
                  <span className="font-mono text-amber-100">
                    sudo ./infra/scripts/fix-sandbox-dns.sh
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
                sudo ./infra/scripts/fix-sandbox-dns.sh
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
                sudo ./infra/scripts/fix-sandbox-dns.sh
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

function AgentTerminalPanel({
  events,
  isActive,
}: {
  events: TaskEvent[];
  isActive: boolean;
}) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  const outputLines = events
    .filter((event) => event.type === "agent.output")
    .map((event) => ({
      line: event.message,
      stream: (event.data?.stream as string) ?? "stdout",
      time: event.timestamp,
    }));

  useEffect(() => {
    if (terminalRef.current && isExpanded) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [outputLines.length, isExpanded]);

  if (outputLines.length === 0 && !isActive) {
    return null;
  }

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0a0a0a]">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between border-b border-[#252525] px-4 py-2.5 text-left transition-colors hover:bg-[#111]"
      >
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-green-400" />
          <h2 className="text-[13px] font-medium text-gray-300">
            Agent Output
          </h2>
          {isActive ? (
            <span className="flex items-center gap-1 text-[11px] text-green-400">
              <span className="size-1.5 animate-pulse rounded-full bg-green-400" />
              Live
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">
            {outputLines.length} lines
          </span>
          {isExpanded ? (
            <ChevronDown className="size-4 text-gray-500" />
          ) : (
            <ChevronRight className="size-4 text-gray-500" />
          )}
        </div>
      </button>

      {isExpanded ? (
        <div
          ref={terminalRef}
          className="max-h-[400px] overflow-auto p-3 font-mono text-[12px] leading-relaxed"
        >
          {outputLines.length === 0 ? (
            <div className="flex items-center gap-2 text-gray-500">
              {isActive ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  <span>Agent is running — output will appear here…</span>
                </>
              ) : (
                <span>No agent output captured for this task.</span>
              )}
            </div>
          ) : (
            outputLines.map((output, index) => (
              <div
                key={index}
                className={cn(
                  "break-all whitespace-pre-wrap",
                  output.stream === "stderr"
                    ? "text-red-400"
                    : "text-green-300",
                )}
              >
                {output.line}
              </div>
            ))
          )}
          {isActive && outputLines.length > 0 ? (
            <div className="mt-1 flex items-center gap-1 text-gray-500">
              <Loader2 className="size-3 animate-spin" />
              <span>Waiting for output...</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const latestPush = pushEvents[pushEvents.length - 1];
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
            {latestPush
              ? `Pushed to ${targetBranch} — commits should be visible on GitHub`
              : commitEvents.length > 0
                ? `${commitEvents.length} commit(s) recorded — waiting for push`
                : "Waiting for initial commit and push…"}
          </p>
          {failedBootstrap ? (
            <p className="mt-1 text-[12px] text-red-400">
              Bootstrap failed — check activity log for details
            </p>
          ) : latestPush ? (
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

function PreviewDeployBanner({
  task,
  events,
}: {
  task: Task;
  events: TaskEvent[];
}) {
  const building = events.some((event) => event.type === "deploy.building");
  const deployFailed = events.some((event) => event.type === "deploy.failed");
  const deployReady = events.find((event) => event.type === "deploy.ready");
  const taskCompleted = events.some((event) => event.type === "task.completed");
  const taskFailed =
    task.status === "failed" || events.some((e) => e.type === "task.failed");
  const latestAgentPush = events
    .filter(
      (event) => event.type === "git.push" && event.data?.controlPlane !== true,
    )
    .at(-1);
  const previewUrl =
    task.previewUrl ||
    (deployReady?.data?.previewUrl as string | undefined) ||
    undefined;

  const deployPhaseStarted =
    building || deployFailed || Boolean(deployReady) || taskCompleted;

  if (taskFailed && !previewUrl) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-[13px] font-medium text-amber-100">
          Preview deploy skipped
        </p>
        <p className="mt-0.5 text-[12px] text-amber-100/70">
          The agent did not finish successfully, so no live preview was
          deployed.
          {task.message ? ` ${task.message}` : ""}
        </p>
      </div>
    );
  }

  if (!deployPhaseStarted && !latestAgentPush) {
    return null;
  }

  if (!deployPhaseStarted) {
    return null;
  }

  const isBuilding = building && !previewUrl && !deployFailed;
  const isLive = Boolean(previewUrl);

  return (
    <div
      className={cn(
        "mb-4 rounded-xl border px-4 py-3",
        isLive
          ? "border-emerald-500/30 bg-emerald-500/5"
          : deployFailed
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-[#2a2a2a] bg-[#111]",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-200">
            {isLive
              ? "Work completed — preview deployed"
              : isBuilding
                ? "Building production preview…"
                : taskCompleted
                  ? "Work completed and pushed to GitHub"
                  : "Preparing deployment"}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {isLive
              ? "Production build finished. Your app is live on a preview subdomain."
              : isBuilding
                ? "Running npm install, production build, and starting the app in the sandbox."
                : deployFailed
                  ? "Preview deploy failed — code was still pushed to GitHub."
                  : taskCompleted && !previewUrl
                    ? "Task finished but preview URL is not available yet."
                    : latestAgentPush
                      ? "Agent pushed changes — building production preview."
                      : "Waiting for agent to finish before deploy."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {isBuilding ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-gray-300">
              <Loader2 className="size-3.5 animate-spin" />
              Building…
            </span>
          ) : null}
          {isLive && previewUrl ? (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[12px] text-emerald-300 transition-colors hover:bg-emerald-500/25"
            >
              Open preview
              <Globe className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PhaseTimeline({ task, events }: { task: Task; events: TaskEvent[] }) {
  const runtimeAgent = usesRuntimeAgent(task.agent);
  const draftCompleted = events.some(
    (event) => event.type === "draft.completed",
  );
  const draftDone =
    runtimeAgent ||
    draftCompleted ||
    events.some((event) => event.type === "execution.started") ||
    events.some((event) => event.type.startsWith("sandbox."));
  const sandboxDone = events.some((event) => event.type === "sandbox.started");
  const executeDone =
    task.status === "completed" ||
    task.status === "awaiting_review" ||
    events.some((event) => event.type === "task.completed") ||
    events.some((event) => event.data?.awaitingReview === true);

  const currentPhase = (() => {
    if (
      !runtimeAgent &&
      ["queued", "scheduling", "drafting"].includes(task.status)
    ) {
      return "draft";
    }
    if (
      task.status === "draft_ready" ||
      task.status === "sandbox_starting" ||
      events.some(
        (event) =>
          event.type.startsWith("sandbox.") && event.type !== "sandbox.started",
      )
    ) {
      return "sandbox";
    }
    if (
      task.status === "running" ||
      task.status === "runtime_ready" ||
      task.status === "awaiting_review"
    ) {
      return task.status === "awaiting_review" ? "review" : "execute";
    }
    if (executeDone) {
      return "complete";
    }
    return draftDone ? "sandbox" : "draft";
  })();

  const phases = runtimeAgent
    ? ([
        { id: "sandbox", label: "Sandbox", done: sandboxDone },
        { id: "execute", label: "Execute", done: executeDone },
        {
          id: "review",
          label: "Review",
          done: task.status === "completed",
        },
        { id: "complete", label: "Done", done: task.status === "completed" },
      ] as const)
    : ([
        { id: "draft", label: "Draft plan", done: draftDone },
        { id: "sandbox", label: "Sandbox", done: sandboxDone },
        { id: "execute", label: "Execute", done: executeDone },
        { id: "complete", label: "Done", done: executeDone },
      ] as const);

  return (
    <div className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#111] px-4 py-3">
      <p className="mb-2 text-[11px] font-medium tracking-wide text-gray-500 uppercase">
        Progress
      </p>
      <div className="grid grid-cols-4 gap-2">
        {phases.map((phase) => {
          const isActive = phase.id === currentPhase;
          return (
            <div
              key={phase.id}
              className={cn(
                "rounded-lg border px-2 py-1.5 text-center text-[11px]",
                phase.done
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : isActive
                    ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200"
                    : "border-[#2a2a2a] bg-[#0d0d0d] text-gray-500",
              )}
            >
              {phase.label}
            </div>
          );
        })}
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
  const feedRef = useRef<HTMLDivElement>(null);

  const isActive =
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled";

  const runtimeAgent = usesRuntimeAgent(task.agent);
  const devboxRuntime =
    task.runtime ?? resolveRuntimeForTask(task.agent, task.prompt);

  const elapsedTime = useElapsedTime(task.createdAt, isActive);
  const isLongRunning =
    isActive && Date.now() - new Date(task.createdAt).getTime() > 5 * 60 * 1000;

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

        if (event.type === "task.completed" || event.type === "task.failed") {
          void fetchTask(taskId).then((updated) => {
            if (!cancelled) {
              setTask(updated);
              void refreshTasks();
            }
          });
        }

        if (event.type === "deploy.ready") {
          void fetchTask(taskId).then((updated) => {
            if (!cancelled) {
              setTask(updated);
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
  }, [task.id, refreshTasks, loadDiagnostics]);

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events.length]);

  const showDiagnostics =
    task.status === "failed" ||
    task.status === "sandbox_starting" ||
    task.status === "scheduling" ||
    events.some((event) => event.type === "sandbox.failed");

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="mb-4 flex items-center gap-3">
        <MotionButton
          type="button"
          pressStyle="icon"
          onClick={onBack}
          className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
          aria-label="Back to composer"
        >
          <ArrowLeft className="size-4" />
        </MotionButton>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-medium text-white">
            {task.title ?? task.prompt}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-gray-500">
            <span
              className={cn(
                "inline-flex items-center gap-1",
                isActive ? "text-[#5a9fd4]" : "text-gray-500",
                task.status === "failed" ? "text-red-400" : null,
              )}
            >
              {isActive ? <Loader2 className="size-3 animate-spin" /> : null}
              {taskStatusLabel(task.status)}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1",
                isLongRunning ? "text-amber-400" : "text-gray-500",
              )}
            >
              <Clock className="size-3" />
              {elapsedTime}
            </span>
            {task.repository ? (
              <>
                <span>•</span>
                <span>{task.repository}</span>
              </>
            ) : null}
            {task.branch ? (
              <>
                <span>•</span>
                <span className="text-gray-600">{task.branch}</span>
              </>
            ) : null}
            {devboxRuntime ? (
              <>
                <span>•</span>
                <span className="text-indigo-300/80">
                  {runtimeLabel(devboxRuntime)}
                </span>
              </>
            ) : null}
          </div>
        </div>

        {task.prUrl ? (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-[#5a9fd4] transition-colors hover:bg-[#222]"
          >
            View PR
            <ExternalLink className="size-3" />
          </a>
        ) : task.repository ? (
          <a
            href={`https://github.com/${task.repository}/commits/${task.branch ?? "main"}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-emerald-400 transition-colors hover:bg-[#222]"
          >
            View commits
            <GitCommit className="size-3" />
          </a>
        ) : null}
      </div>

      <div className="mb-4 max-h-[38vh] shrink-0 space-y-4 overflow-y-auto">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#141414] px-4 py-3">
          <p className="text-[13px] leading-relaxed text-gray-300">
            {task.prompt}
          </p>
        </div>

        {isLongRunning ? (
          <p className="text-[12px] text-amber-300/90">
            Still running ({elapsedTime}) — complex tasks can take 30+ minutes.
          </p>
        ) : null}

        <PhaseTimeline task={task} events={events} />

        {task.status === "failed" ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
            <div>
              <p className="text-[13px] font-medium text-red-100">
                Task failed
              </p>
              <p className="text-[12px] text-red-100/70">
                {task.message ??
                  "Check activity and sandbox diagnostics below, then retry."}
              </p>
            </div>
            <MotionButton
              type="button"
              onClick={() => void handleRetryTask()}
              disabled={retryingTask}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/20 px-3 py-1.5 text-[12px] text-red-100 transition-colors hover:bg-red-500/30 disabled:opacity-60"
            >
              {retryingTask ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Server className="size-3.5" />
              )}
              Retry
            </MotionButton>
          </div>
        ) : null}

        {awaitingSandboxApproval ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/5 px-4 py-3">
            <div>
              <p className="text-[13px] font-medium text-indigo-100">
                Draft is ready
              </p>
              <p className="text-[12px] text-indigo-100/70">
                Review planned files below, then start sandbox execution.
              </p>
            </div>
            <MotionButton
              type="button"
              onClick={() => void handleStartSandbox()}
              disabled={startingSandbox}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-500/20 px-3 py-1.5 text-[12px] text-indigo-100 transition-colors hover:bg-indigo-500/30 disabled:opacity-60"
            >
              {startingSandbox ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Server className="size-3.5" />
              )}
              Run in devbox
            </MotionButton>
          </div>
        ) : null}

        {awaitingReview ? (
          <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[13px] font-medium text-emerald-100">
                Review changes
              </p>
              <p className="text-[12px] text-emerald-100/70">
                Manual review is enabled for your account. Commit or open a PR
                when you are satisfied with the devbox work.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MotionButton
                type="button"
                onClick={() => void handleCommitNow()}
                disabled={committingWork || raisingPr}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-100 transition-colors hover:bg-emerald-500/30 disabled:opacity-60"
              >
                {committingWork ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitCommit className="size-3.5" />
                )}
                Commit now
              </MotionButton>
              <MotionButton
                type="button"
                onClick={() => void handleRaisePr()}
                disabled={committingWork || raisingPr}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-500/20 px-3 py-1.5 text-[12px] text-indigo-100 transition-colors hover:bg-indigo-500/30 disabled:opacity-60"
              >
                {raisingPr ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <GitPullRequest className="size-3.5" />
                )}
                Raise a PR
              </MotionButton>
            </div>
          </div>
        ) : null}

        {sessionActive && !awaitingReview && task.status !== "running" ? (
          <div className="space-y-3 rounded-xl border border-[#2a2a2a] bg-[#141414] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[13px] font-medium text-gray-200">
                  Devbox session active
                </p>
                <p className="text-[12px] text-gray-500">
                  Send a follow-up prompt in the same environment, use Shell /
                  Files / Browser below, or end the session to tear down the
                  microVM.
                </p>
              </div>
              <MotionButton
                type="button"
                onClick={() => void handleTerminateSession()}
                disabled={terminatingSession || continuingSession}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-gray-300 transition-colors hover:bg-[#222] disabled:opacity-60"
              >
                {terminatingSession ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                End session
              </MotionButton>
            </div>
            <div className="flex gap-2">
              <input
                value={followUpPrompt}
                onChange={(event) => setFollowUpPrompt(event.target.value)}
                placeholder="Ask for a follow-up change in this devbox…"
                className="min-w-0 flex-1 rounded-lg border border-[#333] bg-[#0d0d0d] px-3 py-2 text-[13px] text-gray-200 outline-none placeholder:text-gray-600 focus:border-[#444]"
              />
              <MotionButton
                type="button"
                onClick={() => void handleContinueSession()}
                disabled={!followUpPrompt.trim() || continuingSession}
                className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-500/20 px-3 py-2 text-[12px] text-indigo-100 transition-colors hover:bg-indigo-500/30 disabled:opacity-60"
              >
                {continuingSession ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Send follow-up
              </MotionButton>
            </div>
          </div>
        ) : null}

        <DevboxWorkspace task={task} onTaskChange={setTask} />

        {runtimeAgent ? (
          <p className="text-[12px] text-gray-500">
            Shell, Files, and Browser are available while the devbox is booting
            or the agent is running.
          </p>
        ) : null}

        <LiveWorkPanel task={task} events={events} />

        {task.repository ? (
          <GitHubProgressBanner
            repository={task.repository}
            events={events}
            branch={task.branch}
          />
        ) : null}

        <PreviewDeployBanner task={task} events={events} />

        {showDiagnostics ? (
          <DiagnosticsPanel
            task={task}
            taskDiagnostics={taskDiagnostics}
            infraDiagnostics={infraDiagnostics}
            loading={diagnosticsLoading}
            error={diagnosticsError}
            onRefresh={() => void loadDiagnostics(task.id)}
            defaultExpanded={task.status === "failed"}
          />
        ) : null}
      </div>

      <AgentTerminalPanel events={events} isActive={isActive} />

      <div className="mt-4 flex min-h-0 min-h-[min(42vh,480px)] flex-1 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#111]">
        <div className="border-b border-[#252525] px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-gray-400">Activity</h2>
        </div>

        <div
          ref={feedRef}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
        >
          {events.length === 0 ? (
            <div className="space-y-2 px-2 py-4">
              {task.status === "failed" && task.message ? (
                <p className="text-[13px] leading-relaxed text-red-300">
                  {task.message}
                </p>
              ) : (
                <div className="flex items-center gap-2 text-[13px] text-gray-600">
                  <Loader2 className="size-4 animate-spin" />
                  Waiting for sandbox and agent activity…
                </div>
              )}
            </div>
          ) : (
            events
              .filter((event) => event.type !== "agent.output")
              .map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>

        {streamError ? (
          <p className="border-t border-[#252525] px-4 py-2 text-[12px] text-red-400">
            Event stream error: {streamError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
