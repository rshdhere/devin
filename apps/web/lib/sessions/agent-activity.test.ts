import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "@devin/types";
import {
  buildConversationMessages,
  humanizeToolProgressLine,
  isToolMetadataName,
  progressActivityLines,
} from "./agent-activity";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    prompt: "make me a chat app",
    status: "running",
    agent: "cursor",
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
    expect(lines.some((line) => line.includes("toolCallId"))).toBe(false);
    expect(lines).toContain("Edited `page.tsx`");
    expect(lines.some((line) => line.includes("npm run build"))).toBe(true);
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

  it("includes follow-up prompts from scheduled events", () => {
    const messages = buildConversationMessages(
      task({ prompt: "use python for the backend" }),
      [
        event({
          id: "created",
          type: "task.created",
          message: "Task accepted",
          data: { prompt: "make me a chat app" },
        }),
        event({
          id: "follow-up",
          type: "task.scheduled",
          message: "Follow-up prompt queued",
          data: { followUp: true, prompt: "use python for the backend" },
        }),
      ],
    );
    const users = messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual([
      "make me a chat app",
      "use python for the backend",
    ]);
  });
});

describe("humanizeToolProgressLine", () => {
  it("formats write steps with file names", () => {
    expect(
      humanizeToolProgressLine("Write", "src/components/chat-app.tsx"),
    ).toBe("Edited `chat-app.tsx`");
  });
});
