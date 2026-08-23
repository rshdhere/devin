import { describe, expect, it } from "bun:test";
import { toolProgressDetail } from "./loop.js";
import {
  ensureBotCommitMessage,
  normalizeConventionalSubject,
  resolveRepoPath,
} from "./tools.js";

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

describe("normalizeConventionalSubject", () => {
  it("keeps typed scoped subjects and lowercases the verb", () => {
    expect(
      normalizeConventionalSubject("feat(ui): Add flappy bird canvas"),
    ).toBe("feat(ui): add flappy bird canvas");
  });

  it("rewrites Implemented … into imperative feat", () => {
    expect(
      normalizeConventionalSubject("feat: implement flappy bird game UI"),
    ).toBe("feat: add flappy bird game UI");
  });
});

describe("ensureBotCommitMessage", () => {
  it("appends baby-devin-bot trailer to subject-only messages", () => {
    const msg = ensureBotCommitMessage(
      "fix(deps): update futures-util to stabilize dependencies",
    );
    expect(msg).toContain(
      "fix(deps): update futures-util to stabilize dependencies",
    );
    expect(msg).toContain(
      "Co-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
    expect(msg.split("Co-authored-by: baby-devin-bot").length - 1).toBe(1);
  });

  it("preserves conventional bullets before the trailer", () => {
    const msg = ensureBotCommitMessage(
      [
        "feat(ui): add flappy bird canvas",
        "",
        "- Render bird and pipes",
        "- Detect collisions",
        "- Keep /health JSON ok",
      ].join("\n"),
    );
    expect(msg.startsWith("feat(ui): add flappy bird canvas\n\n")).toBe(true);
    expect(msg).toContain("- Render bird and pipes");
    expect(msg).toContain("- Detect collisions");
    expect(msg).toContain(
      "Co-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
  });

  it("does not duplicate an existing baby-devin-bot trailer", () => {
    const msg = ensureBotCommitMessage(
      "feat(chat): add room\n\nCo-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
    expect(msg.split("Co-authored-by: baby-devin-bot").length - 1).toBe(1);
    expect(msg.startsWith("feat(chat): add room\n\n")).toBe(true);
  });

  it("strips Cursor/Claude co-authors", () => {
    const msg = ensureBotCommitMessage(
      "feat(board): add board\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
    );
    expect(msg).not.toMatch(/Cursor Agent/i);
    expect(msg).not.toMatch(/Claude/i);
    expect(msg).toContain("Co-authored-by: baby-devin-bot");
    expect(msg.startsWith("feat(board): add board\n\n")).toBe(true);
  });

  it("replaces trailer-only messages with a real subject", () => {
    const msg = ensureBotCommitMessage(
      "Co-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
    expect(msg.startsWith("chore(repo): update project files\n\n")).toBe(true);
    expect(msg).toContain(
      "Co-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
    expect(msg.split("Co-authored-by: baby-devin-bot").length - 1).toBe(1);
  });

  it("strips co-author from single-newline subject lines", () => {
    const msg = ensureBotCommitMessage(
      "feat(ws): add websocket hub\nCo-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
    );
    expect(msg.startsWith("feat(ws): add websocket hub\n\n")).toBe(true);
  });
});

describe("toolProgressDetail", () => {
  it("maps write_file to Write with path detail under workDir", () => {
    const progress = toolProgressDetail(
      "write_file",
      JSON.stringify({ path: "app/page.tsx", content: "x" }),
      "repo",
    );
    expect(progress.tool).toBe("Write");
    expect(progress.detail).toBe("repo/app/page.tsx");
  });

  it("maps shell to Shell with command detail", () => {
    const progress = toolProgressDetail(
      "shell",
      JSON.stringify({ command: "bun run build" }),
    );
    expect(progress.tool).toBe("Shell");
    expect(progress.detail).toBe("bun run build");
  });

  it("uses only the commit subject in progress detail", () => {
    const progress = toolProgressDetail(
      "git_commit",
      JSON.stringify({
        message:
          "feat(ui): add rooms\n\nCo-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
      }),
    );
    expect(progress.tool).toBe("Commit");
    expect(progress.detail).toBe("feat(ui): add rooms");
    expect(progress.message).not.toContain("Co-authored-by");
  });
});
