import { Router, type Request, type Response } from "express";
import { isPreviewTlsDomainAllowed } from "../preview/registry.js";
import type { TaskService } from "../task/service.js";
import type { ScheduleJob } from "../task/types.js";
import { createTaskRouter } from "./task-routes.js";

export function createSchedulerRouter(
  tasks: TaskService,
  preferredHost: string | undefined,
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      mode: tasks.getMode(),
      preferredHost,
      durable: tasks.getTaskStore().isEnabled(),
    });
  });

  // Caddy on_demand_tls ask endpoint — only mint preview-domain certs.
  router.get("/internal/v1/preview/tls-allowed", (req, res) => {
    const domain = queryString(req, "domain");
    if (isPreviewTlsDomainAllowed(domain)) {
      res.status(200).type("text/plain").send("ok");
      return;
    }
    res.status(400).type("text/plain").send("forbidden");
  });

  router.post("/internal/v1/jobs", async (req, res) => {
    try {
      const job = req.body as ScheduleJob;
      await tasks.ingestWorkerJob(job);
      res.status(202).json({ status: "accepted", taskId: job.taskId });
    } catch (error) {
      sendError(res, 400, error, "invalid job");
    }
  });

  router.get("/api/v1/diagnostics", async (_req, res) => {
    try {
      res.status(200).json(await tasks.getInfraDiagnostics());
    } catch (error) {
      sendError(res, 500, error, "diagnostics failed");
    }
  });

  router.use("/api/v1/tasks", createTaskRouter(tasks));

  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return router;
}

function queryString(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === "string" ? value : "";
}

function sendError(
  res: Response,
  status: number,
  error: unknown,
  fallback: string,
): void {
  res.status(status).json({
    error: error instanceof Error ? error.message : fallback,
  });
}
