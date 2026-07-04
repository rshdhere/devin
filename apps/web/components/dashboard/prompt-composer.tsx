"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  FolderPlus,
  GitBranch,
  Loader2,
  Mic,
  MoreHorizontal,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { DashboardLogo } from "@/components/dashboard/dashboard-logo";
import { MotionButton } from "@/components/dashboard/motion-button";
import { PromptMetadataBar } from "@/components/dashboard/prompt-metadata-bar";
import { useSessions } from "@/components/dashboard/sessions-context";
import { DEVIN_BOT } from "@/lib/devin-bot";
import { cn } from "@/lib/utils";

const MIN_TEXTAREA_HEIGHT = 72;

type RepoMode = "existing" | "create";

const textareaSpring = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.85,
};

const agentOptions = [
  { id: "cursor" as const, label: "Cursor" },
  { id: "claude" as const, label: "Claude" },
  { id: "mock" as const, label: "Template (legacy)" },
];

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
  const [agent, setAgent] =
    useState<(typeof agentOptions)[number]["id"]>("cursor");
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoMode, setRepoMode] = useState<RepoMode>(
    selectedRepository ? "existing" : "create",
  );
  const [newRepoName, setNewRepoName] = useState("");
  const [autoStartSandbox, setAutoStartSandbox] = useState(true);
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
        autoStartSandbox,
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

  const selectedAgent =
    agentOptions.find((option) => option.id === agent) ?? agentOptions[0]!;

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

        <div className="flex items-center justify-between px-3 pt-1 pb-3.5">
          <div className="flex items-center gap-0.5">
            <div className="relative" ref={agentMenuRef}>
              <MotionButton
                type="button"
                onClick={() => {
                  setShowAgentMenu((open) => !open);
                  setShowRepoOptions(false);
                }}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-[#333] bg-[#161616] px-2.5 py-1 text-[13px] text-gray-300 transition-colors hover:bg-[#222] hover:text-white"
              >
                <Bot className="size-3.5 text-gray-400" strokeWidth={1.75} />
                {selectedAgent.label}
                <ChevronDown
                  className={cn(
                    "size-3 text-gray-500 transition-transform",
                    showAgentMenu && "rotate-180",
                  )}
                />
              </MotionButton>

              <AnimatePresence>
                {showAgentMenu ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.96 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-full left-0 z-[100] mb-2 min-w-[140px] overflow-hidden rounded-xl border border-[#333] bg-[#1e1e1e] py-1 shadow-2xl"
                  >
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
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <div className="relative" ref={repoMenuRef}>
              <MotionButton
                type="button"
                onClick={() => {
                  setShowRepoOptions((open) => !open);
                  setShowAgentMenu(false);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] transition-colors hover:bg-[#222]",
                  repoMode === "create"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-[#333] bg-[#161616] text-gray-300 hover:text-white",
                )}
              >
                {repoMode === "create" ? (
                  <FolderPlus className="size-3.5" strokeWidth={1.75} />
                ) : (
                  <GitBranch
                    className="size-3.5 text-gray-400"
                    strokeWidth={1.75}
                  />
                )}
                {repoMode === "create"
                  ? newRepoName || "New repo"
                  : selectedRepository
                    ? selectedRepository.split("/")[1]
                    : "Select repo"}
                <ChevronDown
                  className={cn(
                    "size-3 text-gray-500 transition-transform",
                    showRepoOptions && "rotate-180",
                  )}
                />
              </MotionButton>

              <AnimatePresence>
                {showRepoOptions ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.96 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-full left-0 z-[100] mb-2 min-w-[220px] overflow-hidden rounded-xl border border-[#333] bg-[#1e1e1e] py-1 shadow-2xl"
                  >
                    <MotionButton
                      type="button"
                      onClick={() => {
                        setRepoMode("create");
                        setShowRepoOptions(false);
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#252525]",
                        repoMode === "create"
                          ? "text-emerald-400"
                          : "text-gray-400",
                      )}
                    >
                      <FolderPlus className="size-4" />
                      <div>
                        <p className="font-medium">Create new repository</p>
                        <p className="text-[11px] text-gray-500">
                          Co-authored by{" "}
                          <a
                            href={DEVIN_BOT.profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#5a9fd4] hover:underline"
                          >
                            @{DEVIN_BOT.username}
                          </a>
                        </p>
                      </div>
                    </MotionButton>

                    {selectedRepository ? (
                      <MotionButton
                        type="button"
                        onClick={() => {
                          setRepoMode("existing");
                          setShowRepoOptions(false);
                        }}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#252525]",
                          repoMode === "existing"
                            ? "text-white"
                            : "text-gray-400",
                        )}
                      >
                        <GitBranch className="size-4" />
                        <div>
                          <p className="font-medium">{selectedRepository}</p>
                          <p className="text-[11px] text-gray-500">
                            Use selected repo
                          </p>
                        </div>
                      </MotionButton>
                    ) : null}

                    {repoMode === "create" ? (
                      <div className="border-t border-[#333] px-3 py-2">
                        <input
                          type="text"
                          value={newRepoName}
                          onChange={(event) =>
                            setNewRepoName(event.target.value)
                          }
                          placeholder="repo-name (optional)"
                          className="w-full rounded-lg border border-[#333] bg-[#111] px-2.5 py-1.5 text-[12px] text-white placeholder:text-gray-600 focus:border-emerald-500/50 focus:outline-none"
                        />
                        <p className="text-[11px] text-gray-500">
                          Leave empty for a random project name
                        </p>
                      </div>
                    ) : null}

                    <div className="border-t border-[#333] px-3 py-2">
                      <label className="flex cursor-pointer items-center justify-between gap-2 text-[12px] text-gray-300">
                        <span>Auto-start sandbox after draft</span>
                        <input
                          type="checkbox"
                          checked={autoStartSandbox}
                          onChange={(event) =>
                            setAutoStartSandbox(event.target.checked)
                          }
                          className="size-3.5 accent-indigo-400"
                        />
                      </label>
                      <p className="mt-1 text-[11px] text-gray-500">
                        Off = review draft first, then run in sandbox manually
                      </p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

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
