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
  type RepoMode,
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
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const [showTerminalBanner, setShowTerminalBanner] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [textareaHeight, setTextareaHeight] = useState(MIN_TEXTAREA_HEIGHT);
  const [agent, setAgent] = useState<AgentId>("cursor");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoMode, setRepoMode] = useState<RepoMode>(
    selectedRepository ? "existing" : "create",
  );
  const [newRepoName, setNewRepoName] = useState("");
  const [showRepoOptions, setShowRepoOptions] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        agentMenuRef.current &&
        !agentMenuRef.current.contains(event.target as Node)
      ) {
        setShowAgentMenu(false);
      }
      if (
        repoMenuRef.current &&
        !repoMenuRef.current.contains(event.target as Node)
      ) {
        setShowRepoOptions(false);
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

  useLayoutEffect(() => {
    if (selectedRepository) {
      setRepoMode("existing");
    }
  }, [selectedRepository]);

  async function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const finalRepoName = newRepoName.trim();

      await startSession({
        prompt: trimmed,
        agent,
        repository:
          repoMode === "existing"
            ? (selectedRepository ?? undefined)
            : undefined,
        createRepository:
          repoMode === "create" && finalRepoName ? finalRepoName : undefined,
        autoCreateRepository:
          repoMode === "create" && !finalRepoName ? true : undefined,
        autoStartSandbox: true,
        agentModel: agent === "cursor" ? DEFAULT_CURSOR_AGENT_MODEL : undefined,
      });
      setPrompt("");
      setNewRepoName("");
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
      <div className="mb-6 flex justify-center">
        <DashboardLogo size={52} className="text-[#525252]" />
      </div>

      <div
        className={cn(
          "relative w-full rounded-[28px] border border-[#333] bg-[#1a1a1a]",
          "shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_8px_32px_rgba(0,0,0,0.4)]",
        )}
      >
        {showTerminalBanner ? (
          <>
            <div className="flex items-center justify-between rounded-t-[28px] bg-[#171717] px-4 py-2.5">
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
          placeholder="Ask Devin to build features, fix bugs, or ship changes"
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

        <PromptComposerToolbar
          agent={agent}
          onAgentChange={(nextAgent) => {
            setAgent(nextAgent);
            setShowAgentMenu(false);
          }}
          showAgentMenu={showAgentMenu}
          onToggleAgentMenu={() => {
            setShowAgentMenu((open) => !open);
            setShowRepoOptions(false);
          }}
          agentMenuRef={agentMenuRef}
          repoMode={repoMode}
          onRepoModeChange={(mode) => {
            setRepoMode(mode);
            setShowRepoOptions(false);
          }}
          newRepoName={newRepoName}
          onNewRepoNameChange={setNewRepoName}
          showRepoOptions={showRepoOptions}
          onToggleRepoOptions={() => {
            setShowRepoOptions((open) => !open);
            setShowAgentMenu(false);
          }}
          repoMenuRef={repoMenuRef}
          selectedRepository={selectedRepository}
          prompt={prompt}
          isSubmitting={isSubmitting}
          onSubmit={() => void handleSubmit()}
        />
      </div>

      {error ? (
        <p className="mt-2 text-center text-[12px] text-red-400">{error}</p>
      ) : null}

      {prompt.trim() ? (
        <p className="mt-2 text-center text-[12px] text-gray-500">
          Devbox snapshot:{" "}
          <span className="font-medium text-indigo-300/90">
            {runtimeLabel(resolvedRuntime)}
          </span>
          <span className="text-gray-600">
            {" "}
            — runtime agents always use the agent image
          </span>
        </p>
      ) : null}

      <PromptMetadataBar />
    </div>
  );
}
