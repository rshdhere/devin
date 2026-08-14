"use client";

import {
  ArrowUp,
  Bot,
  ChevronDown,
  Loader2,
  Mic,
  Paperclip,
  Plus,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MotionButton } from "@/components/dashboard/motion-button";
import {
  agentOptions,
  type AgentId,
} from "@/components/dashboard/prompt-composer-constants";
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
  prompt,
  isSubmitting,
  onSubmit,
}: PromptComposerToolbarProps) {
  const selectedAgent =
    agentOptions.find((option) => option.id === agent) ?? agentOptions[0]!;
  const canSend = Boolean(prompt.trim()) && !isSubmitting;

  return (
    <div className="flex items-center justify-between px-3.5 pt-1 pb-3">
      <div className="flex items-center gap-0.5">
        <MotionButton
          type="button"
          pressStyle="icon"
          className="cursor-pointer rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          aria-label="Add"
        >
          <Plus className="size-4" strokeWidth={2} />
        </MotionButton>
        <MotionButton
          type="button"
          pressStyle="icon"
          className="cursor-pointer rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          aria-label="Attach file"
        >
          <Paperclip className="size-4" strokeWidth={1.75} />
        </MotionButton>

        <div className="relative ml-0.5" ref={agentMenuRef}>
          <MotionButton
            type="button"
            onClick={onToggleAgentMenu}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-zinc-200 transition-colors hover:bg-white/[0.06]"
          >
            <span>
              {selectedAgent.label === "Cursor" ? "Agent" : selectedAgent.label}
            </span>
            <ChevronDown
              className={cn(
                "size-3.5 text-zinc-500 transition-transform",
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
                className="absolute bottom-full left-0 z-[100] mb-2 min-w-[180px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1e1e1e] py-1 shadow-2xl"
              >
                {agentOptions.map((option) => (
                  <MotionButton
                    key={option.id}
                    type="button"
                    onClick={() => onAgentChange(option.id)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col px-3 py-2 text-left transition-colors hover:bg-[#252525]",
                      agent === option.id ? "text-white" : "text-zinc-400",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-[13px]">
                      <Bot className="size-3.5 opacity-60" />
                      {option.label === "Cursor" ? "Agent" : option.label}
                    </span>
                    <span className="mt-0.5 text-[11px] text-zinc-600">
                      {option.id === "cursor"
                        ? cursorAgentModelLabel(DEFAULT_CURSOR_AGENT_MODEL)
                        : option.description}
                    </span>
                  </MotionButton>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <MotionButton
          type="button"
          pressStyle="icon"
          className="cursor-pointer rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
          aria-label="Voice input"
        >
          <Mic className="size-4" strokeWidth={1.75} />
        </MotionButton>
        <MotionButton
          type="button"
          pressStyle="primary"
          disabled={!canSend}
          onClick={onSubmit}
          className={cn(
            "flex size-8 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed",
            canSend
              ? "bg-white text-zinc-900 hover:bg-zinc-200"
              : "bg-[#2a2a2a] text-zinc-600",
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
          className="cursor-pointer rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-300"
        >
          <ChevronDown className="size-3.5" />
        </MotionButton>
      </div>
    </div>
  );
}
