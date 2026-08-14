"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { useSessions } from "@/components/dashboard/sessions-context";
import type {
  InfraDiagnostics,
  Task,
  TaskDiagnostics,
  TaskEvent,
} from "@devin/types";
import { usesRuntimeAgent } from "@devin/types";
import { DEFAULT_CURSOR_AGENT_MODEL } from "@devin/types";
import {
  fetchInfraDiagnostics,
  fetchTaskDiagnostics,
  fetchTaskEventHistory,
  executeTask,
  retryTask,
  commitTaskWork,
  raiseTaskPullRequest,
  continueTask,
  terminateSession,
} from "@/lib/tasks-api";
import {
  SessionChatColumn,
  SessionPhaseStrip,
} from "@/components/dashboard/session-chat-column";
import { SessionCodeColumn } from "@/components/dashboard/session-code-column";
import { sumLineCounts, mergeTaskEvents } from "@/lib/sessions/agent-activity";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { useSessionDetailEffects } from "./session-detail-effects";
import { useElapsedTime } from "./session-detail-utils";
import { DiagnosticsPanel } from "./session-detail-diagnostics";

interface SessionDetailProps {
  task: Task;
  onBack: () => void;
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
  >(() => (canUseDevbox(initialTask) ? "desktop" : "changes"));
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
    const optimisticEvent: TaskEvent = {
      id: `optimistic-${Date.now()}`,
      taskId: task.id,
      type: "task.scheduled",
      message: "Follow-up prompt queued",
      timestamp: new Date().toISOString(),
      data: { followUp: true, prompt: trimmed, optimistic: true },
    };
    setEvents((current) => mergeTaskEvents(current, [optimisticEvent]));
    setFollowUpPrompt("");
    try {
      const updated = await continueTask(
        task.id,
        trimmed,
        DEFAULT_CURSOR_AGENT_MODEL,
      );
      setTask(updated);
      const history = await fetchTaskEventHistory(task.id);
      if (history.length > 0) {
        setEvents((current) => mergeTaskEvents(current, history));
      }
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

  useSessionDetailEffects({
    task,
    initialTask,
    setTask,
    setEvents,
    streamError,
    setStreamError,
    refreshTasks,
    loadDiagnostics,
  });

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
          elapsedTime={elapsedTime}
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
