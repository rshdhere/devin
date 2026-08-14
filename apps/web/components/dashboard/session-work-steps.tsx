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

function WorkStepLabel({ line, active }: { line: string; active: boolean }) {
  const shell = parseShellLine(line);
  if (shell) {
    return (
      <p
        className={cn(
          "flex flex-wrap items-center gap-1.5",
          active ? "text-zinc-200" : "text-zinc-500",
        )}
      >
        <span className="text-zinc-500">{shell.prefix}</span>
        <ShellSource command={shell.command} />
      </p>
    );
  }
  return (
    <p className={cn("min-w-0", active ? "text-zinc-200" : "text-zinc-500")}>
      {line}
    </p>
  );
}

export function SessionWorkSteps({
  lines,
  isActive,
}: {
  lines: string[];
  isActive: boolean;
}) {
  if (lines.length === 0 && !isActive) {
    return <p className="text-[12px] text-zinc-600">No progress recorded.</p>;
  }

  return (
    <ChainOfThought defaultOpen className="space-y-3 text-zinc-400">
      <ChainOfThoughtHeader className="text-zinc-500 hover:text-zinc-200">
        Progress
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="mt-3 space-y-0 text-zinc-400">
        {lines.map((line, index) => {
          const isLast = index === lines.length - 1;
          const active = isActive && isLast;
          const shell = parseShellLine(line);
          const StepIcon = active ? Loader2 : shell ? Terminal : Check;

          return (
            <ChainOfThoughtStep
              key={`${index}-${line.slice(0, 20)}`}
              icon={StepIcon}
              status={active ? "active" : "complete"}
              label={<WorkStepLabel line={line} active={active} />}
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
