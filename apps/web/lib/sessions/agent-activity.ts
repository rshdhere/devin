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
    return `Cursor agent error: ${core.slice(0, 240)}`;
  }

  if (/database or disk is full/i.test(text)) {
    return "Sandbox disk or agent database is full on the execution host. Free disk space and retry.";
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
      if (/^hook/i.test(tool)) {
        continue;
      }
      const detail =
        typeof event.data.detail === "string" ? event.data.detail : "";
      const shortDetail = detail.split("\n")[0]?.trim() ?? "";
      if (shortDetail) {
        return `${tool} · ${shortDetail}`;
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
  return p;
}

export function isAddedChangeType(changeType: string): boolean {
  const lower = changeType.toLowerCase();
  return lower === "added" || lower === "create" || lower === "new";
}

export function extractChangedFiles(events: TaskEvent[]): ChangedFile[] {
  const byPath = new Map<string, string>();

  for (const event of events) {
    if (event.type === "draft.diff" && event.data?.path) {
      byPath.set(
        normalizeSandboxFilePath(String(event.data.path)),
        String(event.data.changeType ?? "modified"),
      );
      continue;
    }
    if (event.type === "agent.tool" && event.data?.tool) {
      const tool = String(event.data.tool);
      const detail =
        typeof event.data.detail === "string" ? event.data.detail.trim() : "";
      const pathLike =
        detail.split("\n")[0]?.trim() ||
        (tool === "Write" || tool === "Read" ? detail : "");
      if (!pathLike || pathLike.includes(" ")) {
        continue;
      }
      const normalized = normalizeSandboxFilePath(pathLike);
      const kind =
        tool === "Write" || tool === "ApplyPatch"
          ? "added"
          : (byPath.get(normalized) ?? "modified");
      byPath.set(normalized, kind);
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

export function progressActivityLines(events: TaskEvent[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.type === "agent.tool" && event.data?.tool) {
      const tool = String(event.data.tool);
      if (/^hook/i.test(tool)) {
        continue;
      }
      const line = latestProgressLine([event]);
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
      continue;
    }
    if (event.type === "agent.output" && !isAgentStreamNoise(event.message)) {
      const text = event.message.trim();
      if (text.length >= 24 && text.length <= 200 && !seen.has(text)) {
        seen.add(text);
        lines.push(text);
      }
    }
  }

  return lines.slice(-12);
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
