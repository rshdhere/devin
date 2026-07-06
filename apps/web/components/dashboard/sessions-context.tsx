"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createTask, fetchTasks } from "@/lib/api/tasks";
import type { Task } from "@devin/types";

interface SessionsContextValue {
  tasks: Task[];
  activeTaskId: string | null;
  isLoading: boolean;
  refreshTasks: () => Promise<void>;
  startSession: (input: {
    prompt: string;
    agent?: Task["agent"];
    repository?: string;
    createRepository?: string;
    autoCreateRepository?: boolean;
    autoStartSandbox?: boolean;
    testCommand?: string;
    issueTitle?: string;
    issueBody?: string;
  }) => Promise<Task>;
  selectTask: (taskId: string | null) => void;
  activeTask: Task | null;
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshTasks = useCallback(async () => {
    try {
      const next = await fetchTasks();
      setTasks(next);
    } catch {
      // keep existing list on transient errors
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchTasks()
      .then((next) => {
        if (!cancelled) {
          setTasks(next);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const startSession = useCallback(
    async (input: {
      prompt: string;
      agent?: Task["agent"];
      repository?: string;
      createRepository?: string;
      autoCreateRepository?: boolean;
      testCommand?: string;
      issueTitle?: string;
      issueBody?: string;
    }) => {
      const task = await createTask(input);
      setTasks((current) => [task, ...current]);
      setActiveTaskId(task.id);
      return task;
    },
    [],
  );

  const selectTask = useCallback((taskId: string | null) => {
    setActiveTaskId(taskId);
  }, []);

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  const value = useMemo(
    () => ({
      tasks,
      activeTaskId,
      isLoading,
      refreshTasks,
      startSession,
      selectTask,
      activeTask,
    }),
    [
      tasks,
      activeTaskId,
      isLoading,
      refreshTasks,
      startSession,
      selectTask,
      activeTask,
    ],
  );

  return (
    <SessionsContext.Provider value={value}>
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessions() {
  const context = useContext(SessionsContext);
  if (!context) {
    throw new Error("useSessions must be used within SessionsProvider");
  }
  return context;
}
