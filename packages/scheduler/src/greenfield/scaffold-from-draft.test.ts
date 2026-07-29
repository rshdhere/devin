import { describe, expect, test } from "bun:test";
import { buildHeuristicDraftPlan } from "./draft-planner.js";
import { scaffoldFilesFromDraft } from "./scaffold-from-draft.js";

describe("scaffoldFilesFromDraft", () => {
  test("keeps a thin shell for any product prompt — agent builds the app", () => {
    for (const prompt of [
      "make me a chat-app using nodejs",
      "make me a todo-app using nodejs",
      "build a notes API in node",
      "make me a tic-tac-toe game using nextjs",
    ]) {
      const plan = buildHeuristicDraftPlan({ prompt });
      const files = scaffoldFilesFromDraft(plan, {
        title: "Helm Craft",
        prompt,
      });
      const entry = files.find((file) => file.path === "src/index.js");
      expect(entry).toBeDefined();
      expect(entry!.content).toContain("Scaffold is running");
      expect(entry!.content).not.toContain("/messages");
      expect(entry!.content).not.toContain("/todos");
      expect(files.some((file) => file.path.startsWith("src/routes/"))).toBe(
        false,
      );

      const pkg = files.find((file) => file.path === "package.json");
      expect(pkg).toBeDefined();
      expect(pkg!.content).not.toContain("express");
    }
  });
});
