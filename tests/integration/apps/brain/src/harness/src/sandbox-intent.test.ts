import { describe, expect, it } from "bun:test";
import {
  DEFAULT_DIRECT_REPLY,
  looksLikeDirectReplyPrompt,
  parseBrainExecutionPlan,
} from "@harness/sandbox-intent.js";

describe("looksLikeDirectReplyPrompt", () => {
  it("matches short greetings and small talk", () => {
    for (const prompt of [
      "hi",
      "HI!",
      "hello",
      "hey there",
      "how are you",
      "how's it going?",
      "good morning",
      "thanks",
    ]) {
      expect(looksLikeDirectReplyPrompt(prompt)).toBe(true);
    }
  });

  it("does not match coding work even if it starts with a greeting", () => {
    expect(looksLikeDirectReplyPrompt("hello world")).toBe(false);
    expect(looksLikeDirectReplyPrompt("hi, add a login page")).toBe(false);
    expect(
      looksLikeDirectReplyPrompt("how are you going to implement auth"),
    ).toBe(false);
    expect(looksLikeDirectReplyPrompt("Build a Next.js dashboard")).toBe(false);
  });
});

describe("parseBrainExecutionPlan", () => {
  it("parses a direct reply", () => {
    const result = parseBrainExecutionPlan(
      JSON.stringify({
        action: "reply",
        reply: DEFAULT_DIRECT_REPLY,
        rationale: "greeting",
      }),
    );
    expect(result).toEqual({
      action: "reply",
      reply: DEFAULT_DIRECT_REPLY,
      rationale: "greeting",
    });
  });

  it("parses a sandbox plan", () => {
    expect(
      parseBrainExecutionPlan(
        JSON.stringify({
          action: "sandbox",
          runtime: "rust",
          rationale: "Cargo CLI",
        }),
      ),
    ).toEqual({
      action: "sandbox",
      runtime: "rust",
      rationale: "Cargo CLI",
    });
  });

  it("accepts needsSandbox aliases", () => {
    expect(
      parseBrainExecutionPlan(
        JSON.stringify({
          needsSandbox: false,
          reply: DEFAULT_DIRECT_REPLY,
        }),
      )?.action,
    ).toBe("reply");
    expect(
      parseBrainExecutionPlan(
        JSON.stringify({ needsSandbox: true, runtime: "python" }),
      ),
    ).toEqual({
      action: "sandbox",
      runtime: "python",
      rationale: "Selected by model",
    });
  });

  it("pads short replies so they render in session chat", () => {
    const result = parseBrainExecutionPlan(
      JSON.stringify({ action: "reply", reply: "Hi!" }),
    );
    expect(result?.action).toBe("reply");
    if (result?.action === "reply") {
      expect(result.reply.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("returns null for invalid payloads", () => {
    expect(parseBrainExecutionPlan(null)).toBeNull();
    expect(parseBrainExecutionPlan("not-json")).toBeNull();
    expect(
      parseBrainExecutionPlan(JSON.stringify({ action: "sandbox" })),
    ).toBeNull();
    expect(
      parseBrainExecutionPlan(
        JSON.stringify({ action: "sandbox", runtime: "java" }),
      ),
    ).toBeNull();
  });
});
