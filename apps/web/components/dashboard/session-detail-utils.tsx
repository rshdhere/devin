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

export function formatElapsedTime(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  const elapsed = Math.floor((now - start) / 1000);

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

export function useElapsedTime(startTime: string, isActive: boolean): string {
  const [elapsed, setElapsed] = useState(() => formatElapsedTime(startTime));

  useEffect(() => {
    if (!isActive) {
      setElapsed(formatElapsedTime(startTime));
      return;
    }

    const interval = setInterval(() => {
      setElapsed(formatElapsedTime(startTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime, isActive]);

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
