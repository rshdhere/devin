"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
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
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveError, setInteractiveError] = useState<string | null>(null);
  const [interactiveReady, setInteractiveReady] = useState(false);

  const prepareInteractive = useCallback(async () => {
    if (!canUse) {
      return;
    }
    setInteractiveLoading(true);
    setInteractiveError(null);
    setInteractiveReady(false);
    try {
      const response = await fetch(interactiveSrc, {
        credentials: "include",
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 504) {
        setInteractiveError(
          "Devbox is still starting — try again in a moment.",
        );
        return;
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        setInteractiveError(
          body.trim() ||
            `Desktop unavailable (HTTP ${response.status}). Wake the devbox or retry.`,
        );
        return;
      }
      setInteractiveReady(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setInteractiveError(
          "Desktop connection timed out — the devbox may still be booting.",
        );
      } else {
        setInteractiveError(
          error instanceof Error
            ? error.message
            : "Could not connect to desktop",
        );
      }
    } finally {
      setInteractiveLoading(false);
    }
  }, [canUse, interactiveSrc]);

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
    if (view === "interactive" && canUse) {
      void prepareInteractive();
    }
  }, [canUse, prepareInteractive, task.id, view]);

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
            Desktop
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
            {showInteractive ? (
              <button
                type="button"
                onClick={() => void prepareInteractive()}
                disabled={interactiveLoading}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
              >
                <RefreshCw
                  className={cn(
                    "size-3.5",
                    interactiveLoading && "animate-spin",
                  )}
                />
                Retry
              </button>
            ) : null}
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
          interactiveReady ? (
            <iframe
              key={`${task.id}-${interactiveSrc}`}
              src={interactiveSrc}
              title="Interactive devbox desktop"
              className="h-full w-full border-0 bg-black"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 p-6">
              <Loader2
                className={cn(
                  "size-6 text-zinc-600",
                  interactiveLoading && "animate-spin",
                )}
              />
              <p className="max-w-sm text-center text-[12px] text-zinc-500">
                {interactiveError ??
                  (interactiveLoading
                    ? "Starting interactive desktop…"
                    : "Preparing desktop…")}
              </p>
              {interactiveError && isEmbed ? (
                <button
                  type="button"
                  onClick={() => void prepareInteractive()}
                  className="mt-1 rounded-md border border-white/[0.08] px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.04]"
                >
                  Retry
                </button>
              ) : null}
            </div>
          )
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
