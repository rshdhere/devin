"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskEvent, TaskStatus } from "@devin/types";
import { fetchTaskEventHistory } from "@/lib/api/tasks";
import { subscribeToTaskEvents } from "@/lib/api/task-events";

interface UseTaskEventsOptions {
  reconnect?: boolean;
  terminalStatuses?: TaskStatus[];
}

export function useTaskEvents(
  taskId: string,
  taskStatus: TaskStatus,
  options?: UseTaskEventsOptions,
) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const terminalStatuses = useMemo(
    () =>
      options?.terminalStatuses ??
      (["completed", "failed", "cancelled"] as TaskStatus[]),
    [options?.terminalStatuses],
  );

  useEffect(() => {
    let cancelled = false;
    setStreamError(null);

    void fetchTaskEventHistory(taskId)
      .then((history) => {
        if (!cancelled && history.length > 0) {
          setEvents(
            [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
          );
        }
      })
      .catch(() => {
        // SSE replay remains the fallback.
      });

    const unsubscribe = subscribeToTaskEvents(
      taskId,
      (event) => {
        if (cancelled || event.taskId !== taskId) {
          return;
        }

        setEvents((current) => {
          if (current.some((item) => item.id === event.id)) {
            return current;
          }
          return [...current, event].sort((a, b) =>
            a.timestamp.localeCompare(b.timestamp),
          );
        });
      },
      (error) => {
        if (!cancelled) {
          setStreamError(error.message);
        }
      },
      {
        reconnect: options?.reconnect ?? !terminalStatuses.includes(taskStatus),
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [taskId, taskStatus, options?.reconnect, terminalStatuses]);

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [events.length]);

  return { events, setEvents, streamError, setStreamError, feedRef };
}
