import { decryptSecret, encryptSecret, isEncrypted } from "./envelope.js";

const ACCOUNT_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
] as const;

export type AccountTokenField = (typeof ACCOUNT_TOKEN_FIELDS)[number];

export async function encryptAccountTokenField(
  value: string | Buffer | null | undefined,
): Promise<Buffer | null | undefined> {
  if (value == null) {
    return value;
  }
  if (Buffer.isBuffer(value) && isEncrypted(value)) {
    return value;
  }
  const plaintext = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (!plaintext) {
    return null;
  }
  return encryptSecret(plaintext);
}

export async function decryptAccountTokenField(
  value: string | Buffer | null | undefined,
): Promise<string | null | undefined> {
  if (value == null) {
    return null;
  }
  return decryptSecret(Buffer.isBuffer(value) ? value : Buffer.from(value));
}

export async function encryptAccountRecord<
  T extends Partial<Record<AccountTokenField, string | Buffer | null>>,
>(record: T): Promise<T> {
  const next = { ...record };
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const value = next[field];
    if (typeof value === "string" && value.length > 0) {
      next[field] = (await encryptAccountTokenField(
        value,
      )) as T[AccountTokenField];
    }
  }
  return next;
}

export async function decryptAccountRecord<
  T extends Partial<Record<AccountTokenField, string | Buffer | null>>,
>(record: T | null | undefined): Promise<T | null | undefined> {
  if (!record) {
    return record;
  }
  const next = { ...record };
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    const value = next[field];
    if (value != null) {
      next[field] = (await decryptAccountTokenField(
        value,
      )) as T[AccountTokenField];
    }
  }
  return next;
}
