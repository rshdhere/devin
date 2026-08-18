"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
import type { Task } from "@devin/types";
import { tasksApiUrl } from "@/lib/api/http";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

type DesktopView = "snapshot" | "interactive";

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

function isSnapshotNotReadyYet(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }
  return /^snapshot HTTP (404|503|504)$/.test(error.message);
}

function DesktopSnapshotAwaiting({
  compact,
  isActive,
}: {
  compact?: boolean;
  isActive: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex w-full flex-col items-center justify-center overflow-hidden",
        compact ? "min-h-[160px] px-4 py-8" : "min-h-[220px] px-6 py-12",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.06),transparent_62%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(ellipse at center, black 20%, transparent 72%)",
        }}
      />
      <div className="relative flex flex-col items-center gap-3">
        <div className="relative rounded-2xl border border-white/[0.1] bg-[#121212]/90 p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-sm">
          <div className="relative flex h-16 w-24 items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-[#0b0b0b]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.08),transparent_55%)]" />
            <Monitor
              className="relative size-6 text-zinc-500"
              strokeWidth={1.5}
            />
            <div className="absolute inset-x-3 bottom-2 h-px overflow-hidden rounded-full bg-emerald-950/80">
              <div className="desktop-await-progress h-full w-2/5 rounded-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
            </div>
          </div>
          <div className="mx-auto mt-2 h-1 w-8 rounded-full bg-white/[0.08]" />
          <div className="mx-auto mt-1 h-0.5 w-12 rounded-full bg-white/[0.05]" />
        </div>

        <div className="space-y-1 text-center">
          <p className="text-[12px] font-medium tracking-wide text-zinc-300">
            {isActive ? "Preparing desktop" : "Waiting for desktop"}
          </p>
          <p className="max-w-[220px] text-[10px] leading-relaxed text-zinc-600">
            {isActive
              ? "First snapshot appears once the sandbox boots."
              : "No frame yet — refresh after the session wakes."}
          </p>
        </div>
      </div>
    </div>
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
  const interactiveSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-vnc`,
  );

  const isAgentActive =
    task.status === "running" ||
    task.status === "runtime_ready" ||
    task.status === "sandbox_starting" ||
    task.status === "drafting" ||
    task.status === "scheduling" ||
    task.status === "awaiting_review";

  const [view, setView] = useState<DesktopView>("snapshot");
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const [shotError, setShotError] = useState<string | null>(null);
  const [interactiveLoading, setInteractiveLoading] = useState(false);
  const [interactiveError, setInteractiveError] = useState<string | null>(null);
  const [interactiveReady, setInteractiveReady] = useState(false);
  const shotUrlRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  shotUrlRef.current = shotUrl;

  const loadScreenshot = useCallback(
    async (fresh: boolean) => {
      if (!canUse || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      if (!shotUrlRef.current) {
        setShotLoading(true);
      }
      setShotError(null);
      try {
        const freshQuery = fresh ? "&fresh=1" : "";
        const response = await fetch(
          `${screenshotSrc}?t=${Date.now()}${freshQuery}`,
          {
            credentials: "include",
            signal: AbortSignal.timeout(fresh ? 180_000 : 25_000),
          },
        );
        if (!response.ok) {
          throw new Error(`snapshot HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (!(await blobLooksLikePng(blob))) {
          throw new Error("snapshot is not an image");
        }
        const nextUrl = URL.createObjectURL(blob);
        setShotUrl((prev) => {
          if (prev?.startsWith("blob:")) {
            URL.revokeObjectURL(prev);
          }
          return nextUrl;
        });
        setShotError(null);
      } catch (error) {
        if (!shotUrlRef.current) {
          // Early 404/503/timeouts are expected while the sandbox boots — keep the
          // calm awaiting UI instead of surfacing raw HTTP errors in chat.
          if (isSnapshotNotReadyYet(error)) {
            setShotError(null);
          } else {
            setShotError(
              error instanceof Error
                ? error.message
                : "Could not load snapshot",
            );
          }
        }
      } finally {
        inFlightRef.current = false;
        setShotLoading(false);
      }
    },
    [canUse, screenshotSrc],
  );

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

  useEffect(() => {
    if (!canUse || view !== "snapshot") {
      return;
    }
    void loadScreenshot(false);
  }, [canUse, loadScreenshot, task.id, view, externalRefreshKey]);

  useEffect(() => {
    if (!canUse || view !== "snapshot" || !isAgentActive) {
      return;
    }
    // Poll faster until the first frame lands, then settle into the normal cadence.
    const intervalMs = shotUrl ? 12_000 : 4_000;
    const timer = window.setInterval(() => {
      void loadScreenshot(false);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [canUse, isAgentActive, loadScreenshot, shotUrl, view]);

  useEffect(() => {
    if (view === "interactive" && canUse) {
      void prepareInteractive();
    }
  }, [canUse, prepareInteractive, task.id, view]);

  useEffect(() => {
    return () => {
      if (shotUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(shotUrlRef.current);
      }
    };
  }, []);

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
  const showSnapshot = view === "snapshot" || isEmbed;
  const showInteractive = !isEmbed && view === "interactive";

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
            {showInteractive
              ? "Full VM desktop — mouse and keyboard (1024×768)"
              : "Latest screenshot of the agent desktop"}
          </p>
        </div>
        {!isEmbed ? (
          <div className="flex shrink-0 items-center gap-1">
            <div className="flex rounded-lg border border-white/[0.08] bg-[#111] p-0.5">
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
            </div>
            {showSnapshot ? (
              <button
                type="button"
                onClick={() => void loadScreenshot(true)}
                disabled={shotLoading}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
              >
                <RefreshCw
                  className={cn("size-3.5", shotLoading && "animate-spin")}
                />
                Refresh
              </button>
            ) : (
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
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void loadScreenshot(true)}
            disabled={shotLoading}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshCw
              className={cn("size-3.5", shotLoading && "animate-spin")}
            />
            Refresh
          </button>
        )}
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center bg-[#0a0a0a]",
          isEmbed ? "min-h-[180px] p-2" : "p-0",
        )}
      >
        {showSnapshot ? (
          shotUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shotUrl}
              alt="Desktop snapshot"
              className="animate-in fade-in max-h-full max-w-full object-contain duration-500"
            />
          ) : shotError ? (
            <div className="flex flex-col items-center gap-2 p-6">
              <Monitor className="size-6 text-zinc-600" strokeWidth={1.5} />
              <p className="max-w-sm text-center text-[12px] text-zinc-500">
                {shotError}
              </p>
            </div>
          ) : (
            <DesktopSnapshotAwaiting
              compact={isEmbed}
              isActive={isAgentActive || shotLoading}
            />
          )
        ) : null}

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
