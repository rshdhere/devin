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
});
