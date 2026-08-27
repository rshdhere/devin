import type { ToolContext, ToolResult } from "./types.js";

/**
 * Call a Devbox tool through the worker HTTP proxy (Brain → worker → gateway).
 * Worker resolves the live session by taskId — no guest IP on the Brain.
 */
export async function executeToolViaWorker(
  ctx: Pick<
    ToolContext,
    | "taskId"
    | "workDir"
    | "executionWorkerUrl"
    | "requireProductImplementation"
    | "stackRuntime"
  >,
  name: string,
  rawArgs: string,
): Promise<ToolResult> {
  const base = ctx.executionWorkerUrl?.replace(/\/$/, "");
  if (!base) {
    return { content: "tool error: EXECUTION_WORKER_URL is not configured" };
  }

  try {
    const response = await fetch(
      `${base}/api/v1/tasks/${encodeURIComponent(ctx.taskId)}/tools`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          arguments: rawArgs,
          workDir: ctx.workDir,
          stackRuntime: ctx.stackRuntime,
          requireProductImplementation: ctx.requireProductImplementation,
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      content?: string;
      done?: boolean;
      summary?: string;
      error?: string;
    };
    if (!response.ok) {
      return {
        content:
          body.error ?? body.content ?? `tool proxy HTTP ${response.status}`,
      };
    }
    return {
      content: body.content ?? "",
      done: body.done,
      summary: body.summary,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "worker tool proxy failed";
    return { content: `tool error: ${message}` };
  }
}
