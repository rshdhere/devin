import { describe, expect, test } from "bun:test";
import { inferStackFromPrompt } from "@devin/types";
import { greenfieldShellScaffoldFiles } from "./shell-scaffold.js";

describe("greenfieldShellScaffoldFiles", () => {
  test("includes package.json for Next.js prompts", () => {
    const prompt = "make me a tic-tac-toe game using nextjs";
    const stackRuntime = inferStackFromPrompt(prompt);
    expect(stackRuntime).toBe("nextjs");

    const files = greenfieldShellScaffoldFiles({
      title: "Tic Tac Toe",
      prompt,
      stackRuntime,
    });

    expect(files.some((file) => file.path === "package.json")).toBe(true);
    expect(files.some((file) => file.path === "app/page.tsx")).toBe(true);
    expect(files.some((file) => file.path === "src/index.js")).toBe(false);
    expect(files.some((file) => file.path === "src/main.ts")).toBe(false);
  });

  test("includes package.json for Node prompts", () => {
    const prompt = "build an express api";
    const files = greenfieldShellScaffoldFiles({
      title: "API",
      prompt,
      stackRuntime: "node",
    });

    expect(files.some((file) => file.path === "package.json")).toBe(true);
    expect(files.some((file) => file.path === "src/index.js")).toBe(true);
  });
});
