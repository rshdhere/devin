"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { navIdFromPathname } from "@/components/dashboard/dashboard-nav";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionsProvider } from "@/components/dashboard/sessions-context";
import { cn } from "@/lib/utils";

interface DashboardShellProps {
  userName: string;
  children: ReactNode;
}

export function DashboardShell({ userName, children }: DashboardShellProps) {
  const pathname = usePathname();
  const activeNav = navIdFromPathname(pathname);
  const isSessionsLayout = activeNav === "sessions";

  return (
    <SessionsProvider>
      <div className="flex h-screen overflow-hidden bg-[#0d0d0d] text-white">
        <Sidebar userName={userName} />

        <div className="relative flex min-w-0 flex-1 flex-col">
          <main
            className={cn(
              isSessionsLayout
                ? "relative flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2.5 lg:px-4 lg:py-3"
                : "relative flex flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto px-8 pt-3 pb-8",
            )}
          >
            {children}
          </main>
        </div>
      </div>
    </SessionsProvider>
  );
}
