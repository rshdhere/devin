"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { GitHubPermissionsPanel } from "@/components/dashboard/github-permissions-panel";
import { OnboardingPanel } from "@/components/dashboard/onboarding-panel";
import { PromptComposer } from "@/components/dashboard/prompt-composer";
import { SessionDetail } from "@/components/dashboard/session-detail";
import { useSessions } from "@/components/dashboard/sessions-context";
import { fetchDashboardSettingsSafe } from "@/lib/dashboard-settings-api";
import { fetchGitHubStatusSafe } from "@/lib/github-api";
import { cn } from "@/lib/utils";

const collapseTransition = {
  height: {
    type: "tween" as const,
    duration: 0.4,
    ease: [0.4, 0, 0.2, 1] as const,
  },
  opacity: { duration: 0.28, ease: "easeOut" as const },
  paddingTop: {
    type: "tween" as const,
    duration: 0.4,
    ease: [0.4, 0, 0.2, 1] as const,
  },
  paddingBottom: {
    type: "tween" as const,
    duration: 0.4,
    ease: [0.4, 0, 0.2, 1] as const,
  },
};

export function SessionsView() {
  const { activeTask, selectTask, tasks } = useSessions();
  const panelSectionRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState<string | null>(
    null,
  );
  const [githubConnected, setGithubConnected] = useState(false);
  const [hasRepoAccess, setHasRepoAccess] = useState(false);
  const sessionCount = tasks.length;

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      fetchDashboardSettingsSafe(),
      fetchGitHubStatusSafe(),
    ]).then(([settings, github]) => {
      if (!cancelled) {
        setSelectedRepository(settings.selectedRepository);
        setGithubConnected(github.connected);
        setHasRepoAccess(github.hasRepoAccess);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function handleDismissConfirmed() {
    const measured = panelSectionRef.current?.offsetHeight ?? 0;
    setPanelHeight(measured);
    setIsDismissed(true);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsCollapsing(true);
      });
    });
  }

  if (activeTask) {
    return (
      <div className="flex min-h-0 w-full max-w-[900px] flex-1 flex-col self-center overflow-hidden">
        <SessionDetail
          key={activeTask.id}
          task={activeTask}
          onBack={() => selectTask(null)}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div
        className={cn(
          "grid min-h-0 w-full flex-1 grid-rows-[minmax(0,1fr)_auto]",
          isCollapsing && "overflow-hidden",
        )}
      >
        <div className="flex min-h-0 items-center justify-center">
          <div className="w-full max-w-[840px] space-y-4">
            <PromptComposer selectedRepository={selectedRepository} />
            <GitHubPermissionsPanel compact />
          </div>
        </div>

        <motion.div
          ref={panelSectionRef}
          initial={false}
          animate={{
            height: isCollapsing ? 0 : (panelHeight ?? "auto"),
            opacity: isCollapsing ? 0 : 1,
            paddingTop: isCollapsing ? 0 : 32,
            paddingBottom: isCollapsing ? 0 : 8,
          }}
          transition={collapseTransition}
          className="min-h-0 overflow-hidden"
          aria-hidden={isDismissed}
        >
          <div
            className={cn(
              "mx-auto w-full max-w-[840px]",
              isDismissed && "pointer-events-none select-none",
            )}
          >
            <OnboardingPanel
              githubConnected={githubConnected}
              hasRepoAccess={hasRepoAccess}
              hasRepository={Boolean(selectedRepository)}
              sessionCount={sessionCount}
              onDismissConfirmed={
                isDismissed ? undefined : handleDismissConfirmed
              }
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
