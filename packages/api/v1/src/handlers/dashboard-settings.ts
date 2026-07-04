import { db } from "@devin/drizzle";
import { userDashboardSettings } from "@devin/drizzle/schema";
import { dashboardSettingsSchema } from "@devin/validators";
import { eq } from "drizzle-orm";
import { Request, Response, Router } from "express";
import { requireAuth } from "../middleware/require-auth.js";

export const dashboardSettingsRouter = Router();

const defaultSettings = {
  repositoryLabel: "No repository selected",
  environment: "Ubuntu",
  selectedRepository: null as string | null,
  githubCanCommit: true,
  githubCanCreatePr: true,
  githubCanCreateRepo: true,
  githubCanCreateIssue: true,
  githubCanPush: true,
  requireReviewBeforePush: false,
} as const;

async function getOrCreateSettings(userId: string) {
  const existing = await db
    .select()
    .from(userDashboardSettings)
    .where(eq(userDashboardSettings.userId, userId))
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  const [created] = await db
    .insert(userDashboardSettings)
    .values({
      userId,
      repositoryLabel: defaultSettings.repositoryLabel,
      environment: defaultSettings.environment,
      githubCanCommit: defaultSettings.githubCanCommit,
      githubCanCreatePr: defaultSettings.githubCanCreatePr,
      githubCanCreateRepo: defaultSettings.githubCanCreateRepo,
      githubCanCreateIssue: defaultSettings.githubCanCreateIssue,
      githubCanPush: defaultSettings.githubCanPush,
      requireReviewBeforePush: defaultSettings.requireReviewBeforePush,
    })
    .returning();

  return created!;
}

function serializeSettings(
  settings: Awaited<ReturnType<typeof getOrCreateSettings>>,
) {
  return {
    repositoryLabel: settings.repositoryLabel,
    selectedRepository: settings.selectedRepository,
    environment: settings.environment,
    githubPermissions: {
      canCommit: settings.githubCanCommit,
      canCreatePr: settings.githubCanCreatePr,
      canCreateRepo: settings.githubCanCreateRepo,
      canCreateIssue: settings.githubCanCreateIssue,
      canPush: settings.githubCanPush,
    },
    requireReviewBeforePush: settings.requireReviewBeforePush,
  };
}

export async function getDashboardSettingsHandler(req: Request, res: Response) {
  const userId = req.auth?.user.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const settings = await getOrCreateSettings(userId);
    res.status(200).json(serializeSettings(settings));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to load settings",
    });
  }
}

export async function updateDashboardSettingsHandler(
  req: Request,
  res: Response,
) {
  const userId = req.auth?.user.id;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = dashboardSettingsSchema.update.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid settings",
      details: parsed.error.flatten(),
    });
    return;
  }

  await getOrCreateSettings(userId);

  const updateData: Record<string, unknown> = {};
  if (parsed.data.repositoryLabel !== undefined) {
    updateData.repositoryLabel = parsed.data.repositoryLabel;
  }
  if (parsed.data.selectedRepository !== undefined) {
    updateData.selectedRepository = parsed.data.selectedRepository;
    if (parsed.data.repositoryLabel === undefined) {
      updateData.repositoryLabel =
        parsed.data.selectedRepository ?? "No repository selected";
    }
  }
  if (parsed.data.environment !== undefined) {
    updateData.environment = parsed.data.environment;
  }
  if (parsed.data.githubCanCommit !== undefined) {
    updateData.githubCanCommit = parsed.data.githubCanCommit;
  }
  if (parsed.data.githubCanCreatePr !== undefined) {
    updateData.githubCanCreatePr = parsed.data.githubCanCreatePr;
  }
  if (parsed.data.githubCanCreateRepo !== undefined) {
    updateData.githubCanCreateRepo = parsed.data.githubCanCreateRepo;
  }
  if (parsed.data.githubCanCreateIssue !== undefined) {
    updateData.githubCanCreateIssue = parsed.data.githubCanCreateIssue;
  }
  if (parsed.data.githubCanPush !== undefined) {
    updateData.githubCanPush = parsed.data.githubCanPush;
  }
  if (parsed.data.requireReviewBeforePush !== undefined) {
    updateData.requireReviewBeforePush = parsed.data.requireReviewBeforePush;
  }

  const [updated] = await db
    .update(userDashboardSettings)
    .set(updateData)
    .where(eq(userDashboardSettings.userId, userId))
    .returning();

  res.status(200).json(serializeSettings(updated!));
}

dashboardSettingsRouter.get(
  "/dashboard",
  requireAuth,
  getDashboardSettingsHandler,
);
dashboardSettingsRouter.patch(
  "/dashboard",
  requireAuth,
  updateDashboardSettingsHandler,
);
