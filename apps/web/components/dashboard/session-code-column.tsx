"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Folder,
  ListFilter,
  Loader2,
  Monitor,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { DevboxWorkspace } from "@/components/dashboard/devbox-workspace";
import {
  changeKindFromType,
  formatPathContext,
  SessionCodeBlock,
  SessionDiffView,
} from "@/components/dashboard/session-syntax";
import { readTaskFile, runTaskTerminal } from "@/lib/api/tasks";
import { canUseDevbox } from "@/lib/sessions/devbox";
import {
  type ChangedFile,
  extractChangedFiles,
  fileDisplayName,
  groupChangedFilesByFolder,
  isAddedChangeType,
  isAgentStreamNoise,
  normalizeSandboxFilePath,
  progressActivityLines,
} from "@/lib/sessions/agent-activity";
import {
  buildFileDiffCommand,
  countDiffStats,
  parseUnifiedDiff,
  syntheticAddedDiff,
  type DiffLine,
} from "@/lib/sessions/unified-diff";
import { cn } from "@/lib/utils";

export type WorkspaceTab = "progress" | "changes" | "desktop";

interface SessionCodeColumnProps {
  task: Task;
  events: TaskEvent[];
  isActive: boolean;
  onTaskChange?: (task: Task) => void;
  workspaceTab: WorkspaceTab;
  onWorkspaceTabChange: (tab: WorkspaceTab) => void;
  selectedPath: string | null;
  onSelectedPathChange: (path: string | null) => void;
  onFileLineCount?: (path: string, lineCount: number) => void;
}

export function SessionCodeColumn({
  task,
  events,
  isActive,
  onTaskChange,
  workspaceTab,
  onWorkspaceTabChange,
  selectedPath,
  onSelectedPathChange,
  onFileLineCount,
}: SessionCodeColumnProps) {
  const changedFiles = useMemo(() => extractChangedFiles(events), [events]);
  const activityLines = useMemo(() => progressActivityLines(events), [events]);
  const grouped = useMemo(
    () => groupChangedFilesByFolder(changedFiles),
    [changedFiles],
  );

  const [fileSearch, setFileSearch] = useState("");
  const [contents, setContents] = useState<Record<string, string>>({});
  const [diffLines, setDiffLines] = useState<Record<string, DiffLine[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  const changedFileByPath = useMemo(() => {
    const map = new Map<string, ChangedFile>();
    for (const file of changedFiles) {
      map.set(normalizeSandboxFilePath(file.path), file);
    }
    return map;
  }, [changedFiles]);

  const effectivePath = useMemo(() => {
    const raw =
      selectedPath ?? changedFiles[changedFiles.length - 1]?.path ?? null;
    return raw ? normalizeSandboxFilePath(raw) : null;
  }, [selectedPath, changedFiles]);

  useEffect(() => {
    const latest = changedFiles[changedFiles.length - 1];
    if (changedFiles.length > 0 && !selectedPath && latest) {
      onSelectedPathChange(latest.path);
    }
  }, [changedFiles, selectedPath, onSelectedPathChange]);

  const loadFile = useCallback(
    async (path: string) => {
      const normalized = normalizeSandboxFilePath(path);
      if (!normalized) {
        return;
      }
      if (contents[normalized] !== undefined && diffLines[normalized]) {
        return;
      }
      if (inFlightRef.current.has(normalized)) {
        return;
      }
      if (!canUseDevbox(task)) {
        setErrors((prev) => ({
          ...prev,
          [normalized]: "Available after devbox is running",
        }));
        return;
      }

      inFlightRef.current.add(normalized);
      setLoadingPaths((prev) => new Set(prev).add(normalized));
      try {
        const meta = changedFileByPath.get(normalized);
        const skipGitDiff =
          meta !== undefined && isAddedChangeType(meta.changeType);
        const needRead = contents[normalized] === undefined;
        const needDiff = !diffLines[normalized] && !skipGitDiff;

        let content = contents[normalized];
        if (needRead) {
          const readResult = await readTaskFile(task.id, normalized);
          content = readResult.content;
          setContents((prev) => ({ ...prev, [normalized]: content }));
          onFileLineCount?.(normalized, content.split("\n").length);
        }

        if (!diffLines[normalized]) {
          if (skipGitDiff && content) {
            setDiffLines((prev) => ({
              ...prev,
              [normalized]: syntheticAddedDiff(content),
            }));
          } else if (needDiff) {
            try {
              const diffResult = await runTaskTerminal(
                task.id,
                buildFileDiffCommand(normalized),
                "repo",
              );
              const raw = diffResult.stdout.trim();
              let parsed = raw ? parseUnifiedDiff(raw) : [];
              const hasHunkLines = parsed.some(
                (line) =>
                  line.kind === "add" ||
                  line.kind === "remove" ||
                  line.kind === "context",
              );
              if (!hasHunkLines && content) {
                parsed = syntheticAddedDiff(content);
              }
              setDiffLines((prev) => ({ ...prev, [normalized]: parsed }));
            } catch {
              if (content) {
                setDiffLines((prev) => ({
                  ...prev,
                  [normalized]: syntheticAddedDiff(content),
                }));
              }
            }
          }
        }

        setErrors((prev) => {
          const next = { ...prev };
          delete next[normalized];
          return next;
        });
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [normalized]:
            error instanceof Error ? error.message : "Could not load file",
        }));
      } finally {
        inFlightRef.current.delete(normalized);
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(normalized);
          return next;
        });
      }
    },
    [changedFileByPath, contents, diffLines, onFileLineCount, task],
  );

  useEffect(() => {
    if (workspaceTab !== "changes") {
      return;
    }
    for (const file of changedFiles) {
      void loadFile(file.path);
    }
  }, [workspaceTab, changedFiles, loadFile]);

  const filteredGroups = useMemo(() => {
    const q = fileSearch.trim().toLowerCase();
    if (!q) return grouped;
    return grouped
      .map((group) => ({
        ...group,
        files: group.files.filter(
          (f) =>
            f.path.toLowerCase().includes(q) ||
            fileDisplayName(f.path).toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.files.length > 0);
  }, [grouped, fileSearch]);

  const toggleCollapsed = (path: string) => {
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-[#0d0d0d] lg:min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-0 border-b border-white/[0.06] px-4 py-2">
          <TabButton
            active={workspaceTab === "progress"}
            onClick={() => onWorkspaceTabChange("progress")}
            label="Progress"
          />
          <TabButton
            active={workspaceTab === "changes"}
            onClick={() => onWorkspaceTabChange("changes")}
            label="Changes"
          />
          <TabButton
            active={workspaceTab === "desktop"}
            onClick={() => onWorkspaceTabChange("desktop")}
            label="Desktop"
          />
          <button
            type="button"
            className="ml-1 rounded-md p-1.5 text-zinc-600 hover:bg-white/[0.04] hover:text-zinc-400"
            aria-label="New tab"
          >
            <Plus className="size-4" />
          </button>
          {isActive ? (
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-zinc-500">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </span>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden bg-[#0d0d0d]">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {workspaceTab === "progress" ? (
              <ProgressPanel lines={activityLines} isActive={isActive} />
            ) : null}
            {workspaceTab === "changes" ? (
              <ChangesStackPanel
                files={changedFiles}
                contents={contents}
                diffLines={diffLines}
                loadingPaths={loadingPaths}
                errors={errors}
                highlightPath={effectivePath}
                collapsedPaths={collapsedPaths}
                onToggleCollapsed={toggleCollapsed}
                onSelectPath={(path) => {
                  onSelectedPathChange(path);
                  onWorkspaceTabChange("changes");
                  setCollapsedPaths((prev) => {
                    const next = new Set(prev);
                    next.delete(path);
                    return next;
                  });
                }}
              />
            ) : null}
            {workspaceTab === "desktop" ? (
              <div className="flex h-full min-h-0 flex-col p-3">
                <DevboxWorkspace
                  task={task}
                  onTaskChange={onTaskChange}
                  layout="panel"
                  defaultTab="browser"
                />
              </div>
            ) : null}
          </div>

          {workspaceTab === "changes" ? (
            <aside className="flex w-[210px] shrink-0 flex-col border-l border-white/[0.06] bg-[#0a0a0a]">
              <div className="shrink-0 border-b border-white/[0.06] p-2.5">
                <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#111] px-2 py-1.5">
                  <Search className="size-3.5 shrink-0 text-zinc-600" />
                  <input
                    value={fileSearch}
                    onChange={(e) => setFileSearch(e.target.value)}
                    placeholder="Search files..."
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-300 outline-none placeholder:text-zinc-600"
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-zinc-600 hover:text-zinc-400"
                    aria-label="Filter files"
                  >
                    <ListFilter className="size-3.5" />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {changedFiles.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-zinc-600">
                    Files appear as the agent edits the repo.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {filteredGroups.map((group) => (
                      <div key={group.folder || "root"}>
                        <div className="mb-1 flex items-center gap-1.5 px-1 py-0.5">
                          <Folder className="size-3 text-zinc-600" />
                          <p className="truncate font-mono text-[11px] text-zinc-400">
                            {group.folder || "project"}
                          </p>
                        </div>
                        <ul className="space-y-0.5">
                          {group.files.map((file) => (
                            <li key={file.path}>
                              <FileTreeRow
                                file={file}
                                active={effectivePath === file.path}
                                onSelect={() => {
                                  onSelectedPathChange(file.path);
                                  onWorkspaceTabChange("changes");
                                  setCollapsedPaths((prev) => {
                                    const next = new Set(prev);
                                    next.delete(file.path);
                                    return next;
                                  });
                                }}
                              />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
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
        "cursor-pointer rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
        active ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

function FileTreeRow({
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

function TreeStatusBadge({ changeType }: { changeType: string }) {
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

function ProgressPanel({
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
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="flex items-center gap-2 text-[12px] text-zinc-600">
            <Sparkles className="size-3.5" />
            {isActive ? "Waiting for agent steps…" : "No progress recorded."}
          </p>
        ) : (
          filtered.map((line, index) => (
            <p
              key={`${index}-${line.slice(0, 24)}`}
              className="text-[12px] leading-relaxed text-zinc-400"
            >
              {line}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function ChangesStackPanel({
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
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Monitor className="size-8 text-zinc-700" />
        <p className="text-[13px] text-zinc-500">No changes yet</p>
        <p className="max-w-sm text-[12px] text-zinc-600">
          File diffs will appear here as the agent edits the repo.
        </p>
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

function CopyFileButton({ content }: { content: string | undefined }) {
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
