import { describe, expect, it } from "bun:test";
import { resolveRepoPath } from "./tools.js";

describe("resolveRepoPath", () => {
  it("prefixes repo-relative paths with workDir", () => {
    expect(resolveRepoPath("repo", "app/page.tsx")).toBe("repo/app/page.tsx");
    expect(resolveRepoPath("repo", "./package.json")).toBe("repo/package.json");
  });

  it("keeps paths that already include workDir", () => {
    expect(resolveRepoPath("repo", "repo/app/page.tsx")).toBe(
      "repo/app/page.tsx",
    );
    expect(resolveRepoPath("repo", "repo")).toBe("repo");
  });

  it("strips /workspace prefixes before joining", () => {
    expect(resolveRepoPath("repo", "/workspace/app/page.tsx")).toBe(
      "repo/app/page.tsx",
    );
    expect(resolveRepoPath("repo", "/workspace/repo/app/page.tsx")).toBe(
      "repo/app/page.tsx",
    );
  });

  it("defaults empty path to workDir", () => {
    expect(resolveRepoPath("repo", "")).toBe("repo");
    expect(resolveRepoPath("repo", ".")).toBe("repo");
  });
});
