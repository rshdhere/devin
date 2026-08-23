import { startSchedulerServer } from "@devin/scheduler/start-server";

export const main = async () => {
  const port = Number(process.env.SCHEDULER_PORT ?? 9091);
  const orchestratorUrl =
    process.env.ORCHESTRATOR_URL ?? "http://localhost:9090";
  const runtimeUrl = process.env.RUNTIME_URL ?? "http://localhost:8081";
  const firecrackerHostUrl =
    process.env.FIRECRACKER_HOST_URL?.trim() || undefined;
  const defaultAgent = process.env.DEFAULT_AGENT as
    | "brain"
    | "mock"
    | undefined;
  const mode = (process.env.SERVICE_MODE ?? "standalone") as
    | "standalone"
    | "brain"
    | "worker";

  await startSchedulerServer({
    port,
    orchestratorUrl,
    runtimeUrl,
    firecrackerHostUrl,
    defaultAgent,
    mode,
    executionWorkerUrl: process.env.EXECUTION_WORKER_URL,
  });
};
