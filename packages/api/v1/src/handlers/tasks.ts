import { db } from "@devin/drizzle";
import { userDashboardSettings } from "@devin/drizzle/schema";
import { createTaskSchema } from "@devin/validators";
import { eq } from "drizzle-orm";
import { Router } from "express";
import { authenticatedCloneUrl, getGitHubAccessToken } from "../lib/github.js";
import {
  createTask,
  getTask,
  listTasks,
  streamTaskEvents,
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
    const githubToken = repository
      ? await getGitHubAccessToken(userId)
      : undefined;

    const response = await createTask({
      prompt: parsed.data.prompt,
      agent: parsed.data.agent,
      userId,
      repository,
      githubToken: githubToken ?? undefined,
      permissions: settings
        ? {
            canCommit: settings.githubCanCommit,
            canCreatePr: settings.githubCanCreatePr,
            canPush: settings.githubCanPush,
          }
        : undefined,
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

tasksRouter.get("/:id", async (req, res) => {
  try {
    const response = await getTask(req.params.id);
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
