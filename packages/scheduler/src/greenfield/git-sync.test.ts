import { describe, expect, test } from "bun:test";
import {
  buildAlignHydratedRepoScript,
  buildPushGreenfieldMainScript,
  greenfieldCommitPlateauReason,
  isAgentTimeoutMessage,
  isRecoverableAgentInterruption,
} from "./git-sync.js";

describe("greenfield-git-sync", () => {
  test("isAgentTimeoutMessage detects scheduler timeout", () => {
    expect(
      isAgentTimeoutMessage(
        "Agent run for task abc did not finish within 1800s",
      ),
    ).toBe(true);
    expect(isAgentTimeoutMessage("Agent run timed out after 30m0s")).toBe(true);
    expect(isAgentTimeoutMessage("cursor agent exited with code -1")).toBe(
      true,
    );
    expect(isAgentTimeoutMessage("cursor agent exited with code 1")).toBe(
      false,
    );
    expect(
      isAgentTimeoutMessage(
        "cursor agent idle-stalled after 3m0s with no output — likely hung on a shell HEREDOC",
      ),
    ).toBe(true);
    expect(isAgentTimeoutMessage(greenfieldCommitPlateauReason(3))).toBe(true);
    expect(isAgentTimeoutMessage("context canceled")).toBe(true);
  });

  test("isRecoverableAgentInterruption covers Cursor resource_exhausted", () => {
    expect(
      isRecoverableAgentInterruption(
        "RetriableError: [resource_exhausted] Error",
      ),
    ).toBe(true);
    expect(
      isRecoverableAgentInterruption(
        'RetriableError: [resource_exhausted] Error\n{"type":"error"}',
      ),
    ).toBe(true);
    expect(isRecoverableAgentInterruption("rate limit exceeded")).toBe(true);
    expect(isRecoverableAgentInterruption("quota exceeded for model")).toBe(
      true,
    );
    expect(
      isRecoverableAgentInterruption("cursor agent exited with code 1"),
    ).toBe(false);
    expect(
      isRecoverableAgentInterruption(
        "Agent run for task abc did not finish within 1800s",
      ),
    ).toBe(true);
  });

  test("buildAlignHydratedRepoScript hard-resets by default", () => {
    const script = buildAlignHydratedRepoScript();
    expect(script).toContain("git fetch --depth 1");
    expect(script).toContain("git reset --hard FETCH_HEAD");
    expect(script).toContain("timeout 15");
  });

  test("buildPushGreenfieldMainScript uses force-with-lease by default", () => {
    const script = buildPushGreenfieldMainScript();
    expect(script).toContain("git fetch --no-tags origin main");
    expect(script).not.toContain("git fetch --depth 1");
    expect(script).toContain("git push --force-with-lease");
    expect(script).toContain("max=3");
  });
});
