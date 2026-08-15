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
import {
  ChatLaunchMorphOverlay,
  measureChatColumnTargetRect,
  measureComposerShellRect,
  measureElementRect,
} from "@/components/dashboard/chat-launch-morph";
import {
  CHAT_MORPH_MS,
  type MorphRect,
} from "@/components/dashboard/prompt-composer-constants";

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

interface LaunchMorphState {
  from: MorphRect;
  to: MorphRect;
  fading: boolean;
  settled: boolean;
  prompt: string;
}

interface SessionsContextValue {
  tasks: Task[];
  isLoading: boolean;
  isLaunchingSession: boolean;
  isLaunchMorphing: boolean;
  isLaunchMorphFading: boolean;
  alignLaunchMorphToSlot: (slot: HTMLElement) => void;
  beginLaunchMorphFade: () => void;
  completeLaunchMorph: () => void;
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
  const [launchMorph, setLaunchMorph] = useState<LaunchMorphState | null>(null);

  useEffect(() => {
    if (!pathname.startsWith("/s/") || pathname === "/s") {
      return;
    }
    setIsLaunchingSession(false);
  }, [pathname]);

  const alignLaunchMorphToSlot = useCallback((slot: HTMLElement) => {
    const exact = measureElementRect(slot);
    if (!exact) {
      return;
    }
    setLaunchMorph((current) => {
      if (!current) {
        return current;
      }
      return { ...current, to: exact, settled: true };
    });
  }, []);

  const beginLaunchMorphFade = useCallback(() => {
    setLaunchMorph((current) =>
      current ? { ...current, fading: true } : null,
    );
  }, []);

  const completeLaunchMorph = useCallback(() => {
    setLaunchMorph(null);
  }, []);

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
      const from = measureComposerShellRect(
        document.querySelector("[data-composer-shell]"),
      );
      const to = measureChatColumnTargetRect();

      setIsLaunchingSession(true);
      if (from && to) {
        setLaunchMorph({
          from,
          to,
          fading: false,
          settled: false,
          prompt: input.prompt,
        });
      }

      try {
        const [task] = await Promise.all([
          createTask(input),
          sleep(CHAT_MORPH_MS),
        ]);
        setTasks((current) => [task, ...current]);
        router.push(`/s/${task.id}`);
        return task;
      } catch (error) {
        setIsLaunchingSession(false);
        setLaunchMorph(null);
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
      isLaunchMorphing: launchMorph !== null,
      isLaunchMorphFading: launchMorph?.fading === true,
      alignLaunchMorphToSlot,
      beginLaunchMorphFade,
      completeLaunchMorph,
      refreshTasks,
      startSession,
    }),
    [
      tasks,
      isLoading,
      isLaunchingSession,
      launchMorph,
      alignLaunchMorphToSlot,
      beginLaunchMorphFade,
      completeLaunchMorph,
      refreshTasks,
      startSession,
    ],
  );

  return (
    <SessionsContext.Provider value={value}>
      {children}
      {launchMorph ? (
        <ChatLaunchMorphOverlay
          from={launchMorph.from}
          to={launchMorph.to}
          fading={launchMorph.fading}
          settled={launchMorph.settled}
          prompt={launchMorph.prompt}
        />
      ) : null}
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
