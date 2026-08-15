"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import type { Task } from "@devin/types";
import { SessionDetail } from "@/components/dashboard/session-detail";
import { useSessions } from "@/components/dashboard/sessions-context";
import { fetchTask } from "@/lib/api/tasks";
import { LoadingScreen } from "@/components/loading-screen";

interface SessionPageProps {
  sessionId: string;
}

const enterEase = [0.22, 1, 0.36, 1] as const;

export function SessionPage({ sessionId }: SessionPageProps) {
  const router = useRouter();
  const { tasks, isLoading: tasksLoading } = useSessions();
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

  if (!task && (tasksLoading || isFetching) && !fetchFailed) {
    // Fresh navigation from composer already has the task in context —
    // only show the heavy loader for cold deep-links.
    if (tasksLoading && tasks.length === 0) {
      return <LoadingScreen />;
    }
    return (
      <motion.div
        className="flex min-h-0 w-full flex-1 items-center justify-center bg-[#0a0a0a]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
      >
        <div className="h-8 w-8 animate-pulse rounded-full bg-white/10" />
      </motion.div>
    );
  }

  if (!task || fetchFailed) {
    return (
      <div className="flex min-h-0 w-full max-w-[900px] flex-1 flex-col items-center justify-center gap-3 self-center text-center">
        <p className="text-[15px] text-gray-300">Session not found</p>
        <button
          type="button"
          onClick={() => router.push("/s")}
          className="cursor-pointer text-[14px] text-[#5a9fd4] hover:text-[#6aa8ef]"
        >
          Back to composer
        </button>
      </div>
    );
  }

  return (
    <motion.div
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: enterEase }}
    >
      <SessionDetail
        key={task.id}
        task={task}
        onBack={() => router.push("/s")}
      />
    </motion.div>
  );
}
