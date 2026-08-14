"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  History,
  MessageCircle,
  Loader2,
  Monitor,
  TerminalSquare,
  Users,
} from "lucide-react";
import {
  changeKindFromType,
  formatPathContext,
  SessionCodeBlock,
  SessionDiffView,
} from "@/components/dashboard/session-syntax";
import { SessionWorkSteps } from "@/components/dashboard/session-work-steps";
import {
  type ChangedFile,
  fileDisplayName,
  isAgentStreamNoise,
} from "@/lib/sessions/agent-activity";
import { countDiffStats, type DiffLine } from "@/lib/sessions/unified-diff";
import { cn } from "@/lib/utils";

export function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
        active ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

export function FileTreeRow({
  file,
  active,
  onSelect,
}: {
  file: ChangedFile;
  active: boolean;
  onSelect: () => void;
}) {
  const name = fileDisplayName(file.path);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-1.5 pl-4 text-left transition-colors",
        active
          ? "bg-white/[0.06] text-zinc-100"
          : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {name}
      </span>
      <TreeStatusBadge changeType={file.changeType} />
    </button>
  );
}

export function TreeStatusBadge({ changeType }: { changeType: string }) {
  const added = changeKindFromType(changeType) === "added";
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-semibold",
        added ? "text-emerald-400" : "text-amber-400",
      )}
    >
      {added ? "A" : "M"}
    </span>
  );
}

export function ProgressPanel({
  lines,
  isActive,
}: {
  lines: string[];
  isActive: boolean;
}) {
  const filtered = lines.filter((line) => !isAgentStreamNoise(line));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-5 py-4">
      <div className="mb-4 flex items-center gap-2 text-[12px] text-zinc-500">
        <Code2 className="size-3.5 text-zinc-500" />
        <span>Progress</span>
        {isActive ? (
          <Loader2 className="size-3.5 animate-spin text-zinc-500" />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionWorkSteps lines={filtered} isActive={isActive} />
      </div>
    </div>
  );
}

export function ChangesStackPanel({
  files,
  contents,
  diffLines,
  loadingPaths,
  errors,
  highlightPath,
  collapsedPaths,
  onToggleCollapsed,
  onSelectPath,
}: {
  files: ChangedFile[];
  contents: Record<string, string>;
  diffLines: Record<string, DiffLine[]>;
  loadingPaths: Set<string>;
  errors: Record<string, string>;
  highlightPath: string | null;
  collapsedPaths: Set<string>;
  onToggleCollapsed: (path: string) => void;
  onSelectPath: (path: string) => void;
}) {
  const blockRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (!highlightPath || !blockRefs.current[highlightPath]) {
      return;
    }
    blockRefs.current[highlightPath]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [highlightPath]);

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-left">
        <div className="w-full max-w-[250px] space-y-3">
          <WorkspaceHint
            icon={Monitor}
            label="Desktop"
            detail="Watch and control Devin's Desktop"
          />
          <WorkspaceHint
            icon={FileCode2}
            label="Editor"
            detail="Full control of Devin's machine"
          />
          <WorkspaceHint
            icon={Code2}
            label="Changes"
            detail="See Devin's file edits"
          />
          <WorkspaceHint
            icon={TerminalSquare}
            label="Shell"
            detail="View Devin's command history"
          />
          <WorkspaceHint
            icon={History}
            label="Progress"
            detail="Understand Devin's history and actions"
          />
          <WorkspaceHint
            icon={Users}
            label="Agents"
            detail="Manage this session's child sessions"
          />
          <WorkspaceHint
            icon={MessageCircle}
            label="Side chat"
            detail="Ask questions without interrupting your main agent"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-[#0d0d0d]">
      <div className="space-y-0 divide-y divide-white/[0.04]">
        {files.map((file) => {
          const name = fileDisplayName(file.path);
          const pathContext = formatPathContext(file.path);
          const content = contents[file.path];
          const lines = diffLines[file.path];
          const stats = lines ? countDiffStats(lines) : null;
          const lineCount = content?.split("\n").length ?? 0;
          const loading = loadingPaths.has(file.path);
          const awaitingDiff =
            loading && content !== undefined && !lines && !errors[file.path];
          const error = errors[file.path];
          const changeKind = changeKindFromType(file.changeType);
          const isAdded = stats
            ? stats.removed === 0 && stats.added > 0
            : changeKind === "added";
          const collapsed = collapsedPaths.has(file.path);
          const hasDiffView =
            lines &&
            lines.some(
              (line) =>
                line.kind === "add" ||
                line.kind === "remove" ||
                line.kind === "context",
            );

          return (
            <section
              key={file.path}
              ref={(el) => {
                blockRefs.current[file.path] = el;
              }}
              className={cn(
                "bg-[#0d0d0d]",
                highlightPath === file.path &&
                  "ring-1 ring-white/[0.06] ring-inset",
              )}
              onMouseEnter={() => onSelectPath(file.path)}
            >
              <header className="flex items-center gap-2 border-b border-white/[0.04] bg-[#111111] px-3 py-2">
                <button
                  type="button"
                  onClick={() => onToggleCollapsed(file.path)}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-zinc-500 hover:text-zinc-300"
                  aria-expanded={!collapsed}
                >
                  {collapsed ? (
                    <ChevronRight className="size-4" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onToggleCollapsed(file.path)}
                  className="cursor-pointer font-mono text-[13px] font-medium text-zinc-100 hover:text-white"
                >
                  {name}
                </button>
                {pathContext ? (
                  <span className="truncate text-[12px] text-zinc-500">
                    {pathContext}
                  </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <CopyFileButton content={content} />
                  {stats ? (
                    <>
                      {stats.added > 0 ? (
                        <span className="font-mono text-[12px] font-medium text-emerald-400 tabular-nums">
                          +{stats.added}
                        </span>
                      ) : null}
                      {stats.removed > 0 ? (
                        <span className="font-mono text-[12px] font-medium text-rose-400 tabular-nums">
                          -{stats.removed}
                        </span>
                      ) : null}
                    </>
                  ) : lineCount > 0 ? (
                    <span
                      className={cn(
                        "font-mono text-[12px] font-medium tabular-nums",
                        isAdded ? "text-emerald-400" : "text-amber-400",
                      )}
                    >
                      +{lineCount}
                    </span>
                  ) : null}
                  {(stats?.added ?? lineCount) > 0 ? (
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                        isAdded
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-400",
                      )}
                    >
                      {isAdded ? "Added" : "Modified"}
                    </span>
                  ) : null}
                </div>
              </header>
              {!collapsed ? (
                <div className="bg-[#0a0a0a]">
                  {loading && content === undefined ? (
                    <div className="flex items-center gap-2 px-4 py-8 text-[12px] text-zinc-500">
                      <Loader2 className="size-4 animate-spin" />
                      Loading…
                    </div>
                  ) : error ? (
                    <p className="px-4 py-8 text-[12px] text-zinc-500">
                      {error}
                    </p>
                  ) : hasDiffView && lines ? (
                    <SessionDiffView path={file.path} lines={lines} />
                  ) : content ? (
                    <SessionCodeBlock
                      path={file.path}
                      content={content}
                      changeKind={changeKind}
                    />
                  ) : awaitingDiff ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-zinc-600">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading diff…
                    </div>
                  ) : (
                    <p className="px-4 py-8 text-[12px] text-zinc-600">
                      Waiting for file content…
                    </p>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceHint({
  icon: Icon,
  label,
  detail,
}: {
  icon: typeof Monitor;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2 text-zinc-500">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
      <div>
        <p className="text-[12px] text-zinc-300">{label}</p>
        <p className="text-[10px] text-zinc-600">{detail}</p>
      </div>
    </div>
  );
}

export function CopyFileButton({ content }: { content: string | undefined }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      disabled={!content}
      onClick={() => {
        if (!content) return;
        void navigator.clipboard.writeText(content).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded p-1 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-300 disabled:opacity-30"
      aria-label={copied ? "Copied" : "Copy file"}
    >
      <Copy className="size-3.5" />
    </button>
  );
}
