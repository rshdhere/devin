"use client";

import {
  ArrowUp,
  Bot,
  Bell,
  ChevronDown,
  FolderPlus,
  GitBranch,
  Loader2,
  Mic,
  Plus,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MotionButton } from "@/components/dashboard/motion-button";
import {
  agentOptions,
  type AgentId,
  type RepoMode,
} from "@/components/dashboard/prompt-composer-constants";
import { DEVIN_BOT } from "@/lib/devin-bot";
import {
  cursorAgentModelLabel,
  DEFAULT_CURSOR_AGENT_MODEL,
} from "@devin/types";
import { cn } from "@/lib/utils";

interface PromptComposerToolbarProps {
  agent: AgentId;
  onAgentChange: (agent: AgentId) => void;
  showAgentMenu: boolean;
  onToggleAgentMenu: () => void;
  agentMenuRef: React.RefObject<HTMLDivElement | null>;
  repoMode: RepoMode;
  onRepoModeChange: (mode: RepoMode) => void;
  newRepoName: string;
  onNewRepoNameChange: (name: string) => void;
  showRepoOptions: boolean;
  onToggleRepoOptions: () => void;
  repoMenuRef: React.RefObject<HTMLDivElement | null>;
  selectedRepository?: string | null;
  prompt: string;
  isSubmitting: boolean;
  onSubmit: () => void;
}

export function PromptComposerToolbar({
  agent,
  onAgentChange,
  showAgentMenu,
  onToggleAgentMenu,
  agentMenuRef,
  repoMode,
  onRepoModeChange,
  newRepoName,
  onNewRepoNameChange,
  showRepoOptions,
  onToggleRepoOptions,
  repoMenuRef,
  selectedRepository,
  prompt,
  isSubmitting,
  onSubmit,
}: PromptComposerToolbarProps) {
  const selectedAgent =
    agentOptions.find((option) => option.id === agent) ?? agentOptions[0]!;

  return (
    <div className="flex items-center justify-between px-3 pt-1 pb-3.5">
      <div className="flex items-center gap-0.5">
        <div className="relative" ref={agentMenuRef}>
          <MotionButton
            type="button"
            onClick={onToggleAgentMenu}
            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-[#333] bg-[#161616] px-2.5 py-1 text-[13px] text-gray-300 transition-colors hover:bg-[#222] hover:text-white"
          >
            <Bot className="size-3.5 text-gray-400" strokeWidth={1.75} />
            {selectedAgent.label === "Cursor" ? "Normal" : selectedAgent.label}
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
                    onClick={() => onAgentChange(option.id)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col px-3 py-2 text-left transition-colors hover:bg-[#252525]",
                      agent === option.id ? "text-white" : "text-gray-400",
                    )}
                  >
                    <span className="text-[13px]">{option.label}</span>
                    <span className="text-[11px] text-gray-600">
                      {option.description}
                    </span>
                  </MotionButton>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {agent === "cursor" ? (
          <span className="flex items-center rounded-full border border-[#333] bg-[#161616] px-2.5 py-1 text-[13px] text-gray-400">
            {cursorAgentModelLabel(DEFAULT_CURSOR_AGENT_MODEL)}
          </span>
        ) : null}

        <div className="relative" ref={repoMenuRef}>
          <MotionButton
            type="button"
            onClick={onToggleRepoOptions}
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
                  onClick={() => onRepoModeChange("create")}
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
                    onClick={() => onRepoModeChange("existing")}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-[#252525]",
                      repoMode === "existing" ? "text-white" : "text-gray-400",
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
                        onNewRepoNameChange(event.target.value)
                      }
                      placeholder="repo-name (optional)"
                      className="w-full rounded-lg border border-[#333] bg-[#111] px-2.5 py-1.5 text-[12px] text-white placeholder:text-gray-600 focus:border-emerald-500/50 focus:outline-none"
                    />
                    <p className="text-[11px] text-gray-500">
                      Leave empty for a random project name
                    </p>
                  </div>
                ) : null}
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
          <Bell className="size-4" />
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
          onClick={onSubmit}
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
        <MotionButton
          type="button"
          pressStyle="icon"
          aria-label="Send options"
          className="cursor-pointer rounded-full p-1.5 text-gray-500 transition-colors hover:bg-[#222] hover:text-gray-300"
        >
          <ChevronDown className="size-3.5" />
        </MotionButton>
      </div>
    </div>
  );
}
