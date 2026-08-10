"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Monitor, RefreshCw } from "lucide-react";
import type { Task } from "@devin/types";
import { tasksApiUrl } from "@/lib/api/http";
import { canUseDevbox } from "@/lib/sessions/devbox";
import { cn } from "@/lib/utils";

export function SessionDesktopPanel({
  task,
  layout = "panel",
}: {
  task: Task;
  layout?: "panel" | "embed";
}) {
  const canUse = canUseDevbox(task);
  const screenshotSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-screenshot`,
  );

  const [shotKey, setShotKey] = useState(0);
  const [shotError, setShotError] = useState(false);
  const [shotLoading, setShotLoading] = useState(false);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const shotUrlRef = useRef<string | null>(null);
  shotUrlRef.current = shotUrl;

  const refreshScreenshot = useCallback(() => {
    setShotError(false);
    setShotKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!canUse || task.sessionSleeping) {
      return;
    }
    let cancelled = false;
    setShotLoading(true);
    const url = `${screenshotSrc}?t=${shotKey}`;
    fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`snapshot HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        if (!blob.type.includes("image")) {
          throw new Error("snapshot is not an image");
        }
        setShotUrl((prev) => {
          if (prev?.startsWith("blob:")) {
            URL.revokeObjectURL(prev);
          }
          return URL.createObjectURL(blob);
        });
        setShotError(false);
      })
      .catch(() => {
        if (!cancelled && !shotUrlRef.current) {
          setShotError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setShotLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canUse, screenshotSrc, shotKey, task.sessionSleeping]);

  const isAgentActive =
    task.status === "running" ||
    task.status === "runtime_ready" ||
    task.status === "sandbox_starting" ||
    task.status === "drafting" ||
    task.status === "scheduling" ||
    task.status === "awaiting_review";

  useEffect(() => {
    if (!canUse || task.sessionSleeping) {
      return;
    }
    const interval = setInterval(
      () => {
        refreshScreenshot();
      },
      isAgentActive ? 8_000 : 20_000,
    );
    return () => clearInterval(interval);
  }, [canUse, isAgentActive, refreshScreenshot, task.sessionSleeping]);

  useEffect(() => {
    return () => {
      if (shotUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(shotUrl);
      }
    };
  }, [shotUrl]);

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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        isEmbed ? "min-h-[200px]" : "h-full",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          Sandbox snapshot (headless capture from localhost in the devbox)
        </span>
        <button
          type="button"
          onClick={refreshScreenshot}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </button>
      </div>

      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center bg-[#0a0a0a]",
          isEmbed ? "min-h-[180px] p-2" : "p-4",
        )}
      >
        {shotLoading && !shotUrl ? (
          <Loader2 className="size-6 animate-spin text-zinc-600" />
        ) : null}
        {shotError && !shotUrl ? (
          <p className="max-w-sm text-center text-[12px] text-zinc-500">
            Waiting for the agent to run a dev server in the sandbox (for
            example <code className="text-zinc-300">npm run dev</code> or{" "}
            <code className="text-zinc-300">go run .</code>). Snapshots refresh
            automatically while the session is live.
          </p>
        ) : null}
        {shotUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={shotUrl}
            alt="Sandbox app snapshot"
            className={cn(
              "rounded-lg border border-white/[0.08] object-contain object-top shadow-lg",
              isEmbed ? "max-h-[220px] w-full" : "max-h-full w-full max-w-5xl",
            )}
          />
        ) : null}
      </div>
    </div>
  );
}
