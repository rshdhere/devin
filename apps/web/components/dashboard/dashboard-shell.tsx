"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import {
  navIdFromPathname,
  sessionIdFromPathname,
} from "@/components/dashboard/dashboard-nav";
import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionsProvider } from "@/components/dashboard/sessions-context";
import { cn } from "@/lib/utils";

interface DashboardShellProps {
  userName: string;
  children: ReactNode;
}

const shellEase = [0.22, 1, 0.36, 1] as const;

export function DashboardShell({ userName, children }: DashboardShellProps) {
  const pathname = usePathname();
  const activeNav = navIdFromPathname(pathname);
  const isSessionsLayout = activeNav === "sessions";
  const isSessionWorkspace = Boolean(sessionIdFromPathname(pathname));

  return (
    <SessionsProvider>
      <div className="flex h-screen overflow-hidden bg-[#0d0d0d] text-white">
        <Sidebar userName={userName} />

        <div className="relative flex min-w-0 flex-1 flex-col">
          <motion.main
            key={isSessionWorkspace ? "session-workspace" : "app-main"}
            initial={{ opacity: 0.72, y: isSessionWorkspace ? 10 : 0 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: shellEase }}
            className={cn(
              isSessionWorkspace
                ? "relative flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2 lg:px-4"
                : isSessionsLayout
                  ? "relative flex min-h-0 flex-1 flex-col items-center overflow-hidden px-6 pt-3 pb-8"
                  : "relative flex flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto px-8 pt-3 pb-8",
            )}
          >
            {children}
          </motion.main>
        </div>
      </div>
    </SessionsProvider>
  );
}
