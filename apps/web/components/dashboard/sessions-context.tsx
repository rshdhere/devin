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
import { useRouter } from "next/navigation";
import { createTask, fetchTasks } from "@/lib/api/tasks";
import type { Task } from "@devin/types";

interface SessionsContextValue {
  tasks: Task[];
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
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
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
      router.push(`/s/${task.id}`);
      return task;
    },
    [router],
  );

  const value = useMemo(
    () => ({
      tasks,
      isLoading,
      refreshTasks,
      startSession,
    }),
    [tasks, isLoading, refreshTasks, startSession],
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
