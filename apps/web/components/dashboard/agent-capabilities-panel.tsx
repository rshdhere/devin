"use client";

import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, Loader2, X } from "lucide-react";
import { motion } from "motion/react";
import { MotionButton } from "@/components/dashboard/motion-button";
import { fetchInfraDiagnostics } from "@/lib/tasks-api";
import { cn } from "@/lib/utils";

interface AgentCapabilitiesPanelProps {
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

export function AgentCapabilitiesPanel({
  onClose,
}: AgentCapabilitiesPanelProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [cursorConfigured, setCursorConfigured] = useState(false);
  const [anthropicConfigured, setAnthropicConfigured] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState("cursor");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchInfraDiagnostics()
      .then((diagnostics) => {
        if (!cancelled) {
          setCursorConfigured(
            diagnostics.agent?.cursorApiKeyConfigured ?? false,
          );
          setAnthropicConfigured(
            diagnostics.agent?.anthropicApiKeyConfigured ?? false,
          );
          setDefaultAgent(diagnostics.agent?.defaultAgent ?? "cursor");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load agent configuration from the scheduler");
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
        aria-labelledby="agent-capabilities-title"
        className="w-full max-w-[520px] rounded-xl border border-[#333] bg-[#1e1e1e] p-5 shadow-2xl"
        initial={{ opacity: 0, scale: 0.94, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={panelSpring}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5 shrink-0 text-[#4a90e2]" />
            <div>
              <h3
                id="agent-capabilities-title"
                className="text-[16px] font-semibold text-white"
              >
                Agent capabilities
              </h3>
              <p className="mt-1 text-[13px] text-gray-500">
                Platform-wide keys power Cursor and Claude agents for all users.
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
            Checking scheduler configuration…
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] text-gray-200">Cursor API key</p>
                  <p className="text-[11px] text-gray-600">
                    Required for the Cursor agent (default: {defaultAgent})
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium",
                    cursorConfigured
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-red-500/10 text-red-400",
                  )}
                >
                  {cursorConfigured ? "Configured" : "Missing"}
                </span>
              </div>
            </div>

            <div className="rounded-lg border border-[#2a2a2a] bg-[#141414] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] text-gray-200">Anthropic API key</p>
                  <p className="text-[11px] text-gray-600">
                    Required only when using the Claude agent
                  </p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-medium",
                    anthropicConfigured
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-amber-500/10 text-amber-400",
                  )}
                >
                  {anthropicConfigured ? "Configured" : "Optional"}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-5 rounded-lg border border-[#2a2a2a] bg-[#111] p-3">
          <p className="text-[12px] font-medium text-gray-300">
            Where to set the platform Cursor key (admin)
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12px] leading-relaxed text-gray-500">
            <li>
              Create a user API key at{" "}
              <a
                href="https://cursor.com/dashboard/integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#5a9fd4] hover:text-[#6aa8ef]"
              >
                cursor.com/dashboard/integrations
                <ExternalLink className="size-3" />
              </a>
            </li>
            <li>
              Store it in AWS SSM as a{" "}
              <span className="text-gray-400">SecureString</span> at{" "}
              <code className="rounded bg-[#1a1a1a] px-1 py-0.5 text-[11px] text-gray-300">
                /devin-production/platform/cursor_api_key
              </code>
            </li>
            <li>
              Sync the execution host:{" "}
              <code className="rounded bg-[#1a1a1a] px-1 py-0.5 text-[11px] text-gray-300">
                ./infra/scripts/sync-execution-host-config.sh
                &lt;instance-id&gt;
              </code>
            </li>
            <li>
              Retry your session — the scheduler injects the key into each
              sandbox run.
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
