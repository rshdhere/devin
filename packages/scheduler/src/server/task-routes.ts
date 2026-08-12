import { Router, type Request, type Response } from "express";
import type { TaskService } from "../task/service.js";
import { normalizeSandboxFilePath } from "../sandbox/paths.js";
import { handleTaskEvents } from "./task-events.js";

type TaskRequestBody = {
  prompt?: string;
  agent?: "cursor" | "claude" | "mock";
  userId?: string;
  repository?: string;
  cloneUrl?: string;
  githubToken?: string;
  permissions?: {
    canCommit: boolean;
    canCreatePr: boolean;
    canCreateRepo: boolean;
    canCreateIssue: boolean;
    canPush: boolean;
  };
  createRepository?: string;
  autoCreateRepository?: boolean;
  autoStartSandbox?: boolean;
  requireReviewBeforePush?: boolean;
  testCommand?: string;
  issueTitle?: string;
  issueBody?: string;
  agentModel?: string;
};

export function createTaskRouter(tasks: TaskService): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const stored = await tasks.listTasksFromStore();
    res.status(200).json(stored.length > 0 ? stored : tasks.listTasks());
  });

  router.post("/", (req, res) => {
    try {
      const body = req.body as TaskRequestBody;
      const task = tasks.createTask({
        prompt: body.prompt ?? "",
        agent: body.agent,
        userId: body.userId,
        repository: body.repository,
        createRepository: body.createRepository,
        autoCreateRepository: body.autoCreateRepository,
        autoStartSandbox: body.autoStartSandbox,
        requireReviewBeforePush: body.requireReviewBeforePush,
        cloneUrl: body.cloneUrl,
        githubToken: body.githubToken,
        permissions: body.permissions,
        testCommand: body.testCommand,
        issueTitle: body.issueTitle,
        issueBody: body.issueBody,
        agentModel: body.agentModel,
      });
      res.status(202).json(task);
    } catch (error) {
      sendError(res, 400, error, "invalid request");
    }
  });

  router.get("/:id", async (req, res) => {
    const taskId = req.params.id;
    const task =
      tasks.getTask(taskId) ?? (await tasks.getTaskStore().getTask(taskId));
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.status(200).json(task);
  });

  router.get("/:id/diagnostics", async (req, res) => {
    const taskId = req.params.id;
    if (!tasks.getTask(taskId)) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    try {
      res.status(200).json(await tasks.getTaskDiagnostics(taskId));
    } catch (error) {
      sendError(res, 500, error, "diagnostics failed");
    }
  });

  router.get("/:id/events/history", async (req, res) => {
    const taskId = req.params.id;
    if (
      !tasks.getTask(taskId) &&
      !(await tasks.getTaskStore().getTask(taskId))
    ) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    const memoryHistory = tasks.getEventHistory(taskId);
    const history = tasks.getTaskStore().isEnabled()
      ? await tasks.getTaskStore().loadEvents(taskId)
      : memoryHistory.length > 0
        ? memoryHistory
        : await tasks.getTaskStore().loadEvents(taskId);
    res.status(200).json(history);
  });

  router.get("/:id/events", async (req, res) => {
    await handleTaskEvents(tasks, req.params.id, req, res);
  });

  router.post("/:id/retry", async (req, res) => {
    await runTaskAction(res, 202, "retry failed", () =>
      tasks.retryTask(req.params.id),
    );
  });

  router.post("/:id/execute", async (req, res) => {
    await runTaskAction(res, 202, "execute failed", () =>
      tasks.startExecution(req.params.id),
    );
  });

  router.post("/:id/commit", async (req, res) => {
    await runTaskAction(res, 200, "commit failed", () =>
      tasks.commitTaskWork(req.params.id),
    );
  });

  router.post("/:id/pr", async (req, res) => {
    await runTaskAction(res, 200, "pull request failed", () =>
      tasks.raiseTaskPullRequest(req.params.id),
    );
  });

  router.post("/:id/continue", async (req, res) => {
    const body = req.body as { prompt?: string; agentModel?: string };
    await runTaskAction(res, 202, "continue failed", () =>
      tasks.continueTask(req.params.id, body.prompt ?? "", body.agentModel),
    );
  });

  router.post("/:id/wake", async (req, res) => {
    try {
      await tasks.wakeSession(req.params.id);
      res.status(200).json(tasks.getTask(req.params.id) ?? { status: "ok" });
    } catch (error) {
      sendError(res, 400, error, "wake failed");
    }
  });

  router.post("/:id/terminate", async (req, res) => {
    await runTaskAction(res, 200, "terminate failed", () =>
      tasks.terminateSession(req.params.id),
    );
  });

  router.post("/:id/terminal", async (req, res) => {
    await handleTerminalProxy(tasks, req.params.id, req, res);
  });

  router.get("/:id/files", async (req, res) => {
    const path = normalizeSandboxFilePath(queryString(req, "path", "."));
    await proxyRuntimeGet(
      tasks,
      req.params.id,
      `/files/list?path=${encodeURIComponent(path)}`,
      res,
      "files list failed",
    );
  });

  router.get("/:id/files/read", async (req, res) => {
    const path = normalizeSandboxFilePath(queryString(req, "path", ""));
    await proxyRuntimeGet(
      tasks,
      req.params.id,
      `/files/read?path=${encodeURIComponent(path)}`,
      res,
      "file read failed",
    );
  });

  router.get("/:id/devbox-preview", async (req, res) => {
    const path =
      typeof req.query.path === "string" && req.query.path.trim()
        ? req.query.path
        : "/";
    const warm =
      req.query.warm === "1" ||
      req.query.warm === "true" ||
      req.query.bootstrap === "1";
    try {
      await tasks.proxyDevboxPreview(req.params.id, path, req, res, { warm });
    } catch (error) {
      sendError(res, 502, error, "devbox preview failed");
    }
  });

  router.get("/:id/desktop-screenshot", async (req, res) => {
    try {
      const fresh =
        req.query.fresh === "1" ||
        req.query.fresh === "true" ||
        req.query.refresh === "1";
      const response = await tasks.fetchDesktopScreenshot(req.params.id, {
        fresh,
      });
      const body = await response.arrayBuffer();
      res.status(response.status);
      res.setHeader(
        "Content-Type",
        response.headers.get("content-type") ?? "image/png",
      );
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(body));
    } catch (error) {
      sendError(res, 502, error, "desktop screenshot failed");
    }
  });

  router.get("/:id/runtime-proxy", async (req, res) => {
    const runtimePath = queryString(req, "path", "/");
    try {
      const upstream = await tasks.proxyRuntimeRequest(
        req.params.id,
        runtimePath,
      );
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === "transfer-encoding" || lower === "content-encoding") {
          return;
        }
        res.setHeader(key, value);
      });
      const body = await upstream.arrayBuffer();
      res.send(Buffer.from(body));
    } catch (error) {
      sendError(res, 502, error, "runtime proxy failed");
    }
  });

  return router;
}

async function runTaskAction(
  res: Response,
  status: number,
  fallback: string,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    res.status(status).json(await action());
  } catch (error) {
    sendError(res, 400, error, fallback);
  }
}

async function handleTerminalProxy(
  tasks: TaskService,
  taskId: string,
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      command?: string;
      cwd?: string;
      stream?: boolean;
    };
    const upstream = await tasks.proxyRuntimeRequest(
      taskId,
      body.stream ? "/terminal/stream" : "/terminal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          command: body.command ?? "",
          cwd: body.cwd,
        }),
      },
    );

    res.status(upstream.status);
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") ??
        (body.stream ? "text/event-stream" : "application/json"),
    );

    if (body.stream) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      return;
    }

    res.send(await upstream.text());
  } catch (error) {
    sendError(res, 400, error, "terminal failed");
  }
}

async function proxyRuntimeGet(
  tasks: TaskService,
  taskId: string,
  path: string,
  res: Response,
  fallback: string,
): Promise<void> {
  try {
    const upstream = await tasks.proxyRuntimeRequest(taskId, path);
    res.status(upstream.status);
    res.type(upstream.headers.get("content-type") ?? "application/json");
    res.send(await upstream.text());
  } catch (error) {
    sendError(res, 400, error, fallback);
  }
}

function queryString(req: Request, key: string, fallback: string): string {
  const value = req.query[key];
  return typeof value === "string" ? value : fallback;
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
