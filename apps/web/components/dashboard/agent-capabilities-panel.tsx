"use client";

import { useEffect, useState } from "react";
import { Activity, Loader2, X } from "lucide-react";
import { motion } from "motion/react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { fetchInfraDiagnostics } from "@/lib/api/tasks";
import type { PlatformDiagnostics, ServiceProbe } from "@devin/types";
import { cn } from "@/lib/utils";

interface PlatformStatusPanelProps {
  onClose: () => void;
}

const backdropSpring = {
  type: "spring" as const,
  stiffness: 420,
  damping: 40,
  mass: 0.85,
};

const panelSpring = {
  type: "spring" as const,
  stiffness: 380,
  damping: 34,
  mass: 0.9,
};

function serviceModeLabel(mode: PlatformDiagnostics["serviceMode"]): string {
  switch (mode) {
    case "brain":
      return "Brain (control plane)";
    case "worker":
      return "Execution worker";
    default:
      return "Standalone scheduler";
  }
}

function StatusRow({
  title,
  description,
  probe,
  okLabel = "Connected",
  failLabel = "Unreachable",
}: {
  title: string;
  description: string;
  probe?: ServiceProbe;
  okLabel?: string;
  failLabel?: string;
}) {
  const reachable = probe?.reachable ?? false;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] text-gray-200">{title}</p>
          <p className="text-[11px] text-gray-600">{description}</p>
          {probe?.url ? (
            <p className="mt-1 truncate font-mono text-[10px] text-gray-700">
              {probe.url}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
            reachable
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-red-500/10 text-red-400",
          )}
        >
          {reachable ? okLabel : failLabel}
        </span>
      </div>
      {probe?.error ? (
        <p className="mt-2 text-[11px] leading-relaxed text-red-300/90">
          {probe.error}
        </p>
      ) : null}
    </div>
  );
}

export function AgentCapabilitiesPanel({ onClose }: PlatformStatusPanelProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [platform, setPlatform] = useState<PlatformDiagnostics | null>(null);
  const [orchestrator, setOrchestrator] = useState<ServiceProbe | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchInfraDiagnostics()
      .then((diagnostics) => {
        if (!cancelled) {
          setPlatform(diagnostics.platform);
          setOrchestrator(diagnostics.orchestrator);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load platform status from the control plane");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={backdropSpring}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="platform-status-title"
        className="w-full max-w-[520px] rounded-xl border border-[#333] bg-[#1e1e1e] p-5 shadow-2xl"
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={panelSpring}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <Activity className="mt-0.5 size-5 shrink-0 text-[#4a90e2]" />
            <div>
              <h3
                id="platform-status-title"
                className="text-[16px] font-semibold text-white"
              >
                Platform status
              </h3>
              <p className="mt-1 text-[13px] text-gray-500">
                Sessions run through the brain control plane. Agent credentials
                stay on the execution host — never in the browser.
              </p>
            </div>
          </div>
          <MotionButton
            type="button"
            pressStyle="icon"
            onClick={onClose}
            className="cursor-pointer rounded-full p-1 text-gray-500 transition-colors hover:bg-[#2a2a2a] hover:text-gray-300"
            aria-label="Close"
          >
            <X className="size-4" />
          </MotionButton>
        </div>

        {isLoading ? (
          <div className="mt-5 flex items-center gap-2 text-[13px] text-gray-500">
            <Loader2 className="size-4 animate-spin" />
            Checking control plane…
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {platform ? (
              <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[13px] text-gray-200">
                      {serviceModeLabel(platform.serviceMode)}
                    </p>
                    <p className="text-[11px] text-gray-600">
                      Default agent: {platform.defaultAgent}
                      {platform.preferredHost
                        ? ` · host ${platform.preferredHost}`
                        : null}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-medium",
                      platform.durable
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-amber-500/10 text-amber-400",
                    )}
                  >
                    {platform.durable ? "Durable sessions" : "In-memory"}
                  </span>
                </div>
              </div>
            ) : null}

            {platform?.serviceMode === "brain" ? (
              <StatusRow
                title="Execution worker"
                description="Runs devboxes and agent CLIs on the execution host"
                probe={platform.executionWorker}
                okLabel="Ready"
                failLabel="Not reachable"
              />
            ) : null}

            <StatusRow
              title="Orchestrator"
              description="Provisions Firecracker sandboxes for devbox sessions"
              probe={orchestrator ?? undefined}
            />
          </div>
        )}

        <div className="mt-5 rounded-lg border border-[#2a2a2a] bg-[#111] p-3">
          <p className="text-[12px] font-medium text-gray-300">
            How sessions work
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-relaxed text-gray-500">
            <li>
              The web UI talks to the API server, which forwards tasks to the
              brain control plane.
            </li>
            <li>
              Brain persists sessions in Postgres and delegates sandbox work to
              the execution worker.
            </li>
            <li>
              Cursor or Claude runs inside the devbox microVM — credentials are
              configured on the execution host only.
            </li>
          </ol>
        </div>

        {error ? (
          <p className="mt-3 text-[12px] text-red-400">{error}</p>
        ) : null}

        <div className="mt-5 flex justify-end">
          <MotionButton
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[#333] bg-[#1a1a1a] px-4 py-2 text-[13px] text-gray-300 transition-colors hover:bg-[#252525]"
          >
            Close
          </MotionButton>
        </div>
      </motion.div>
    </motion.div>
  );
}
