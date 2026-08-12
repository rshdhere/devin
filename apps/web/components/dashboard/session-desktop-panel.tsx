"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
import type { Task } from "@devin/types";
import { tasksApiUrl } from "@/lib/api/http";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

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
}: {
  task: Task;
  layout?: "panel" | "embed";
  externalRefreshKey?: number;
}) {
  const canUse = canUseDevbox(task);
  const screenshotSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-screenshot`,
  );

  const [shotError, setShotError] = useState(false);
  const [shotErrorDetail, setShotErrorDetail] = useState<string | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const shotUrlRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const freshInFlightRef = useRef(false);
  const autoFreshDoneRef = useRef(false);
  const freshRetryCountRef = useRef(0);
  const freshRetryTimerRef = useRef<number | null>(null);
  const captureExhaustedRef = useRef(false);
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
      freshRetryTimerRef.current = window.setTimeout(() => {
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
      setShotLoading(true);

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
          const stillCapturing =
            !captureExhaustedRef.current &&
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
      scheduleFreshRetry,
      screenshotSrc,
    ],
  );

  const refreshScreenshot = useCallback(
    (fresh = true) => {
      freshRetryCountRef.current = 0;
      captureExhaustedRef.current = false;
      clearFreshRetryTimer();
      void loadScreenshot(fresh);
    },
    [clearFreshRetryTimer, loadScreenshot],
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
    }
  }, [externalRefreshKey, clearFreshRetryTimer, loadScreenshot]);

  useEffect(() => {
    if (!canUse) {
      return;
    }
    autoFreshDoneRef.current = false;
    freshRetryCountRef.current = 0;
    captureExhaustedRef.current = false;
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
  }, [canUse, loadScreenshot, task.id, task.status]);

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
      },
      isAgentActive ? 8_000 : 20_000,
    );
    return () => clearInterval(interval);
  }, [canUse, isAgentActive, loadScreenshot]);

  useEffect(() => {
    return () => {
      clearFreshRetryTimer();
      if (shotUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(shotUrl);
      }
    };
  }, [clearFreshRetryTimer, shotUrl]);

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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        isEmbed ? "min-h-[200px]" : "h-full",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          Sandbox snapshot (Playwright capture from localhost in the devbox)
        </span>
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

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center bg-[#0a0a0a]",
          isEmbed ? "min-h-[180px] p-2" : "p-4",
        )}
      >
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
        {shotError && !shotUrl ? (
          <p className="max-w-sm text-center text-[12px] text-zinc-500">
            {shotErrorDetail ??
              (task.sessionSleeping
                ? "Waking devbox to load saved snapshot — try Refresh."
                : "No desktop snapshot yet — click Refresh to start the app and capture localhost (1024×768).")}
          </p>
        ) : null}
        {shotUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={shotUrl}
            alt="Sandbox app snapshot"
            className={cn(
              "rounded-lg border border-white/[0.08] object-contain object-top shadow-lg",
              isEmbed ? "max-h-[280px] w-full" : "max-h-full w-full max-w-5xl",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
