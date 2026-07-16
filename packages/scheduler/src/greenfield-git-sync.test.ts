import { describe, expect, test } from "bun:test";
import {
  buildAlignHydratedRepoScript,
  buildPushGreenfieldMainScript,
  isAgentTimeoutMessage,
} from "./greenfield-git-sync.js";

describe("greenfield-git-sync", () => {
  test("isAgentTimeoutMessage detects scheduler timeout", () => {
    expect(
      isAgentTimeoutMessage(
        "Agent run for task abc did not finish within 1800s",
      ),
    ).toBe(true);
    expect(isAgentTimeoutMessage("cursor agent exited with code 1")).toBe(
      false,
    );
  });

  test("buildAlignHydratedRepoScript hard-resets by default", () => {
    const script = buildAlignHydratedRepoScript();
    expect(script).toContain("git fetch --depth 1");
    expect(script).toContain("git reset --hard FETCH_HEAD");
    expect(script).toContain("timeout 30");
  });

  test("buildPushGreenfieldMainScript uses force-with-lease by default", () => {
    const script = buildPushGreenfieldMainScript();
    expect(script).toContain("git fetch --depth 1");
    expect(script).toContain("git push --force-with-lease");
  });
});
