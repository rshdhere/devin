"use client";

import { useState, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

export type ShellSourceProps = {
  command: string;
  label?: string;
  className?: string;
};

export function ShellSource({ command, label, className }: ShellSourceProps) {
  const [open, setOpen] = useState(false);
  const display = label ?? command;

  return (
    <span className={cn("inline-flex max-w-full align-middle", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/[0.08] bg-[#141414] px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-white/[0.14] hover:text-zinc-100"
      >
        <Terminal className="size-3 shrink-0 text-emerald-400" />
        <span className="truncate font-mono">{display}</span>
      </button>
      {open ? (
        <div className="mt-1 w-full rounded-lg border border-white/[0.08] bg-[#0f0f0f] p-2">
          <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-300">
            {command}
          </pre>
        </div>
      ) : null}
    </span>
  );
}

export type SourceProps = {
  href: string;
  children: ReactNode;
};

export function Source({ href, children }: SourceProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-emerald-400 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

export function SourceTrigger({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-300",
        className,
      )}
    >
      {label}
    </span>
  );
}
