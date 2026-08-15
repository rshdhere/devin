"use client";

import { useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  ArrowUp,
  GitCommit,
  Loader2,
  Mic,
  Plus,
} from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { MotionButton } from "@/components/dashboard/motion-button";
import { SessionDesktopPanel } from "@/components/dashboard/session-desktop-panel";
import {
  buildConversationMessages,
  pickStatusLine,
  formatAgentFailureMessage,
} from "@/lib/sessions/agent-activity";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { taskSessionLabel } from "@/lib/sessions/labels";
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
}: SessionChatColumnProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversation = buildConversationMessages(task, events);
  const systemMessages =
    task.status === "failed" ? [] : buildChatMessages(task, events);
  const statusLine = pickStatusLine(task, events, isActive);

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
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-transparent">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
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
          {taskSessionLabel(task)}
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          {conversation.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex flex-col items-end gap-1">
                {message.timestamp ? (
                  <time
                    dateTime={message.timestamp}
                    className="mr-10 text-[11px] text-zinc-500 tabular-nums"
                  >
                    {formatMessageTime(message.timestamp)}
                  </time>
                ) : null}
                <div className="flex items-end gap-2">
                  <div className="max-w-[min(88%,20rem)] rounded-2xl rounded-tr-md bg-[#1a1a1a] px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-100">
                    {message.content}
                  </div>
                  <UserAvatar />
                </div>
              </div>
            ) : (
              <div key={message.id} className="pr-2">
                <AssistantMarkdown content={message.content} />
              </div>
            ),
          )}
        </div>

        {isActive && statusLine ? (
          <p className="mt-4 text-[13px] leading-relaxed text-zinc-400">
            {statusLine}
          </p>
        ) : null}

        <p
          className={cn(
            "mt-3 flex items-center gap-2 text-[12px] text-zinc-500",
            isActive && "font-medium text-zinc-400",
          )}
        >
          {isActive ? (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
          ) : null}
          {workLabel}
        </p>

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
        <div className="shrink-0 border-t border-white/[0.06] bg-transparent px-3 pt-3">
          <div className="overflow-hidden rounded-xl border border-white/10 bg-[#111]/90">
            <SessionDesktopPanel
              task={task}
              layout="embed"
              onOpenDesktop={onOpenDesktop}
            />
          </div>
        </div>
      ) : null}

      <div className="shrink-0 border-t border-white/[0.06] bg-transparent p-3">
        <form
          className="rounded-xl border border-white/15 bg-[#1c1c1c]/75 p-2.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-md"
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
            rows={1}
            placeholder="Ask Devin to build features, fix bugs, or work on your code"
            className="w-full resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-50"
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

function formatMessageTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
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
  const done = task.status === "completed";

  const steps = [
    { label: "Sandbox", done: sandboxDone },
    { label: "Build", done: executeDone },
    { label: "Done", done },
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
