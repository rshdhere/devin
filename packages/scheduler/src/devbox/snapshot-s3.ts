import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

let s3Client: S3Client | undefined;

function snapshotBucket(): string | undefined {
  const bucket = process.env.DEVIN_SNAPSHOT_S3_BUCKET?.trim();
  return bucket || undefined;
}

export function snapshotS3Enabled(): boolean {
  return snapshotBucket() !== undefined;
}

export function snapshotS3Key(taskId: string): string {
  const prefix =
    process.env.DEVIN_SNAPSHOT_S3_PREFIX?.trim() || "desktop-snapshots";
  return `${prefix}/${taskId}.png`;
}

function client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION?.trim() || "ap-south-1",
    });
  }
  return s3Client;
}

export async function saveTaskDesktopSnapshotS3(
  taskId: string,
  data: Buffer,
): Promise<void> {
  const bucket = snapshotBucket();
  if (!bucket || data.length < 128) {
    return;
  }
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: snapshotS3Key(taskId),
      Body: data,
      ContentType: "image/png",
      CacheControl: "no-store",
    }),
  );
}

export async function loadTaskDesktopSnapshotS3(
  taskId: string,
): Promise<Buffer | undefined> {
  const bucket = snapshotBucket();
  if (!bucket) {
    return undefined;
  }
  try {
    const response = await client().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: snapshotS3Key(taskId),
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes || bytes.length < 128) {
      return undefined;
    }
    return Buffer.from(bytes);
  } catch {
    return undefined;
  }
}
