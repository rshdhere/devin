"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";
import type { TaskEvent } from "@devin/types";

export function formatElapsedTime(
  startTime: string,
  isActive = false,
  events: TaskEvent[] = [],
): string {
  const fallbackStart = new Date(startTime).getTime();
  const orderedEvents = [...events].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const terminalTypes = new Set(["task.completed", "task.failed"]);
  let activeStart: number | null = null;
  let elapsedMs = 0;

  for (const event of orderedEvents) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    if (event.type === "execution.started") {
      activeStart ??= timestamp;
    } else if (terminalTypes.has(event.type) && activeStart !== null) {
      elapsedMs += Math.max(0, timestamp - activeStart);
      activeStart = null;
    }
  }

  if (activeStart !== null) {
    elapsedMs += Math.max(0, Date.now() - activeStart);
  } else if (elapsedMs === 0) {
    const terminal = orderedEvents.find((event) =>
      terminalTypes.has(event.type),
    );
    const end = terminal ? Date.parse(terminal.timestamp) : Date.now();
    elapsedMs = Math.max(0, end - fallbackStart);
  } else if (isActive) {
    elapsedMs = Math.max(0, Date.now() - fallbackStart);
  }

  const elapsed = Math.floor(elapsedMs / 1000);

  if (elapsed < 60) {
    return `${elapsed}s`;
  }
  if (elapsed < 3600) {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  return `${hours}h ${mins}m`;
}

export function useElapsedTime(
  startTime: string,
  isActive: boolean,
  events: TaskEvent[] = [],
): string {
  const [elapsed, setElapsed] = useState(() =>
    formatElapsedTime(startTime, isActive, events),
  );

  useEffect(() => {
    const update = () => {
      setElapsed(formatElapsedTime(startTime, isActive, events));
    };
    update();

    if (!isActive) {
      return;
    }

    const interval = setInterval(() => {
      update();
    }, 1000);

    return () => clearInterval(interval);
  }, [events, isActive, startTime]);

  return elapsed;
}

export function eventIcon(type: TaskEvent["type"]) {
  if (type.startsWith("draft.") || type === "task.phase_changed") {
    return Terminal;
  }
  if (type.startsWith("sandbox.")) {
    if (type === "sandbox.failed") return XCircle;
    if (type === "sandbox.started") return CheckCircle2;
    return Server;
  }
  if (type.startsWith("runtime.")) {
    return type === "runtime.ready" ? CheckCircle2 : Loader2;
  }
  if (type.startsWith("git.")) {
    if (type === "git.pr") return GitPullRequest;
    if (type === "git.commit") return GitCommit;
    if (type === "git.repo") return FolderPlus;
    return GitBranch;
  }
  if (type === "agent.output") return Terminal;
  if (type === "task.completed") return CheckCircle2;
  if (type === "task.failed") return XCircle;
  return Terminal;
}

export function eventColor(type: TaskEvent["type"]) {
  if (
    type === "draft.completed" ||
    type === "execution.started" ||
    type === "task.phase_changed"
  ) {
    return "text-indigo-300";
  }
  if (type === "draft.failed") {
    return "text-red-400";
  }
  if (type.startsWith("draft.")) {
    return "text-indigo-400";
  }
  if (
    type === "task.completed" ||
    type === "sandbox.started" ||
    type === "runtime.ready"
  ) {
    return "text-emerald-400";
  }
  if (type === "task.failed" || type === "sandbox.failed") {
    return "text-red-400";
  }
  if (type.startsWith("sandbox.") || type.startsWith("runtime.")) {
    return "text-amber-300";
  }
  if (type === "git.repo") return "text-emerald-400";
  if (type.startsWith("git.")) return "text-[#5a9fd4]";
  if (type === "agent.output") return "text-green-400";
  return "text-gray-400";
}
