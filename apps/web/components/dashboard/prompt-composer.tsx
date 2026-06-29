"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Loader2,
  Mic,
  MoreHorizontal,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { DashboardLogo } from "@/components/dashboard/dashboard-logo";
import { MotionButton } from "@/components/dashboard/motion-button";
import { PromptMetadataBar } from "@/components/dashboard/prompt-metadata-bar";
import { useSessions } from "@/components/dashboard/sessions-context";
import { cn } from "@/lib/utils";

const MIN_TEXTAREA_HEIGHT = 72;

const textareaSpring = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.85,
};

const agentOptions = [
  { id: "mock" as const, label: "Mock (dev)" },
  { id: "cursor" as const, label: "Cursor" },
  { id: "claude" as const, label: "Claude" },
];

interface PromptComposerProps {
  selectedRepository?: string | null;
}

export function PromptComposer({ selectedRepository }: PromptComposerProps) {
  const { startSession } = useSessions();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showTerminalBanner, setShowTerminalBanner] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [textareaHeight, setTextareaHeight] = useState(MIN_TEXTAREA_HEIGHT);
  const [agent, setAgent] =
    useState<(typeof agentOptions)[number]["id"]>("mock");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const selectedAgent =
    agentOptions.find((option) => option.id === agent) ?? agentOptions[0]!;

  return (
    <div className="flex w-full flex-col items-center overflow-visible">
      <div className="mb-6 flex justify-center">
        <DashboardLogo size={52} className="text-[#525252]" />
      </div>

      <div
        className={cn(
          "w-full overflow-hidden rounded-[28px] border border-[#333] bg-[#1a1a1a]",
          "shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_8px_32px_rgba(0,0,0,0.4)]",
        )}
      >
        {showTerminalBanner ? (
          <>
            <div className="flex items-center justify-between bg-[#171717] px-4 py-2.5">
              <div className="flex items-center gap-2 text-[13px] text-gray-400">
                <Terminal className="size-4 shrink-0 text-gray-500" />
                <span>Run Devin directly from your terminal.</span>
              </div>
              <div className="flex items-center gap-1">
                <MotionButton
                  type="button"
                  className="cursor-pointer text-[13px] text-[#4a90e2] hover:text-[#6aa8ef]"
                >
                  Get started
                </MotionButton>
                <MotionButton
                  type="button"
                  pressStyle="icon"
                  onClick={() => setShowTerminalBanner(false)}
                  className="cursor-pointer rounded-full p-1 text-gray-500 transition-colors hover:bg-[#222] hover:text-gray-300"
                  aria-label="Dismiss banner"
                >
                  <X className="size-4" />
                </MotionButton>
              </div>
            </div>
            <div
              aria-hidden
              className="h-px bg-gradient-to-r from-transparent via-[#404040] to-transparent"
            />
          </>
        ) : null}

        <motion.textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Devin to build features, fix bugs, or iterate on your code"
          rows={1}
          disabled={isSubmitting}
          initial={false}
          animate={{ height: textareaHeight }}
          transition={textareaSpring}
          className={cn(
            "w-full resize-none overflow-hidden bg-transparent px-5 pb-2",
            showTerminalBanner ? "pt-3" : "pt-5",
            "text-[15px] leading-relaxed text-white placeholder:text-gray-500",
            "selection:bg-white selection:text-[#1a1a1a]",
            "outline-none disabled:opacity-60",
          )}
        />

        <div className="flex items-center justify-between px-3 pt-1 pb-3.5">
          <div className="relative flex items-center gap-0.5">
            <MotionButton
              type="button"
              onClick={() => setShowAgentMenu((open) => !open)}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-[#333] bg-[#161616] px-2.5 py-1 text-[13px] text-gray-300 transition-colors hover:bg-[#222] hover:text-white"
            >
              <Bot className="size-3.5 text-gray-400" strokeWidth={1.75} />
              {selectedAgent.label}
              <ChevronDown className="size-3 text-gray-500" />
            </MotionButton>

            {showAgentMenu ? (
              <div className="absolute top-full left-0 z-50 mt-1 min-w-[140px] overflow-hidden rounded-xl border border-[#333] bg-[#1e1e1e] py-1 shadow-2xl">
                {agentOptions.map((option) => (
                  <MotionButton
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setAgent(option.id);
                      setShowAgentMenu(false);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer px-3 py-2 text-left text-[13px] transition-colors hover:bg-[#252525]",
                      agent === option.id ? "text-white" : "text-gray-400",
                    )}
                  >
                    {option.label}
                  </MotionButton>
                ))}
              </div>
            ) : null}

            <MotionButton
              type="button"
              pressStyle="icon"
              className="cursor-pointer rounded-full p-1.5 text-gray-500 transition-colors hover:bg-[#222] hover:text-gray-300"
              aria-label="Add attachment"
            >
              <Plus className="size-4" />
            </MotionButton>
            <MotionButton
              type="button"
              pressStyle="icon"
              className="cursor-pointer rounded-full p-1.5 text-gray-500 transition-colors hover:bg-[#222] hover:text-gray-300"
              aria-label="More options"
            >
              <MoreHorizontal className="size-4" />
            </MotionButton>
          </div>

          <div className="flex items-center gap-1.5">
            <MotionButton
              type="button"
              pressStyle="icon"
              className="cursor-pointer rounded-full p-1.5 text-gray-500 transition-colors hover:bg-[#222] hover:text-gray-300"
              aria-label="Voice input"
            >
              <Mic className="size-4" />
            </MotionButton>
            <MotionButton
              type="button"
              pressStyle="primary"
              disabled={!prompt.trim() || isSubmitting}
              onClick={() => void handleSubmit()}
              className={cn(
                "flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed",
                prompt.trim() && !isSubmitting
                  ? "bg-[#4a90e2] text-white hover:bg-[#3d7ec8]"
                  : "bg-[#2a2a2a] text-gray-600",
              )}
              aria-label="Send prompt"
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" strokeWidth={2.5} />
              )}
            </MotionButton>
          </div>
        </div>
      </div>

      {error ? (
        <p className="mt-2 text-center text-[12px] text-red-400">{error}</p>
      ) : null}

      <PromptMetadataBar />
    </div>
  );
}
