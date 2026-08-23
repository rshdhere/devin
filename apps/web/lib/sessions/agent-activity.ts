import type { Task, TaskEvent } from "@devin/types";

/** Raw Cursor stream-json payloads should never appear in the session UI. */
export function looksLikeCursorStreamJson(text: string | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return false;
  if (trimmed.startsWith('{"type":')) return true;
  if (trimmed.includes('{"type":"thinking"')) return true;
  if (trimmed.includes('{"type":"tool_call"')) return true;
  return false;
}

/** Collapse huge agent failure blobs into a short user-facing line. */
export function formatAgentFailureMessage(
  raw: string | undefined | null,
): string {
  const text = raw?.trim() ?? "";
  if (!text) return "";
  if (!looksLikeCursorStreamJson(text) && text.length <= 480) {
    return text;
  }

  const retriable = text.match(
    /RetriableError:\s*(?:\[[^\]]+\]\s*)?(.+?)(?:\s*$|\s*\{)/,
  );
  if (retriable?.[1]) {
    const core = retriable[1].trim();
    if (/database or disk is full/i.test(core)) {
      return "Cursor agent failed: sandbox disk or agent database is full on the execution host. Free disk space (or remove old sandboxes), then retry the task.";
    }
    if (/enospc|no space left on device/i.test(core)) {
      return "Sandbox workspace ran out of disk (ENOSPC). Retry the task — the platform now prunes caches and uses a larger workspace tmpfs.";
    }
    if (/resource_exhausted/i.test(core) || /resource_exhausted/i.test(text)) {
      return "Cursor agent hit a temporary resource limit (resource_exhausted). Work already on disk is finalized when possible — retry if the session failed.";
    }
    return `Cursor agent error: ${core.slice(0, 240)}`;
  }

  if (/database or disk is full/i.test(text)) {
    return "Sandbox disk or agent database is full on the execution host. Free disk space and retry.";
  }

  if (/enospc|no space left on device/i.test(text)) {
    return "Sandbox workspace ran out of disk (ENOSPC). Retry the task after redeploying the runtime — caches are pruned automatically and tmpfs is larger.";
  }

  if (/resource_exhausted/i.test(text)) {
    return "Cursor agent hit a temporary resource limit (resource_exhausted). Work already on disk is finalized when possible — retry if the session failed.";
  }

  const assistantTexts = [
    ...text.matchAll(/"type":"text","text":"((?:\\.|[^"\\])*)"/g),
  ];
  if (assistantTexts.length > 0) {
    const last = assistantTexts[assistantTexts.length - 1]?.[1];
    if (last && last.length >= 24) {
      return last.replace(/\\n/g, "\n").replace(/\\"/g, '"').slice(0, 320);
    }
  }

  return text.length > 320 ? `${text.slice(0, 320)}…` : text;
}

/** Cursor stream-json heartbeats and token deltas — not user-facing. */
export function isAgentStreamNoise(message: string | undefined): boolean {
  const text = message?.trim() ?? "";
  if (!text) return true;
  if (looksLikeCursorStreamJson(text)) return true;
  const lower = text.toLowerCase();
  if (lower.startsWith("thinking:")) return true;
  if (lower.startsWith("assistant_delta:")) return true;
  if (/^cursor agent working — no output for \d+s$/i.test(text)) return true;
  if (lower === "connection: reconnected") return true;
  if (lower === "connection: reconnecting") return true;
  if (lower === "retrying cursor agent session") return true;
  if (/^hook[a-z]/i.test(text)) return true;
  if (text.includes("hookAdditionalContexts")) return true;
  return false;
}

export function filterAgentOutputEvents(events: TaskEvent[]): TaskEvent[] {
  return events.filter(
    (event) =>
      event.type === "agent.output" && !isAgentStreamNoise(event.message),
  );
}

export function latestProgressLine(events: TaskEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type === "agent.tool" && event.data?.tool) {
      const tool = String(event.data.tool);
      if (isToolMetadataName(tool) || /^hook/i.test(tool)) {
        continue;
      }
      const detail =
        typeof event.data.detail === "string" ? event.data.detail : "";
      const humanized = humanizeToolProgressLine(tool, detail);
      if (humanized) {
        return humanized;
      }
      return event.message?.trim() || tool;
    }
    if (event.type === "agent.output" && !isAgentStreamNoise(event.message)) {
      const msg = event.message.trim();
      if (msg.length > 0 && msg.length <= 160) {
        return msg;
      }
    }
    if (
      event.type === "draft.updated" ||
      event.type === "sandbox.provisioning" ||
      event.type === "execution.started"
    ) {
      const msg = event.message?.trim();
      if (msg) return msg;
    }
  }
  return null;
}

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

const TOOL_METADATA_NAMES = new Set([
  "toolcallid",
  "tool",
  "id",
  "callid",
  "requestid",
]);

export function isToolMetadataName(tool: string): boolean {
  return TOOL_METADATA_NAMES.has(tool.trim().toLowerCase());
}

/** Prefer bun in UI when the agent emits npm commands in the sandbox. */
export function normalizePackageManagerCommand(command: string): string {
  return command
    .replace(/\bnpm run\b/g, "bun run")
    .replace(/\bnpm install\b/g, "bun install")
    .replace(/\bnpm ci\b/g, "bun install")
    .replace(/\bnpm start\b/g, "bun run start");
}

export function humanizeToolProgressLine(
  tool: string,
  detail: string,
): string | null {
  if (isToolMetadataName(tool) || /^hook/i.test(tool)) {
    return null;
  }
  const shortDetail = normalizePackageManagerCommand(
    detail.split("\n")[0]?.trim() ?? "",
  );
  const fileName = shortDetail
    ? fileDisplayName(normalizeSandboxFilePath(shortDetail))
    : "";
  switch (tool) {
    case "Write":
    case "write_file":
    case "ApplyPatch":
      return fileName ? `Edited \`${fileName}\`` : "Edited a file";
    case "Read":
    case "read_file":
      return fileName ? `Read \`${fileName}\`` : "Read a file";
    case "List":
    case "list_dir":
      return shortDetail ? `Listed \`${shortDetail}\`` : "Listed a directory";
    case "Bash":
    case "Shell":
    case "shell":
      return shortDetail
        ? `Ran \`${shortDetail.length > 48 ? `${shortDetail.slice(0, 45)}…` : shortDetail}\``
        : "Ran a shell command";
    case "Edit":
      return fileName ? `Updated \`${fileName}\`` : "Updated a file";
    case "Commit":
    case "git_commit":
      return shortDetail
        ? `Committed · ${shortDetail.length > 48 ? `${shortDetail.slice(0, 45)}…` : shortDetail}`
        : "Committed changes";
    case "Push":
    case "git_push":
      return "Pushed branch";
    case "Finish":
    case "finish":
      return shortDetail ? `Finished · ${shortDetail}` : "Finished";
    default:
      if (shortDetail) {
        return `${tool} · ${shortDetail.length > 64 ? `${shortDetail.slice(0, 61)}…` : shortDetail}`;
      }
      return tool;
  }
}

export function looksLikeSyntheticFollowUpPrompt(text: string): boolean {
  return (
    text.includes("Continue the existing session using the context below") ||
    text.includes("Previous session context:")
  );
}

/** Prefer the real user text when older events stored the wrapped agent prompt. */
export function normalizeUserFacingPrompt(prompt: string): string | null {
  const text = prompt.trim();
  if (!text) {
    return null;
  }
  if (!looksLikeSyntheticFollowUpPrompt(text)) {
    return text;
  }
  const match = text.match(/New user request:\s*([\s\S]+)$/i);
  const extracted = match?.[1]?.trim();
  return extracted || null;
}

export function buildConversationMessages(
  task: Task,
  events: TaskEvent[],
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const seenUserIds = new Set<string>();
  const seenAssistant = new Set<string>();
  const seenFollowUpPrompts = new Set<string>();

  const pushUser = (id: string, content: string, timestamp?: string) => {
    const text = content.trim();
    if (!text || seenUserIds.has(id)) {
      return;
    }
    seenUserIds.add(id);
    messages.push({ id, role: "user", content: text, timestamp });
  };

  const pushFollowUpUser = (
    id: string,
    rawPrompt: string,
    timestamp?: string,
  ) => {
    const text = normalizeUserFacingPrompt(rawPrompt);
    if (!text || seenFollowUpPrompts.has(text)) {
      return false;
    }
    seenFollowUpPrompts.add(text);
    pushUser(id, text, timestamp);
    return true;
  };

  const pushAssistant = (id: string, content: string, timestamp?: string) => {
    const text = content.trim();
    if (
      !text ||
      text.length < 20 ||
      isAgentStreamNoise(text) ||
      looksLikeCursorStreamJson(text) ||
      seenAssistant.has(text)
    ) {
      return;
    }
    seenAssistant.add(text);
    messages.push({ id, role: "assistant", content: text, timestamp });
  };

  let hasUserFromEvents = false;
  for (const event of events) {
    const eventPrompt =
      typeof event.data?.prompt === "string" ? event.data.prompt.trim() : "";

    if (event.type === "task.created" && eventPrompt) {
      const text = normalizeUserFacingPrompt(eventPrompt) ?? eventPrompt;
      pushUser(event.id, text, event.timestamp);
      hasUserFromEvents = true;
      continue;
    }
    if (event.type === "task.scheduled" && event.data?.followUp === true) {
      if (
        eventPrompt &&
        pushFollowUpUser(event.id, eventPrompt, event.timestamp)
      ) {
        hasUserFromEvents = true;
      }
      continue;
    }
    if (
      event.type === "task.phase_changed" &&
      event.data?.followUp === true &&
      eventPrompt
    ) {
      if (pushFollowUpUser(event.id, eventPrompt, event.timestamp)) {
        hasUserFromEvents = true;
      }
      continue;
    }
    if (event.type === "execution.started" && eventPrompt) {
      if (event.data?.followUp === true) {
        if (
          pushFollowUpUser(`exec-${event.id}`, eventPrompt, event.timestamp)
        ) {
          hasUserFromEvents = true;
        }
      } else if (!hasUserFromEvents) {
        const text = normalizeUserFacingPrompt(eventPrompt) ?? eventPrompt;
        pushUser(`exec-${event.id}`, text, event.timestamp);
        hasUserFromEvents = true;
      }
      continue;
    }
    if (event.type === "agent.output" && !isAgentStreamNoise(event.message)) {
      pushAssistant(event.id, event.message, event.timestamp);
    }
  }

  if (!hasUserFromEvents && task.prompt.trim()) {
    pushUser("user-initial", task.prompt, task.createdAt);
  }

  messages.sort((a, b) => {
    const at = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
    return at - bt;
  });

  const terminal =
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "awaiting_review";

  if (terminal) {
    const summary = pickAssistantSummary(task, events);
    if (summary && !seenAssistant.has(summary)) {
      pushAssistant("assistant-summary", summary);
    }
  }

  return messages;
}

export function mergeTaskEvents(
  current: TaskEvent[],
  incoming: TaskEvent[],
): TaskEvent[] {
  const byId = new Map<string, TaskEvent>();
  for (const event of [...current, ...incoming]) {
    byId.set(event.id, event);
  }
  const merged = [...byId.values()];
  const confirmedPrompts = new Set(
    merged
      .filter(
        (event) =>
          event.data?.optimistic !== true &&
          typeof event.data?.prompt === "string",
      )
      .map((event) => String(event.data?.prompt)),
  );
  return merged
    .filter((event) => {
      if (event.data?.optimistic !== true) {
        return true;
      }
      const prompt = event.data?.prompt;
      return typeof prompt !== "string" || !confirmedPrompts.has(prompt);
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export type ChangedFile = {
  path: string;
  changeType: "added" | "modified" | "create" | string;
};

/** Normalize agent/UI paths to workspace-relative form (e.g. repo/app.py). */
export function normalizeSandboxFilePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (!p) {
    return p;
  }
  let prev = "";
  while (p !== prev) {
    prev = p;
    while (p.startsWith("/workspace/")) {
      p = p.slice("/workspace/".length);
    }
    p = p.replace(/^\/+/, "");
    while (p.startsWith("workspace/")) {
      p = p.slice("workspace/".length);
    }
  }
  if (
    p &&
    p !== "." &&
    !p.startsWith("repo/") &&
    p !== "repo" &&
    !p.startsWith(".home/") &&
    !p.startsWith(".build/")
  ) {
    return `repo/${p}`;
  }
  return p;
}

export function isAddedChangeType(changeType: string): boolean {
  const lower = changeType.toLowerCase();
  return lower === "added" || lower === "create" || lower === "new";
}

function isDependencyOrBuildPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    p.includes("/node_modules/") ||
    p.startsWith("node_modules/") ||
    p.includes("/.next/") ||
    p.startsWith(".next/") ||
    p.includes("/dist/") ||
    p.startsWith("dist/")
  );
}

export function extractChangedFiles(events: TaskEvent[]): ChangedFile[] {
  const byPath = new Map<string, string>();

  for (const event of events) {
    if (event.type === "draft.diff" && event.data?.path) {
      const normalized = normalizeSandboxFilePath(String(event.data.path));
      if (isDependencyOrBuildPath(normalized)) {
        continue;
      }
      byPath.set(normalized, String(event.data.changeType ?? "modified"));
      continue;
    }
    if (event.type === "agent.tool" && event.data?.tool) {
      const tool = String(event.data.tool);
      // Only writes belong in Changes — reads of vendor trees used to pollute the panel.
      if (tool !== "Write" && tool !== "ApplyPatch" && tool !== "write_file") {
        continue;
      }
      const detail =
        typeof event.data.detail === "string" ? event.data.detail.trim() : "";
      const pathLike = detail.split("\n")[0]?.trim() || detail;
      if (!pathLike || pathLike.includes(" ")) {
        continue;
      }
      const normalized = normalizeSandboxFilePath(pathLike);
      if (isDependencyOrBuildPath(normalized)) {
        continue;
      }
      byPath.set(normalized, "added");
    }
  }

  return Array.from(byPath.entries()).map(([path, changeType]) => ({
    path,
    changeType,
  }));
}

export function pickAssistantSummary(
  task: Task,
  events: TaskEvent[],
): string | null {
  const draftSummary = events.find((e) => e.type === "draft.completed")?.data
    ?.summary;
  if (draftSummary && String(draftSummary).trim()) {
    return String(draftSummary).trim();
  }

  const outputs = filterAgentOutputEvents(events);
  const substantial = outputs.filter(
    (event) =>
      event.message.trim().length >= 60 &&
      !looksLikeCursorStreamJson(event.message),
  );
  const candidate = substantial[substantial.length - 1] ?? outputs.at(-1);
  if (candidate?.message?.trim()) {
    return candidate.message.trim();
  }

  if (
    task.message &&
    (task.status === "completed" ||
      task.status === "failed" ||
      task.status === "awaiting_review")
  ) {
    const formatted = formatAgentFailureMessage(task.message);
    if (formatted && !looksLikeCursorStreamJson(formatted)) {
      return formatted;
    }
  }

  return null;
}

export type ProgressActivityLine = {
  line: string;
  timestamp?: string;
};

export function progressActivityLines(
  events: TaskEvent[],
): ProgressActivityLine[] {
  const lines: ProgressActivityLine[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.type === "agent.started") {
      const text = event.message.trim() || "Brain harness started";
      if (!seen.has(text)) {
        seen.add(text);
        lines.push({ line: text, timestamp: event.timestamp });
      }
      continue;
    }
    if (event.type === "agent.tool" && event.data?.tool) {
      const tool = String(event.data.tool);
      if (isToolMetadataName(tool) || /^hook/i.test(tool)) {
        continue;
      }
      const detail =
        typeof event.data.detail === "string"
          ? event.data.detail
          : event.message.replace(
              /^(Write|Read|Shell|List|Commit|Push|Finish)\s+/i,
              "",
            );
      const line = humanizeToolProgressLine(tool, detail);
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push({ line, timestamp: event.timestamp });
      }
      continue;
    }
    if (
      event.type === "agent.log" &&
      /brain harness|step \d+|Brain harness/i.test(event.message)
    ) {
      const text = event.message.trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        lines.push({ line: text, timestamp: event.timestamp });
      }
      continue;
    }
    if (event.type === "agent.output" && !isAgentStreamNoise(event.message)) {
      const text = event.message.trim();
      if (text.length >= 24 && text.length <= 200 && !seen.has(text)) {
        seen.add(text);
        lines.push({ line: text, timestamp: event.timestamp });
      }
    }
    if (event.type === "agent.completed") {
      const text = "Harness finished";
      if (!seen.has(text)) {
        seen.add(text);
        lines.push({ line: text, timestamp: event.timestamp });
      }
    }
  }

  return lines.slice(-20);
}

export function sumLineCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

export function groupChangedFilesByFolder(
  files: ChangedFile[],
): Array<{ folder: string; files: ChangedFile[] }> {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const list = groups.get(folder) ?? [];
    list.push(file);
    groups.set(folder, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, folderFiles]) => ({
      folder,
      files: folderFiles.sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

export function fileDisplayName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

export function pickStatusLine(
  task: Task,
  events: TaskEvent[],
  isActive: boolean,
): string | null {
  if (isActive) {
    const progress = latestProgressLine(events);
    if (progress) {
      return progress;
    }
    return "Building now — will let you know once it's running.";
  }
  if (task.status === "completed") {
    return null;
  }
  return null;
}
