import type { ChatMessage } from "./types.js";
import {
  stackEntryFiles,
  stackGuidanceLines,
  type BrainStackRuntime,
} from "./stack.js";

export function buildSystemPrompt(input: {
  workDir: string;
  followUp?: boolean;
  requireProductImplementation?: boolean;
  stackRuntime?: BrainStackRuntime;
  sessionContext?: string;
  recalledMemory?: string;
  repoListing?: string;
}): string {
  const stack = input.stackRuntime;
  const entries = stackEntryFiles(stack).join(", ");

  const lines = [
    "You are Devin Brain, a coding agent that edits a remote Devbox via tools.",
    `Workspace root: /workspace/${input.workDir}`.replace(/\/+/g, "/"),
    ...stackGuidanceLines(stack),
    "Prefer read_file / write_file / list_dir over shell for file work.",
    "File tool paths are relative to the repo root — do not prefix /workspace.",
    `When unsure which files exist, list_dir "." first. Likely entry points: ${entries}.`,
    "Never read or edit node_modules, .next, dist, target, __pycache__, or vendor trees.",
    "Implement features in project source. Add dependencies via the stack package manager, then import them — do not open vendor source under node_modules.",
    "Use shell for builds, installs, git status/diff, and tests.",
    "Never run unbounded servers in the foreground. Do not curl localhost smoke loops.",
    "When the user request is satisfied, call finish with a short summary.",
    "Make focused commits with git_commit when you change code.",
    "git_commit messages MUST follow Conventional Commits (AGENTS.md fashion):",
    "  type(context): lowercase imperative summary",
    "  optional blank line then up to 4 '- ' implementation bullets",
    "  allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert",
    "  example: feat(ui): add flappy bird canvas\\n\\n- Draw bird and pipes\\n- Detect collisions",
    "Never put Co-authored-by in the message — the harness adds baby-devin-bot automatically.",
    "Never attribute work to Cursor, Claude, or any AI assistant.",
  ];

  if (input.repoListing?.trim()) {
    lines.push(
      "",
      "Current repository root listing (authoritative — only open paths that exist here or that you create):",
      input.repoListing.trim(),
    );
  }

  if (input.requireProductImplementation) {
    lines.push(
      "This repo starts as a thin scaffold with placeholder copy or a health-only stub.",
      "You MUST replace the scaffold with the real product the user asked for.",
      "Do not ship a marketing landing page without the actual interactive product.",
    );
    if (stack === "nextjs" || stack === "node") {
      lines.push(
        "For games (chess, etc.), implement a playable board and moves — not only a hero CTA.",
        "Do not leave App Router / Express scaffold placeholder text in place.",
      );
    } else if (stack === "python") {
      lines.push(
        "Extend app.py (Flask/FastAPI/etc.) into the full product. Do not invent a Next.js tree.",
      );
    } else if (stack === "rust") {
      lines.push(
        "Extend src/main.rs / Cargo into the full product. Do not invent a Next.js or Node tree.",
      );
    } else if (stack === "go") {
      lines.push(
        "Extend main.go into the full product. Do not invent a Next.js or Node tree.",
      );
    }
    lines.push(
      "Do not call finish while the scaffold is untouched.",
      "Make at least 3 focused git_commit calls beyond the scaffold before finishing.",
    );
  }

  if (input.followUp) {
    lines.push(
      "This is a follow-up in an existing session.",
      "Apply ONLY the new user request. Do not re-scaffold or reinstall deps unless required.",
      "Do NOT run bun/npm/python servers or localhost curls on follow-ups.",
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
