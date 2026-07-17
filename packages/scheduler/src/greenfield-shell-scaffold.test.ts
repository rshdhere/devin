import { describe, expect, test } from "bun:test";
import { inferStackFromPrompt } from "@devin/types";
import { greenfieldShellScaffoldFiles } from "./greenfield-shell-scaffold.js";

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
    expect(files.some((file) => file.path === "src/index.js")).toBe(true);
    expect(files.some((file) => file.path === "src/main.ts")).toBe(false);
  });

  test("includes package.json for React prompts", () => {
    const prompt = "build a react dashboard with charts";
    const files = greenfieldShellScaffoldFiles({
      title: "Dashboard",
      prompt,
      stackRuntime: "nextjs",
    });

    expect(files.some((file) => file.path === "package.json")).toBe(true);
  });
});
