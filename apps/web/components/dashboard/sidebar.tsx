"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  Download,
  GitBranch,
  GitPullRequest,
  HelpCircle,
  History,
  MessageCircleQuestion,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import {
  navIdFromPathname,
  navItems,
  recentEmptyLabels,
  sessionIdFromPathname,
} from "@/components/dashboard/dashboard-nav";
import { useSessions } from "@/components/dashboard/sessions-context";
import { reviewRecentItems } from "@/components/dashboard/views/review-view";
import { MotionButton } from "@/components/dashboard/motion-button";
import { UserMenu } from "@/components/dashboard/user-menu";
import { cn } from "@/lib/utils";
import { taskSessionLabel } from "@/lib/sessions/labels";

const SIDEBAR_COLLAPSED_KEY = "devin.sidebar.collapsed";
const SIDEBAR_EXPANDED_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 56;

const sidebarSpring = {
  type: "spring" as const,
  stiffness: 320,
  damping: 34,
  mass: 0.85,
};

const fadeTransition = {
  duration: 0.18,
  ease: "easeOut" as const,
};

const navIcons = {
  sessions: MessageSquare,
  ask: MessageCircleQuestion,
  automations: History,
  review: GitBranch,
  wiki: BookOpen,
} as const;

interface SidebarProps {
  userName: string;
}

export function Sidebar({ userName }: SidebarProps) {
  const pathname = usePathname();
  const activeNav = navIdFromPathname(pathname);
  const activeSessionId = sessionIdFromPathname(pathname);
  const { tasks } = useSessions();
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (stored === "1") {
        setCollapsed(true);
      }
    } catch {
      // ignore storage errors
    }
    setHydrated(true);
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }

  return (
    <motion.aside
      initial={false}
      animate={{
        width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
      }}
      transition={hydrated ? sidebarSpring : { duration: 0 }}
      className="relative flex h-full shrink-0 flex-col overflow-hidden border-r border-[#252525] bg-[#111111]"
    >
      <div
        className={cn(
          "flex items-center pt-3 pb-2",
          collapsed ? "flex-col gap-1 px-1.5" : "gap-2 px-3",
        )}
      >
        <UserMenu userName={userName} collapsed={collapsed} />

        <div
          className={cn(
            "flex shrink-0 items-center",
            collapsed ? "flex-col gap-0.5" : "gap-0.5",
          )}
        >
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.div
                key="search"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={fadeTransition}
              >
                <MotionButton
                  type="button"
                  pressStyle="icon"
                  className="cursor-pointer rounded-md p-1.5 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-200"
                  aria-label="Search"
                >
                  <Search className="size-4" strokeWidth={1.75} />
                </MotionButton>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <MotionButton
            type="button"
            pressStyle="icon"
            onClick={toggleCollapsed}
            className="cursor-pointer rounded-md p-1.5 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-200"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            <PanelLeft
              className={cn(
                "size-4 transition-transform duration-300",
                collapsed && "rotate-180",
              )}
              strokeWidth={1.75}
            />
          </MotionButton>
        </div>
      </div>

      <nav className={cn("mt-1 space-y-0.5", collapsed ? "px-1.5" : "px-2")}>
        {navItems.map((item) => {
          const Icon = navIcons[item.id];
          const isActive = activeNav === item.id;

          return (
            <Link
              key={item.id}
              href={item.href}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex w-full cursor-pointer items-center rounded-lg text-[14px] font-medium transition-all duration-200",
                collapsed
                  ? "justify-center px-0 py-2.5"
                  : "gap-2.5 px-2.5 py-2",
                isActive
                  ? "bg-[#252525] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  : "text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-100",
              )}
            >
              <Icon
                className={cn(
                  "size-[18px] shrink-0 transition-colors duration-200",
                  isActive ? "text-gray-100" : "text-gray-500",
                )}
                strokeWidth={1.75}
              />
              <AnimatePresence initial={false}>
                {!collapsed ? (
                  <motion.span
                    key="label"
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={fadeTransition}
                    className="truncate"
                  >
                    {item.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          {!collapsed ? (
            <motion.div
              key="recent"
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={fadeTransition}
              className="h-full overflow-y-auto px-3"
            >
              <div className="flex items-center justify-between px-1">
                <span className="text-[13px] font-medium text-gray-500">
                  Recent
                </span>
                <div className="flex items-center">
                  <MotionButton
                    type="button"
                    pressStyle="icon"
                    className="cursor-pointer rounded-md p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
                    aria-label="Search recent"
                  >
                    <Search className="size-3.5" strokeWidth={1.75} />
                  </MotionButton>
                  <Link
                    href="/s"
                    className="cursor-pointer rounded-md p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
                    aria-label="Create new"
                  >
                    <Plus className="size-3.5" strokeWidth={1.75} />
                  </Link>
                  <MotionButton
                    type="button"
                    pressStyle="icon"
                    className="cursor-pointer rounded-md p-1 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
                    aria-label="More options"
                  >
                    <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
                  </MotionButton>
                </div>
              </div>

              {activeNav === "review" ? (
                <div className="mt-2 space-y-0.5">
                  {reviewRecentItems.map((item) => (
                    <MotionButton
                      key={item.id}
                      type="button"
                      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-[#1a1a1a]"
                    >
                      <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                      <div className="min-w-0">
                        <p className="truncate text-[13px] text-gray-300">
                          {item.title}
                        </p>
                        <p className="text-[11px] text-gray-600">{item.meta}</p>
                      </div>
                    </MotionButton>
                  ))}
                </div>
              ) : activeNav === "sessions" ? (
                <div className="mt-2 space-y-0.5">
                  {tasks.length === 0 ? (
                    <p className="px-1 text-[13px] text-gray-600">
                      {recentEmptyLabels.sessions}
                    </p>
                  ) : (
                    tasks.slice(0, 12).map((task) => (
                      <Link
                        key={task.id}
                        href={`/s/${task.id}`}
                        className={cn(
                          "flex w-full cursor-pointer items-start gap-2 rounded-md px-1 py-2 text-left transition-colors hover:bg-[#1a1a1a]",
                          activeSessionId === task.id && "bg-[#1a1a1a]",
                        )}
                      >
                        <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-gray-500" />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] text-gray-300">
                            {taskSessionLabel(task)}
                          </p>
                          <p className="text-[11px] text-gray-600">
                            {task.repository ?? task.status}
                          </p>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              ) : (
                <p className="mt-2.5 px-1 text-[13px] text-gray-600">
                  {recentEmptyLabels[activeNav]}
                </p>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div
        className={cn(
          "mt-auto pt-2 pb-4",
          collapsed ? "flex flex-col items-center gap-1 px-1.5" : "px-3",
        )}
      >
        <MotionButton
          type="button"
          title="Upgrade"
          className={cn(
            "cursor-pointer items-center rounded-lg text-[14px] font-medium text-[#5a9fd4] transition-colors hover:bg-[#1a1a1a] hover:text-[#6aa8ef]",
            collapsed
              ? "flex justify-center p-2"
              : "mb-2 flex w-full gap-2 px-2.5 py-2",
          )}
        >
          <Sparkles className="size-4 shrink-0" strokeWidth={1.75} />
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.span
                key="upgrade"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={fadeTransition}
              >
                Upgrade
              </motion.span>
            ) : null}
          </AnimatePresence>
        </MotionButton>

        <div
          className={cn(
            "flex items-center",
            collapsed ? "flex-col gap-0.5" : "gap-0.5 px-0.5",
          )}
        >
          <MotionButton
            type="button"
            pressStyle="icon"
            className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
            aria-label="Settings"
          >
            <Settings className="size-4" strokeWidth={1.75} />
          </MotionButton>
          <MotionButton
            type="button"
            pressStyle="icon"
            className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
            aria-label="Download"
          >
            <Download className="size-4" strokeWidth={1.75} />
          </MotionButton>
          <MotionButton
            type="button"
            pressStyle="icon"
            className="cursor-pointer rounded-lg p-2 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-300"
            aria-label="Help"
          >
            <HelpCircle className="size-4" strokeWidth={1.75} />
          </MotionButton>
        </div>
      </div>
    </motion.aside>
  );
}
