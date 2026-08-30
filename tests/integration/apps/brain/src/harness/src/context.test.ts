import { describe, expect, it } from "bun:test";
import { buildSystemPrompt, compactMessages } from "@harness/context.js";
import type { ChatMessage } from "@harness/types.js";

describe("buildSystemPrompt", () => {
  it("includes follow-up bans for start/curl and trust policy", () => {
    const prompt = buildSystemPrompt({
      workDir: "repo",
      followUp: true,
    });
    expect(prompt).toContain("follow-up");
    expect(prompt).toContain("Do NOT run bun/npm/python servers");
    expect(prompt).toContain("Instruction hierarchy");
    expect(prompt).toContain("untrusted");
  });
});

describe("compactMessages", () => {
  it("keeps system and injects summary as untrusted data", () => {
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
    expect(
      next.some((m) => String(m.content).includes("conversation_summary")),
    ).toBe(true);
  });
});
