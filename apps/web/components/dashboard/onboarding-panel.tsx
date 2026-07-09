"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { DismissChecklistModal } from "@/components/dashboard/dismiss-checklist-modal";
import { MotionButton } from "@/components/dashboard/motion-button";
import { cn } from "@/lib/utils";

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  current: boolean;
  badge?: string;
}

interface OnboardingPanelProps {
  githubConnected?: boolean;
  hasRepoAccess?: boolean;
  hasRepository?: boolean;
  sessionCount?: number;
  onDismissConfirmed?: () => void;
}

const advancedItems = [
  { id: "integration", label: "Connect an integration" },
  { id: "automations", label: "Set up automations" },
  { id: "playbook", label: "Create a playbook" },
  { id: "capabilities", label: "Check platform status" },
];

export function OnboardingPanel({
  githubConnected = false,
  hasRepoAccess = false,
  hasRepository = false,
  sessionCount = 0,
  onDismissConfirmed,
}: OnboardingPanelProps) {
  const [showDismissModal, setShowDismissModal] = useState(false);
  const [showAdvancedTips, setShowAdvancedTips] = useState(true);

  const checklistItems: ChecklistItem[] = [
    {
      id: "git",
      label: "Connect to Git",
      completed: githubConnected,
      current: !githubConnected,
    },
    {
      id: "repos",
      label: "Select repositories",
      completed: hasRepoAccess && hasRepository,
      current: githubConnected && (!hasRepoAccess || !hasRepository),
      badge: hasRepoAccess && hasRepository ? "Earned $10" : undefined,
    },
    {
      id: "session",
      label: "Make your first session",
      completed: sessionCount > 0,
      current:
        githubConnected && hasRepoAccess && hasRepository && sessionCount === 0,
    },
    {
      id: "review",
      label: "Validate in Devin Review",
      completed: false,
      current: sessionCount > 0,
    },
    { id: "wiki", label: "Set up your wiki", completed: false, current: false },
    {
      id: "ask",
      label: "Ask Devin about your codebase",
      completed: false,
      current: false,
    },
  ];

  const completedCount =
    (githubConnected ? 1 : 0) +
    (hasRepoAccess && hasRepository ? 1 : 0) +
    (sessionCount > 0 ? 1 : 0);
  const totalCount = 10;
  const progress = (completedCount / totalCount) * 100;

  function handleDismissConfirm() {
    setShowDismissModal(false);
    onDismissConfirmed?.();
  }

  return (
    <>
      <div className="w-full max-w-[840px] overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414]">
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-4 py-3">
          <h2 className="text-[14px] font-medium text-white">
            Get started with Devin
          </h2>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-gray-500">
                {completedCount} of {totalCount}
              </span>
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#2a2a2a]">
                <div
                  className="h-full rounded-full bg-[#4a90e2] transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <MotionButton
              type="button"
              pressStyle="icon"
              onClick={() => setShowDismissModal(true)}
              className="cursor-pointer rounded p-1 text-gray-500 transition-colors hover:bg-[#1e1e1e] hover:text-gray-300"
              aria-label="Dismiss onboarding"
            >
              <X className="size-4" />
            </MotionButton>
          </div>
        </div>

        <div className="px-2 py-2">
          {checklistItems.map((item) => (
            <MotionButton
              key={item.id}
              type="button"
              className={cn(
                "flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors hover:bg-[#1a1a1a]/60",
                item.current && "bg-[#1a1a1a]",
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    item.completed
                      ? "border-[#4a90e2] bg-[#4a90e2] text-white"
                      : "border-[#3a3a3a] bg-transparent",
                  )}
                >
                  {item.completed ? (
                    <Check className="size-3" strokeWidth={3} />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "text-[14px]",
                    item.completed ? "text-gray-400" : "text-gray-200",
                  )}
                >
                  {item.label}
                </span>
              </div>
              {item.badge ? (
                <span className="text-[12px] text-gray-500">{item.badge}</span>
              ) : null}
            </MotionButton>
          ))}

          {showAdvancedTips ? (
            <>
              <p className="mt-2 px-3 py-1.5 text-[13px] font-medium text-gray-500">
                Advanced
              </p>

              {advancedItems.map((item) => (
                <MotionButton
                  key={item.id}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-[#1a1a1a]/60"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[#3a3a3a]" />
                  <span className="text-[14px] text-gray-200">
                    {item.label}
                  </span>
                </MotionButton>
              ))}
            </>
          ) : null}
        </div>

        <MotionButton
          type="button"
          onClick={() => setShowAdvancedTips((open) => !open)}
          className="flex w-full cursor-pointer items-center justify-center gap-1.5 border-t border-[#2a2a2a] bg-[#121212] px-4 py-2.5 text-[13px] text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-400"
        >
          {showAdvancedTips ? (
            <>
              <ChevronUp className="size-3.5" />
              Hide advanced tips
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" />
              Show advanced tips
            </>
          )}
        </MotionButton>
      </div>

      <AnimatePresence initial={false}>
        {showDismissModal ? (
          <DismissChecklistModal
            onCancel={() => setShowDismissModal(false)}
            onDismiss={handleDismissConfirm}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}
