import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  localSecretsKeyForTests,
} from "@devin/secrets/envelope.js";
import {
  decryptSessionGithubToken,
  encryptGithubTokenForTransit,
  encryptSessionGithubToken,
  normalizeIngestedJob,
  serializeJobForDelegation,
  stripSecretsFromPersistedJob,
  tokenFreeCloneUrl,
} from "@devin/secrets/job-tokens.js";
import {
  decryptAccountTokenField,
  encryptAccountTokenField,
} from "@devin/secrets/account-tokens.js";

const ENV_KEYS = ["SECRETS_KMS_KEY_ID", "LOCAL_SECRETS_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

describe("@devin/secrets local envelope", () => {
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

  it("encrypts and decrypts round-trip", async () => {
    const blob = await encryptSecret("ghp_test_token_123");
    expect(isEncrypted(blob)).toBe(true);
    await expect(decryptSecret(blob)).resolves.toBe("ghp_test_token_123");
  });

  it("dual-reads legacy plaintext bytea", async () => {
    const legacy = Buffer.from("ghp_legacy_plaintext", "utf8");
    expect(isEncrypted(legacy)).toBe(false);
    await expect(decryptSecret(legacy)).resolves.toBe("ghp_legacy_plaintext");
  });

  it("encrypts account token fields idempotently", async () => {
    const first = await encryptAccountTokenField("gho_oauth");
    expect(first).toBeDefined();
    const second = await encryptAccountTokenField(first);
    expect(Buffer.compare(first!, second!)).toBe(0);
    await expect(decryptAccountTokenField(first)).resolves.toBe("gho_oauth");
  });

  it("strips secrets from persisted jobs", () => {
    const stripped = stripSecretsFromPersistedJob({
      taskId: "t1",
      githubToken: "ghp_secret",
      cloneUrl: "https://x-access-token:ghp_secret@github.com/org/repo.git",
      repository: "org/repo",
    } as never);
    expect(stripped.githubToken).toBeUndefined();
    expect(stripped.cloneUrl).toBe(tokenFreeCloneUrl("org/repo"));
  });

  it("serializes delegation payload without plaintext token", async () => {
    const payload = await serializeJobForDelegation({
      taskId: "t1",
      prompt: "hi",
      agent: "brain",
      githubToken: "ghp_secret",
      repository: "org/repo",
      cloneUrl: "https://x-access-token:ghp_secret@github.com/org/repo.git",
      enqueuedAt: new Date().toISOString(),
    } as never);
    expect(payload.githubToken).toBeUndefined();
    expect(payload.githubTokenEncrypted).toBeString();
    expect(payload.cloneUrl).toBe(tokenFreeCloneUrl("org/repo"));
    expect(JSON.stringify(payload)).not.toContain("ghp_secret");
  });

  it("normalizes ingested encrypted jobs", async () => {
    const encrypted = await encryptGithubTokenForTransit("ghp_worker");
    const normalized = await normalizeIngestedJob({
      taskId: "t1",
      prompt: "hi",
      agent: "brain",
      githubTokenEncrypted: encrypted,
      enqueuedAt: new Date().toISOString(),
    } as never);
    expect(normalized.githubToken).toBe("ghp_worker");
    expect(normalized.githubTokenEncrypted).toBeUndefined();
  });

  it("encrypts session github tokens for storage", async () => {
    const stored = await encryptSessionGithubToken("ghp_session");
    expect(stored).toBeDefined();
    await expect(decryptSessionGithubToken(stored)).resolves.toBe(
      "ghp_session",
    );
  });
});
