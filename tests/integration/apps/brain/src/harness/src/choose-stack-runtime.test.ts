import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type OpenAI from "openai";
import { chooseStackRuntime } from "@harness/runtime-chooser.js";

describe("chooseStackRuntime", () => {
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

  it("returns the model-selected stack runtime", async () => {
    const create = mock(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              runtime: "python",
              rationale: "FastAPI service",
            }),
          },
        },
      ],
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await chooseStackRuntime({
      prompt: "Build a FastAPI todo API",
      model: "gpt-4o-mini",
      client,
    });

    expect(result).toEqual({
      runtime: "python",
      rationale: "FastAPI service",
    });
    expect(create).toHaveBeenCalled();
  });

  it("returns null when the model response is invalid", async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              { message: { content: JSON.stringify({ runtime: "java" }) } },
            ],
          }),
        },
      },
    } as unknown as OpenAI;

    await expect(
      chooseStackRuntime({
        prompt: "something",
        client,
      }),
    ).resolves.toBeNull();
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
      chooseStackRuntime({
        prompt: "Build a Go chat app",
        client,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for empty prompts", async () => {
    await expect(chooseStackRuntime({ prompt: "  " })).resolves.toBeNull();
  });
});
