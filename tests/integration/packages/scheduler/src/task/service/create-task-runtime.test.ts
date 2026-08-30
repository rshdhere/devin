import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { TaskService } from "@scheduler/task/service/task-service.js";
import type { StackRuntime } from "@devin/types";

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("TaskService.createTask runtime selection", () => {
  const originalAllowMock = process.env.ALLOW_TEMPLATE_AGENT;

  beforeEach(() => {
    delete process.env.ALLOW_TEMPLATE_AGENT;
  });

  afterEach(() => {
    if (originalAllowMock === undefined) {
      delete process.env.ALLOW_TEMPLATE_AGENT;
    } else {
      process.env.ALLOW_TEMPLATE_AGENT = originalAllowMock;
    }
  });

  it("applies LLM runtime before enqueue when no explicit runtime", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "rust",
        rationale: "Cargo CLI tool",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => null,
    });

    const task = svc.createTask({
      prompt: "Build a Rust CLI that greps files",
    });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some(
            (event) =>
              event.type === "task.runtime_selected" &&
              event.data?.source === "llm",
          ),
      ),
    );

    expect(chooseStackRuntime).toHaveBeenCalled();
    expect(svc.getTask(task.id)?.runtime).toBe("rust");
    expect(svc.pendingJobs.get(task.id)?.runtime).toBe("rust");
  });

  it("does not call the LLM when an explicit stack runtime is provided", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "python",
        rationale: "should not run",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => null,
    });

    const task = svc.createTask({
      prompt: "Build anything",
      runtime: "go",
    });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some((event) => event.type === "task.created"),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(chooseStackRuntime).not.toHaveBeenCalled();
    expect(svc.getTask(task.id)?.runtime).toBe("go");
    expect(svc.pendingJobs.get(task.id)?.runtime).toBe("go");
  });

  it("falls back to heuristic when the LLM returns null", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{ runtime: StackRuntime; rationale: string } | null> =>
        null,
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => null,
    });

    const task = svc.createTask({
      prompt: "Build a Next.js dashboard with app router",
    });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some(
            (event) =>
              event.type === "task.runtime_selected" &&
              event.data?.source === "heuristic",
          ),
      ),
    );

    expect(chooseStackRuntime).toHaveBeenCalled();
    expect(svc.getTask(task.id)?.runtime).toBe("nextjs");
    expect(svc.pendingJobs.get(task.id)?.runtime).toBe("nextjs");
  });

  it("replies to greetings without selecting a runtime or enqueueing", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "python",
        rationale: "should not run",
      }),
    );
    const planBrainExecution = mock(
      async (): Promise<{
        action: "reply";
        reply: string;
        rationale: string;
      } | null> => ({
        action: "reply",
        reply:
          "Hey — I'm doing well. Tell me what you want to build when you're ready.",
        rationale: "greeting",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution,
    });

    const task = svc.createTask({ prompt: "hi, how are you?" });

    await waitFor(() => svc.getTask(task.id)?.status === "completed");

    const events = svc.getEventHistory(task.id);
    expect(chooseStackRuntime).not.toHaveBeenCalled();
    expect(svc.pendingJobs.has(task.id)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "task.sandbox_skipped" && event.data?.source === "llm",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "agent.output" && event.message.includes("doing well"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "task.scheduled")).toBe(false);
    expect(events.some((event) => event.type === "task.runtime_selected")).toBe(
      false,
    );
  });

  it("skips the microVM for obvious greetings when the LLM is unavailable", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{ runtime: StackRuntime; rationale: string } | null> =>
        null,
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => null,
    });

    const task = svc.createTask({ prompt: "Hello" });

    await waitFor(() => svc.getTask(task.id)?.status === "completed");

    expect(chooseStackRuntime).not.toHaveBeenCalled();
    expect(svc.pendingJobs.has(task.id)).toBe(false);
    expect(
      svc
        .getEventHistory(task.id)
        .some(
          (event) =>
            event.type === "task.sandbox_skipped" &&
            event.data?.source === "heuristic",
        ),
    ).toBe(true);
  });

  it("does not skip the sandbox for coding prompts that start with hi", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "node",
        rationale: "express api",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => null,
    });

    const task = svc.createTask({
      prompt: "hi, add a login page to this repo",
    });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some((event) => event.type === "task.runtime_selected"),
      ),
    );

    expect(chooseStackRuntime).toHaveBeenCalled();
    expect(svc.getTask(task.id)?.status).not.toBe("completed");
    expect(svc.pendingJobs.has(task.id)).toBe(true);
  });

  it("uses the plan runtime and skips the second chooser for coding work", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "python",
        rationale: "should not run",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution: async () => ({
        action: "sandbox" as const,
        runtime: "go" as const,
        rationale: "Go HTTP service",
      }),
    });

    const task = svc.createTask({ prompt: "Build a Go chat server" });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some(
            (event) =>
              event.type === "task.runtime_selected" &&
              event.data?.runtime === "go",
          ),
      ),
    );

    expect(chooseStackRuntime).not.toHaveBeenCalled();
    expect(svc.getTask(task.id)?.runtime).toBe("go");
    expect(svc.pendingJobs.get(task.id)?.runtime).toBe("go");
  });

  it("still boots a sandbox when the user asked to create a repository", async () => {
    const chooseStackRuntime = mock(
      async (): Promise<{
        runtime: StackRuntime;
        rationale: string;
      } | null> => ({
        runtime: "node",
        rationale: "greenfield",
      }),
    );
    const planBrainExecution = mock(
      async (): Promise<{
        action: "reply";
        reply: string;
        rationale: string;
      } | null> => ({
        action: "reply",
        reply: "Hey there, what would you like to work on today?",
        rationale: "should not skip when creating a repo",
      }),
    );

    const svc = new TaskService({
      orchestratorUrl: "http://orchestrator.test",
      runtimeUrl: "http://runtime.test",
      mode: "standalone",
      defaultAgent: "brain",
      chooseStackRuntime,
      planBrainExecution,
    });

    const task = svc.createTask({
      prompt: "hi",
      createRepository: "acme/hello",
    });

    await waitFor(() =>
      Boolean(
        svc
          .getEventHistory(task.id)
          .some((event) => event.type === "task.runtime_selected"),
      ),
    );

    expect(planBrainExecution).not.toHaveBeenCalled();
    expect(chooseStackRuntime).toHaveBeenCalled();
    expect(svc.getTask(task.id)?.status).not.toBe("completed");
    expect(svc.pendingJobs.has(task.id)).toBe(true);
  });
});
