import { authConfig } from "@/lib/auth-config";

export interface GitHubPermissions {
  canCommit: boolean;
  canCreatePr: boolean;
  canCreateRepo: boolean;
  canCreateIssue: boolean;
  canPush: boolean;
}

export interface DashboardSettings {
  repositoryLabel: string;
  selectedRepository: string | null;
  environment: string;
  githubPermissions: GitHubPermissions;
  requireReviewBeforePush: boolean;
}

export const defaultDashboardSettings: DashboardSettings = {
  repositoryLabel: "No repository selected",
  selectedRepository: null,
  environment: "Ubuntu",
  githubPermissions: {
    canCommit: true,
    canCreatePr: true,
    canCreateRepo: true,
    canCreateIssue: true,
    canPush: true,
  },
  requireReviewBeforePush: false,
};

const settingsUrl = `${authConfig.baseURL}/api/v1/settings/dashboard`;

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === "string" ? body.error : "Request failed",
    );
  }

  return response.json() as Promise<T>;
}

export async function fetchDashboardSettings() {
  const response = await fetch(settingsUrl, {
    credentials: "include",
  });

  return parseResponse<DashboardSettings>(response);
}

export async function fetchDashboardSettingsSafe() {
  try {
    return await fetchDashboardSettings();
  } catch {
    return defaultDashboardSettings;
  }
}

export async function updateDashboardSettings(
  data: Partial<DashboardSettings> & {
    githubCanCommit?: boolean;
    githubCanCreatePr?: boolean;
    githubCanCreateRepo?: boolean;
    githubCanCreateIssue?: boolean;
    githubCanPush?: boolean;
    requireReviewBeforePush?: boolean;
  },
) {
  const payload: Record<string, unknown> = {};
  if (data.repositoryLabel !== undefined) {
    payload.repositoryLabel = data.repositoryLabel;
  }
  if (data.selectedRepository !== undefined) {
    payload.selectedRepository = data.selectedRepository;
  }
  if (data.environment !== undefined) {
    payload.environment = data.environment;
  }
  if (data.githubPermissions) {
    payload.githubCanCommit = data.githubPermissions.canCommit;
    payload.githubCanCreatePr = data.githubPermissions.canCreatePr;
    payload.githubCanCreateRepo = data.githubPermissions.canCreateRepo;
    payload.githubCanCreateIssue = data.githubPermissions.canCreateIssue;
    payload.githubCanPush = data.githubPermissions.canPush;
  }
  if (data.githubCanCommit !== undefined) {
    payload.githubCanCommit = data.githubCanCommit;
  }
  if (data.githubCanCreatePr !== undefined) {
    payload.githubCanCreatePr = data.githubCanCreatePr;
  }
  if (data.githubCanCreateRepo !== undefined) {
    payload.githubCanCreateRepo = data.githubCanCreateRepo;
  }
  if (data.githubCanCreateIssue !== undefined) {
    payload.githubCanCreateIssue = data.githubCanCreateIssue;
  }
  if (data.githubCanPush !== undefined) {
    payload.githubCanPush = data.githubCanPush;
  }
  if (data.requireReviewBeforePush !== undefined) {
    payload.requireReviewBeforePush = data.requireReviewBeforePush;
  }

  const response = await fetch(settingsUrl, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseResponse<DashboardSettings>(response);
}

export const environmentOptions = [
  "Ubuntu",
  "Debian",
  "Amazon Linux",
  "macOS",
] as const;
