"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { DashboardLogo } from "@/components/dashboard/dashboard-logo";
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
  }, [prompt]);

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
      <div className="mb-3 flex w-full items-center justify-between px-0.5">
        <div className="flex items-center gap-2.5 text-[22px] font-semibold tracking-tight text-white">
          <DashboardLogo size={26} className="text-white" />
          <span>Devin</span>
        </div>

        <div className="flex items-center rounded-full border border-white/10 bg-white/[0.04] p-[3px] text-[12px] backdrop-blur-md">
          <button
            type="button"
            onClick={() => setComposerMode("agent")}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 transition-colors",
              composerMode === "agent"
                ? "bg-white/10 font-medium text-white"
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
                ? "bg-white/10 font-medium text-white"
                : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            Ask
          </button>
        </div>
      </div>

      <div
        className={cn(
          "relative w-full overflow-hidden rounded-2xl",
          "border border-white/15 bg-[#1c1c1c]/75 backdrop-blur-xl",
          "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),0_0_0_1px_rgba(255,255,255,0.04),0_16px_48px_rgba(0,0,0,0.45)]",
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
