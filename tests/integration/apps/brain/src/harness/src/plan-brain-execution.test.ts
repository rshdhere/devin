import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type OpenAI from "openai";
import {
  DEFAULT_DIRECT_REPLY,
  planBrainExecution,
} from "@harness/sandbox-intent.js";

describe("planBrainExecution", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("returns a reply plan for greetings", async () => {
    const create = mock(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "reply",
              reply: DEFAULT_DIRECT_REPLY,
              rationale: "greeting",
            }),
          },
        },
      ],
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await planBrainExecution({
      prompt: "how are you",
      model: "gpt-4o-mini",
      client,
    });

    expect(result).toEqual({
      action: "reply",
      reply: DEFAULT_DIRECT_REPLY,
      rationale: "greeting",
    });
    expect(create).toHaveBeenCalled();
  });

  it("returns a sandbox plan for coding work", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "sandbox",
                    runtime: "go",
                    rationale: "Go service",
                  }),
                },
              },
            ],
          }),
        },
      },
    } as unknown as OpenAI;

    await expect(
      planBrainExecution({
        prompt: "Build a Go chat app",
        client,
      }),
    ).resolves.toEqual({
      action: "sandbox",
      runtime: "go",
      rationale: "Go service",
    });
  });

  it("returns null when OpenAI throws", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => {
            throw new Error("network down");
          },
        },
      },
    } as unknown as OpenAI;

    await expect(
      planBrainExecution({
        prompt: "hi",
        client,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for empty prompts", async () => {
    await expect(planBrainExecution({ prompt: "  " })).resolves.toBeNull();
  });
});
