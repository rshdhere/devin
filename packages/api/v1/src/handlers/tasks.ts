import { db } from "@devin/drizzle";
import { userDashboardSettings } from "@devin/drizzle/schema";
import { createTaskSchema } from "@devin/validators";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { authenticatedCloneUrl, getGitHubAccessToken } from "../lib/github.js";
import {
  createTask,
  ensureDesktopComputer,
  fetchDesktopScreenshot,
  fetchDesktopVNC,
  fetchDesktopVNCAsset,
  fetchDevboxPreview,
  fetchTaskEventHistory,
  getInfraDiagnostics,
  getTask,
  getTaskDiagnostics,
  listTasks,
  retryTask,
  startTaskExecution,
  streamTaskEvents,
  commitTaskWork,
  raiseTaskPullRequest,
  continueTask,
  terminateSession,
  wakeSession,
  runTaskTerminal,
  listTaskFiles,
  readTaskFile,
} from "../lib/scheduler.js";
import { applyCorsHeaders } from "../lib/cors.js";
import { rewriteDesktopVncPageHtml } from "../lib/desktop-vnc-html.js";
import { requireAuth } from "../middleware/require-auth.js";

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

function respondSchedulerFailure(
  req: import("express").Request,
  res: import("express").Response,
  error: unknown,
) {
  applyCorsHeaders(res, req.headers.origin, req.hostname);
  const message =
    error instanceof Error ? error.message : "Scheduler unavailable";
  res.status(503).json({ error: message });
}

tasksRouter.get("/", async (req, res) => {
  try {
    const response = await listTasks();
    const tasks = (await response.json()) as Array<{ userId?: string }>;
    const userId = req.auth?.user.id;

    if (userId) {
      const filtered = tasks.filter(
        (task) => !task.userId || task.userId === userId,
      );
      res.status(200).json(filtered);
      return;
    }

    res.status(response.status).json(tasks);
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/", async (req, res) => {
  const userId = req.auth?.user.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid task",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const [settings] = await db
      .select()
      .from(userDashboardSettings)
      .where(eq(userDashboardSettings.userId, userId))
      .limit(1);

    const repository =
      parsed.data.repository ?? settings?.selectedRepository ?? undefined;
    const createRepository = parsed.data.createRepository;
    const autoCreateRepository = parsed.data.autoCreateRepository;
    const userToken = await getGitHubAccessToken(userId);
    const githubToken =
      userToken?.trim() || process.env.GITHUB_BOT_TOKEN?.trim() || undefined;

    const response = await createTask({
      prompt: parsed.data.prompt,
      agent:
        parsed.data.agent === "claude"
          ? "claude"
          : parsed.data.agent === "mock" &&
              process.env.ALLOW_TEMPLATE_AGENT === "true"
            ? "mock"
            : "cursor",
      runtime: parsed.data.runtime,
      userId,
      repository,
      createRepository,
      autoCreateRepository,
      autoStartSandbox: parsed.data.autoStartSandbox,
      testCommand: parsed.data.testCommand,
      issueTitle: parsed.data.issueTitle,
      issueBody: parsed.data.issueBody,
      agentModel: parsed.data.agentModel,
      githubToken: githubToken ?? undefined,
      permissions: settings
        ? {
            canCommit: settings.githubCanCommit,
            canCreatePr: settings.githubCanCreatePr,
            canCreateRepo: settings.githubCanCreateRepo,
            canCreateIssue: settings.githubCanCreateIssue,
            canPush: settings.githubCanPush,
          }
        : undefined,
      requireReviewBeforePush: settings?.requireReviewBeforePush ?? false,
      cloneUrl:
        repository && githubToken
          ? authenticatedCloneUrl(githubToken, repository)
          : undefined,
    });

    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/diagnostics/infra", async (req, res) => {
  try {
    const response = await getInfraDiagnostics();
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/diagnostics", async (req, res) => {
  try {
    const response = await getTaskDiagnostics(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id", async (req, res) => {
  try {
    const response = await getTask(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/execute", async (req, res) => {
  try {
    const response = await startTaskExecution(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/retry", async (req, res) => {
  try {
    const response = await retryTask(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/commit", async (req, res) => {
  try {
    const response = await commitTaskWork(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/pr", async (req, res) => {
  try {
    const response = await raiseTaskPullRequest(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/continue", async (req, res) => {
  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  try {
    const agentModel =
      typeof req.body?.agentModel === "string"
        ? req.body.agentModel.trim()
        : undefined;
    const response = await continueTask(req.params.id, prompt, agentModel);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/terminate", async (req, res) => {
  try {
    const response = await terminateSession(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/wake", async (req, res) => {
  try {
    const response = await wakeSession(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/terminal", async (req, res) => {
  try {
    const response = await runTaskTerminal(req.params.id, req.body);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (!response.body) {
        res.status(502).end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }
    res.status(response.status).send(await response.text());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/files/read", async (req, res) => {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    const response = await readTaskFile(req.params.id, path);
    res.status(response.status).send(await response.text());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/files", async (req, res) => {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : ".";
    const response = await listTaskFiles(req.params.id, path);
    res.status(response.status).send(await response.text());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/devbox-preview", async (req, res) => {
  try {
    const path =
      typeof req.query.path === "string" && req.query.path.trim()
        ? req.query.path
        : "/";
    const warm =
      req.query.warm === "1" ||
      req.query.warm === "true" ||
      req.query.bootstrap === "1";
    const response = await fetchDevboxPreview(req.params.id, path, { warm });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === "transfer-encoding" ||
        lower === "content-encoding" ||
        lower === "content-length"
      ) {
        return;
      }
      res.setHeader(key, value);
    });
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.post("/:id/desktop/ensure", async (req, res) => {
  try {
    const response = await ensureDesktopComputer(req.params.id);
    res.status(response.status);
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ?? "application/json",
    );
    res.send(await response.text());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/desktop-screenshot", async (req, res) => {
  try {
    const fresh =
      req.query.fresh === "1" ||
      req.query.fresh === "true" ||
      req.query.refresh === "1";
    const response = await fetchDesktopScreenshot(req.params.id, { fresh });
    res.status(response.status);
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") ?? "image/png",
    );
    res.setHeader("Cache-Control", "no-store");
    const body = await response.arrayBuffer();
    res.send(Buffer.from(body));
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/desktop-vnc", async (req, res) => {
  try {
    const response = await fetchDesktopVNC(req.params.id);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding") {
        return;
      }
      res.setHeader(key, value);
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    let body = Buffer.from(await response.arrayBuffer()).toString("utf8");
    if (response.ok) {
      body = rewriteDesktopVncPageHtml(body, req.params.id);
    }
    res.send(body);
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/desktop-vnc/assets/*assetPath", async (req, res) => {
  try {
    const assetPath = Array.isArray(req.params.assetPath)
      ? req.params.assetPath.join("/")
      : req.params.assetPath;
    const response = await fetchDesktopVNCAsset(req.params.id, assetPath);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding") {
        return;
      }
      res.setHeader(key, value);
    });
    if (/\.(m?js)$/i.test(assetPath)) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

// Compat: older noVNC HTML resolves assets relative to .../tasks/:id/assets/...
tasksRouter.get("/:id/assets/*assetPath", async (req, res) => {
  try {
    const assetPath = Array.isArray(req.params.assetPath)
      ? req.params.assetPath.join("/")
      : req.params.assetPath;
    const response = await fetchDesktopVNCAsset(req.params.id, assetPath);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding") {
        return;
      }
      res.setHeader(key, value);
    });
    if (/\.(m?js)$/i.test(assetPath)) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/events/history", async (req, res) => {
  try {
    const response = await fetchTaskEventHistory(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});

tasksRouter.get("/:id/events", async (req, res) => {
  try {
    const response = await streamTaskEvents(req.params.id);

    if (!response.ok || !response.body) {
      res.status(response.status).json(await response.json());
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    req.on("close", () => {
      void reader.cancel();
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();
  } catch (error) {
    respondSchedulerFailure(req, res, error);
  }
});
