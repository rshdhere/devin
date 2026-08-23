import type { ChatMessage } from "./types.js";

export function buildSystemPrompt(input: {
  workDir: string;
  followUp?: boolean;
  sessionContext?: string;
  recalledMemory?: string;
}): string {
  const lines = [
    "You are Devin Brain, a coding agent that edits a remote Devbox via tools.",
    `Workspace root: /workspace/${input.workDir}`.replace(/\/+/g, "/"),
    "Prefer read_file / write_file / list_dir over shell for file work.",
    "Use shell for builds, installs, git status/diff, and tests.",
    "Never run unbounded servers in the foreground. Do not curl localhost smoke loops.",
    "When the user request is satisfied, call finish with a short summary.",
    "Make focused commits with git_commit when you change code.",
  ];

  if (input.followUp) {
    lines.push(
      "This is a follow-up in an existing session.",
      "Apply ONLY the new user request. Do not re-scaffold or reinstall deps unless required.",
      "Do NOT run bun/npm start or localhost curls on follow-ups.",
    );
  }

  if (input.sessionContext?.trim()) {
    lines.push("", "Bounded session context:", input.sessionContext.trim());
  }
  if (input.recalledMemory?.trim()) {
    lines.push("", "Recalled durable memory:", input.recalledMemory.trim());
  }

  return lines.join("\n");
}

export function compactMessages(
  messages: ChatMessage[],
  summary: string,
): ChatMessage[] {
  const system = messages.find((m) => m.role === "system");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const next: ChatMessage[] = [];
  if (system) {
    next.push(system);
  }
  next.push({
    role: "user",
    content: `Conversation summary so far:\n${summary}\n\nContinue from here.`,
  });
  if (lastUser && lastUser.content) {
    next.push(lastUser);
  }
  return next;
}
