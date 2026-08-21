import { describe, expect, it } from "bun:test";
import {
  buildAgentPrompt,
  buildFollowUpAgentPrompt,
  buildFollowUpSessionContext,
} from "./agent-prompt.js";

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

  it("includes the bounded durable context without replacing the repository source of truth", () => {
    const prompt = buildFollowUpAgentPrompt(
      "make the background black",
      "acme/tic-tac-toe",
      "repo",
      undefined,
      "Initial user request: make a chess app\n- git.commit: Added the board",
    );

    expect(prompt).toContain("same persisted devbox microVM");
    expect(prompt).toContain("Bounded session context");
    expect(prompt).toContain("Added the board");
    expect(prompt).toContain("current files are the source of truth");
  });

  it("adds Vercel deployment instructions only when requested", () => {
    const prompt = buildFollowUpAgentPrompt(
      "deploy this to Vercel",
      "acme/tic-tac-toe",
      "repo",
    );

    expect(prompt).toContain("Vercel deployment requested (follow-up)");
    expect(prompt).toContain("npx --yes vercel --prod --yes");
    expect(prompt).toContain("VERCEL_TOKEN");
    expect(prompt).toContain("Do NOT run local production servers");
    expect(prompt).toContain("curl --max-time 5");
    expect(prompt).not.toContain("npx --yes vercel --version");
  });
});

describe("buildFollowUpSessionContext", () => {
  it("compacts context to a bounded size", () => {
    const context = buildFollowUpSessionContext(
      "build an app",
      Array.from({ length: 30 }, (_, index) => ({
        id: `event-${index}`,
        taskId: "task-1",
        type: "agent.output" as const,
        message: `output ${index} ${"x".repeat(500)}`,
        timestamp: new Date().toISOString(),
      })),
      1_000,
    );

    expect(context.length).toBeLessThan(1_200);
    expect(context).toContain("Earlier context compacted");
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
