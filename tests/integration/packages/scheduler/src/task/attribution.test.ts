import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentAttributionOptOutScript,
  buildCommitMsgHook,
} from "@scheduler/task/attribution.js";

async function withSandboxHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "devin-attribution-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function sh(
  script: string,
  home: string,
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stderr, stdout };
}

describe("agent-attribution-opt-out", () => {
  test("writes a cli config with attribution disabled", async () => {
    await withSandboxHome(async (home) => {
      const result = await sh(buildAgentAttributionOptOutScript(), home, home);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      const config = JSON.parse(
        await readFile(join(home, ".cursor/cli-config.json"), "utf8"),
      );
      expect(config.attribution.attributeCommitsToAgent).toBe(false);
      expect(config.attribution.attributePRsToAgent).toBe(false);
    });
  });

  test("preserves unrelated keys in an existing cli config", async () => {
    await withSandboxHome(async (home) => {
      const seed = [
        'mkdir -p "$HOME/.cursor"',
        `printf '%s' '{"version":1,"editor":{"vimMode":true},"attribution":{"attributeCommitsToAgent":true}}' > "$HOME/.cursor/cli-config.json"`,
      ].join("\n");
      expect((await sh(seed, home, home)).exitCode).toBe(0);
      expect(
        (await sh(buildAgentAttributionOptOutScript(), home, home)).exitCode,
      ).toBe(0);

      const config = JSON.parse(
        await readFile(join(home, ".cursor/cli-config.json"), "utf8"),
      );
      expect(config.editor.vimMode).toBe(true);
      expect(config.attribution.attributeCommitsToAgent).toBe(false);
    });
  });

  test("commit-msg hook strips tool trailers and keeps the bot trailer", async () => {
    await withSandboxHome(async (home) => {
      const repo = join(home, "repo");
      const setup = [
        buildAgentAttributionOptOutScript(),
        `mkdir -p '${repo}'`,
        `cd '${repo}'`,
        "git init -q -b main",
        "git config user.name 'raashed md'",
        "git config user.email 'work@raashed.cloud'",
        "printf 'hi\\n' > file.txt",
        "git add file.txt",
        [
          "git commit -q -F - <<'MSG'",
          "feat(app): add greeting wall",
          "",
          "- Implement the greeting endpoint",
          "",
          "Co-authored-by: baby-devin-bot <baby-devin-bot@users.noreply.github.com>",
          "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
          "Co-authored-by: Claude <noreply@anthropic.com>",
          "Generated with Cursor",
          "MSG",
        ].join("\n"),
      ].join("\n");

      const result = await sh(setup, home, home);
      expect(result.exitCode).toBe(0);

      const log = await sh("git log -1 --pretty=%B", home, repo);
      expect(log.stdout).toContain("feat(app): add greeting wall");
      expect(log.stdout).toContain("Co-authored-by: baby-devin-bot");
      expect(log.stdout.toLowerCase()).not.toContain("cursor");
      expect(log.stdout.toLowerCase()).not.toContain("claude");

      const trailers = await sh(
        "git log -1 --pretty=%B | git interpret-trailers --parse",
        home,
        repo,
      );
      expect(trailers.stdout.trim().split("\n")).toHaveLength(1);
    });
  });

  test("commit-msg hook leaves a message of only tool trailers alone", async () => {
    await withSandboxHome(async (home) => {
      const repo = join(home, "repo");
      const setup = [
        buildAgentAttributionOptOutScript(),
        `mkdir -p '${repo}'`,
        `cd '${repo}'`,
        "git init -q -b main",
        "git config user.name 'raashed md'",
        "git config user.email 'work@raashed.cloud'",
        "printf 'hi\\n' > file.txt",
        "git add file.txt",
        "git commit -q -m 'Co-authored-by: Cursor Agent <cursoragent@cursor.com>'",
      ].join("\n");

      // An empty message aborts the commit, so the hook must bail out instead.
      expect((await sh(setup, home, home)).exitCode).toBe(0);
      const log = await sh("git log --oneline", home, repo);
      expect(log.stdout.trim()).not.toBe("");
    });
  });

  test("hook is a POSIX shell script", () => {
    expect(buildCommitMsgHook().startsWith("#!/bin/sh")).toBe(true);
  });
});
