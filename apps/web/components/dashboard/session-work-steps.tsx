"use client";

import { Check, Circle, Loader2, Terminal } from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { ShellSource } from "@/components/prompt-kit/source";
import { cn } from "@/lib/utils";

function parseShellLine(line: string): {
  prefix: string;
  command: string;
} | null {
  const match = line.match(/^Ran `(.+)`$/);
  if (!match?.[1]) {
    return null;
  }
  return { prefix: "Ran", command: match[1] };
}

function formatStepTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function WorkStepLabel({
  line,
  active,
  timestamp,
}: {
  line: string;
  active: boolean;
  timestamp?: string;
}) {
  const shell = parseShellLine(line);
  const timeLabel = timestamp ? formatStepTime(timestamp) : "";

  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      {shell ? (
        <p
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-1.5",
            active ? "text-zinc-200" : "text-zinc-500",
          )}
        >
          <span className="text-zinc-500">{shell.prefix}</span>
          <ShellSource command={shell.command} />
        </p>
      ) : (
        <p
          className={cn("min-w-0", active ? "text-zinc-200" : "text-zinc-500")}
        >
          {line}
        </p>
      )}
      {timeLabel ? (
        <time
          dateTime={timestamp}
          className="shrink-0 pt-0.5 text-[11px] text-zinc-600 tabular-nums"
        >
          {timeLabel}
        </time>
      ) : null}
    </div>
  );
}

export function SessionWorkSteps({
  lines,
  isActive,
  elapsedTime,
}: {
  lines: Array<{ line: string; timestamp?: string }>;
  isActive: boolean;
  elapsedTime: string;
}) {
  if (lines.length === 0 && !isActive) {
    return <p className="text-[12px] text-zinc-600">No progress recorded.</p>;
  }

  const header = isActive
    ? `Working… ${elapsedTime}`
    : `Worked for ${elapsedTime}`;

  return (
    <ChainOfThought defaultOpen className="space-y-3 text-zinc-400">
      <ChainOfThoughtHeader className="text-zinc-500 hover:text-zinc-200">
        {header}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="mt-3 space-y-0 text-zinc-400">
        {lines.map((entry, index) => {
          const isLast = index === lines.length - 1;
          const shell = parseShellLine(entry.line);
          // Shell rows keep the terminal icon; spinning the last Shell forever
          // (e.g. bun start hung) is confusing — only spin non-shell steps.
          const active = isActive && isLast && !shell;
          const StepIcon = active ? Loader2 : shell ? Terminal : Check;

          return (
            <ChainOfThoughtStep
              key={`${index}-${entry.line.slice(0, 20)}`}
              icon={StepIcon}
              status={active ? "active" : "complete"}
              label={
                <WorkStepLabel
                  line={entry.line}
                  active={active}
                  timestamp={entry.timestamp}
                />
              }
              className={cn(
                "gap-3 border-l border-white/[0.06] py-2 pl-3 text-[12px]",
                active ? "text-zinc-200" : "text-zinc-500",
                active && "[&_svg]:animate-spin [&_svg]:text-emerald-400",
              )}
            />
          );
        })}
        {isActive && lines.length === 0 ? (
          <ChainOfThoughtStep
            icon={Circle}
            status="pending"
            label={
              <p className="text-[12px] text-zinc-500">
                Waiting for agent steps…
              </p>
            }
            className="gap-3 py-2 pl-3 text-zinc-600"
          />
        ) : null}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
