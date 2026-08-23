"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, ListFilter, Plus, Search } from "lucide-react";
import type { Task, TaskEvent } from "@devin/types";
import { SessionDesktopPanel } from "@/components/dashboard/session-desktop-panel";
import { readTaskFile, runTaskTerminal } from "@/lib/api/tasks";
import { canUseDevbox } from "@/lib/sessions/devbox";
import {
  type ChangedFile,
  extractChangedFiles,
  fileDisplayName,
  groupChangedFilesByFolder,
  isAddedChangeType,
  normalizeSandboxFilePath,
  progressActivityLines,
} from "@/lib/sessions/agent-activity";
import {
  buildFileDiffCommand,
  parseUnifiedDiff,
  syntheticAddedDiff,
  type DiffLine,
} from "@/lib/sessions/unified-diff";
import {
  TabButton,
  FileTreeRow,
  ProgressPanel,
  ChangesStackPanel,
} from "./session-code-helpers";
export type WorkspaceTab = "progress" | "changes" | "desktop";

interface SessionCodeColumnProps {
  task: Task;
  events: TaskEvent[];
  isActive: boolean;
  elapsedTime: string;
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
  elapsedTime,
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
          setContents((prev) => ({
            ...prev,
            [normalized]: readResult.content,
          }));
          onFileLineCount?.(normalized, readResult.content.split("\n").length);
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
        const raw =
          error instanceof Error ? error.message : "Could not load file";
        const friendly =
          /no devbox session|Cannot reach execution worker|rehydrate failed/i.test(
            raw,
          )
            ? "Devbox file proxy unavailable — wait until sandbox is running, then reopen Changes"
            : /no such file|ENOENT|HTTP 404/i.test(raw)
              ? "File not found in the sandbox yet"
              : raw;
        setErrors((prev) => ({
          ...prev,
          [normalized]: friendly,
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
    <div className="flex min-h-0 min-w-0 flex-1 bg-transparent lg:min-h-0">
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
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400 tabular-nums">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              Working… {elapsedTime}
            </span>
          ) : (
            <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">
              Worked {elapsedTime}
            </span>
          )}
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden bg-[#121212]/55">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {workspaceTab === "progress" ? (
              <ProgressPanel
                lines={activityLines}
                isActive={isActive}
                elapsedTime={elapsedTime}
              />
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
              <SessionDesktopPanel task={task} layout="panel" />
            ) : null}
          </div>

          {workspaceTab === "changes" ? (
            <aside className="flex w-[210px] shrink-0 flex-col border-l border-white/[0.06] bg-[#101010]/70">
              <div className="shrink-0 border-b border-white/[0.06] p-2.5">
                <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#171717]/90 px-2 py-1.5">
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
