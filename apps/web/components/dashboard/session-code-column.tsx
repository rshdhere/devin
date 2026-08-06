"use client";

import { useMemo } from "react";
import { Code2, Sparkles, Terminal } from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { DevboxWorkspace } from "@/components/dashboard/devbox-workspace";
import { cn } from "@/lib/utils";

interface SessionCodeColumnProps {
  task: Task;
  events: TaskEvent[];
  isActive: boolean;
  onTaskChange?: (task: Task) => void;
}

export function SessionCodeColumn({
  task,
  events,
  isActive,
  onTaskChange,
}: SessionCodeColumnProps) {
  const outputLines = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.type === "agent.output" ||
            (event.type === "agent.tool" && Boolean(event.data?.tool)),
        )
        .map((event) => ({
          line:
            event.type === "agent.tool" ? `$ ${event.message}` : event.message,
          stream: (event.data?.stream as string) ?? "stdout",
        })),
    [events],
  );

  const fileHints = useMemo(
    () =>
      events
        .filter((e) => e.type === "draft.diff")
        .slice(-8)
        .map((e) => String(e.data?.path ?? "file")),
    [events],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0c0c0e] lg:min-h-0">
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Code2 className="size-4" />
          </div>
          <div>
            <p className="text-[13px] font-medium text-zinc-100">Workspace</p>
            <p className="text-[11px] text-zinc-500">
              Live repo, shell, and agent output
            </p>
          </div>
        </div>
        {fileHints.length > 0 ? (
          <div className="hidden max-w-[45%] truncate text-right font-mono text-[10px] text-zinc-500 lg:block">
            {fileHints.join(" · ")}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden p-3">
        <DevboxWorkspace
          task={task}
          onTaskChange={onTaskChange}
          layout="panel"
          defaultTab="files"
        />

        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-[#08080a]">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
            <Terminal className="size-3.5 text-emerald-400" />
            <span className="text-[12px] font-medium text-zinc-300">
              Agent stream
            </span>
            {isActive ? (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                Live
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed">
            {outputLines.length === 0 ? (
              <p className="flex items-center gap-2 text-zinc-600">
                <Sparkles className="size-3.5" />
                Code and terminal output will appear as the agent works.
              </p>
            ) : (
              outputLines.map((output, index) => (
                <div
                  key={index}
                  className={cn(
                    "break-words whitespace-pre-wrap",
                    output.stream === "stderr"
                      ? "text-rose-400"
                      : "text-emerald-300/90",
                  )}
                >
                  {output.line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
