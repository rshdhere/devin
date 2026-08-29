import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  localSecretsKeyForTests,
  stripSecretsFromPersistedJob,
} from "@devin/secrets";
import type { ScheduleJob } from "@scheduler/task/types.js";

const ENV_KEYS = ["SECRETS_KMS_KEY_ID", "LOCAL_SECRETS_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

describe("task store secret persistence helpers", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    delete process.env.SECRETS_KMS_KEY_ID;
    process.env.LOCAL_SECRETS_KEY = localSecretsKeyForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("removes github token fields from persisted job json", () => {
    const job = {
      taskId: "task-1",
      prompt: "test",
      agent: "brain",
      githubToken: "ghp_secret",
      githubTokenEncrypted: "ignored",
      cloneUrl: "https://x-access-token:ghp_secret@github.com/acme/repo.git",
      repository: "acme/repo",
      enqueuedAt: new Date().toISOString(),
    } satisfies ScheduleJob;

    const stripped = stripSecretsFromPersistedJob(job);
    expect(stripped.githubToken).toBeUndefined();
    expect(stripped.githubTokenEncrypted).toBeUndefined();
    expect(stripped.cloneUrl).toBe("https://github.com/acme/repo.git");
    expect(JSON.stringify(stripped)).not.toContain("ghp_secret");
  });
});
