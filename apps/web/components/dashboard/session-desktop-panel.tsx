"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import type { Task } from "@devin/types";
import { tasksApiUrl } from "@/lib/api/http";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

type DesktopView = "interactive" | "recording";

export function SessionDesktopPanel({
  task,
  layout = "panel",
  onOpenDesktop,
}: {
  task: Task;
  layout?: "panel" | "embed";
  /** @deprecated No longer used — snapshots were removed. */
  externalRefreshKey?: number;
  onOpenDesktop?: () => void;
}) {
  const canUse = canUseDevbox(task);
  const interactiveSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-vnc`,
  );
  const recordingSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/session-recording`,
  );

  const isTerminal =
    task.status === "completed" || task.status === "awaiting_review";

  const [view, setView] = useState<DesktopView>("interactive");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState(false);

  const loadRecording = useCallback(async () => {
    if (!canUse) {
      return;
    }
    try {
      const response = await fetch(`${recordingSrc}?t=${Date.now()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        setRecordingError(true);
        return;
      }
      const blob = await response.blob();
      if (blob.size < 1024) {
        setRecordingError(true);
        return;
      }
      setRecordingUrl((prev) => {
        if (prev?.startsWith("blob:")) {
          URL.revokeObjectURL(prev);
        }
        return URL.createObjectURL(blob);
      });
      setRecordingError(false);
    } catch {
      setRecordingError(true);
    }
  }, [canUse, recordingSrc]);

  useEffect(() => {
    if (view === "recording" && isTerminal) {
      void loadRecording();
    }
  }, [isTerminal, loadRecording, view]);

  useEffect(() => {
    return () => {
      if (recordingUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(recordingUrl);
      }
    };
  }, [recordingUrl]);

  if (!canUse) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <Monitor className="size-8 text-zinc-700" />
        <p className="text-[13px] text-zinc-500">
          Desktop preview unlocks with the devbox.
        </p>
      </div>
    );
  }

  const isEmbed = layout === "embed";
  const showRecording = !isEmbed && view === "recording";
  const showInteractive = !showRecording;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        isEmbed ? "min-h-[200px]" : "h-full",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-medium text-zinc-300">
            {isEmbed ? "Desktop" : "Desktop"}
          </p>
          <p className="truncate text-[10px] text-zinc-600">
            {showRecording
              ? "Annotated screen recording from agent session"
              : "Full VM desktop — mouse and keyboard (1024×768)"}
          </p>
        </div>
        {!isEmbed ? (
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex rounded-lg border border-white/[0.08] bg-[#111] p-0.5">
              <button
                type="button"
                onClick={() => setView("interactive")}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                  view === "interactive"
                    ? "bg-white/[0.08] text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                Interactive
              </button>
              {isTerminal ? (
                <button
                  type="button"
                  onClick={() => {
                    setView("recording");
                    void loadRecording();
                  }}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                    view === "recording"
                      ? "bg-white/[0.08] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  Recording
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center bg-[#0a0a0a]",
          isEmbed ? "min-h-[180px] p-2" : "p-0",
        )}
      >
        {showInteractive ? (
          <iframe
            key={interactiveSrc}
            src={interactiveSrc}
            title="Interactive devbox desktop"
            className="h-full w-full border-0 bg-black"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : showRecording ? (
          recordingUrl ? (
            <video
              src={recordingUrl}
              controls
              className="max-h-full w-full max-w-5xl rounded-lg border border-white/[0.08] bg-black"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 p-6">
              <Loader2
                className={cn(
                  "size-6 text-zinc-600",
                  !recordingError && "animate-spin",
                )}
              />
              <p className="max-w-sm text-center text-[12px] text-zinc-500">
                {recordingError
                  ? "No session recording yet — recordings are saved when the agent finishes."
                  : "Loading session recording…"}
              </p>
            </div>
          )
        ) : null}
      </div>

      {isEmbed && onOpenDesktop ? (
        <button
          type="button"
          onClick={onOpenDesktop}
          className="mx-3 mt-1 mb-3 flex w-[calc(100%-1.5rem)] cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#141414] py-2 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-[#1a1a1a]"
        >
          <Monitor className="size-4 text-zinc-400" />
          Open Desktop
        </button>
      ) : null}
    </div>
  );
}
