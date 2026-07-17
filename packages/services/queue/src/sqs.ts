import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { QueueHandler, QueueJob, TaskQueue } from "./types.js";

export interface SqsQueueOptions {
  queueUrl: string;
  region?: string;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
}

export class SqsQueue<T> implements TaskQueue<T> {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeoutSeconds: number;
  private handler: QueueHandler<T> | null = null;
  private running = false;
  private pollPromise: Promise<void> | null = null;

  constructor(options: SqsQueueOptions) {
    this.queueUrl = options.queueUrl;
    this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 3600;
    this.client = new SQSClient({
      region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
    });
  }

  async enqueue(payload: T, maxAttempts = 3): Promise<QueueJob<T>> {
    const job: QueueJob<T> = {
      id: crypto.randomUUID(),
      payload,
      attempts: 0,
      maxAttempts,
      enqueuedAt: new Date().toISOString(),
    };

    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(job),
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.send(command);
        break;
      } catch (error) {
        if (!isCredentialProviderError(error) || attempt >= 4) {
          throw error;
        }
        await sleep(250 * 2 ** attempt);
      }
    }

    return job;
  }

  startWorker(handler: QueueHandler<T>): void {
    if (this.running) {
      return;
    }

    this.handler = handler;
    this.running = true;
    this.pollPromise = this.poll();
  }

  stopWorker(): void {
    this.running = false;
    this.handler = null;
  }

  private async poll(): Promise<void> {
    while (this.running && this.handler) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: this.waitTimeSeconds,
            VisibilityTimeout: this.visibilityTimeoutSeconds,
          }),
        );

        const message = response.Messages?.[0];
        if (!message?.Body || !message.ReceiptHandle) {
          continue;
        }

        const job = JSON.parse(message.Body) as QueueJob<T>;
        job.attempts += 1;

        const heartbeat = setInterval(
          () => {
            void this.client
              .send(
                new ChangeMessageVisibilityCommand({
                  QueueUrl: this.queueUrl,
                  ReceiptHandle: message.ReceiptHandle!,
                  VisibilityTimeout: this.visibilityTimeoutSeconds,
                }),
              )
              .catch((error) => {
                console.error("[queue:sqs] visibility heartbeat failed", error);
              });
          },
          Math.max(60_000, (this.visibilityTimeoutSeconds * 1000) / 2),
        );

        try {
          await this.handler(job);
          await this.client.send(
            new DeleteMessageCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        } catch {
          if (job.attempts >= job.maxAttempts) {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: this.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
        } finally {
          clearInterval(heartbeat);
        }
      } catch (error) {
        console.error("[queue:sqs] poll failed", error);
        await sleep(1000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCredentialProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "CredentialsProviderError" ||
    /could not load credentials from any providers/i.test(error.message)
  );
}
