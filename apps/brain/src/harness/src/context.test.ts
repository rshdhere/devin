import { describe, expect, it } from "bun:test";
import { buildSystemPrompt, compactMessages } from "./context.js";
import type { ChatMessage } from "./types.js";

describe("buildSystemPrompt", () => {
  it("includes follow-up bans for start/curl", () => {
    const prompt = buildSystemPrompt({
      workDir: "repo",
      followUp: true,
    });
    expect(prompt).toContain("follow-up");
    expect(prompt).toContain("Do NOT run bun/npm start");
  });
});

describe("compactMessages", () => {
  it("keeps system and injects summary", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];
    const next = compactMessages(messages, "did stuff");
    expect(next[0]?.role).toBe("system");
    expect(next.some((m) => String(m.content).includes("did stuff"))).toBe(
      true,
    );
  });
});
