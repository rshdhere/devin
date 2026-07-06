"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileCode2, Globe, Loader2, Play, Terminal } from "lucide-react";
import { MotionButton } from "@/components/dashboard/motion-button";
import {
  listTaskFiles,
  readTaskFile,
  runTaskTerminalStream,
  wakeSession,
  fetchTask,
} from "@/lib/api/tasks";
import type { Task } from "@devin/types";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

type WorkspaceTab = "shell" | "files" | "browser";

interface DevboxWorkspaceProps {
  task: Task;
  onTaskChange?: (task: Task) => void;
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export function DevboxWorkspace({ task, onTaskChange }: DevboxWorkspaceProps) {
  const canUse = canUseDevbox(task);

  const [tab, setTab] = useState<WorkspaceTab>("shell");
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);

  const handleWake = useCallback(async () => {
    setWaking(true);
    setWakeError(null);
    try {
      const updated = await wakeSession(task.id);
      onTaskChange?.(updated);
      void fetchTask(task.id)
        .then(onTaskChange)
        .catch(() => undefined);
    } catch (error) {
      setWakeError(error instanceof Error ? error.message : "Wake failed");
    } finally {
      setWaking(false);
    }
  }, [task.id]);

  if (!canUse) {
    return null;
  }

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0a0a0a]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#252525] px-4 py-2.5">
        <div className="flex items-center gap-1">
          <WorkspaceTabButton
            active={tab === "shell"}
            onClick={() => setTab("shell")}
            icon={Terminal}
            label="Shell"
          />
          <WorkspaceTabButton
            active={tab === "files"}
            onClick={() => setTab("files")}
            icon={FileCode2}
            label="Files"
          />
          <WorkspaceTabButton
            active={tab === "browser"}
            onClick={() => setTab("browser")}
            icon={Globe}
            label="Browser"
          />
        </div>
        {task.sessionSleeping ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-amber-300">Devbox sleeping</span>
            <MotionButton
              type="button"
              onClick={() => void handleWake()}
              disabled={waking}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-100 hover:bg-amber-500/20 disabled:opacity-60"
            >
              {waking ? <Loader2 className="size-3 animate-spin" /> : null}
              Wake devbox
            </MotionButton>
          </div>
        ) : null}
      </div>

      {wakeError ? (
        <p className="border-b border-[#252525] px-4 py-2 text-[12px] text-red-300">
          {wakeError}
        </p>
      ) : null}

      {tab === "shell" ? (
        <InteractiveShell taskId={task.id} disabled={task.sessionSleeping} />
      ) : null}
      {tab === "files" ? (
        <FileExplorer taskId={task.id} disabled={task.sessionSleeping} />
      ) : null}
      {tab === "browser" ? <BrowserPanel task={task} /> : null}
    </div>
  );
}

function WorkspaceTabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Terminal;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
        active
          ? "bg-[#1f1f1f] text-gray-100"
          : "text-gray-500 hover:bg-[#151515] hover:text-gray-300",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function InteractiveShell({
  taskId,
  disabled,
}: {
  taskId: string;
  disabled?: boolean;
}) {
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const runCommand = useCallback(async () => {
    const trimmed = command.trim();
    if (!trimmed || disabled) {
      return;
    }

    setRunning(true);
    setLines((prev) => [...prev, `$ ${trimmed}`]);

    try {
      await runTaskTerminalStream(taskId, trimmed, (event) => {
        if (event.type === "terminal.output") {
          const prefix = event.data.stream === "stderr" ? "[stderr] " : "";
          setLines((prev) => [...prev, `${prefix}${event.data.line}`]);
        }
        if (event.type === "terminal.done") {
          if (event.data.exitCode !== 0) {
            setLines((prev) => [...prev, `[exit ${event.data.exitCode}]`]);
          }
        }
        if (event.type === "terminal.error") {
          setLines((prev) => [...prev, `[error] ${event.data.error}`]);
        }
      });
    } catch (error) {
      setLines((prev) => [
        ...prev,
        error instanceof Error ? error.message : "Command failed",
      ]);
    } finally {
      setRunning(false);
      setCommand("");
    }
  }, [command, disabled, taskId]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="flex flex-col">
      <div
        ref={outputRef}
        className="max-h-[320px] min-h-[180px] overflow-auto p-3 font-mono text-[12px] leading-relaxed text-green-400"
      >
        {lines.length === 0 ? (
          <p className="text-gray-600">
            Run shell commands in the live devbox (repo cwd).
          </p>
        ) : (
          lines.map((line, index) => (
            <div
              key={`${index}-${line.slice(0, 24)}`}
              className="whitespace-pre-wrap"
            >
              {line}
            </div>
          ))
        )}
      </div>
      <div className="flex gap-2 border-t border-[#252525] p-3">
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void runCommand();
            }
          }}
          disabled={disabled || running}
          placeholder={
            disabled ? "Wake devbox to run commands…" : "Enter command…"
          }
          className="min-w-0 flex-1 rounded-lg border border-[#333] bg-[#111] px-3 py-2 font-mono text-[12px] text-gray-200 outline-none placeholder:text-gray-600 focus:border-[#444] disabled:opacity-60"
        />
        <MotionButton
          type="button"
          onClick={() => void runCommand()}
          disabled={disabled || running || !command.trim()}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-[12px] text-green-200 hover:bg-green-500/20 disabled:opacity-60"
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          Run
        </MotionButton>
      </div>
    </div>
  );
}

function FileExplorer({
  taskId,
  disabled,
}: {
  taskId: string;
  disabled?: boolean;
}) {
  const [path, setPath] = useState("repo");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (nextPath: string) => {
      if (disabled) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await listTaskFiles(taskId, nextPath);
        setPath(result.path);
        setEntries(result.items);
        setSelected(null);
        setContent("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to list files");
      } finally {
        setLoading(false);
      }
    },
    [disabled, taskId],
  );

  useEffect(() => {
    void loadDir("repo");
  }, [loadDir]);

  const openFile = useCallback(
    async (entry: FileEntry) => {
      if (entry.isDir) {
        void loadDir(entry.path);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const file = await readTaskFile(taskId, entry.path);
        setSelected(entry.path);
        setContent(file.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to read file");
      } finally {
        setLoading(false);
      }
    },
    [loadDir, taskId],
  );

  return (
    <div className="grid min-h-[280px] grid-cols-1 md:grid-cols-2">
      <div className="border-b border-[#252525] md:border-r md:border-b-0 md:border-[#252525]">
        <div className="flex items-center justify-between border-b border-[#252525] px-3 py-2">
          <span className="truncate font-mono text-[11px] text-gray-500">
            /workspace/{path}
          </span>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-gray-500" />
          ) : null}
        </div>
        <div className="max-h-[240px] overflow-auto p-2">
          {disabled ? (
            <p className="px-2 py-3 text-[12px] text-gray-600">
              Wake devbox to browse files.
            </p>
          ) : error ? (
            <p className="px-2 py-3 text-[12px] text-red-300">{error}</p>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void openFile(entry)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-[#151515]",
                  selected === entry.path
                    ? "bg-[#1a1a1a] text-indigo-200"
                    : "text-gray-300",
                )}
              >
                <span className="truncate font-mono">
                  {entry.isDir ? `${entry.name}/` : entry.name}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="max-h-[280px] overflow-auto p-3">
        {selected ? (
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-gray-300">
            {content}
          </pre>
        ) : (
          <p className="text-[12px] text-gray-600">Select a file to preview.</p>
        )}
      </div>
    </div>
  );
}

function BrowserPanel({ task }: { task: Task }) {
  const previewUrl = task.previewUrl;

  if (!previewUrl) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-gray-500">
        No preview URL yet. When the agent deploys a preview, it will appear
        here in an embedded browser panel.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-[#252525] px-4 py-2">
        <span className="truncate text-[12px] text-gray-400">{previewUrl}</span>
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-indigo-300 hover:text-indigo-200"
        >
          Open tab
        </a>
      </div>
      <iframe
        title="Devbox preview"
        src={previewUrl}
        className="h-[360px] w-full bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
