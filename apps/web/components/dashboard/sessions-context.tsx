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
import { usePathname, useRouter } from "next/navigation";
import { createTask, fetchTasks } from "@/lib/api/tasks";
import type { Task } from "@devin/types";

const SESSION_EXIT_MS = 380;

interface StartSessionInput {
  prompt: string;
  agent?: Task["agent"];
  repository?: string;
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
  agentModel?: string;
}

interface SessionsContextValue {
  tasks: Task[];
  isLoading: boolean;
  isLaunchingSession: boolean;
  refreshTasks: () => Promise<void>;
  startSession: (input: StartSessionInput) => Promise<Task>;
}

const SessionsContext = createContext<SessionsContextValue | null>(null);

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function SessionsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLaunchingSession, setIsLaunchingSession] = useState(false);

  useEffect(() => {
    if (!pathname.startsWith("/s/") || pathname === "/s") {
      return;
    }
    setIsLaunchingSession(false);
  }, [pathname]);

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
    async (input: StartSessionInput) => {
      setIsLaunchingSession(true);
      try {
        const [task] = await Promise.all([
          createTask(input),
          sleep(SESSION_EXIT_MS),
        ]);
        setTasks((current) => [task, ...current]);
        router.push(`/s/${task.id}`);
        return task;
      } catch (error) {
        setIsLaunchingSession(false);
        throw error;
      }
    },
    [router],
  );

  const value = useMemo(
    () => ({
      tasks,
      isLoading,
      isLaunchingSession,
      refreshTasks,
      startSession,
    }),
    [tasks, isLoading, isLaunchingSession, refreshTasks, startSession],
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
