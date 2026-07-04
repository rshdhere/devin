import { startSchedulerServer } from "@devin/scheduler/start-server";

const port = Number(process.env.BRAIN_PORT ?? process.env.PORT ?? 9092);
const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:9090";
const runtimeUrl = process.env.RUNTIME_URL ?? "http://localhost:8081";
const executionWorkerUrl =
  process.env.EXECUTION_WORKER_URL ?? "http://localhost:9091";

void startSchedulerServer({
  port,
  orchestratorUrl,
  runtimeUrl,
  defaultAgent: process.env.DEFAULT_AGENT as
    | "cursor"
    | "claude"
    | "mock"
    | undefined,
  mode: "brain",
  executionWorkerUrl,
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
