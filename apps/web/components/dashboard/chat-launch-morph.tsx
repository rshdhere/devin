"use client";

import { motion } from "motion/react";
import {
  CHAT_COLUMN_WIDTH,
  chatLaunchTransition,
  workspaceShellClassName,
  type MorphRect,
} from "@/components/dashboard/prompt-composer-constants";
import { cn } from "@/lib/utils";

interface ChatLaunchMorphOverlayProps {
  from: MorphRect;
  to: MorphRect;
  fading?: boolean;
  /** Snap layout instantly (post-expand slot align) — never a second expand. */
  settled?: boolean;
  prompt?: string;
}

/**
 * Stable morph shell — content stays the same for the whole expand
 * (no portal swaps mid-flight, which caused the glitch).
 */
export function ChatLaunchMorphOverlay({
  from,
  to,
  fading = false,
  settled = false,
  prompt,
}: ChatLaunchMorphOverlayProps) {
  const layoutTransition = settled ? { duration: 0 } : chatLaunchTransition;

  return (
    <motion.div
      className={cn(
        workspaceShellClassName,
        "pointer-events-none fixed z-[60] flex flex-col will-change-[top,left,width,height,opacity]",
      )}
      initial={{
        top: from.top,
        left: from.left,
        width: from.width,
        height: from.height,
        opacity: 1,
      }}
      animate={{
        top: to.top,
        left: to.left,
        width: to.width,
        height: to.height,
        opacity: fading ? 0 : 1,
      }}
      transition={{
        top: layoutTransition,
        left: layoutTransition,
        width: layoutTransition,
        height: layoutTransition,
        opacity: { duration: 0.2, ease: "easeOut" },
      }}
    >
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
          <div className="h-4 w-4 rounded bg-white/10" />
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-100">
            {prompt?.trim() || "New session"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-5 py-4">
          {prompt?.trim() ? (
            <div className="flex justify-end">
              <div className="max-w-[88%] rounded-2xl rounded-tr-md bg-[#1a1a1a] px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-100">
                {prompt}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

export function measureElementRect(element: Element | null): MorphRect | null {
  if (!element) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function measureComposerShellRect(
  element: Element | null,
): MorphRect | null {
  return measureElementRect(element);
}

/** Approximate chat-column target from main padding (used before session mounts). */
export function measureChatColumnTargetRect(): MorphRect | null {
  const main = document.querySelector("main");
  if (!main) {
    return null;
  }

  const rect = main.getBoundingClientRect();
  const styles = window.getComputedStyle(main);
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const contentWidth = Math.max(0, rect.width - paddingLeft - paddingRight);
  const width = Math.min(CHAT_COLUMN_WIDTH, Math.max(280, contentWidth));

  return {
    top: rect.top + paddingTop,
    left: rect.left + paddingLeft,
    width,
    height: Math.max(0, rect.height - paddingTop - paddingBottom),
  };
}
