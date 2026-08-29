import { decryptSecret, encryptSecret } from "./envelope.js";

export function tokenFreeCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}

export function cloneUrlEmbedsToken(cloneUrl: string | undefined): boolean {
  return Boolean(cloneUrl?.includes("x-access-token:"));
}

export async function encryptGithubTokenForTransit(
  token: string | undefined,
): Promise<string | undefined> {
  const trimmed = token?.trim();
  if (!trimmed) {
    return undefined;
  }
  return (await encryptSecret(trimmed)).toString("base64");
}

export async function decryptGithubTokenFromTransit(
  encrypted: string | undefined,
): Promise<string | undefined> {
  const trimmed = encrypted?.trim();
  if (!trimmed) {
    return undefined;
  }
  const decrypted = await decryptSecret(Buffer.from(trimmed, "base64"));
  return decrypted ?? undefined;
}

export type JobWithEncryptedGithubToken = {
  githubToken?: string;
  githubTokenEncrypted?: string;
  cloneUrl?: string;
  repository?: string;
};

export async function resolveJobGithubToken(
  job: JobWithEncryptedGithubToken,
): Promise<string | undefined> {
  const plaintext = job.githubToken?.trim();
  if (plaintext) {
    return plaintext;
  }
  return decryptGithubTokenFromTransit(job.githubTokenEncrypted);
}

export function stripSecretsFromPersistedJob<
  T extends JobWithEncryptedGithubToken,
>(job: T): T {
  const next = { ...job };
  delete next.githubToken;
  delete next.githubTokenEncrypted;
  if (next.repository) {
    next.cloneUrl = tokenFreeCloneUrl(next.repository);
  } else if (cloneUrlEmbedsToken(next.cloneUrl)) {
    delete next.cloneUrl;
  }
  return next;
}

export async function serializeJobForDelegation<
  T extends JobWithEncryptedGithubToken,
>(job: T): Promise<Record<string, unknown>> {
  const token = await resolveJobGithubToken(job);
  const payload: Record<string, unknown> = {
    ...job,
    githubToken: undefined,
    githubTokenEncrypted: token
      ? await encryptGithubTokenForTransit(token)
      : undefined,
  };
  if (job.repository) {
    payload.cloneUrl = tokenFreeCloneUrl(job.repository);
  } else if (cloneUrlEmbedsToken(job.cloneUrl)) {
    delete payload.cloneUrl;
  }
  return payload;
}

export async function normalizeIngestedJob<
  T extends JobWithEncryptedGithubToken,
>(job: T): Promise<T> {
  const token = await resolveJobGithubToken(job);
  const next = { ...job, githubToken: token };
  delete next.githubTokenEncrypted;
  return next;
}

export async function encryptSessionGithubToken(
  token: string | undefined,
): Promise<Buffer | null | undefined> {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  return encryptSecret(trimmed);
}

export async function decryptSessionGithubToken(
  value: Buffer | string | null | undefined,
): Promise<string | undefined> {
  if (value == null) {
    return undefined;
  }
  const decrypted = await decryptSecret(
    Buffer.isBuffer(value) ? value : Buffer.from(value),
  );
  return decrypted ?? undefined;
}
