"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { navIdFromPathname } from "@/components/dashboard/dashboard-nav";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionsProvider } from "@/components/dashboard/sessions-context";

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
            className={
              isSessionsLayout
                ? "relative flex min-h-0 flex-1 flex-col items-center overflow-hidden px-6 pt-3 pb-8"
                : "relative flex flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto px-8 pt-3 pb-8"
            }
          >
            {children}
          </main>
        </div>
      </div>
    </SessionsProvider>
  );
}
