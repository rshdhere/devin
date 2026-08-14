"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal, X } from "lucide-react";
import { motion } from "motion/react";
import { DashboardLogo } from "@/components/dashboard/dashboard-logo";
import { MotionButton } from "@/components/dashboard/motion-button";
import { PromptMetadataBar } from "@/components/dashboard/prompt-metadata-bar";
import {
  MIN_TEXTAREA_HEIGHT,
  textareaSpring,
  type AgentId,
} from "@/components/dashboard/prompt-composer-constants";
import { PromptComposerToolbar } from "@/components/dashboard/prompt-composer-toolbar";
import { useSessions } from "@/components/dashboard/sessions-context";
import {
  DEFAULT_CURSOR_AGENT_MODEL,
  resolveRuntimeForTask,
  runtimeLabel,
} from "@devin/types";
import { cn } from "@/lib/utils";

interface PromptComposerProps {
  selectedRepository?: string | null;
}

export function PromptComposer({ selectedRepository }: PromptComposerProps) {
  const { startSession } = useSessions();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const [showTerminalBanner, setShowTerminalBanner] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [textareaHeight, setTextareaHeight] = useState(MIN_TEXTAREA_HEIGHT);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerMode, setComposerMode] = useState<"agent" | "ask">("agent");

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        agentMenuRef.current &&
        !agentMenuRef.current.contains(event.target as Node)
      ) {
        setShowAgentMenu(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const nextHeight = Math.max(MIN_TEXTAREA_HEIGHT, textarea.scrollHeight);
    setTextareaHeight(nextHeight);
  }, [prompt, showTerminalBanner]);

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await startSession({
        prompt: trimmed,
        agent,
        repository: selectedRepository ?? undefined,
        autoCreateRepository: selectedRepository ? undefined : true,
        autoStartSandbox: true,
        agentModel: agent === "cursor" ? DEFAULT_CURSOR_AGENT_MODEL : undefined,
      });
      setPrompt("");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to start session",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  const resolvedRuntime = resolveRuntimeForTask(agent, prompt);

  return (
    <div className="flex w-full flex-col items-center overflow-visible">
      <div className="mb-3 flex w-full max-w-[520px] items-center justify-between px-0.5">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
          <DashboardLogo size={18} className="text-white" />
          <span>Devin</span>
        </div>

        <div className="flex items-center rounded-full bg-[#1c1c1c] p-[3px] text-[12px]">
          <button
            type="button"
            onClick={() => setComposerMode("agent")}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 transition-colors",
              composerMode === "agent"
                ? "bg-[#2e2e2e] font-medium text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            Agent
          </button>
          <button
            type="button"
            onClick={() => setComposerMode("ask")}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 transition-colors",
              composerMode === "ask"
                ? "bg-[#2e2e2e] font-medium text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            Ask
          </button>
        </div>
      </div>

      <div
        className={cn(
          "relative w-full max-w-[520px] overflow-hidden rounded-2xl bg-[#1c1c1c]",
          "shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_12px_40px_rgba(0,0,0,0.45)]",
        )}
      >
        <motion.textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            composerMode === "ask"
              ? "Ask Devin anything about your code"
              : "Ask Devin to build features, fix bugs, or work on your code"
          }
          rows={1}
          disabled={isSubmitting}
          initial={false}
          animate={{ height: textareaHeight }}
          transition={textareaSpring}
          className={cn(
            "w-full resize-none overflow-hidden bg-transparent px-4 pt-4 pb-2",
            "text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-500",
            "selection:bg-white selection:text-[#1c1c1c]",
            "outline-none disabled:opacity-60",
          )}
        />

        <PromptComposerToolbar
          agent={agent}
          onAgentChange={(nextAgent) => {
            setAgent(nextAgent);
            setShowAgentMenu(false);
          }}
          showAgentMenu={showAgentMenu}
          onToggleAgentMenu={() => {
            setShowAgentMenu((open) => !open);
          }}
          agentMenuRef={agentMenuRef}
          prompt={prompt}
          isSubmitting={isSubmitting}
          onSubmit={() => void handleSubmit()}
        />

        {showTerminalBanner ? (
          <div className="flex items-center justify-between border-t border-white/[0.06] bg-[#171717] px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-300">
              <Terminal className="size-3.5 shrink-0 text-zinc-500" />
              <span className="truncate">
                Run Devin directly from your terminal.
              </span>
            </div>
            <div className="ml-3 flex shrink-0 items-center gap-2.5">
              <MotionButton
                type="button"
                className="cursor-pointer text-[13px] font-medium text-[#4b9dff] hover:text-[#6eb0ff]"
              >
                Get started
              </MotionButton>
              <MotionButton
                type="button"
                pressStyle="icon"
                onClick={() => setShowTerminalBanner(false)}
                className="cursor-pointer rounded-md p-0.5 text-zinc-500 transition-colors hover:text-zinc-300"
                aria-label="Dismiss banner"
              >
                <X className="size-3.5" />
              </MotionButton>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 text-center text-[12px] text-red-400">{error}</p>
      ) : null}

      {prompt.trim() ? (
        <p className="mt-2 text-center text-[12px] text-zinc-500">
          Devbox snapshot:{" "}
          <span className="font-medium text-indigo-300/90">
            {runtimeLabel(resolvedRuntime)}
          </span>
          <span className="text-zinc-600">
            {" "}
            — runtime agents always use the agent image
          </span>
        </p>
      ) : null}

      <PromptMetadataBar />
    </div>
  );
}
