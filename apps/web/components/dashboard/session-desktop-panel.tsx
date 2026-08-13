"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
import type { Task } from "@devin/types";
import { tasksApiUrl } from "@/lib/api/http";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

type DesktopView = "live" | "snapshot" | "interactive" | "recording";

async function blobLooksLikePng(blob: Blob): Promise<boolean> {
  if (blob.type.includes("image")) {
    return true;
  }
  const header = await blob.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(header);
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

export function SessionDesktopPanel({
  task,
  layout = "panel",
  externalRefreshKey = 0,
  onOpenDesktop,
}: {
  task: Task;
  layout?: "panel" | "embed";
  externalRefreshKey?: number;
  onOpenDesktop?: () => void;
}) {
  const canUse = canUseDevbox(task);
  const screenshotSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-screenshot`,
  );
  const livePreviewBase = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/devbox-preview?path=/`,
  );
  const buildLivePreviewSrc = useCallback(
    (warm: boolean) => `${livePreviewBase}${warm ? "&warm=1" : ""}`,
    [livePreviewBase],
  );
  const interactiveSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-vnc`,
  );
  const recordingSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/session-recording`,
  );

  const [view, setView] = useState<DesktopView>("snapshot");
  const [liveReachable, setLiveReachable] = useState(false);
  const [liveWarming, setLiveWarming] = useState(false);
  const [shotError, setShotError] = useState(false);
  const [shotErrorDetail, setShotErrorDetail] = useState<string | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const shotUrlRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const freshInFlightRef = useRef(false);
  const autoFreshDoneRef = useRef(false);
  const freshRetryCountRef = useRef(0);
  const freshRetryTimerRef = useRef<number | null>(null);
  const captureExhaustedRef = useRef(false);
  const previewFailCountRef = useRef(0);
  const previewBackoffUntilRef = useRef(0);
  const [livePreviewError, setLivePreviewError] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState(false);
  const [interactiveReady, setInteractiveReady] = useState(false);
  shotUrlRef.current = shotUrl;

  const isAgentActive =
    task.status === "running" ||
    task.status === "runtime_ready" ||
    task.status === "sandbox_starting" ||
    task.status === "drafting" ||
    task.status === "scheduling" ||
    task.status === "awaiting_review";

  const isTerminal =
    task.status === "completed" || task.status === "awaiting_review";

  const clearFreshRetryTimer = useCallback(() => {
    if (freshRetryTimerRef.current !== null) {
      window.clearTimeout(freshRetryTimerRef.current);
      freshRetryTimerRef.current = null;
    }
  }, []);

  const probeLivePreview = useCallback(
    async (warm = false) => {
      if (!canUse) {
        setLiveReachable(false);
        return false;
      }
      if (Date.now() < previewBackoffUntilRef.current) {
        return false;
      }
      setLiveWarming(true);
      setLivePreviewError(null);
      try {
        const response = await fetch(buildLivePreviewSrc(warm), {
          method: "GET",
          credentials: "include",
          signal: AbortSignal.timeout(120_000),
        });
        if (response.status === 504) {
          setLiveReachable(false);
          return false;
        }
        if (response.status === 404) {
          const body = (await response.clone().text()).slice(0, 200);
          if (/no live devbox session/i.test(body)) {
            previewFailCountRef.current += 1;
            const delays = [30_000, 60_000, 120_000];
            const delay =
              delays[
                Math.min(previewFailCountRef.current - 1, delays.length - 1)
              ] ?? 120_000;
            previewBackoffUntilRef.current = Date.now() + delay;
            if (previewFailCountRef.current >= 3) {
              setLivePreviewError(
                "Worker lost devbox session — refresh or start a new task.",
              );
            }
          }
          setLiveReachable(false);
          return false;
        }
        const reachable =
          response.ok &&
          !/404 page not found/i.test(
            (await response.clone().text()).slice(0, 80),
          );
        if (reachable) {
          previewFailCountRef.current = 0;
          previewBackoffUntilRef.current = 0;
        }
        setLiveReachable(reachable);
        if (reachable && layout === "panel") {
          setView("live");
        }
        return reachable;
      } catch {
        setLiveReachable(false);
        return false;
      } finally {
        setLiveWarming(false);
      }
    },
    [buildLivePreviewSrc, canUse, layout],
  );

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

  const openInteractive = useCallback(() => {
    setView("interactive");
    setInteractiveReady(true);
  }, []);

  const scheduleFreshRetry = useCallback(
    (loadFn: (fresh: boolean) => Promise<void>) => {
      if (
        shotUrlRef.current ||
        freshRetryCountRef.current >= 3 ||
        captureExhaustedRef.current
      ) {
        return;
      }
      clearFreshRetryTimer();
      setRetryPending(true);
      freshRetryTimerRef.current = window.setTimeout(() => {
        setRetryPending(false);
        freshRetryCountRef.current += 1;
        if (freshRetryCountRef.current >= 3) {
          captureExhaustedRef.current = true;
        }
        void loadFn(true);
      }, 30_000);
    },
    [clearFreshRetryTimer],
  );

  const loadScreenshot = useCallback(
    async (fresh: boolean) => {
      if (!canUse) {
        return;
      }
      if (inFlightRef.current) {
        if (!fresh || freshInFlightRef.current) {
          return;
        }
      }

      inFlightRef.current = true;
      if (fresh) {
        freshInFlightRef.current = true;
      }
      setShotError(false);
      setShotErrorDetail(null);
      setRetryPending(false);
      if (!shotUrlRef.current) {
        setShotLoading(true);
      }

      const controller = new AbortController();
      const timeoutMs = fresh ? 180_000 : 25_000;
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      const freshQuery = fresh ? "&fresh=1" : "";
      const url = `${screenshotSrc}?t=${Date.now()}${freshQuery}`;

      try {
        const response = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          if (
            response.status === 503 &&
            !captureExhaustedRef.current &&
            (isAgentActive || (isTerminal && fresh && !shotUrlRef.current))
          ) {
            setShotError(false);
            if (isTerminal && fresh) {
              scheduleFreshRetry(loadScreenshot);
            }
            return;
          }
          throw new Error(`snapshot HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (!(await blobLooksLikePng(blob))) {
          throw new Error("snapshot is not an image");
        }
        setShotUrl((prev) => {
          if (prev?.startsWith("blob:")) {
            URL.revokeObjectURL(prev);
          }
          return URL.createObjectURL(blob);
        });
        setShotError(false);
        setShotErrorDetail(null);
        freshRetryCountRef.current = 0;
        captureExhaustedRef.current = false;
        clearFreshRetryTimer();
        setRetryPending(false);
        void probeLivePreview(false);
      } catch (error) {
        if (!shotUrlRef.current) {
          const captureExpected =
            !captureExhaustedRef.current &&
            (isAgentActive ||
              (isTerminal && fresh && freshRetryCountRef.current < 3));
          if (captureExpected) {
            setShotError(false);
            if (isTerminal && fresh) {
              scheduleFreshRetry(loadScreenshot);
            }
          } else {
            setShotError(true);
            captureExhaustedRef.current = true;
            if (error instanceof DOMException && error.name === "AbortError") {
              setShotErrorDetail(
                fresh
                  ? "Capture timed out — the app may still be building. Try Refresh again."
                  : "Snapshot request timed out — try Refresh.",
              );
            } else if (
              error instanceof Error &&
              error.message.startsWith("snapshot HTTP 503")
            ) {
              setShotErrorDetail(
                "Could not capture localhost yet — click Refresh to start the app and retry.",
              );
            } else if (error instanceof Error && error.message.length > 0) {
              setShotErrorDetail(error.message);
            }
          }
        }
      } finally {
        window.clearTimeout(timeout);
        inFlightRef.current = false;
        if (fresh) {
          freshInFlightRef.current = false;
        }
        if (!shotUrlRef.current) {
          const waitingForRetry = freshRetryTimerRef.current !== null;
          const stillCapturing =
            !captureExhaustedRef.current &&
            !waitingForRetry &&
            (freshInFlightRef.current ||
              isAgentActive ||
              (isTerminal && freshRetryCountRef.current < 3));
          setShotLoading(stillCapturing);
        } else {
          setShotLoading(false);
        }
      }
    },
    [
      canUse,
      clearFreshRetryTimer,
      isAgentActive,
      isTerminal,
      probeLivePreview,
      scheduleFreshRetry,
      screenshotSrc,
    ],
  );

  const refreshScreenshot = useCallback(
    (fresh = true) => {
      freshRetryCountRef.current = 0;
      captureExhaustedRef.current = false;
      clearFreshRetryTimer();
      previewFailCountRef.current = 0;
      previewBackoffUntilRef.current = 0;
      setLivePreviewError(null);
      void loadScreenshot(fresh);
      void probeLivePreview(true);
    },
    [clearFreshRetryTimer, loadScreenshot, probeLivePreview],
  );

  useEffect(() => {
    if (externalRefreshKey > 0) {
      freshRetryCountRef.current = 0;
      captureExhaustedRef.current = false;
      clearFreshRetryTimer();
      void loadScreenshot(false).then(() => {
        if (!shotUrlRef.current) {
          void loadScreenshot(true);
        }
      });
      void probeLivePreview(false);
    }
  }, [
    externalRefreshKey,
    clearFreshRetryTimer,
    loadScreenshot,
    probeLivePreview,
  ]);

  useEffect(() => {
    if (!canUse) {
      return;
    }
    autoFreshDoneRef.current = false;
    freshRetryCountRef.current = 0;
    captureExhaustedRef.current = false;
    void probeLivePreview(false);
    void loadScreenshot(false).then(() => {
      if (
        !autoFreshDoneRef.current &&
        !shotUrlRef.current &&
        (task.status === "completed" || task.status === "awaiting_review")
      ) {
        autoFreshDoneRef.current = true;
        void loadScreenshot(true);
      }
    });
  }, [canUse, loadScreenshot, probeLivePreview, task.id, task.status]);

  useEffect(() => {
    if (!canUse) {
      return;
    }
    const interval = setInterval(
      () => {
        if (inFlightRef.current || freshInFlightRef.current) {
          return;
        }
        void loadScreenshot(false);
        void probeLivePreview(false);
      },
      isAgentActive ? 8_000 : 20_000,
    );
    return () => clearInterval(interval);
  }, [canUse, isAgentActive, loadScreenshot, probeLivePreview]);

  useEffect(() => {
    if (view === "recording" && isTerminal) {
      void loadRecording();
    }
  }, [isTerminal, loadRecording, view]);

  useEffect(() => {
    if (layout === "panel" && liveReachable && view === "snapshot") {
      setView("live");
    }
  }, [layout, liveReachable, view]);

  const openLivePreview = useCallback(async () => {
    previewFailCountRef.current = 0;
    previewBackoffUntilRef.current = 0;
    setLivePreviewError(null);
    setView("live");
    const ok = await probeLivePreview(true);
    if (!ok) {
      setView("snapshot");
      refreshScreenshot(true);
    }
  }, [probeLivePreview, refreshScreenshot]);

  useEffect(() => {
    return () => {
      clearFreshRetryTimer();
      if (shotUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(shotUrl);
      }
      if (recordingUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(recordingUrl);
      }
    };
  }, [clearFreshRetryTimer, recordingUrl, shotUrl]);

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
  const captureInProgress =
    shotLoading && !shotUrl && (isAgentActive || isTerminal);
  const showLive = layout === "panel" && view === "live" && liveReachable;
  const showInteractive = layout === "panel" && view === "interactive";
  const showRecording = layout === "panel" && view === "recording";

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
            {isEmbed ? "App preview" : "Desktop"}
          </p>
          <p className="truncate text-[10px] text-zinc-600">
            {showInteractive
              ? "Full VM desktop — mouse & keyboard (1024×768)"
              : showRecording
                ? "Annotated screen recording from agent session"
                : showLive
                  ? "Live localhost in the devbox (1024×768)"
                  : "Playwright snapshot from localhost"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isEmbed ? (
            <div className="mr-1 flex rounded-lg border border-white/[0.08] bg-[#111] p-0.5">
              <button
                type="button"
                onClick={() => void openLivePreview()}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                  view === "live"
                    ? "bg-white/[0.08] text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                Live
              </button>
              <button
                type="button"
                onClick={openInteractive}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                  view === "interactive"
                    ? "bg-white/[0.08] text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                Interactive
              </button>
              <button
                type="button"
                onClick={() => setView("snapshot")}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors",
                  view === "snapshot"
                    ? "bg-white/[0.08] text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                Snapshot
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
          ) : null}
          <button
            type="button"
            onClick={() => refreshScreenshot(true)}
            disabled={shotLoading}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshCw
              className={cn("size-3.5", shotLoading && "animate-spin")}
            />
            Refresh
          </button>
        </div>
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center bg-[#0a0a0a]",
          isEmbed ? "min-h-[180px] p-2" : "p-0",
        )}
      >
        {showInteractive && interactiveReady ? (
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
        ) : showLive ? (
          <iframe
            key={`${task.id}-live-preview`}
            src={buildLivePreviewSrc(true)}
            title="Live app preview"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : view === "live" && (liveWarming || liveReachable === false) ? (
          <div className="flex flex-col items-center gap-2 p-6">
            <Loader2 className="size-6 animate-spin text-zinc-600" />
            <p className="max-w-sm text-center text-[12px] text-zinc-500">
              Starting app in the devbox for live preview…
            </p>
          </div>
        ) : (
          <>
            {captureInProgress ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="size-6 animate-spin text-zinc-600" />
                <p className="max-w-sm text-center text-[12px] text-zinc-500">
                  {isTerminal
                    ? "Starting app and capturing preview…"
                    : "Capturing desktop preview…"}
                </p>
              </div>
            ) : null}
            {livePreviewError ? (
              <p className="max-w-sm text-center text-[12px] text-amber-600/90">
                {livePreviewError}
              </p>
            ) : null}
            {retryPending && !shotUrl && !shotLoading ? (
              <p className="max-w-sm text-center text-[12px] text-zinc-500">
                App still starting — retrying capture shortly…
              </p>
            ) : null}
            {shotError && !shotUrl ? (
              <p className="max-w-sm text-center text-[12px] text-zinc-500">
                {shotErrorDetail ??
                  (task.sessionSleeping
                    ? "Waking devbox to load saved snapshot — try Refresh."
                    : "No desktop snapshot yet — click Refresh to start the app and capture localhost (1024×768).")}
              </p>
            ) : null}
            {shotUrl ? (
              <div className="relative flex h-full w-full items-start justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shotUrl}
                  alt="Sandbox app snapshot"
                  className={cn(
                    "rounded-lg border border-white/[0.08] object-contain object-top shadow-lg",
                    isEmbed
                      ? "max-h-[280px] w-full"
                      : "max-h-full w-full max-w-5xl",
                  )}
                />
                {shotLoading ? (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/35">
                    <Loader2 className="size-6 animate-spin text-zinc-200" />
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
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
