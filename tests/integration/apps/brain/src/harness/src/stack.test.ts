import { describe, expect, it } from "bun:test";
import {
  normalizeBrainStack,
  stackEntryFiles,
  stackGuidanceLines,
} from "@harness/stack.js";
import { buildSystemPrompt } from "@harness/context.js";

describe("stack helpers", () => {
  it("normalizes known stacks", () => {
    expect(normalizeBrainStack("python")).toBe("python");
    expect(normalizeBrainStack("NextJS")).toBe("nextjs");
    expect(normalizeBrainStack("nope")).toBeUndefined();
  });

  it("lists stack entry files", () => {
    expect(stackEntryFiles("python")).toContain("app.py");
    expect(stackEntryFiles("nextjs")).toContain("app/page.tsx");
    expect(stackEntryFiles("rust")).toContain("src/main.rs");
    expect(stackEntryFiles("go")).toContain("main.go");
  });

  it("keeps python guidance free of Next.js paths", () => {
    const lines = stackGuidanceLines("python").join("\n");
    expect(lines).toContain("app.py");
    expect(lines).toContain("Do not create app/page.tsx");
  });
});

describe("buildSystemPrompt", () => {
  it("embeds python scaffold listing and forbids inventing Next.js", () => {
    const prompt = buildSystemPrompt({
      workDir: "repo",
      stackRuntime: "python",
      requireProductImplementation: true,
      repoListing: "app.py\nrequirements.txt\nREADME.md",
    });
    expect(prompt).toContain("Stack: Python");
    expect(prompt).toContain("app.py");
    expect(prompt).toContain("Current repository root listing");
    expect(prompt).toContain("Do not invent a Next.js tree");
    expect(prompt).not.toMatch(/e\.g\. app\/page\.tsx/);
  });
});
