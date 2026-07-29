"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-[#252525] bg-[#111111]">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <UserMenu userName={userName} />

        <div className="flex shrink-0 items-center gap-0.5">
          <MotionButton
            type="button"
            pressStyle="icon"
            className="cursor-pointer rounded-md p-1.5 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-200"
            aria-label="Search"
          >
            <Search className="size-4" strokeWidth={1.75} />
          </MotionButton>
          <MotionButton
            type="button"
            pressStyle="icon"
            className="cursor-pointer rounded-md p-1.5 text-gray-500 transition-colors hover:bg-[#1a1a1a] hover:text-gray-200"
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="size-4" strokeWidth={1.75} />
          </MotionButton>
        </div>
      </div>

      <nav className="mt-1 space-y-0.5 px-2">
        {navItems.map((item) => {
          const Icon = navIcons[item.id];
          const isActive = activeNav === item.id;

          return (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-all duration-150",
                isActive
                  ? "bg-[#252525] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  : "text-gray-400 hover:bg-[#1a1a1a] hover:text-gray-100",
              )}
            >
              <Icon
                className={cn(
                  "size-[18px] shrink-0",
                  isActive ? "text-gray-100" : "text-gray-500",
                )}
                strokeWidth={1.75}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto px-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-[13px] font-medium text-gray-500">Recent</span>
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
                      {task.title ?? task.prompt}
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
      </div>

      <div className="mt-auto px-3 pt-2 pb-4">
        <MotionButton
          type="button"
          className="mb-2 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[14px] font-medium text-[#5a9fd4] transition-colors hover:bg-[#1a1a1a] hover:text-[#6aa8ef]"
        >
          <Sparkles className="size-4" strokeWidth={1.75} />
          Upgrade
        </MotionButton>

        <div className="flex items-center gap-0.5 px-0.5">
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
    </aside>
  );
}
