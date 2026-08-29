import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "@devin/types";
import {
  buildConversationMessages,
  formatAgentFailureMessage,
  humanizeToolProgressLine,
  isToolMetadataName,
  progressActivityLines,
} from "@web/lib/sessions/agent-activity";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    prompt: "make me a chat app",
    status: "running",
    agent: "brain",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function event(
  partial: Partial<TaskEvent> & Pick<TaskEvent, "type" | "message">,
): TaskEvent {
  return {
    id: partial.id ?? `evt-${Math.random()}`,
    taskId: "task-1",
    timestamp: new Date().toISOString(),
    data: partial.data,
    type: partial.type,
    message: partial.message,
  };
}

describe("isToolMetadataName", () => {
  it("flags toolCallId and similar metadata keys", () => {
    expect(isToolMetadataName("toolCallId")).toBe(true);
    expect(isToolMetadataName("Write")).toBe(false);
  });
});

describe("formatAgentFailureMessage", () => {
  it("distinguishes host rootfs clone ENOSPC from guest tmpfs ENOSPC", () => {
    expect(
      formatAgentFailureMessage(
        "sandbox sbx-1 failed: clone golden rootfs: copy /var/lib/devin/snapshots/rust/rootfs.ext4 -> /var/lib/devin/vms/x/rootfs.ext4: No space left on device",
      ),
    ).toMatch(/Execution host disk is full while cloning the golden rootfs/);
    expect(
      formatAgentFailureMessage(
        "host disk guardrail: free=3GiB under /var/lib/devin/vms (need ≥12GiB)",
      ),
    ).toMatch(/Execution host disk is full while cloning the golden rootfs/);
    expect(
      formatAgentFailureMessage(
        "host active VM guardrail: 2/2 microVMs in use",
      ),
    ).toMatch(/microVM concurrency limit/);
    expect(
      formatAgentFailureMessage(
        "ENOSPC: no space left on device writing cache",
      ),
    ).toMatch(/Sandbox workspace ran out of disk/);
  });
});

describe("progressActivityLines", () => {
  it("humanizes tool steps and skips metadata tool names", () => {
    const lines = progressActivityLines([
      event({
        type: "agent.tool",
        message: "toolCallId",
        data: { tool: "toolCallId" },
      }),
      event({
        type: "agent.tool",
        message: "Write src/app/page.tsx",
        data: { tool: "Write", detail: "src/app/page.tsx" },
      }),
      event({
        type: "agent.tool",
        message: "Bash npm run build",
        data: { tool: "Bash", detail: "npm run build" },
      }),
    ]);
    expect(lines.some((entry) => entry.line.includes("toolCallId"))).toBe(
      false,
    );
    expect(lines.some((entry) => entry.line === "Edited `page.tsx`")).toBe(
      true,
    );
    expect(lines.some((entry) => entry.line.includes("bun run build"))).toBe(
      true,
    );
  });

  it("humanizes Brain harness tool names", () => {
    const lines = progressActivityLines([
      event({
        type: "agent.started",
        message: "Brain harness started (model=gpt-4o-mini, workDir=repo)",
      }),
      event({
        type: "agent.tool",
        message: "Write app/page.tsx",
        data: { tool: "Write", detail: "app/page.tsx" },
      }),
      event({
        type: "agent.tool",
        message: "Shell bun install",
        data: { tool: "Shell", detail: "bun install" },
      }),
      event({
        type: "agent.tool",
        message: "Shell git status",
        data: { tool: "Shell", detail: "git status" },
      }),
      event({
        type: "agent.tool",
        message: "List repo",
        data: { tool: "List", detail: "repo" },
      }),
      event({
        type: "agent.tool",
        message: "Read app/page.tsx",
        data: { tool: "Read", detail: "app/page.tsx" },
      }),
      event({
        type: "agent.log",
        message: "brain harness step 2/80",
      }),
      event({
        type: "agent.log",
        message: "brain harness loop ready (maxSteps=80)",
      }),
      event({
        type: "agent.log",
        message: "nudged model to keep implementing (no tool calls yet)",
      }),
      event({
        type: "agent.tool",
        message: "Commit feat: bird",
        data: { tool: "Commit", detail: "feat: bird" },
      }),
      event({
        type: "agent.tool",
        message: "Commit feat: bird",
        data: { tool: "Commit", detail: "feat: bird" },
      }),
    ]);
    expect(lines.some((entry) => entry.line === "Brain harness started")).toBe(
      true,
    );
    expect(lines.some((entry) => entry.line === "Edited `page.tsx`")).toBe(
      true,
    );
    expect(lines.some((entry) => entry.line.includes("bun install"))).toBe(
      true,
    );
    expect(lines.some((entry) => entry.line.includes("git status"))).toBe(
      false,
    );
    expect(lines.some((entry) => entry.line.includes("Listed"))).toBe(false);
    expect(lines.some((entry) => entry.line.includes("Read `"))).toBe(false);
    expect(lines.some((entry) => entry.line.includes("step 2/80"))).toBe(false);
    expect(lines.some((entry) => entry.line.includes("loop ready"))).toBe(
      false,
    );
    expect(lines.some((entry) => entry.line.includes("nudged model"))).toBe(
      false,
    );
    expect(
      lines.filter((entry) => entry.line.includes("Committed · feat: bird"))
        .length,
    ).toBe(1);
  });
});

describe("buildConversationMessages", () => {
  it("builds a user and assistant thread without tool noise", () => {
    const messages = buildConversationMessages(
      task({ prompt: "make me a chat app" }),
      [
        event({
          id: "created",
          type: "task.created",
          message: "Task accepted",
          data: { prompt: "make me a chat app" },
        }),
        event({
          id: "out-1",
          type: "agent.output",
          message: "I'll scaffold a multi-room chat UI with Next.js.",
        }),
        event({
          type: "agent.tool",
          message: "Write src/app/page.tsx",
          data: { tool: "Write", detail: "src/app/page.tsx" },
        }),
      ],
    );
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages[0]?.content).toBe("make me a chat app");
    expect(messages[1]?.content).toContain("Next.js");
  });

  it("includes follow-up prompts from phase and execution events", () => {
    const messages = buildConversationMessages(
      task({ prompt: "use fan-in fan-out pattern" }),
      [
        event({
          id: "created",
          type: "task.created",
          message: "Task accepted",
          data: { prompt: "make me a chat app using rust" },
        }),
        event({
          id: "follow-scheduled",
          type: "task.scheduled",
          message: "Follow-up prompt queued",
          data: { followUp: true, prompt: "use fan-in fan-out pattern" },
        }),
        event({
          id: "follow-phase",
          type: "task.phase_changed",
          message: "Resuming devbox session",
          data: {
            followUp: true,
            prompt: "use fan-in fan-out pattern",
          },
        }),
        event({
          id: "follow-exec",
          type: "execution.started",
          message: "Follow-up execution started",
          data: {
            followUp: true,
            prompt: "use fan-in fan-out pattern",
          },
        }),
      ],
    );
    const users = messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual([
      "make me a chat app using rust",
      "use fan-in fan-out pattern",
    ]);
  });

  it("collapses synthetic wrapped follow-up prompts into the user request", () => {
    const wrapped = [
      "Continue the existing session using the context below.",
      "The repository and current files are the source of truth; verify them before acting.",
      "",
      "Previous session context:",
      "1. make me a tic-tac-toe app using nextjs",
      "2. I'll inspect the Next.js scaffold first",
      "",
      "New user request: make the background black",
    ].join("\n");

    const messages = buildConversationMessages(
      task({ prompt: "make the background black" }),
      [
        event({
          id: "created",
          type: "task.created",
          message: "Task accepted",
          data: { prompt: "make me a tic-tac-toe app using nextjs" },
        }),
        event({
          id: "follow-scheduled",
          type: "task.scheduled",
          message: "Follow-up prompt queued",
          data: { followUp: true, prompt: "make the background black" },
        }),
        event({
          id: "follow-exec",
          type: "execution.started",
          message: "Follow-up execution started",
          data: { followUp: true, prompt: wrapped },
        }),
      ],
    );

    expect(
      messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual([
      "make me a tic-tac-toe app using nextjs",
      "make the background black",
    ]);
  });

  it("recovers the initial prompt from execution.started when task.created lacks it", () => {
    const messages = buildConversationMessages(
      task({ prompt: "use fan-in fan-out pattern" }),
      [
        event({
          id: "exec-initial",
          type: "execution.started",
          message: "Execution starting in devbox",
          data: { prompt: "make me a chat app using rust" },
        }),
        event({
          id: "follow-up",
          type: "task.scheduled",
          message: "Follow-up prompt queued",
          data: { followUp: true, prompt: "use fan-in fan-out pattern" },
        }),
      ],
    );
    expect(
      messages.filter((m) => m.role === "user").map((m) => m.content),
    ).toEqual(["make me a chat app using rust", "use fan-in fan-out pattern"]);
  });
});

describe("humanizeToolProgressLine", () => {
  it("formats write steps with file names", () => {
    expect(
      humanizeToolProgressLine("Write", "src/components/chat-app.tsx"),
    ).toBe("Edited `chat-app.tsx`");
  });
});
