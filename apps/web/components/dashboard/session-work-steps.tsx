"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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
    <ol className="space-y-0">
      {lines.map((line, index) => {
        const isLast = index === lines.length - 1;
        const active = isActive && isLast;
        return (
          <li
            key={`${index}-${line.slice(0, 20)}`}
            className="flex gap-3 border-l border-white/[0.06] py-2 pl-3"
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                active
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-white/[0.08] bg-[#141414] text-zinc-500",
              )}
            >
              {active ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
            </span>
            <p
              className={cn(
                "min-w-0 text-[12px] leading-relaxed",
                active ? "text-zinc-200" : "text-zinc-500",
              )}
            >
              {line}
            </p>
          </li>
        );
      })}
      {isActive && lines.length === 0 ? (
        <li className="flex gap-3 py-2 pl-3">
          <span className="mt-0.5 flex size-5 items-center justify-center rounded-full border border-white/[0.08] bg-[#141414]">
            <Circle className="size-3 text-zinc-600" />
          </span>
          <p className="text-[12px] text-zinc-500">Waiting for agent steps…</p>
        </li>
      ) : null}
    </ol>
  );
}
