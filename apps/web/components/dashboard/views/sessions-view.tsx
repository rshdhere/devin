"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { PromptComposer } from "@/components/dashboard/prompt-composer";
import { useSessions } from "@/components/dashboard/sessions-context";
import { fetchDashboardSettingsSafe } from "@/lib/dashboard-settings-api";

const launchEase = [0.22, 1, 0.36, 1] as const;

export function SessionsView() {
  const { isLaunchingSession } = useSessions();
  const [selectedRepository, setSelectedRepository] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    void fetchDashboardSettingsSafe().then((settings) => {
      if (!cancelled) {
        setSelectedRepository(settings.selectedRepository);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col">
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[#0a0a0a]"
        initial={false}
        animate={{
          opacity: isLaunchingSession ? 1 : 0,
        }}
        transition={{ duration: 0.4, ease: launchEase }}
      />

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4">
        <motion.div
          className="w-full max-w-[680px]"
          initial={false}
          animate={
            isLaunchingSession
              ? {
                  opacity: 0,
                  y: -18,
                  scale: 0.97,
                  filter: "blur(8px)",
                }
              : {
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  filter: "blur(0px)",
                }
          }
          transition={{ duration: 0.38, ease: launchEase }}
        >
          <PromptComposer selectedRepository={selectedRepository} />
        </motion.div>
      </div>
    </div>
  );
}
