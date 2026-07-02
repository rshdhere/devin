import { InMemoryQueue } from "./memory.js";
import { SqsQueue } from "./sqs.js";
import type { TaskQueue } from "./types.js";

export type QueueDriver = "memory" | "sqs";

export function createQueue<T>(): TaskQueue<T> {
  const queueUrl = process.env.SQS_QUEUE_URL?.trim();
  const driver = (process.env.QUEUE_DRIVER ??
    (queueUrl ? "sqs" : "memory")) as QueueDriver;

  if (driver === "sqs") {
    if (!queueUrl) {
      throw new Error("SQS_QUEUE_URL is required when QUEUE_DRIVER=sqs");
    }

    return new SqsQueue<T>({
      queueUrl,
      region: process.env.AWS_REGION,
      waitTimeSeconds: envInt("SQS_WAIT_TIME_SECONDS", 20),
      visibilityTimeoutSeconds: envInt("SQS_VISIBILITY_TIMEOUT_SECONDS", 7200),
    });
  }

  return new InMemoryQueue<T>();
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}
