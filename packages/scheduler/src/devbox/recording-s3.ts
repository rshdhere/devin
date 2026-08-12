import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

let s3Client: S3Client | undefined;

function recordingBucket(): string | undefined {
  const bucket =
    process.env.DEVIN_RECORDING_S3_BUCKET?.trim() ||
    process.env.DEVIN_SNAPSHOT_S3_BUCKET?.trim();
  return bucket || undefined;
}

export function recordingS3Enabled(): boolean {
  return recordingBucket() !== undefined;
}

export function recordingS3Key(taskId: string): string {
  const prefix =
    process.env.DEVIN_RECORDING_S3_PREFIX?.trim() || "session-recordings";
  return `${prefix}/${taskId}.webm`;
}

function client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION?.trim() || "ap-south-1",
    });
  }
  return s3Client;
}

export async function saveTaskSessionRecordingS3(
  taskId: string,
  data: Buffer,
): Promise<void> {
  const bucket = recordingBucket();
  if (!bucket || data.length < 1024) {
    return;
  }
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: recordingS3Key(taskId),
      Body: data,
      ContentType: "video/webm",
      CacheControl: "no-store",
    }),
  );
}

export async function loadTaskSessionRecordingS3(
  taskId: string,
): Promise<Buffer | undefined> {
  const bucket = recordingBucket();
  if (!bucket) {
    return undefined;
  }
  try {
    const response = await client().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: recordingS3Key(taskId),
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes || bytes.length < 1024) {
      return undefined;
    }
    return Buffer.from(bytes);
  } catch {
    return undefined;
  }
}
