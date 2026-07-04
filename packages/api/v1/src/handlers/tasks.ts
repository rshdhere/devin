import { db } from "@devin/drizzle";
import { userDashboardSettings } from "@devin/drizzle/schema";
import { createTaskSchema } from "@devin/validators";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { authenticatedCloneUrl, getGitHubAccessToken } from "../lib/github.js";
import {
  createTask,
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
import { requireAuth } from "../middleware/require-auth.js";

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

function respondSchedulerFailure(
  res: import("express").Response,
  error: unknown,
) {
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
    respondSchedulerFailure(res, error);
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
    const githubToken = userToken ?? undefined;

    const response = await createTask({
      prompt: parsed.data.prompt,
      agent: parsed.data.agent,
      userId,
      repository,
      createRepository,
      autoCreateRepository,
      autoStartSandbox: parsed.data.autoStartSandbox,
      testCommand: parsed.data.testCommand,
      issueTitle: parsed.data.issueTitle,
      issueBody: parsed.data.issueBody,
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
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/diagnostics/infra", async (_req, res) => {
  try {
    const response = await getInfraDiagnostics();
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/:id/diagnostics", async (req, res) => {
  try {
    const response = await getTaskDiagnostics(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/:id", async (req, res) => {
  try {
    const response = await getTask(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/execute", async (req, res) => {
  try {
    const response = await startTaskExecution(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/retry", async (req, res) => {
  try {
    const response = await retryTask(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/commit", async (req, res) => {
  try {
    const response = await commitTaskWork(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/pr", async (req, res) => {
  try {
    const response = await raiseTaskPullRequest(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
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
    const response = await continueTask(req.params.id, prompt);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/terminate", async (req, res) => {
  try {
    const response = await terminateSession(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.post("/:id/wake", async (req, res) => {
  try {
    const response = await wakeSession(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
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
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/:id/files/read", async (req, res) => {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    const response = await readTaskFile(req.params.id, path);
    res.status(response.status).send(await response.text());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/:id/files", async (req, res) => {
  try {
    const path = typeof req.query.path === "string" ? req.query.path : ".";
    const response = await listTaskFiles(req.params.id, path);
    res.status(response.status).send(await response.text());
  } catch (error) {
    respondSchedulerFailure(res, error);
  }
});

tasksRouter.get("/:id/events/history", async (req, res) => {
  try {
    const response = await fetchTaskEventHistory(req.params.id);
    res.status(response.status).json(await response.json());
  } catch (error) {
    respondSchedulerFailure(res, error);
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
    respondSchedulerFailure(res, error);
  }
});
