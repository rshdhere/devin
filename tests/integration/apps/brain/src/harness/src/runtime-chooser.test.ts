import { describe, expect, it } from "bun:test";
import { parseStackRuntimeChoice } from "@harness/runtime-chooser.js";

describe("parseStackRuntimeChoice", () => {
  it("parses a valid stack runtime choice", () => {
    const result = parseStackRuntimeChoice(
      JSON.stringify({
        runtime: "go",
        rationale: "User asked for a Go HTTP service",
      }),
    );
    expect(result).toEqual({
      runtime: "go",
      rationale: "User asked for a Go HTTP service",
    });
  });

  it("accepts nextjs, node, rust, and python", () => {
    for (const runtime of ["nextjs", "node", "rust", "python"] as const) {
      expect(
        parseStackRuntimeChoice(JSON.stringify({ runtime, rationale: "ok" }))
          ?.runtime,
      ).toBe(runtime);
    }
  });

  it("rejects agent and unknown runtimes", () => {
    expect(
      parseStackRuntimeChoice(
        JSON.stringify({ runtime: "agent", rationale: "no" }),
      ),
    ).toBeNull();
    expect(
      parseStackRuntimeChoice(
        JSON.stringify({ runtime: "java", rationale: "no" }),
      ),
    ).toBeNull();
  });

  it("returns null for invalid JSON or empty content", () => {
    expect(parseStackRuntimeChoice(null)).toBeNull();
    expect(parseStackRuntimeChoice("")).toBeNull();
    expect(parseStackRuntimeChoice("not-json")).toBeNull();
    expect(parseStackRuntimeChoice("{}")).toBeNull();
  });

  it("defaults rationale when missing", () => {
    expect(
      parseStackRuntimeChoice(JSON.stringify({ runtime: "node" })),
    ).toEqual({
      runtime: "node",
      rationale: "Selected by model",
    });
  });
});
