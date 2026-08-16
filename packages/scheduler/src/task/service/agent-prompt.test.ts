import { describe, expect, it } from "bun:test";
import { buildAgentPrompt, buildFollowUpAgentPrompt } from "./agent-prompt.js";

describe("buildFollowUpAgentPrompt", () => {
  it("asks the agent to apply only the new request", () => {
    const prompt = buildFollowUpAgentPrompt(
      "make the background black",
      "acme/tic-tac-toe",
      "repo",
    );

    expect(prompt).toContain("This is a follow-up in an existing session.");
    expect(prompt).toContain("Apply ONLY the new user request below.");
    expect(prompt).toContain("make the background black");
    expect(prompt).not.toContain("Make at least 3 focused commits");
    expect(prompt).not.toContain("Previous session context:");
    expect(prompt).not.toContain(
      "Continue the existing session using the context below",
    );
  });
});

describe("buildAgentPrompt", () => {
  it("uses the light follow-up template when resumeSession is set", () => {
    const prompt = buildAgentPrompt(
      "make the background black",
      "acme/tic-tac-toe",
      "repo",
      undefined,
      "nextjs",
      { followUp: true, greenfieldRepo: true },
    );

    expect(prompt).toContain("follow-up in an existing session");
    expect(prompt).not.toContain("build the full product the user asked for");
    expect(prompt).not.toContain(
      "Smoke-check GET / and /health before finishing",
    );
  });

  it("keeps the greenfield template for initial runs", () => {
    const prompt = buildAgentPrompt(
      "make me a tic-tac-toe app",
      "acme/tic-tac-toe",
      "repo",
      undefined,
      "nextjs",
      true,
    );

    expect(prompt).toContain("build the full product the user asked for");
    expect(prompt).toContain(
      "Make at least 3 focused commits beyond the scaffold",
    );
  });
});
