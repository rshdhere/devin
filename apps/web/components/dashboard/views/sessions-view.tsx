"use client";

import { useEffect, useState } from "react";
import { PromptComposer } from "@/components/dashboard/prompt-composer";
import { fetchDashboardSettingsSafe } from "@/lib/dashboard-settings-api";

export function SessionsView() {
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
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <div className="w-full max-w-[680px]">
          <PromptComposer selectedRepository={selectedRepository} />
        </div>
      </div>
    </div>
  );
}
