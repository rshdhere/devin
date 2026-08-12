"use client";

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitCommit,
  Terminal,
} from "lucide-react";
import { DEVIN_BOT } from "@/lib/devin-bot";
import type { Task, TaskEvent } from "@devin/types";
import { usesRuntimeAgent } from "@devin/types";
import { eventTypeLabel, formatEventData } from "@/lib/tasks-api";
import { cn } from "@/lib/utils";
import { eventColor, eventIcon } from "./session-detail-utils";

export function CollapsiblePanel({
  title,
  icon: Icon,
  iconClassName,
  defaultExpanded = true,
  headerRight,
  children,
  className,
}: {
  title: string;
  icon: typeof Terminal;
  iconClassName?: string;
  defaultExpanded?: boolean;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#111]",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[#161616]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-4 shrink-0", iconClassName)} />
          <h2 className="text-[13px] font-medium text-gray-300">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {headerRight}
          {expanded ? (
            <ChevronDown className="size-4 text-gray-500" />
          ) : (
            <ChevronRight className="size-4 text-gray-500" />
          )}
        </div>
      </button>
      {expanded ? (
        <div className="border-t border-[#252525] px-4 py-3">{children}</div>
      ) : null}
    </div>
  );
}

export function LiveWorkPanel({
  task,
  events,
}: {
  task: Task;
  events: TaskEvent[];
}) {
  const draftEvents = events.filter((event) => event.type.startsWith("draft."));
  const stepEvents = events.filter((event) => event.type === "draft.updated");
  const fileEvents = events.filter((event) => event.type === "draft.diff");
  const agentLogEvents = events.filter(
    (event) =>
      event.type === "agent.log" ||
      event.type === "agent.tool" ||
      event.type === "agent.started" ||
      event.type === "agent.completed",
  );
  const latestDraft = draftEvents[draftEvents.length - 1];
  const draftSummary = events.find((event) => event.type === "draft.completed")
    ?.data?.summary;
  const runtimeAgent = usesRuntimeAgent(task.agent);
  const reviewDiff = events.find((event) => event.data?.awaitingReview === true)
    ?.data?.diff;

  if (
    draftEvents.length === 0 &&
    agentLogEvents.length === 0 &&
    task.status !== "drafting" &&
    task.status !== "draft_ready" &&
    task.status !== "running" &&
    task.status !== "awaiting_review"
  ) {
    return null;
  }

  const defaultExpanded = [
    "drafting",
    "draft_ready",
    "scheduling",
    "running",
    "awaiting_review",
  ].includes(task.status);

  const summaryText = runtimeAgent
    ? task.status === "awaiting_review"
      ? "Agent finished in the sandbox — review output and activity below."
      : String(
          agentLogEvents[agentLogEvents.length - 1]?.message ??
            "Runtime agent working in sandbox…",
        )
    : String(
        draftSummary ?? latestDraft?.message ?? "Generating draft plan...",
      );

  return (
    <CollapsiblePanel
      title="Live Work"
      icon={Terminal}
      iconClassName="text-indigo-300"
      defaultExpanded={defaultExpanded}
      className="border-indigo-500/30 bg-indigo-500/5"
    >
      <p className="text-[12px] text-indigo-100/80">{summaryText}</p>
      {stepEvents.length > 0 ? (
        <div className="mt-2 space-y-1">
          {stepEvents.slice(-4).map((event) => (
            <p key={event.id} className="text-[11px] text-indigo-100/70">
              • {event.message}
            </p>
          ))}
        </div>
      ) : null}
      {fileEvents.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2">
          {fileEvents.slice(-5).map((event) => (
            <p
              key={event.id}
              className="font-mono text-[11px] text-indigo-100/80"
            >
              {String(event.data?.path ?? "file")} —{" "}
              {String(event.data?.summary ?? event.message)}
            </p>
          ))}
        </div>
      ) : null}
      {agentLogEvents.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2">
          {agentLogEvents.slice(-6).map((event) => (
            <p key={event.id} className="text-[11px] text-indigo-100/80">
              • {event.message}
            </p>
          ))}
        </div>
      ) : null}
      {reviewDiff ? (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-indigo-500/20 bg-[#101326] px-3 py-2 font-mono text-[11px] leading-relaxed text-indigo-100/80">
          {String(reviewDiff)}
        </pre>
      ) : null}
    </CollapsiblePanel>
  );
}

export function BotCoAuthorNote({ compact = false }: { compact?: boolean }) {
  return (
    <p
      className={cn(
        "mt-1 flex flex-wrap items-center gap-1.5 text-emerald-400/80",
        compact ? "text-[11px]" : "text-[12px]",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- bot avatar is a static external URL */}
      <img
        src={DEVIN_BOT.avatarUrl}
        alt=""
        className="size-4 rounded-full border border-[#333]"
      />
      <span>Co-authored by</span>
      <a
        href={DEVIN_BOT.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[#5a9fd4] hover:underline"
      >
        @{DEVIN_BOT.username}
      </a>
    </p>
  );
}

export function GitHubProgressBanner({
  repository,
  events,
  branch,
}: {
  repository?: string;
  events: TaskEvent[];
  branch?: string;
}) {
  if (!repository) {
    return null;
  }

  const commitEvents = events.filter((event) => event.type === "git.commit");
  const pushEvents = events.filter((event) => event.type === "git.push");
  const successfulPush = [...pushEvents]
    .reverse()
    .find(
      (event) =>
        event.data?.failed !== true &&
        !/skipped or failed|push failed/i.test(event.message),
    );
  const failedPush = [...pushEvents]
    .reverse()
    .find(
      (event) =>
        event.data?.failed === true ||
        /skipped or failed|push failed/i.test(event.message),
    );
  const pushOk = Boolean(successfulPush);
  const failedBootstrap = commitEvents.some(
    (event) => event.data?.bootstrap && event.data?.error,
  );
  const targetBranch = branch ?? "main";
  const commitsUrl = `https://github.com/${repository}/commits/${targetBranch}`;
  const repoUrl = `https://github.com/${repository}`;

  return (
    <div className="mb-4 rounded-xl border border-[#2a2a2a] bg-[#111] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-200">
            GitHub: {repository}
          </p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {pushOk
              ? `Pushed to ${targetBranch} — commits should be visible on GitHub`
              : failedPush
                ? `Push to ${targetBranch} failed — commits may not be on GitHub yet`
                : commitEvents.length > 0
                  ? `${commitEvents.length} commit(s) recorded — waiting for push`
                  : "Waiting for initial commit and push…"}
          </p>
          {failedBootstrap ? (
            <p className="mt-1 text-[12px] text-red-400">
              Bootstrap failed — check activity log for details
            </p>
          ) : pushOk ? (
            <BotCoAuthorNote compact />
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-[#5a9fd4] transition-colors hover:bg-[#222]"
          >
            Open repo
            <ExternalLink className="size-3" />
          </a>
          <a
            href={commitsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[#333] bg-[#1a1a1a] px-3 py-1.5 text-[12px] text-emerald-400 transition-colors hover:bg-[#222]"
          >
            View commits
            <GitCommit className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

export function EventRow({ event }: { event: TaskEvent }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = eventIcon(event.type);
  const details = formatEventData(event.data);
  const hasDetails = details.length > 0;
  const isRepoCreated = event.type === "git.repo";

  return (
    <div className="rounded-lg px-2 py-2 transition-colors hover:bg-[#1a1a1a]/50">
      <div className="flex items-start gap-2.5">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            eventColor(event.type),
            event.type === "runtime.waiting" ? "animate-spin" : null,
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-[#1f1f1f] px-1.5 py-0.5 text-[10px] tracking-wide text-gray-500 uppercase">
              {eventTypeLabel(event.type)}
            </span>
            <p className="text-[13px] text-gray-300">{event.message}</p>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
            <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
            {event.data?.prUrl ? (
              <a
                href={String(event.data.prUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#5a9fd4] hover:underline"
              >
                Open PR
              </a>
            ) : null}
            {event.data?.htmlUrl ? (
              <a
                href={String(event.data.htmlUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#5a9fd4] hover:underline"
              >
                {isRepoCreated ? "Open repo" : "View"}
              </a>
            ) : null}
            {event.type === "git.push" && event.data?.branch ? (
              <span className="text-emerald-400/80">
                branch {String(event.data.branch)}
              </span>
            ) : null}
            {hasDetails ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="inline-flex cursor-pointer items-center gap-0.5 text-gray-500 hover:text-gray-300"
              >
                {expanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
                Details
              </button>
            ) : null}
          </div>
          {isRepoCreated ? <BotCoAuthorNote /> : null}
          {event.type === "git.commit" || event.type === "git.push" ? (
            <BotCoAuthorNote />
          ) : null}
          {expanded && hasDetails ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-[#0d0d0d] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-gray-400">
              {details.join("\n")}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
