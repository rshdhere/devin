"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Task } from "@devin/types";
import { SessionDetail } from "@/components/dashboard/session-detail";
import { workspaceShellClassName } from "@/components/dashboard/prompt-composer-constants";
import { useSessions } from "@/components/dashboard/sessions-context";
import { Diamond } from "@/components/loading-ui/diamond";
import { fetchTask } from "@/lib/api/tasks";
import { LoadingScreen } from "@/components/loading-screen";
import { cn } from "@/lib/utils";

interface SessionPageProps {
  sessionId: string;
}

export function SessionPage({ sessionId }: SessionPageProps) {
  const router = useRouter();
  const {
    tasks,
    isLoading: tasksLoading,
    isLaunchMorphing,
    isLaunchMorphFading,
  } = useSessions();
  const fromList = tasks.find((task) => task.id === sessionId) ?? null;
  const [fetchedTask, setFetchedTask] = useState<Task | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    setFetchedTask(null);
    setFetchFailed(false);
  }, [sessionId]);

  useEffect(() => {
    if (fromList || tasksLoading) {
      return;
    }

    let cancelled = false;
    setIsFetching(true);

    void fetchTask(sessionId)
      .then((task) => {
        if (!cancelled) {
          setFetchedTask(task);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFetchFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsFetching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fromList, sessionId, tasksLoading]);

  const task = fromList ?? fetchedTask;

  function handleBack() {
    router.push("/s");
  }

  if (!task && (tasksLoading || isFetching) && !fetchFailed) {
    if (tasksLoading && tasks.length === 0) {
      return <LoadingScreen />;
    }
    return (
      <div className="flex min-h-0 w-full flex-1 overflow-hidden lg:gap-3">
        <div
          data-chat-slot=""
          className={cn(
            workspaceShellClassName,
            "flex min-h-0 w-full min-w-0 flex-1 flex-col lg:w-[395px] lg:max-w-[395px] lg:flex-none",
            isLaunchMorphing && !isLaunchMorphFading && "invisible",
          )}
        />
        <div
          className={cn(
            workspaceShellClassName,
            "hidden min-h-0 flex-1 flex-col items-center justify-center text-zinc-300 lg:flex",
          )}
          role="status"
          aria-label="Loading workspace"
        >
          <Diamond className="size-10 text-zinc-300" />
        </div>
      </div>
    );
  }

  if (!task || fetchFailed) {
    return (
      <div className="flex min-h-0 w-full max-w-[900px] flex-1 flex-col items-center justify-center gap-3 self-center text-center">
        <p className="text-[15px] text-gray-300">Session not found</p>
        <button
          type="button"
          onClick={handleBack}
          className="cursor-pointer text-[14px] text-[#5a9fd4] hover:text-[#6aa8ef]"
        >
          Back to composer
        </button>
      </div>
    );
  }

  return <SessionDetail key={task.id} task={task} onBack={handleBack} />;
}
