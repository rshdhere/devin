import { startSchedulerServer } from "@devin/scheduler/start-server";

const port = Number(process.env.SCHEDULER_PORT ?? 9091);
const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:9090";
const runtimeUrl = process.env.RUNTIME_URL ?? "http://localhost:8081";
const firecrackerHostUrl =
  process.env.FIRECRACKER_HOST_URL?.trim() || undefined;
const defaultAgent = process.env.DEFAULT_AGENT as
  | "cursor"
  | "claude"
  | "mock"
  | undefined;
const mode = (process.env.SERVICE_MODE ?? "standalone") as
  | "standalone"
  | "brain"
  | "worker";

void startSchedulerServer({
  port,
  orchestratorUrl,
  runtimeUrl,
  firecrackerHostUrl,
  defaultAgent,
  mode,
  executionWorkerUrl: process.env.EXECUTION_WORKER_URL,
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
