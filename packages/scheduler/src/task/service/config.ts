import {
  resolveRuntimeForTask,
  inferStackFromPrompt,
  type StackRuntime,
} from "@devin/types";
import type { ScheduleJob, Task, ServiceMode } from "../types.js";

export function resolveServiceMode(): ServiceMode {
  const raw = process.env.SERVICE_MODE?.trim().toLowerCase();
  if (raw === "brain" || raw === "worker" || raw === "standalone") {
    return raw;
  }
  return "standalone";
}

export function hydrateTaskRuntime(task: Task): Task {
  if (!task.runtime) {
    task.runtime = resolveRuntimeForTask(task.agent, task.prompt);
  }
  return task;
}

export function resolveStackRuntime(
  task: Task,
  job?: ScheduleJob,
): StackRuntime {
  const candidate = task.runtime ?? job?.runtime;
  if (candidate && candidate !== "agent") {
    return candidate;
  }
  return inferStackFromPrompt(task.prompt);
}

export function resolveBotToken(): string | undefined {
  return process.env.GITHUB_BOT_TOKEN?.trim() || undefined;
}

export function resolveBotAuthor(): { name: string; email: string } {
  const defaultName = "baby-devin-bot";
  const defaultEmail = "baby-devin-bot@users.noreply.github.com";
  const rawName = process.env.GITHUB_BOT_NAME?.trim() || defaultName;
  const rawEmail = process.env.GITHUB_BOT_EMAIL?.trim() || defaultEmail;

  return {
    name: sanitizeBotEnvValue(rawName, defaultName),
    email: sanitizeBotEnvValue(rawEmail, defaultEmail),
  };
}

function sanitizeBotEnvValue(value: string, fallback: string): string {
  if (!value || value.includes("${") || value.includes(":-")) {
    return fallback;
  }
  return value;
}

function coAuthorTrailer(): string {
  const bot = resolveBotAuthor();
  return `Co-authored-by: ${bot.name} <${bot.email}>`;
}

export function buildCommitMessage(subject: string): string {
  return `${subject}\n\n${coAuthorTrailer()}`;
}

export function isNetworkCloneFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("could not resolve host") ||
    message.includes("name or service not known") ||
    message.includes("temporary failure in name resolution") ||
    message.includes("network is unreachable") ||
    message.includes("connection timed out") ||
    message.includes("failed to connect") ||
    message.includes("couldn't connect") ||
    message.includes("unable to access") ||
    message.includes("operation timed out") ||
    message.includes("no route to host") ||
    message.includes("git clone timed out") ||
    message.includes("cloning into '/workspace/")
  );
}

export function escapeShell(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

export function resolveAgentTimeoutMinutes(): number {
  const raw = process.env.AGENT_RUN_TIMEOUT_MIN?.trim();
  const defaultMinutes = 60;
  if (!raw) {
    return defaultMinutes;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return defaultMinutes;
  }
  return minutes;
}

export function resolveAgentMaxWaitMs(): number {
  return resolveAgentTimeoutMinutes() * 60 * 1000;
}

export function resolveTimeoutMs(
  envKey: string,
  defaultSeconds: number,
): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) {
    return defaultSeconds * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return defaultSeconds * 1000;
  }
  return seconds * 1000;
}

export function resolveSandboxCpu(_task: Task): number {
  const fromEnv = Number(process.env.SANDBOX_CPU?.trim());
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return 2;
}

export function resolveSandboxMemory(_task: Task): string {
  const fromEnv = process.env.SANDBOX_MEMORY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return "8Gi";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
