"use client";

import { useEffect } from "react";
import type { Task, TaskEvent } from "@devin/types";
import { usesRuntimeAgent } from "@devin/types";
import {
  fetchTask,
  fetchTaskEventHistory,
  subscribeToTaskEvents,
} from "@/lib/tasks-api";

export function useSessionDetailEffects({
  task,
  initialTask,
  setTask,
  setEvents,
  streamError,
  setStreamError,
  refreshTasks,
  loadDiagnostics,
}: {
  task: Task;
  initialTask: Task;
  setTask: React.Dispatch<React.SetStateAction<Task>>;
  setEvents: React.Dispatch<React.SetStateAction<TaskEvent[]>>;
  streamError: string | null;
  setStreamError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshTasks: () => Promise<void>;
  loadDiagnostics: (taskId: string) => Promise<void>;
}) {
  useEffect(() => {
    setTask(initialTask);
  }, [initialTask, setTask]);

  useEffect(() => {
    setStreamError(null);

    const taskId = task.id;
    let cancelled = false;

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

        if (
          event.type === "sandbox.provisioning" ||
          event.type === "sandbox.failed" ||
          event.type === "task.failed"
        ) {
          void loadDiagnostics(taskId);
        }

        // Status lives on the task record; SSE only carries events. Refresh on
        // phase transitions so the header does not stay on "Booting devbox"
        // after the agent has already started.
        if (
          event.type === "task.completed" ||
          event.type === "task.failed" ||
          event.type === "task.phase_changed" ||
          (event.type === "task.scheduled" && event.data?.followUp === true) ||
          event.type === "agent.running" ||
          event.type === "sandbox.started" ||
          event.type === "runtime.ready" ||
          event.type === "git.push" ||
          event.type === "git.pr"
        ) {
          void fetchTask(taskId).then((updated) => {
            if (!cancelled) {
              setTask(updated);
              if (
                event.type === "task.completed" ||
                event.type === "task.failed"
              ) {
                void refreshTasks();
              }
            }
          });
        }
      },
      (error) => {
        if (!cancelled) {
          setStreamError(error.message);
        }
      },
      {
        reconnect:
          task.status !== "failed" &&
          task.status !== "cancelled" &&
          (task.status !== "completed" ||
            task.sessionActive === true ||
            task.sessionSleeping === true ||
            usesRuntimeAgent(task.agent)),
      },
    );

    if (
      task.status === "failed" ||
      task.status === "sandbox_starting" ||
      task.status === "scheduling"
    ) {
      void loadDiagnostics(taskId);
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    task.id,
    task.status,
    task.sessionActive,
    task.sessionSleeping,
    task.agent,
    refreshTasks,
    loadDiagnostics,
    setEvents,
    setStreamError,
    setTask,
  ]);

  useEffect(() => {
    if (!streamError) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      void fetchTaskEventHistory(task.id)
        .then((history) => {
          if (!cancelled && history.length > 0) {
            setEvents(
              [...history].sort((a, b) =>
                a.timestamp.localeCompare(b.timestamp),
              ),
            );
            setStreamError(null);
          }
        })
        .catch(() => undefined);
      void fetchTask(task.id)
        .then((updated) => {
          if (!cancelled) {
            setTask(updated);
          }
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [streamError, task.id, setEvents, setStreamError, setTask]);

  // Poll task status while non-terminal so a dropped SSE stream cannot leave
  // the header stuck on "Booting devbox".
  useEffect(() => {
    const terminal =
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled";
    if (terminal) {
      return;
    }

    let cancelled = false;
    const tick = () => {
      void fetchTask(task.id)
        .then((updated) => {
          if (!cancelled) {
            setTask(updated);
          }
        })
        .catch(() => {
          // SSE / history remain the primary feed.
        });
    };

    const interval = setInterval(tick, 12_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [task.id, task.status, setTask]);
}
