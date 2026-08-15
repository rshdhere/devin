"use client";

import { useEffect, useState } from "react";
import { PromptComposer } from "@/components/dashboard/prompt-composer";
import { workspaceShellClassName } from "@/components/dashboard/prompt-composer-constants";
import { useSessions } from "@/components/dashboard/sessions-context";
import { fetchDashboardSettingsSafe } from "@/lib/dashboard-settings-api";
import { cn } from "@/lib/utils";

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
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4">
        <div
          className={cn(
            "w-full max-w-[680px]",
            isLaunchingSession && "pointer-events-none",
          )}
        >
          <PromptComposer
            selectedRepository={selectedRepository}
            isLaunching={isLaunchingSession}
            shellClassName={workspaceShellClassName}
          />
        </div>
      </div>
    </div>
  );
}
