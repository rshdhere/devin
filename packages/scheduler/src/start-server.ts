import express from "express";
import { createServer } from "node:http";
import {
  handlePreviewProxy,
  shouldHandlePreviewHost,
} from "./preview/proxy.js";
import { TaskService } from "./task/service.js";
import { attachDesktopVNCWebSocketUpgrade } from "./task/service/desktop-computer.js";
import { resolveOrchestratorUrl } from "./config/orchestrator-url.js";
import {
  registerExecutionHostOnce,
  resolvePinnedHost,
  startExecutionHostReRegistration,
} from "./server/host-registration.js";
import { createSchedulerRouter } from "./server/routes.js";

export interface StartSchedulerServerOptions {
  port: number;
  orchestratorUrl: string;
  runtimeUrl: string;
  firecrackerHostUrl?: string;
  defaultAgent?: "cursor" | "claude" | "mock";
  mode?: "standalone" | "brain" | "worker";
  executionWorkerUrl?: string;
}

export async function startSchedulerServer(
  options: StartSchedulerServerOptions,
): Promise<void> {
  const preferredHost = resolvePinnedHost();
  const orchestratorUrl = await resolveOrchestratorUrl(options.orchestratorUrl);

  const tasks = new TaskService({
    orchestratorUrl,
    runtimeUrl: options.runtimeUrl,
    firecrackerHostUrl: options.firecrackerHostUrl,
    preferredHost,
    defaultAgent: options.defaultAgent,
    mode: options.mode,
    executionWorkerUrl: options.executionWorkerUrl,
  });

  await registerExecutionHostOnce({
    orchestratorUrl,
    hostName: preferredHost,
    firecrackerHostUrl: options.firecrackerHostUrl,
  });

  if (preferredHost) {
    startExecutionHostReRegistration({
      orchestratorUrl,
      hostName: preferredHost,
      firecrackerHostUrl: options.firecrackerHostUrl,
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (shouldHandlePreviewHost(req.headers.host)) {
      handlePreviewProxy(req, res);
      return;
    }
    next();
  });
  app.use(express.json());
  app.use(createSchedulerRouter(tasks, preferredHost));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      void next;
      console.error(error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "internal error",
      });
    },
  );

  const server = createServer(app);
  attachDesktopVNCWebSocketUpgrade(tasks, server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      console.log(
        `${options.mode ?? "standalone"} listening @ http://0.0.0.0:${options.port}`,
      );
      console.log(`orchestrator: ${orchestratorUrl}`);
      resolve();
    });
  });

  if (options.mode === "worker" && !tasks.getTaskStore().isEnabled()) {
    console.warn(
      "DATABASE_URL is unset on worker — task events will not persist and brain cannot mirror progress. Run: sudo devin-infra sync-platform-config",
    );
  }

  void tasks
    .initialize()
    .catch((error) => {
      console.error(
        "task store restore failed:",
        error instanceof Error ? error.message : error,
      );
    })
    .finally(() => {
      tasks.startWorker();
    });
}
