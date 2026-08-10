"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, Monitor, RefreshCw } from "lucide-react";
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
  const previewSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/devbox-preview?path=/`,
  );
  const screenshotSrc = tasksApiUrl(
    `/${encodeURIComponent(task.id)}/desktop-screenshot`,
  );

  const [shotKey, setShotKey] = useState(0);
  const [shotError, setShotError] = useState(false);
  const [shotLoading, setShotLoading] = useState(false);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [previewLive, setPreviewLive] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

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
        if (!cancelled) {
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
    task.status === "scheduling";

  const previewFrameSrc = `${previewSrc}&r=${previewKey}`;

  useEffect(() => {
    if (!canUse || task.sessionSleeping) {
      return;
    }
    const interval = setInterval(
      () => {
        refreshScreenshot();
        if (isAgentActive) {
          setPreviewLive(false);
          setPreviewKey((k) => k + 1);
        }
      },
      isAgentActive ? 10_000 : 30_000,
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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        layout === "panel" ? "h-full" : "min-h-[320px]",
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[11px] text-zinc-500">
          Localhost in the sandbox (proxied from the devbox)
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshScreenshot}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
          <a
            href={previewSrc}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200"
          >
            Open
            <ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
        <div className="relative min-h-[200px] border-b border-white/[0.06] bg-[#0a0a0a] lg:border-r lg:border-b-0">
          {!previewLive && !task.sessionSleeping ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0a0a]/80">
              <Loader2 className="size-6 animate-spin text-zinc-600" />
            </div>
          ) : null}
          <iframe
            title="Devbox localhost preview"
            src={previewFrameSrc}
            className="h-full min-h-[240px] w-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={() => {
              setPreviewLive(true);
            }}
          />
        </div>

        <div className="flex min-h-[200px] flex-col bg-[#111]">
          <p className="shrink-0 px-3 py-2 text-[10px] font-medium tracking-wide text-zinc-600 uppercase">
            Desktop snapshot
          </p>
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
            {shotLoading && !shotUrl ? (
              <Loader2 className="size-6 animate-spin text-zinc-600" />
            ) : null}
            {shotError && !shotUrl ? (
              <p className="text-center text-[12px] text-zinc-500">
                Desktop snapshot will appear when the agent starts a local dev
                server (Next, Vite, Rust, Django, etc.). We probe common ports
                and capture the page automatically.
              </p>
            ) : null}
            {shotUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={shotUrl}
                alt="Devbox desktop snapshot"
                className="max-h-full w-full rounded-lg border border-white/[0.08] object-contain object-top shadow-lg"
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
