"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowLeft,
  Clock,
  ExternalLink,
  GitCommit,
  Loader2,
  Send,
} from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { DEVIN_BOT } from "@/lib/devin-bot";
import { MotionButton } from "@/components/dashboard/motion-button";
import { taskStatusLabel } from "@/lib/tasks-api";
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
  const messages: ChatMessage[] = [
    {
      id: `user-${task.id}-initial`,
      role: "user",
      content: task.prompt,
      timestamp: task.createdAt,
    },
  ];

  const draftSummary = events.find((e) => e.type === "draft.completed")?.data
    ?.summary;
  if (draftSummary) {
    messages.push({
      id: "draft-summary",
      role: "assistant",
      content: String(draftSummary),
      timestamp: events.find((e) => e.type === "draft.completed")?.timestamp,
    });
  }

  for (const event of events) {
    if (event.type === "agent.output") {
      const text = event.message?.trim();
      if (!text) continue;
      messages.push({
        id: event.id,
        role: "assistant",
        content: text,
        timestamp: event.timestamp,
      });
      continue;
    }
    if (
      event.type === "task.failed" ||
      event.type === "sandbox.failed" ||
      event.type === "task.completed"
    ) {
      messages.push({
        id: event.id,
        role: "system",
        content: event.message,
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
  sessionActive,
  banner,
  composerDisabled,
}: SessionChatColumnProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = buildChatMessages(task, events);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, isActive]);

  const statusColor =
    task.status === "failed"
      ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
      : isActive
        ? "text-violet-300 bg-violet-500/10 border-violet-500/20"
        : "text-zinc-400 bg-zinc-500/10 border-zinc-500/20";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-white/[0.06] bg-[#09090b] lg:max-w-[42%] lg:flex-none lg:border-r lg:border-b-0">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <MotionButton
          type="button"
          pressStyle="icon"
          onClick={onBack}
          className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </MotionButton>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-zinc-100">
            {task.title ?? "Session"}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                statusColor,
              )}
            >
              {isActive ? <Loader2 className="size-3 animate-spin" /> : null}
              {taskStatusLabel(task.status)}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
              <Clock className="size-3" />
              {elapsedTime}
            </span>
          </div>
        </div>
        {task.prUrl ? (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-violet-300 hover:bg-white/[0.06]"
          >
            PR
            <ExternalLink className="size-3" />
          </a>
        ) : task.repository ? (
          <a
            href={`https://github.com/${task.repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-emerald-400 hover:bg-white/[0.06]"
          >
            <GitCommit className="size-3" />
            Repo
          </a>
        ) : null}
      </header>

      {banner ? (
        <div className="shrink-0 border-b border-white/[0.06] px-4 py-3">
          {banner}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
      >
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} />
        ))}
        {isActive && messages.length <= 1 ? (
          <div className="flex items-start gap-3">
            <AssistantAvatar />
            <div className="rounded-2xl rounded-tl-md border border-white/[0.06] bg-white/[0.03] px-4 py-3">
              <div className="flex items-center gap-2 text-[13px] text-zinc-400">
                <Loader2 className="size-4 animate-spin text-violet-400" />
                Booting devbox and starting agent…
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] bg-[#09090b]/95 p-4 backdrop-blur-md">
        <form
          className="relative"
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
            placeholder={
              sessionActive
                ? "Ask for changes, fixes, or next steps…"
                : isActive
                  ? "Working… you can send a follow-up when the session is ready"
                  : "Start a new session from Sessions to continue building"
            }
            className="w-full resize-none rounded-2xl border border-white/[0.08] bg-[#121214] px-4 py-3 pr-12 text-[14px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 disabled:opacity-50"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!composerDisabled && followUpPrompt.trim()) {
                  onSendFollowUp();
                }
              }
            }}
          />
          <MotionButton
            type="submit"
            disabled={
              composerDisabled || continuingSession || !followUpPrompt.trim()
            }
            className="absolute right-2 bottom-2 inline-flex cursor-pointer items-center justify-center rounded-xl bg-violet-600 p-2 text-white transition-colors hover:bg-violet-500 disabled:opacity-40"
            aria-label="Send message"
          >
            {continuingSession ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </MotionButton>
        </form>
        <p className="mt-2 text-center text-[10px] text-zinc-600">
          Enter to send · Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <p className="text-center text-[12px] leading-relaxed text-zinc-500">
        {message.content}
      </p>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[92%] rounded-2xl rounded-tr-md bg-gradient-to-br from-violet-600/90 to-indigo-600/80 px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-lg shadow-violet-950/30">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <AssistantAvatar />
      <div className="max-w-[92%] min-w-0 rounded-2xl rounded-tl-md border border-white/[0.06] bg-[#121214] px-4 py-2.5 text-[14px] leading-relaxed text-zinc-200">
        <pre className="font-sans whitespace-pre-wrap">{message.content}</pre>
      </div>
    </div>
  );
}

function AssistantAvatar() {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-violet-500/30 bg-gradient-to-br from-violet-600/30 to-indigo-900/50">
      {/* eslint-disable-next-line @next/next/no-img-element -- bot avatar is a static external URL */}
      <img src={DEVIN_BOT.avatarUrl} alt="" className="size-5 rounded-full" />
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
            <span className="h-px w-6 bg-white/[0.08]" />
          ) : null}
        </div>
      ))}
    </div>
  );
}
