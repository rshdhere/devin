"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { MotionButton } from "@/components/dashboard/motion-button";
import { workspaceShellClassName } from "@/components/dashboard/prompt-composer-constants";
import { useSessions } from "@/components/dashboard/sessions-context";
import { useChatSlotMorphHandoff } from "@/components/dashboard/use-chat-slot-morph-handoff";
import { Diamond } from "@/components/loading-ui/diamond";
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
import { cn } from "@/lib/utils";
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
  const { refreshTasks, isLaunchMorphing, isLaunchMorphFading } = useSessions();
  const chatSlotRef = useRef<HTMLDivElement>(null);
  useChatSlotMorphHandoff(chatSlotRef);
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
  >("progress");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLineCounts, setFileLineCounts] = useState<Record<string, number>>(
    {},
  );

  const isActive =
    task.status !== "completed" &&
    task.status !== "failed" &&
    task.status !== "cancelled" &&
    task.status !== "awaiting_review";

  const elapsedTime = useElapsedTime(task.createdAt, isActive, events);

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
    task.sessionSleeping === true ||
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
      {task.sessionSleeping &&
      /Devbox ended — send a follow-up/i.test(task.message ?? "") ? (
        <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
          <p className="text-[12px] text-amber-100">
            {task.message} Your repo and session context stay available for
            follow-ups (up to 30 days).
          </p>
        </div>
      ) : null}
      {awaitingSandboxApproval ? (
        <Confirmation
          approval={{ id: `sandbox-${task.id}` }}
          state="approval-requested"
          className="mt-3 flex-row items-center justify-between gap-3 border-violet-500/25 bg-violet-500/10 px-3 py-2.5 text-violet-100"
        >
          <ConfirmationRequest>
            <ConfirmationTitle className="text-[12px] text-violet-100">
              Draft ready — run in devbox
            </ConfirmationTitle>
          </ConfirmationRequest>
          <ConfirmationActions className="self-auto">
            <ConfirmationAction
              disabled={startingSandbox}
              onClick={() => void handleStartSandbox()}
              className="h-auto cursor-pointer gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] text-white hover:bg-violet-500 disabled:opacity-60"
            >
              {startingSandbox ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              Run
            </ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
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

  const chatColumn = (
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
  );

  // Chat stays covered by the morph overlay. Workspace shows the diamond on
  // top while real panels stay mounted underneath (avoids remount hitch at fade).
  const coveredByMorph = isLaunchMorphing && !isLaunchMorphFading;

  return (
    <div className="relative flex min-h-0 w-full flex-1 overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden lg:flex-row lg:gap-3">
        <div
          ref={chatSlotRef}
          data-chat-slot=""
          className={cn(
            workspaceShellClassName,
            "flex min-h-0 min-w-0 flex-1 flex-col lg:w-[395px] lg:max-w-[395px] lg:flex-none",
            coveredByMorph && "invisible",
          )}
        >
          {chatColumn}
        </div>
        <div
          className={cn(
            workspaceShellClassName,
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
          )}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              coveredByMorph && "invisible",
            )}
          >
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
          {isLaunchMorphing ? (
            <div
              className={cn(
                "absolute inset-0 z-10 flex flex-col items-center justify-center bg-[#1c1c1c] text-zinc-300 transition-opacity duration-200 ease-out",
                isLaunchMorphFading && "opacity-0",
              )}
              role="status"
              aria-label="Loading workspace"
            >
              <Diamond className="size-10 text-zinc-300" />
            </div>
          ) : null}
        </div>
      </div>

      {showDiagnostics && task.status === "failed" ? (
        <details
          className="absolute right-0 bottom-0 left-0 z-20 mx-3 mb-3 shrink-0 rounded-xl border border-white/[0.08] bg-[#141414]/95 px-4 py-2 backdrop-blur-md"
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
