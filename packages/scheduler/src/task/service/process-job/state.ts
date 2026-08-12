import type { RuntimeClient } from "@devin/agent-sdk";
import type { GitHubUserIdentity } from "../../github/client.js";
import type { ScheduleJob, Task } from "../types.js";

export type ProcessJobState = {
  sandboxName?: string;
  retainSandboxForPreview: boolean;
  pausedForReview: boolean;
  guestHost?: string;
  runtime?: RuntimeClient;
  repoCwd: string;
  repository?: string;
  cloneUrl?: string;
  githubToken?: string;
  createdNewRepo: boolean;
  runtimeBaseUrl?: string;
  gitOwner?: GitHubUserIdentity;
  repoHydratedLocally: boolean;
};
