import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const VERSION = 1;
const KEY_SOURCE_KMS = 0;
const KEY_SOURCE_LOCAL = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 4;

let kmsClient: KMSClient | undefined;

function getKmsClient(): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({});
  }
  return kmsClient;
}

function getLocalDek(): Buffer {
  const raw = process.env.LOCAL_SECRETS_KEY?.trim();
  if (!raw) {
    throw new Error(
      "SECRETS_KMS_KEY_ID or LOCAL_SECRETS_KEY is required for secret encryption",
    );
  }
  const keyMaterial = Buffer.from(raw, "base64");
  if (keyMaterial.length !== 32) {
    throw new Error("LOCAL_SECRETS_KEY must be 32 bytes base64-encoded");
  }
  return keyMaterial;
}

export function isEncrypted(
  value: Buffer | string | null | undefined,
): boolean {
  if (value == null) {
    return false;
  }
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return buf.length >= HEADER_LENGTH && buf[0] === VERSION;
}

export async function encryptSecret(plaintext: string): Promise<Buffer> {
  if (!plaintext) {
    throw new Error("encryptSecret requires non-empty plaintext");
  }

  const kmsKeyId = process.env.SECRETS_KMS_KEY_ID?.trim();
  const iv = randomBytes(IV_LENGTH);
  let keySource: number;
  let dek: Buffer;
  let encryptedDek: Buffer;

  if (kmsKeyId) {
    const result = await getKmsClient().send(
      new GenerateDataKeyCommand({
        KeyId: kmsKeyId,
        KeySpec: "AES_256",
      }),
    );
    if (!result.Plaintext || !result.CiphertextBlob) {
      throw new Error("KMS GenerateDataKey returned incomplete payload");
    }
    dek = Buffer.from(result.Plaintext);
    encryptedDek = Buffer.from(result.CiphertextBlob);
    keySource = KEY_SOURCE_KMS;
  } else {
    dek = getLocalDek();
    encryptedDek = Buffer.alloc(0);
    keySource = KEY_SOURCE_LOCAL;
  }

  try {
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_LENGTH);
    header[0] = VERSION;
    header[1] = keySource;
    header.writeUInt16BE(encryptedDek.length, 2);

    return Buffer.concat([header, encryptedDek, iv, ciphertext, tag]);
  } finally {
    dek.fill(0);
  }
}

export async function decryptSecret(
  blob: Buffer | string | null | undefined,
): Promise<string | null> {
  if (blob == null) {
    return null;
  }

  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob, "utf8");
  if (buf.length === 0) {
    return null;
  }

  if (!isEncrypted(buf)) {
    return buf.toString("utf8");
  }

  const keySource = buf[1];
  const encryptedDekLength = buf.readUInt16BE(2);
  const encryptedDekEnd = HEADER_LENGTH + encryptedDekLength;
  if (buf.length < encryptedDekEnd + IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted secret blob is truncated");
  }

  const encryptedDek = buf.subarray(HEADER_LENGTH, encryptedDekEnd);
  const iv = buf.subarray(encryptedDekEnd, encryptedDekEnd + IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(
    encryptedDekEnd + IV_LENGTH,
    buf.length - TAG_LENGTH,
  );

  let dek: Buffer;
  if (keySource === KEY_SOURCE_KMS) {
    const result = await getKmsClient().send(
      new DecryptCommand({
        CiphertextBlob: encryptedDek,
      }),
    );
    if (!result.Plaintext) {
      throw new Error("KMS Decrypt returned empty plaintext");
    }
    dek = Buffer.from(result.Plaintext);
  } else if (keySource === KEY_SOURCE_LOCAL) {
    dek = getLocalDek();
  } else {
    throw new Error(`Unsupported secret key source: ${keySource}`);
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Deterministic local key for unit tests only. */
export function localSecretsKeyForTests(): string {
  return scryptSync("devin-secrets-test", "salt", 32).toString("base64");
}
