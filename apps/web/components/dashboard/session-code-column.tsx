"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, FileCode2, FolderTree, Loader2, Sparkles } from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { DevboxWorkspace } from "@/components/dashboard/devbox-workspace";
import { readTaskFile } from "@/lib/api/tasks";
import { canUseDevbox } from "@/lib/sessions/devbox";
import {
  extractChangedFiles,
  isAgentStreamNoise,
  progressActivityLines,
} from "@/lib/sessions/agent-activity";
import { cn } from "@/lib/utils";

type WorkspaceTab = "progress" | "changes" | "desktop";

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
  const changedFiles = useMemo(() => extractChangedFiles(events), [events]);
  const activityLines = useMemo(() => progressActivityLines(events), [events]);

  const [tab, setTab] = useState<WorkspaceTab>("changes");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const effectivePath =
    selectedPath ?? changedFiles[changedFiles.length - 1]?.path ?? null;

  useEffect(() => {
    const latest = changedFiles[changedFiles.length - 1];
    if (changedFiles.length > 0 && !selectedPath && latest) {
      setSelectedPath(latest.path);
    }
  }, [changedFiles, selectedPath]);

  const loadFile = useCallback(
    async (path: string) => {
      if (!canUseDevbox(task)) {
        setFileContent(null);
        setFileError("Open a file after the devbox is running.");
        return;
      }
      setFileLoading(true);
      setFileError(null);
      try {
        const result = await readTaskFile(task.id, path);
        setFileContent(result.content);
      } catch (error) {
        setFileContent(null);
        setFileError(
          error instanceof Error ? error.message : "Could not load file",
        );
      } finally {
        setFileLoading(false);
      }
    },
    [task],
  );

  useEffect(() => {
    if (tab !== "changes" || !effectivePath) {
      return;
    }
    void loadFile(effectivePath);
  }, [tab, effectivePath, loadFile]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[#0c0c0e] lg:min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-4 py-2.5">
          <TabButton
            active={tab === "progress"}
            onClick={() => setTab("progress")}
            label="Progress"
          />
          <TabButton
            active={tab === "changes"}
            onClick={() => setTab("changes")}
            label="Changes"
          />
          <TabButton
            active={tab === "desktop"}
            onClick={() => setTab("desktop")}
            label="Desktop"
          />
          {isActive ? (
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-emerald-400">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </span>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "progress" ? (
            <ProgressPanel lines={activityLines} isActive={isActive} />
          ) : null}
          {tab === "changes" ? (
            <ChangesPanel
              path={effectivePath}
              content={fileContent}
              loading={fileLoading}
              error={fileError}
            />
          ) : null}
          {tab === "desktop" ? (
            <div className="flex h-full min-h-0 flex-col p-3">
              <DevboxWorkspace
                task={task}
                onTaskChange={onTaskChange}
                layout="panel"
                defaultTab="files"
              />
            </div>
          ) : null}
        </div>
      </div>

      <aside className="hidden w-[220px] shrink-0 flex-col border-l border-white/[0.06] bg-[#09090b] lg:flex">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
          <FolderTree className="size-3.5 text-zinc-500" />
          <span className="text-[11px] font-medium text-zinc-400">Files</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {changedFiles.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-zinc-600">
              Changed files appear here as the agent edits the repo.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {changedFiles.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPath(file.path);
                      setTab("changes");
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                      effectivePath === file.path
                        ? "bg-white/[0.06] text-zinc-100"
                        : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200",
                    )}
                  >
                    <ChangeBadge changeType={file.changeType} />
                    <span className="truncate font-mono text-[11px]">
                      {file.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function TabButton({
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
        "cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "bg-white/[0.08] text-zinc-100"
          : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

function ChangeBadge({ changeType }: { changeType: string }) {
  const normalized = changeType.toLowerCase();
  const added =
    normalized === "added" ||
    normalized === "create" ||
    normalized === "created";
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase",
        added
          ? "bg-emerald-500/15 text-emerald-400"
          : "bg-amber-500/15 text-amber-400",
      )}
    >
      {added ? "A" : "M"}
    </span>
  );
}

function ProgressPanel({
  lines,
  isActive,
}: {
  lines: string[];
  isActive: boolean;
}) {
  const filtered = lines.filter((line) => !isAgentStreamNoise(line));

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-4">
      <div className="mb-3 flex items-center gap-2 text-[12px] text-zinc-500">
        <Code2 className="size-3.5 text-violet-400" />
        <span>Agent activity</span>
        {isActive ? (
          <Loader2 className="size-3.5 animate-spin text-violet-400" />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="flex items-center gap-2 text-[12px] text-zinc-600">
            <Sparkles className="size-3.5" />
            {isActive
              ? "Tools and edits will show up here — not raw stream tokens."
              : "No activity recorded for this session."}
          </p>
        ) : (
          filtered.map((line, index) => (
            <p
              key={`${index}-${line.slice(0, 24)}`}
              className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300"
            >
              {line}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function ChangesPanel({
  path,
  content,
  loading,
  error,
}: {
  path: string | null;
  content: string | null;
  loading: boolean;
  error: string | null;
}) {
  if (!path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileCode2 className="size-8 text-zinc-700" />
        <p className="text-[13px] text-zinc-500">No file changes yet</p>
        <p className="max-w-sm text-[12px] text-zinc-600">
          Select a file from the tree when edits land, or switch to Desktop for
          the full workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-4 py-2">
        <FileCode2 className="size-3.5 text-emerald-400" />
        <span className="truncate font-mono text-[12px] text-zinc-300">
          {path}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <p className="px-4 py-6 text-[12px] text-amber-300/90">{error}</p>
        ) : content ? (
          <pre className="p-4 font-mono text-[12px] leading-relaxed text-emerald-100/90">
            {content}
          </pre>
        ) : (
          <p className="px-4 py-6 text-[12px] text-zinc-600">Empty file</p>
        )}
      </div>
    </div>
  );
}
