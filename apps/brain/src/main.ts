import { startSchedulerServer } from "@devin/scheduler/start-server";

export const main = async () => {
  const port = Number(process.env.BRAIN_PORT ?? process.env.PORT ?? 9092);
  const orchestratorUrl =
    process.env.ORCHESTRATOR_URL ?? "http://localhost:9090";
  const runtimeUrl = process.env.RUNTIME_URL ?? "http://localhost:8081";
  const executionWorkerUrl =
    process.env.EXECUTION_WORKER_URL ?? "http://localhost:9091";

  await startSchedulerServer({
    port,
    orchestratorUrl,
    runtimeUrl,
    defaultAgent: process.env.DEFAULT_AGENT as "brain" | "mock" | undefined,
    mode: "brain",
    executionWorkerUrl,
  });
};
