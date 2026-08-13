"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  GitCommit,
  Lightbulb,
  Loader2,
  Mic,
  Plus,
} from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import {
  CURSOR_AGENT_MODELS,
  cursorAgentModelLabel,
  type CursorAgentModelId,
} from "@devin/types";
import { MotionButton } from "@/components/dashboard/motion-button";
import { SessionDesktopPanel } from "@/components/dashboard/session-desktop-panel";
import {
  buildConversationMessages,
  pickStatusLine,
  formatAgentFailureMessage,
} from "@/lib/sessions/agent-activity";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
};

export function buildChatMessages(
  task: Task,
  events: TaskEvent[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const event of events) {
    if (
      event.type === "task.failed" ||
      event.type === "sandbox.failed" ||
      event.type === "task.completed"
    ) {
      const text = event.message?.trim();
      if (!text) continue;
      const display =
        event.type === "task.failed" || event.type === "sandbox.failed"
          ? formatAgentFailureMessage(text)
          : text;
      messages.push({
        id: event.id,
        role: "system",
        content: display,
        timestamp: event.timestamp,
      });
    }
  }

  return messages;
}

interface SessionChatColumnProps {
  task: Task;
  events: TaskEvent[];
  elapsedTime: string;
  isActive: boolean;
  onBack: () => void;
  followUpPrompt: string;
  onFollowUpChange: (value: string) => void;
  onSendFollowUp: () => void;
  continuingSession: boolean;
  sessionActive: boolean;
  banner?: ReactNode;
  composerDisabled?: boolean;
  addedLineCount?: number;
  onOpenDesktop?: () => void;
  cursorAgentModel?: CursorAgentModelId;
  onCursorAgentModelChange?: (model: CursorAgentModelId) => void;
}

export function SessionChatColumn({
  task,
  events,
  elapsedTime,
  isActive,
  onBack,
  followUpPrompt,
  onFollowUpChange,
  onSendFollowUp,
  continuingSession,
  banner,
  composerDisabled,
  addedLineCount = 0,
  onOpenDesktop,
  cursorAgentModel,
  onCursorAgentModelChange,
}: SessionChatColumnProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const conversation = buildConversationMessages(task, events);
  const systemMessages = buildChatMessages(task, events);
  const statusLine = pickStatusLine(task, events, isActive);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const showModelPicker =
    task.agent === "cursor" && cursorAgentModel && onCursorAgentModelChange;

  const snapshotRefreshKey = events.reduce(
    (count, event) => count + (event.data?.desktopSnapshot === true ? 1 : 0),
    0,
  );

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(event.target as Node)
      ) {
        setShowModelMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [conversation.length, isActive, statusLine]);

  const workLabel = isActive
    ? `Working… ${elapsedTime}`
    : `Worked for ${elapsedTime}${
        addedLineCount > 0 ? ` · +${addedLineCount}` : ""
      }`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0a0a0a] lg:w-[340px] lg:max-w-[340px] lg:flex-none lg:border-r lg:border-white/[0.06]">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-3">
        <MotionButton
          type="button"
          pressStyle="icon"
          onClick={onBack}
          className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </MotionButton>
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
          {task.title ?? task.prompt}
        </p>
        {task.repository ? (
          <a
            href={`https://github.com/${task.repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-zinc-500 hover:text-zinc-300"
            aria-label="Open repository"
          >
            <GitCommit className="size-4" />
          </a>
        ) : null}
      </header>

      {banner ? (
        <div className="shrink-0 border-b border-white/[0.06] px-4 py-2">
          {banner}
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!canUseDevbox(task) ? <TipCard /> : null}

        {isActive && statusLine ? (
          <p className="mb-2 text-[13px] leading-relaxed text-zinc-400">
            {statusLine}
          </p>
        ) : null}

        <p
          className={cn(
            "mb-3 flex items-center gap-2 text-[12px] text-zinc-500",
            isActive && "font-medium text-zinc-400",
          )}
        >
          {isActive ? (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          ) : null}
          {workLabel}
        </p>

        <div className="space-y-4">
          {conversation.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end gap-2">
                <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-[#1a1a1a] px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-100">
                  {message.content}
                </div>
                <UserAvatar />
              </div>
            ) : (
              <div key={message.id} className="pr-2">
                <AssistantMarkdown content={message.content} />
              </div>
            ),
          )}
        </div>

        {systemMessages.map((message) => (
          <p
            key={message.id}
            className="mt-3 text-center text-[11px] text-zinc-600"
          >
            {message.content}
          </p>
        ))}
      </div>

      {canUseDevbox(task) ? (
        <div className="shrink-0 border-t border-white/[0.06] bg-[#0a0a0a] px-3 pt-3">
          <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#111]">
            <SessionDesktopPanel
              task={task}
              layout="embed"
              externalRefreshKey={snapshotRefreshKey}
              onOpenDesktop={onOpenDesktop}
            />
          </div>
        </div>
      ) : null}

      <div className="shrink-0 border-t border-white/[0.06] bg-[#0a0a0a] p-3">
        <form
          className="rounded-2xl border border-white/[0.08] bg-[#111111] p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!composerDisabled && followUpPrompt.trim()) {
              onSendFollowUp();
            }
          }}
        >
          <textarea
            value={followUpPrompt}
            onChange={(event) => onFollowUpChange(event.target.value)}
            disabled={composerDisabled || continuingSession}
            rows={2}
            placeholder="Ask Devin to build features, fix bugs, or work on your code"
            className="w-full resize-none bg-transparent px-2 py-1 text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-50"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!composerDisabled && followUpPrompt.trim()) {
                  onSendFollowUp();
                }
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between px-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
                aria-label="Add attachment"
              >
                <Plus className="size-4" />
              </button>
              {showModelPicker ? (
                <div className="relative" ref={modelMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowModelMenu((open) => !open)}
                    className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                  >
                    {cursorAgentModelLabel(cursorAgentModel)}
                    <ChevronDown
                      className={cn(
                        "size-3.5 transition-transform",
                        showModelMenu && "rotate-180",
                      )}
                    />
                  </button>
                  {showModelMenu ? (
                    <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1a1a] py-1 shadow-xl">
                      {CURSOR_AGENT_MODELS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => {
                            onCursorAgentModelChange(option.id);
                            setShowModelMenu(false);
                          }}
                          className={cn(
                            "flex w-full px-3 py-2 text-left text-[12px] hover:bg-white/[0.06]",
                            cursorAgentModel === option.id
                              ? "text-zinc-100"
                              : "text-zinc-500",
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="flex cursor-default items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-zinc-500"
                >
                  Normal
                  <ChevronDown className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
                aria-label="Voice input"
              >
                <Mic className="size-4" />
              </button>
              <MotionButton
                type="submit"
                disabled={
                  composerDisabled ||
                  continuingSession ||
                  !followUpPrompt.trim()
                }
                className="inline-flex cursor-pointer items-center justify-center rounded-full bg-zinc-700 p-2 text-zinc-100 transition-colors hover:bg-zinc-600 disabled:opacity-40"
                aria-label="Send message"
              >
                {continuingSession ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </MotionButton>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function TipCard() {
  return (
    <div className="mb-4 flex gap-2.5 rounded-xl border border-white/[0.06] bg-[#111111] px-3 py-2.5">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15">
        <Lightbulb className="size-3.5 text-violet-400" />
      </div>
      <p className="text-[12px] leading-relaxed text-zinc-500">
        Tip: ask for a specific stack, tests, or a live preview — Devin works in
        your repo and devbox.
      </p>
    </div>
  );
}

function UserAvatar() {
  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-rose-500 to-orange-600 text-[11px] font-semibold text-white"
      aria-hidden
    >
      You
    </div>
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-zinc-300 [&_a]:text-emerald-400 [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-medium [&_h2]:text-zinc-100 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-medium [&_h3]:text-zinc-100 [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_strong]:font-semibold [&_strong]:text-zinc-100 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

export function SessionPhaseStrip({
  task,
  events,
}: {
  task: Task;
  events: TaskEvent[];
}) {
  const sandboxDone = events.some((e) => e.type === "sandbox.started");
  const executeDone =
    task.status === "completed" ||
    task.status === "awaiting_review" ||
    events.some((e) => e.type === "task.completed");
  const hasDesktopSnapshot = events.some(
    (e) => e.data?.desktopSnapshot === true,
  );
  const completedAt = events.find(
    (e) => e.type === "task.completed",
  )?.timestamp;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (
      task.status !== "completed" ||
      hasDesktopSnapshot ||
      !completedAt ||
      !canUseDevbox(task)
    ) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [completedAt, hasDesktopSnapshot, task]);
  const captureTimedOut =
    completedAt !== undefined && now - Date.parse(completedAt) > 130_000;
  const capturingPreview =
    task.status === "completed" &&
    canUseDevbox(task) &&
    !hasDesktopSnapshot &&
    !captureTimedOut;
  const done = task.status === "completed" && !capturingPreview;

  const steps = [
    { label: "Sandbox", done: sandboxDone },
    { label: "Build", done: executeDone && !capturingPreview },
    {
      label: capturingPreview ? "Capturing preview…" : "Done",
      done,
    },
  ];

  return (
    <div className="flex items-center gap-2">
      {steps.map((step, index) => (
        <div key={step.label} className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-medium tracking-wide uppercase",
              step.done ? "text-emerald-400" : "text-zinc-600",
            )}
          >
            {step.label}
          </span>
          {index < steps.length - 1 ? (
            <span className="h-px w-4 bg-white/[0.08]" />
          ) : null}
        </div>
      ))}
    </div>
  );
}
