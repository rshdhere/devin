"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { useSessions } from "@/components/dashboard/sessions-context";
import {
  eventTypeLabel,
  fetchInfraDiagnostics,
  fetchTask,
  fetchTaskDiagnostics,
  formatEventData,
  subscribeToTaskEvents,
  taskStatusLabel,
  type InfraDiagnostics,
  type Task,
  type TaskDiagnostics,
  type TaskEvent,
} from "@/lib/tasks-api";
import { cn } from "@/lib/utils";

interface SessionDetailProps {
  task: Task;
  onBack: () => void;
}

function eventIcon(type: TaskEvent["type"]) {
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
    return GitBranch;
  }
  if (type === "task.completed") return CheckCircle2;
  if (type === "task.failed") return XCircle;
  return Terminal;
}

function eventColor(type: TaskEvent["type"]) {
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
  if (type.startsWith("git.")) return "text-[#5a9fd4]";
  return "text-gray-400";
}

function DiagnosticsPanel({
  task,
  taskDiagnostics,
  infraDiagnostics,
  loading,
  error,
  onRefresh,
}: {
  task: Task;
  taskDiagnostics: TaskDiagnostics | null;
  infraDiagnostics: InfraDiagnostics | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const sandbox = taskDiagnostics?.sandbox;
  const host = infraDiagnostics?.firecrackerHost;

  return (
    <div className="mb-4 rounded-xl border border-[#3a2a2a] bg-[#1a1212] px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-400" />
          <h2 className="text-[13px] font-medium text-amber-100">
            Sandbox diagnostics
          </h2>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="cursor-pointer rounded-md border border-[#3a2a2a] px-2.5 py-1 text-[11px] text-gray-400 transition-colors hover:bg-[#241818] hover:text-gray-200 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {task.message ? (
        <div className="mb-3 space-y-2">
          <p className="rounded-lg bg-[#120d0d] px-3 py-2 font-mono text-[12px] leading-relaxed text-red-300">
            {task.message}
          </p>
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
          <span className="font-mono">docker logs firecracker-host</span>.
        </p>
      ) : task.status === "failed" && host?.readyVMs === 0 ? (
        <p className="mt-3 text-[12px] leading-relaxed text-amber-200/90">
          No warm microVMs are available. The firecracker-host may still be
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
    </div>
  );
}

function EventRow({ event }: { event: TaskEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = eventIcon(event.type);
  const details = formatEventData(event.data);
  const hasDetails = details.length > 0;

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
  const feedRef = useRef<HTMLDivElement>(null);

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
    setEvents([]);
    setStreamError(null);

    const taskId = task.id;
    let cancelled = false;

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
      },
      (error) => {
        if (!cancelled) {
          setStreamError(error.message);
        }
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

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events.length]);

  const isActive =
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled";

  const showDiagnostics =
    task.status === "failed" ||
    task.status === "sandbox_starting" ||
    task.status === "scheduling" ||
    events.some((event) => event.type.startsWith("sandbox."));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
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
        ) : null}
      </div>

      <div className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#141414] px-4 py-3">
        <p className="text-[13px] leading-relaxed text-gray-300">
          {task.prompt}
        </p>
      </div>

      {showDiagnostics ? (
        <DiagnosticsPanel
          task={task}
          taskDiagnostics={taskDiagnostics}
          infraDiagnostics={infraDiagnostics}
          loading={diagnosticsLoading}
          error={diagnosticsError}
          onRefresh={() => void loadDiagnostics(task.id)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#111]">
        <div className="border-b border-[#252525] px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-gray-400">Activity</h2>
        </div>

        <div
          ref={feedRef}
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
        >
          {events.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-4 text-[13px] text-gray-600">
              <Loader2 className="size-4 animate-spin" />
              Waiting for sandbox and agent activity…
            </div>
          ) : (
            events.map((event) => <EventRow key={event.id} event={event} />)
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
